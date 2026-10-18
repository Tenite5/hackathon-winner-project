// CoTab service worker: owns the room connection and routes messages between the server,
// the popup / room page (ports), the offscreen video engine and the content scripts.

const DEFAULT_SERVER = 'ws://localhost:8787';
const COLORS = ['#ff416c', '#7b2ff7', '#06b6d4', '#f97316', '#22c55e', '#eab308', '#c724b1', '#3b82f6'];
const ADJECTIVES = ['Crimson', 'Violet', 'Neon', 'Cosmic', 'Velvet', 'Ruby', 'Electric', 'Lunar', 'Sonic', 'Magenta'];
const ANIMALS = ['Fox', 'Otter', 'Panda', 'Falcon', 'Lynx', 'Koala', 'Orca', 'Tiger', 'Raven', 'Gecko'];
const ROOM_URL = chrome.runtime.getURL('room.html');
const SHAREABLE = /^(https?|file):/;

const rid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const pick = list => list[Math.floor(Math.random() * list.length)];

let me = null;               // { id, name, color }
let serverUrl = DEFAULT_SERVER;
let roomCode = null;         // room we want to be in (persisted, used to auto-rejoin)
let room = null;             // latest snapshot from the server
let iceServers = null;
let inviteBase = null;       // address other people use to reach the server (from the server)
let status = 'idle';         // idle | connecting | connected | reconnecting
let lastError = null;
let shared = {};             // tabId -> { interactive, mirror, video, media, loading } (session storage)
const viewports = {};        // tabId -> { w, h, dpr } reported by the content script
const subsCount = {};        // tabId -> people watching that tab's live page
const mySubs = new Set();    // tabKeys the room page is watching
const presence = { activeTabKey: null, watching: null };

let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let backoff = 1000;
let pendingJoin = null;
const ports = new Set();
const toasts = new Map();    // toastId -> { t, onAction, tabId }
const announceTimers = {};
const lastPushed = {};

const ready = (async () => {
  const data = await chrome.storage.local.get(['me', 'serverUrl', 'roomCode']);
  me = data.me || { id: rid(), name: `${pick(ADJECTIVES)} ${pick(ANIMALS)}`, color: pick(COLORS) };
  if (!data.me) await chrome.storage.local.set({ me });
  serverUrl = data.serverUrl || DEFAULT_SERVER;
  roomCode = data.roomCode || null;
  shared = (await chrome.storage.session.get('shared')).shared || {};
  updateBadge();
  if (roomCode) connect(true);
})();

// ------------------------------------------------------------------ server connection

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function connect(create) {
  clearTimeout(reconnectTimer);
  closeSocket();
  setStatus(room ? 'reconnecting' : 'connecting');
  let sock;
  try {
    sock = new WebSocket(serverUrl);
  } catch {
    return onDrop(`Invalid server address ${serverUrl}`);
  }
  ws = sock;
  sock.onopen = () => {
    sock.send(JSON.stringify({ type: 'join', room: roomCode, create, user: { ...me, ...presence } }));
    clearInterval(pingTimer);
    // Regular traffic also keeps the MV3 service worker alive while we're in a room.
    pingTimer = setInterval(() => send({ type: 'ping' }), 20000);
  };
  sock.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    onServer(msg);
  };
  sock.onclose = () => {
    if (ws === sock) onDrop(`Can't reach ${serverUrl}`);
  };
}

function closeSocket() {
  clearInterval(pingTimer);
  if (!ws) return;
  const old = ws;
  ws = null;
  old.onclose = null;
  try { old.close(); } catch {}
}

function onDrop(reason) {
  ws = null;
  clearInterval(pingTimer);
  if (pendingJoin) {
    const p = pendingJoin;
    pendingJoin = null;
    resetRoom();
    p.reject(new Error(`${reason}. Is the CoTab server running?`));
    return;
  }
  if (roomCode) {
    lastError = reason;
    setStatus('reconnecting');
    reconnectTimer = setTimeout(() => connect(true), backoff);
    backoff = Math.min(backoff * 1.7, 10000);
  } else {
    setStatus('idle');
  }
}

function joinRoom(code, create) {
  return new Promise((resolve, reject) => {
    pendingJoin?.reject(new Error('Cancelled'));
    const attempt = { resolve, reject };
    pendingJoin = attempt;
    roomCode = code;
    room = null;
    lastError = null;
    backoff = 1000;
    connect(create);
    setTimeout(() => {
      if (pendingJoin !== attempt) return;
      pendingJoin = null;
      resetRoom();
      reject(new Error(`Couldn't reach ${serverUrl}. Is the CoTab server running?`));
    }, 9000);
  });
}

function resetRoom() {
  roomCode = null;
  room = null;
  inviteBase = null;
  presence.activeTabKey = presence.watching = null;
  mySubs.clear();
  chrome.storage.local.remove('roomCode');
  chrome.alarms.clear('keepalive');
  clearTimeout(reconnectTimer);
  closeSocket();
  setStatus('idle');
  updateBadge();
}

async function leaveRoom() {
  for (const tabId of Object.keys(shared)) await unshareTab(Number(tabId));
  send({ type: 'leave' });
  resetRoom();
  if (await hasOffscreen()) chrome.offscreen.closeDocument().catch(() => {});
}

function onServer(msg) {
  switch (msg.type) {
    case 'joined': {
      room = msg.room;
      roomCode = room.code;
      iceServers = msg.iceServers;
      // the server may hand us a different color so everyone in the room is distinct
      const seat = room.members.find(m => m.id === me.id);
      if (seat && seat.color !== me.color) {
        me = { ...me, color: seat.color };
        chrome.storage.local.set({ me });
      }
      backoff = 1000;
      lastError = null;
      chrome.storage.local.set({ roomCode });
      chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
      if (pendingJoin) {
        pendingJoin.resolve(room.code);
        pendingJoin = null;
      }
      reconcileShared();
      for (const key of mySubs) send({ type: 'mirror-sub', tabKey: key });
      updateActive(true);
      setStatus('connected');
      updateBadge();
      break;
    }
    case 'server-info':
      inviteBase = msg.inviteBase || null;
      broadcastState();
      break;
    case 'state': {
      const prev = room;
      room = msg.room;
      afterState(prev);
      break;
    }
    case 'error':
      lastError = msg.message;
      if (pendingJoin) {
        const p = pendingJoin;
        pendingJoin = null;
        resetRoom();
        p.reject(new Error(msg.message));
      } else if (msg.code === 'not-found') {
        resetRoom();
      }
      broadcastState();
      break;

    // someone started watching one of my tabs: send them the page so far
    case 'mirror-sub': {
      const tabId = ownTabId(msg.tabKey);
      if (tabId == null || !shared[tabId]) break;
      subsCount[tabId] = (subsCount[tabId] || 0) + 1;
      chrome.tabs.sendMessage(tabId, { type: 'mirror-init-request', to: msg.from }).catch(() => {});
      break;
    }
    // live page updates / pointers for tabs I'm watching
    case 'mirror':
    case 'mirror-init':
    case 'cursor':
    case 'control-response':
      postToRooms(msg);
      break;
    case 'signal':
      routeSignal(msg.from, msg.data);
      break;
    case 'control':
      onControl(msg);
      break;
    case 'control-request':
      onControlRequest(msg);
      break;
    case 'invite':
      onInvite(msg);
      break;
  }
}

function afterState(prev) {
  for (const t of room.tabs) {
    const tabId = ownTabId(t.key);
    if (tabId != null) subsCount[tabId] = t.viewers || 0;
  }
  if (prev && Object.values(shared).some(s => s.video)) {
    const still = new Set(room.members.map(m => m.id));
    for (const m of prev.members) {
      if (!still.has(m.id)) toOffscreen({ type: 'drop-viewer', viewerId: m.id }).catch(() => {});
    }
  }
  broadcastState();
  for (const tabId of Object.keys(shared)) pushTabState(Number(tabId));
  updateBadge();
}

// After (re)joining: drop shares whose tab is gone, re-announce the rest.
async function reconcileShared() {
  let live = [];
  if (await hasOffscreen()) live = await toOffscreen({ type: 'list-captures' }).catch(() => []);
  for (const id of Object.keys(shared)) {
    const tabId = Number(id);
    try {
      await chrome.tabs.get(tabId);
    } catch {
      delete shared[id];
      continue;
    }
    shared[id].video = live.includes(tabId);
    announce(tabId);
  }
  saveShared();
  broadcastState();
}

// ------------------------------------------------------------------ UI ports (popup + room page)

function reachOf(base) {
  try {
    const u = new URL(base);
    if (u.protocol === 'https:') return 'public';
    return /^(localhost|127\.|\[::1\])/.test(u.hostname) ? 'local' : 'network';
  } catch {
    return 'local';
  }
}

function publicState() {
  const link = room ? inviteLink(room.code) : null;
  return {
    status,
    error: lastError,
    me,
    serverUrl,
    roomCode,
    room,
    iceServers,
    inviteLink: link,
    reach: link ? reachOf(link) : 'local',
    watching: presence.watching,
    sharedTabs: Object.entries(shared).map(([id, s]) => ({ tabId: Number(id), ...s })),
  };
}

function post(port, msg) {
  try { port.postMessage(msg); return true; } catch { return false; }
}

function broadcastState() {
  const msg = { type: 'state', state: publicState() };
  for (const port of ports) post(port, msg);
}

function postToRooms(msg) {
  let n = 0;
  for (const port of ports) if (port.name === 'room' && post(port, msg)) n++;
  return n;
}

function setStatus(s) {
  status = s;
  broadcastState();
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'popup' && port.name !== 'room') return;
  ports.add(port);
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (port.name === 'room' && ![...ports].some(p => p.name === 'room')) {
      api.setWatching(null);
      for (const key of mySubs) send({ type: 'mirror-unsub', tabKey: key });
      mySubs.clear();
    }
  });
  port.onMessage.addListener(msg => ready.then(() => onPortMessage(port, msg)));
  ready.then(() => post(port, { type: 'state', state: publicState() }));
});

async function onPortMessage(port, msg) {
  switch (msg.type) {
    case 'call':
      try {
        if (!api[msg.fn]) throw new Error(`Unknown action ${msg.fn}`);
        const value = await api[msg.fn](...(msg.args || []));
        post(port, { type: 'result', id: msg.id, ok: true, value });
      } catch (e) {
        post(port, { type: 'result', id: msg.id, ok: false, error: e?.message || String(e) });
      }
      break;
    case 'mirror-sub':
      mySubs.add(msg.tabKey);
      send({ type: 'mirror-sub', tabKey: msg.tabKey });
      break;
    case 'mirror-unsub':
      mySubs.delete(msg.tabKey);
      send({ type: 'mirror-unsub', tabKey: msg.tabKey });
      break;
    case 'signal':
      send({ type: 'signal', to: msg.to, data: msg.data });
      break;
    case 'control':
      send({ type: 'control', tabKey: msg.tabKey, event: msg.event });
      break;
  }
}

const api = {
  state: () => publicState(),
  async createRoom() {
    if (room || roomCode) await leaveRoom();
    return joinRoom(null, true);
  },
  async joinRoom(input) {
    const invite = parseInvite(input);
    if (!invite) throw new Error('Paste a room code (like K7F2QX) or an invite link');
    if (room || roomCode) await leaveRoom();
    if (invite.server) await setServer(invite.server);
    return joinRoom(invite.code, false);
  },
  leaveRoom,
  setName,
  setServer,
  shareTab: tabId => shareTab(tabId),
  unshareTab,
  setInteractive,
  async openAndShare(input) {
    const url = toUrl(input);
    if (!url) throw new Error('Type a web address, like github.com');
    const tab = await chrome.tabs.create({ url, active: true });
    await shareTab(tab.id, { capture: false });
    return tab.id;
  },
  async inviteHere(tabId) {
    if (!shared[tabId]) await shareTab(tabId);
    send({ type: 'invite', tabKey: `${me.id}:${tabId}` });
    return true;
  },
  openRoom,
  requestControl(tabKey) {
    send({ type: 'request-control', tabKey });
  },
  setWatching(key) {
    key = key || null;
    if (presence.watching === key) return;
    presence.watching = key;
    send({ type: 'update-me', patch: { watching: key } });
  },
  async focusTab(tabId) {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  },
  openUrl(url) {
    if (/^https?:\/\//i.test(url)) chrome.tabs.create({ url });
  },
  toastAction(id, actionId) {
    runToastAction(id, actionId);
  },
  retry() {
    if (roomCode) connect(true);
  },
};

// ------------------------------------------------------------------ identity + settings

async function setName(name) {
  name = String(name || '').trim().slice(0, 40);
  if (!name || name === me.name) return me;
  me = { ...me, name };
  await chrome.storage.local.set({ me });
  send({ type: 'update-me', patch: { name } });
  broadcastState();
  return me;
}

async function setServer(url) {
  url = String(url || '').trim().replace(/\/+$/, '');
  if (!url) url = DEFAULT_SERVER;
  if (/^https?:\/\//i.test(url)) url = url.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(url)) url = `ws://${url}`;
  serverUrl = url;
  await chrome.storage.local.set({ serverUrl });
  broadcastState();
  return serverUrl;
}

function parseInvite(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9]{4,12}$/.test(s)) return { code: s.toUpperCase() };
  try {
    const u = new URL(s);
    const m = u.pathname.match(/\/r\/([A-Za-z0-9]{4,12})/);
    if (!m) return null;
    return { code: m[1].toUpperCase(), server: `${u.protocol === 'https:' ? 'wss' : 'ws'}://${u.host}` };
  } catch {
    return null;
  }
}

function toUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[^\s]+\.[^\s]{2,}$/.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

function inviteLink(code) {
  let base = inviteBase;
  if (!base) {
    try {
      const u = new URL(serverUrl);
      base = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
    } catch {
      return code;
    }
  }
  return `${base.replace(/\/+$/, '')}/r/${code}`;
}

const member = id => room?.members.find(m => m.id === id);
const keyOf = tabId => `${me.id}:${tabId}`;
const ownTabId = key => {
  const [owner, id] = String(key).split(':');
  return owner === me.id ? Number(id) : null;
};

// ------------------------------------------------------------------ sharing tabs

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creatingOffscreen ||= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'WEB_RTC'],
      justification: 'Capture the tabs you choose to share and stream them to your room over WebRTC.',
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

async function toOffscreen(msg) {
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
  if (!res) throw new Error('Video engine is not running');
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

function saveShared() {
  chrome.storage.session.set({ shared });
}

async function ensureContentScript(tabId) {
  try {
    if ((await chrome.tabs.sendMessage(tabId, { type: 'ping' })) === 'pong') return true;
  } catch {}
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch {
    return false;
  }
}

// The live page mirror: rrweb runs inside the page and streams its DOM. Safe to call repeatedly.
async function injectRecorder(tabId) {
  if (!(await ensureContentScript(tabId))) return false;
  try {
    const [{ result: running } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        if (!window.__cotabRecorder) return false;
        window.__cotabRecorder.ensure();
        return true;
      },
    });
    if (!running) {
      await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['vendor/rrweb-record.js', 'recorder.js'] });
    }
    return true;
  } catch {
    return false;
  }
}

// The video feed: needs that you invoked CoTab on that tab (icon, shortcut or right-click).
async function startCapture(tab) {
  await ensureOffscreen();
  await toOffscreen({ type: 'set-ice', iceServers });
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  const vp = viewports[tab.id];
  await toOffscreen({ type: 'start-capture', tabId: tab.id, streamId, width: vp?.w || tab.width, height: vp?.h || tab.height, dpr: vp?.dpr || 1 });
  return true;
}

async function shareTab(tabId, { capture = true } = {}) {
  if (!room) throw new Error('Start or join a room first');
  const tab = await chrome.tabs.get(tabId);
  if (shared[tabId]) {
    // already live: add the video feed if we can now (you just clicked CoTab on this tab)
    if (capture && !shared[tabId].video && (await startCapture(tab).catch(() => false))) {
      shared[tabId].video = true;
      saveShared();
      await announce(tabId);
      broadcastState();
    }
    return true;
  }
  if (!SHAREABLE.test(tab.url || tab.pendingUrl || '')) throw new Error("Chrome doesn't let extensions share this kind of page");

  const entry = { interactive: false, mirror: false, video: false, media: false, loading: tab.status !== 'complete' };
  shared[tabId] = entry;
  // A tab that is still loading also gets its recorder once the page finishes loading.
  entry.mirror = (await injectRecorder(tabId)) || entry.loading;
  if (capture) entry.video = await startCapture(tab).catch(() => false);
  if (!entry.mirror && !entry.video) {
    delete shared[tabId];
    saveShared();
    throw new Error("This page can't be shared. Chrome protects some pages, like the Web Store and settings.");
  }
  saveShared();
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  await announce(tabId);
  pushTabState(tabId, true);
  updateActive();
  updateBadge();
  broadcastState();
  return true;
}

async function unshareTab(tabId) {
  const was = shared[tabId];
  delete shared[tabId];
  delete subsCount[tabId];
  saveShared();
  send({ type: 'unshare', tabId });
  if (was) {
    if (was.video) toOffscreen({ type: 'stop-capture', tabId }).catch(() => {});
    pushTabState(tabId, true);
    chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
  }
  updateActive();
  updateBadge();
  broadcastState();
  return true;
}

async function setInteractive(tabId, on) {
  if (!shared[tabId]) return false;
  shared[tabId].interactive = !!on;
  saveShared();
  await announce(tabId);
  pushTabState(tabId, true);
  broadcastState();
  return true;
}

async function announce(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return unshareTab(tabId);
  }
  const s = shared[tabId];
  if (!s) return;
  send({
    type: 'share',
    tab: {
      tabId,
      title: tab.title || tab.pendingUrl || tab.url,
      url: tab.url || tab.pendingUrl,
      favIconUrl: tab.favIconUrl,
      interactive: s.interactive,
      mirror: s.mirror,
      video: s.video,
      media: s.media,
      loading: s.loading,
      viewport: viewports[tabId] || { w: tab.width, h: tab.height },
    },
  });
}

function announceSoon(tabId) {
  clearTimeout(announceTimers[tabId]);
  announceTimers[tabId] = setTimeout(() => shared[tabId] && announce(tabId), 120);
}

function tabState(tabId) {
  const s = shared[tabId];
  const key = keyOf(tabId);
  const watchers = s && room
    ? room.members.filter(m => m.id !== me.id && m.online && m.watching === key).map(m => ({ name: m.name, color: m.color }))
    : [];
  return { shared: !!s, interactive: !!s?.interactive, watchers, roomCode: room?.code || null };
}

function pushTabState(tabId, force) {
  const st = tabState(tabId);
  const json = JSON.stringify(st);
  if (!force && lastPushed[tabId] === json) return;
  lastPushed[tabId] = json;
  chrome.tabs.sendMessage(tabId, { type: 'share-state', ...st }).catch(() => {});
}

async function updateActive(force) {
  if (!room) return;
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {}
  // Only shared tabs are ever reported: private browsing stays private.
  const key = tab && shared[tab.id] ? keyOf(tab.id) : null;
  if (key === presence.activeTabKey && !force) return;
  presence.activeTabKey = key;
  send({ type: 'update-me', patch: { activeTabKey: key } });
}

function updateBadge() {
  const sharing = Object.keys(shared).length;
  const people = room ? room.members.filter(m => m.online).length : 0;
  chrome.action.setBadgeBackgroundColor({ color: sharing ? '#ff3d6e' : '#3a3a3a' });
  chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
  chrome.action.setBadgeText({ text: sharing ? 'LIVE' : room ? String(people) : '' });
}

// ------------------------------------------------------------------ WebRTC signaling (video feed)

// Signals must reach the peer connection in order (offer/answer before ICE), so serialize them.
let signalChain = Promise.resolve();
function routeSignal(from, data) {
  signalChain = signalChain.then(() => deliverSignal(from, data)).catch(() => {});
}

async function deliverSignal(from, data) {
  if (!data) return;
  if (data.dir === 'down') {
    postToRooms({ type: 'signal', from, data });
    return;
  }
  const unavailable = () => send({ type: 'signal', to: from, data: { dir: 'down', kind: 'unavailable', pcId: data.pcId } });
  if (data.kind === 'subscribe' && !shared[data.tabId]?.video) return unavailable();
  if (!(await hasOffscreen())) {
    if (data.kind === 'subscribe') unavailable();
    return;
  }
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'signal', from, data }).catch(() => {});
}

// ------------------------------------------------------------------ remote control

function onControl({ from, tabKey, event }) {
  const tabId = ownTabId(tabKey);
  if (tabId == null || !shared[tabId] || !event) return;
  const passive = event.type === 'move' || event.type === 'leave';
  if (!passive && !shared[tabId].interactive) return; // the owner hasn't allowed control
  if (event.type === 'nav') return navigate(tabId, event);
  const m = member(from);
  chrome.tabs
    .sendMessage(tabId, { type: 'control', from: { id: from, name: m?.name || 'Guest', color: m?.color || '#7b2ff7' }, event })
    .catch(() => {});
}

async function navigate(tabId, ev) {
  try {
    if (ev.action === 'back') await chrome.tabs.goBack(tabId);
    else if (ev.action === 'forward') await chrome.tabs.goForward(tabId);
    else if (ev.action === 'reload') await chrome.tabs.reload(tabId);
    else if (ev.action === 'url' && /^https?:\/\//i.test(ev.url)) await chrome.tabs.update(tabId, { url: ev.url });
  } catch {}
}

function onControlRequest({ from, tabKey }) {
  const tabId = ownTabId(tabKey);
  if (tabId == null || !shared[tabId]) return;
  const reply = allowed => send({ type: 'control-response', to: from, tabKey, allowed });
  if (shared[tabId].interactive) return reply(true);
  const m = member(from);
  const tab = room?.tabs.find(t => t.key === tabKey);
  toast(
    {
      title: `${m?.name || 'Someone'} wants to take control`,
      body: `They'd be able to click, type and scroll in “${tab?.title || 'your tab'}”.`,
      color: m?.color,
      initial: (m?.name || '?')[0],
      actions: [
        { id: 'allow', label: 'Allow', primary: true },
        { id: 'deny', label: 'Not now' },
      ],
      timeout: 30000,
    },
    action => {
      const ok = action === 'allow';
      if (ok) setInteractive(tabId, true);
      reply(ok);
    },
  );
}

function onInvite({ from, tabKey, tab: sent }) {
  const m = member(from);
  const tab = room?.tabs.find(t => t.key === tabKey) || sent;
  if (!m || !tab) return;
  toast(
    {
      title: `${m.name} wants you to see this`,
      body: tab.title,
      color: m.color,
      initial: m.name[0],
      favicon: tab.favIconUrl,
      tabKey,
      actions: [
        { id: 'watch', label: 'Watch live', primary: true },
        { id: 'open', label: 'Open my own copy' },
      ],
      timeout: 20000,
    },
    action => {
      if (action === 'watch') openRoom(tabKey);
      else if (action === 'open' && tab.url) chrome.tabs.create({ url: tab.url });
    },
  );
}

async function openRoom(focusKey) {
  const roomPort = [...ports].find(p => p.name === 'room' && p.sender?.tab);
  if (roomPort) {
    const tab = roomPort.sender.tab;
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    if (focusKey) post(roomPort, { type: 'focus', key: focusKey });
    return true;
  }
  await chrome.tabs.create({ url: ROOM_URL + (focusKey ? `#focus=${encodeURIComponent(focusKey)}` : '') });
  return true;
}

// ------------------------------------------------------------------ toasts (room page, in-page, or system)

// Shown in the room page (if open) and on whatever tab you're looking at; falls back to a
// system notification. Acting on any copy closes the others.
async function toast(t, onAction) {
  t.id = rid();
  const entry = { t, onAction, tabId: null };
  toasts.set(t.id, entry);
  setTimeout(() => toasts.delete(t.id), (t.timeout || 15000) + 60000);
  postToRooms({ type: 'toast', toast: t });
  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {}
  if (tab?.url?.startsWith(ROOM_URL)) return;
  if (tab && SHAREABLE.test(tab.url || '') && (await ensureContentScript(tab.id))) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'toast', toast: t });
      entry.tabId = tab.id;
      return;
    } catch {}
  }
  chrome.notifications.create(t.id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: t.title,
    message: t.body || '',
    buttons: (t.actions || []).slice(0, 2).map(a => ({ title: a.label })),
    priority: 2,
  });
}

function runToastAction(id, actionId) {
  const entry = toasts.get(id);
  if (!entry) return;
  toasts.delete(id);
  postToRooms({ type: 'toast-close', id });
  if (entry.tabId != null) chrome.tabs.sendMessage(entry.tabId, { type: 'toast-close', id }).catch(() => {});
  chrome.notifications.clear(id);
  if (actionId) entry.onAction?.(actionId);
}

chrome.notifications.onButtonClicked.addListener((id, index) =>
  ready.then(() => runToastAction(id, toasts.get(id)?.t.actions?.[index]?.id)),
);
chrome.notifications.onClicked.addListener(id => ready.then(() => runToastAction(id, toasts.get(id)?.t.actions?.[0]?.id)));

// ------------------------------------------------------------------ messages from content scripts + offscreen

const fromContent = {
  hello(msg, tab) {
    // a shared tab loaded a new page: start streaming it again
    if (shared[tab.id]?.mirror) injectRecorder(tab.id);
    return tabState(tab.id);
  },
  viewport(msg, tab) {
    viewports[tab.id] = { w: Math.round(msg.w), h: Math.round(msg.h), dpr: Number(msg.dpr) || 1 };
    if (shared[tab.id]) announceSoon(tab.id);
  },
  'mirror-batch'(msg, tab) {
    if (!shared[tab.id] || !(subsCount[tab.id] > 0)) return;
    send({ type: 'mirror', tabKey: keyOf(tab.id), session: msg.session, seq0: msg.seq0, n: msg.n, p: msg.p, z: msg.z, reset: !!msg.reset });
  },
  'mirror-init'(msg, tab) {
    if (!shared[tab.id]) return;
    send({ type: 'mirror-init', to: msg.to, tabKey: keyOf(tab.id), session: msg.session, batches: msg.batches });
  },
  'owner-cursor'(msg, tab) {
    if (!shared[tab.id] || !(subsCount[tab.id] > 0)) return;
    send({ type: 'cursor', tabKey: keyOf(tab.id), x: msg.x, y: msg.y, gone: msg.gone });
  },
  media(msg, tab) {
    const s = shared[tab.id];
    if (!s || s.media === !!msg.media) return;
    s.media = !!msg.media;
    saveShared();
    announceSoon(tab.id);
    if (s.video) toOffscreen({ type: 'content-hint', tabId: tab.id, hint: s.media ? 'motion' : 'detail' }).catch(() => {});
  },
  'toast-action': msg => runToastAction(msg.toastId, msg.actionId),
  'set-interactive': (msg, tab) => setInteractive(tab.id, msg.on),
  'stop-sharing': (msg, tab) => unshareTab(tab.id),
  'invite-info': () => ({ name: me.name, roomCode }),
  async 'invite-join'(msg) {
    if (msg.name) await setName(msg.name);
    if (room?.code !== msg.code) {
      if (room || roomCode) await leaveRoom();
      if (msg.server) await setServer(msg.server);
      await joinRoom(msg.code, true);
    }
    await openRoom();
    return true;
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'background') {
    ready.then(() => {
      if (msg.type === 'signal-out') send({ type: 'signal', to: msg.to, data: msg.data });
      else if (msg.type === 'capture-ended' && shared[msg.tabId]?.video) {
        shared[msg.tabId].video = false;
        if (!shared[msg.tabId].mirror) unshareTab(msg.tabId);
        else announce(msg.tabId);
      }
    });
    return;
  }
  if (msg?.target || !sender.tab || !Object.hasOwn(fromContent, msg?.type)) return;
  ready
    .then(() => fromContent[msg.type](msg, sender.tab))
    .then(
      value => sendResponse({ ok: true, value }),
      e => sendResponse({ ok: false, error: e?.message || String(e) }),
    );
  return true;
});

// ------------------------------------------------------------------ browser events

chrome.tabs.onUpdated.addListener((tabId, info) =>
  ready.then(() => {
    const s = shared[tabId];
    if (!s) return;
    if (info.status) s.loading = info.status === 'loading';
    if (info.title || info.url || info.favIconUrl || info.status) announceSoon(tabId);
    if (info.status === 'complete') {
      pushTabState(tabId, true);
      if (s.mirror) injectRecorder(tabId);
    }
  }),
);
chrome.tabs.onRemoved.addListener(tabId =>
  ready.then(() => {
    delete viewports[tabId];
    delete lastPushed[tabId];
    if (shared[tabId]) unshareTab(tabId);
  }),
);
chrome.tabs.onActivated.addListener(() => ready.then(() => updateActive()));
chrome.windows.onFocusChanged.addListener(() => ready.then(() => updateActive()));

chrome.alarms.onAlarm.addListener(alarm =>
  ready.then(() => {
    if (alarm.name === 'keepalive' && roomCode && !ws) connect(true);
  }),
);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'share', title: 'Share this tab with my CoTab room', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'invite', title: 'Invite everyone to this tab', contexts: ['page'] });
  });
});

async function quickAction(kind, tab) {
  await ready;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  try {
    if (!room) throw new Error('Start or join a room first: click the CoTab icon.');
    if (kind === 'invite') await api.inviteHere(tab.id);
    else if (kind === 'toggle' && shared[tab.id]) await unshareTab(tab.id);
    else await shareTab(tab.id);
  } catch (e) {
    toast({ title: 'CoTab', body: e.message, timeout: 6000 });
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => quickAction(info.menuItemId === 'invite' ? 'invite' : 'share', tab));
chrome.commands.onCommand.addListener((command, tab) => quickAction(command === 'invite-here' ? 'invite' : 'toggle', tab));
