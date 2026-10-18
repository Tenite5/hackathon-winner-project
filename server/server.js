// CoTab room server: rooms, presence, the list of shared tabs, and a relay for live page
// mirrors, cursors, remote-control events and WebRTC signaling. Everything lives in memory.
import http from 'node:http';
import os from 'node:os';
import { randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8787;
const GRACE_MS = 15000; // keep a member's seat (and shared tabs) while their extension reconnects
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PALETTE = ['#ff416c', '#7b2ff7', '#06b6d4', '#f97316', '#22c55e', '#eab308', '#c724b1', '#3b82f6'];

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URL) {
  ICE_SERVERS.push({
    urls: process.env.TURN_URL.split(','),
    username: process.env.TURN_USERNAME || '',
    credential: process.env.TURN_CREDENTIAL || '',
  });
}

let publicUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

/** code -> { code, members: Map<userId, member>, tabs: Map<tabKey, tab>, subs: Map<tabKey, Set<userId>>, pending } */
const rooms = new Map();
let wss = null;

const clean = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const isLocalHost = host => /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(host || '');

export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
    .map(i => i.address);
}

// The address other people should use to reach this server.
function inviteBaseFor(req) {
  if (publicUrl) return publicUrl;
  const host = req?.headers?.host || `localhost:${PORT}`;
  if (!isLocalHost(host)) {
    const https = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    return `${https ? 'https' : 'http'}://${host}`;
  }
  const lan = lanAddresses()[0];
  return lan ? `http://${lan}:${PORT}` : `http://${host}`;
}

function serverInfo(ws) {
  return { type: 'server-info', inviteBase: inviteBaseFor(ws.req), public: !!publicUrl || /^https:/.test(inviteBaseFor(ws.req)) };
}

export function setPublicUrl(url) {
  publicUrl = (url || '').replace(/\/+$/, '');
  for (const ws of wss?.clients || []) sendTo(ws, serverInfo(ws));
}

function newCode() {
  let code;
  do code = Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');
  while (rooms.has(code));
  return code;
}

function snapshot(room) {
  return {
    code: room.code,
    members: [...room.members.values()].map(m => ({
      id: m.id,
      name: m.name,
      color: m.color,
      online: !!m.ws,
      activeTabKey: m.activeTabKey || null,
      watching: m.watching || null,
      agents: m.agents || [],
      joinedAt: m.joinedAt,
    })),
    tabs: [...room.tabs.values()].map(t => ({ ...t, viewers: room.subs.get(t.key)?.size || 0 })),
  };
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

// Coalesce bursts of changes into one state push per tick.
function scheduleBroadcast(room) {
  if (room.pending) return;
  room.pending = true;
  setImmediate(() => room.pending && broadcastNow(room));
}

function broadcastNow(room) {
  room.pending = false;
  if (rooms.get(room.code) !== room) return;
  const msg = JSON.stringify({ type: 'state', room: snapshot(room) });
  for (const m of room.members.values()) sendTo(m.ws, msg);
}

function unsubscribeAll(room, userId) {
  for (const set of room.subs.values()) set.delete(userId);
}

function dropTab(room, key) {
  room.tabs.delete(key);
  room.subs.delete(key);
}

function removeMember(room, id) {
  const m = room.members.get(id);
  if (!m) return;
  clearTimeout(m.leaveTimer);
  room.members.delete(id);
  unsubscribeAll(room, id);
  for (const [key, tab] of room.tabs) if (tab.ownerId === id) dropTab(room, key);
  if (!room.members.size) rooms.delete(room.code);
  else scheduleBroadcast(room);
}

function cleanAgent(a) {
  if (!a || typeof a !== 'object') return undefined;
  return { id: clean(a.id, 64), name: clean(a.name, 24), color: clean(a.color, 20) };
}

function cleanAgents(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 8).map(a => ({
    ...cleanAgent(a),
    tabKey: clean(a.tabKey, 100) || null,
    task: clean(a.task, 140) || null,
    step: clean(a.step, 100) || null,
  }));
}

function cleanTab(owner, t, room) {
  const tabId = Number(t.tabId);
  const key = `${owner.id}:${tabId}`;
  const prev = room.tabs.get(key);
  const fav = clean(t.favIconUrl, 8000);
  return {
    key,
    ownerId: owner.id,
    tabId,
    title: clean(t.title, 200) || 'Untitled tab',
    url: clean(t.url, 2000),
    favIconUrl: fav.length < 8000 ? fav : '',
    interactive: !!t.interactive,
    mirror: !!t.mirror,
    video: !!t.video,
    media: !!t.media,
    loading: !!t.loading,
    viewport: t.viewport ? { w: Number(t.viewport.w) || 0, h: Number(t.viewport.h) || 0 } : prev?.viewport || null,
    sharedAt: prev?.sharedAt || Date.now(),
  };
}

function onConnection(ws, req) {
  ws.req = { headers: { host: req.headers.host, 'x-forwarded-proto': req.headers['x-forwarded-proto'] || '' } };
  let room = null;
  let me = null;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  const relay = (userId, msg) => sendTo(room?.members.get(userId)?.ws, msg);
  const toSubscribers = (key, msg, except) => {
    const set = room.subs.get(key);
    if (!set?.size) return;
    const data = JSON.stringify(msg);
    for (const id of set) if (id !== except) sendTo(room.members.get(id)?.ws, data);
  };

  function join(msg) {
    const user = msg.user || {};
    const id = clean(user.id, 64).replace(/[^\w-]/g, '');
    if (!id) return sendTo(ws, { type: 'error', code: 'bad-user', message: 'Missing user id' });

    const wanted = clean(msg.room, 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (room && me && room.code !== wanted) removeMember(room, me.id);

    const code = wanted || newCode();
    let r = rooms.get(code);
    if (!r) {
      if (wanted && !msg.create) {
        return sendTo(ws, { type: 'error', code: 'not-found', message: `Room ${code} doesn't exist. Check the code or start a new room.` });
      }
      r = { code, members: new Map(), tabs: new Map(), subs: new Map(), pending: false };
      rooms.set(code, r);
    }

    let m = r.members.get(id);
    if (m) {
      clearTimeout(m.leaveTimer);
      if (m.ws && m.ws !== ws) {
        const old = m.ws;
        m.ws = null;
        old.close(4000, 'replaced');
      }
    } else {
      m = { id, joinedAt: Date.now() };
      r.members.set(id, m);
    }
    // Give everyone in the room a distinct color when we can.
    let color = clean(user.color, 20) || PALETTE[0];
    const taken = new Set([...r.members.values()].filter(x => x.id !== id).map(x => x.color));
    if (taken.has(color)) color = PALETTE.find(c => !taken.has(c)) || color;
    Object.assign(m, {
      ws,
      name: clean(user.name, 40) || 'Guest',
      color,
      activeTabKey: clean(user.activeTabKey, 100) || null,
      watching: clean(user.watching, 100) || null,
    });
    room = r;
    me = m;
    sendTo(ws, { type: 'joined', you: id, room: snapshot(r), iceServers: ICE_SERVERS });
    sendTo(ws, serverInfo(ws));
    scheduleBroadcast(r);
  }

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'ping') return sendTo(ws, { type: 'pong' });
    if (msg.type === 'join') return join(msg);
    if (!room || !me || me.ws !== ws) return;

    switch (msg.type) {
      case 'update-me': {
        const p = msg.patch || {};
        if ('name' in p) me.name = clean(p.name, 40) || me.name;
        if ('activeTabKey' in p) me.activeTabKey = clean(p.activeTabKey, 100) || null;
        if ('watching' in p) me.watching = clean(p.watching, 100) || null;
        if ('agents' in p) me.agents = cleanAgents(p.agents);
        scheduleBroadcast(room);
        break;
      }
      case 'share': {
        const tab = cleanTab(me, msg.tab || {}, room);
        if (Number.isFinite(tab.tabId)) room.tabs.set(tab.key, tab);
        scheduleBroadcast(room);
        break;
      }
      case 'unshare': {
        const key = `${me.id}:${Number(msg.tabId)}`;
        dropTab(room, key);
        if (me.activeTabKey === key) me.activeTabKey = null;
        scheduleBroadcast(room);
        break;
      }

      // ---- live page mirror
      case 'mirror-sub': {
        const tab = room.tabs.get(msg.tabKey);
        if (!tab || tab.ownerId === me.id) break;
        if (!room.subs.has(tab.key)) room.subs.set(tab.key, new Set());
        room.subs.get(tab.key).add(me.id);
        relay(tab.ownerId, { type: 'mirror-sub', from: me.id, tabKey: tab.key });
        scheduleBroadcast(room);
        break;
      }
      case 'mirror-unsub':
        room.subs.get(msg.tabKey)?.delete(me.id);
        scheduleBroadcast(room);
        break;
      case 'mirror': // owner -> everyone watching that tab
        if (room.tabs.get(msg.tabKey)?.ownerId === me.id) toSubscribers(msg.tabKey, { ...msg, from: me.id }, me.id);
        break;
      case 'mirror-init': // owner -> one new viewer
        if (room.tabs.get(msg.tabKey)?.ownerId === me.id) relay(msg.to, { ...msg, from: me.id });
        break;
      case 'cursor': // owner's own pointer
        if (room.tabs.get(msg.tabKey)?.ownerId === me.id) {
          toSubscribers(msg.tabKey, { type: 'cursor', from: me.id, tabKey: msg.tabKey, x: msg.x, y: msg.y, gone: !!msg.gone, click: !!msg.click, ai: cleanAgent(msg.ai) }, me.id);
        }
        break;

      case 'signal':
        relay(msg.to, { type: 'signal', from: me.id, data: msg.data });
        break;
      case 'control': {
        const tab = room.tabs.get(msg.tabKey);
        if (!tab || tab.ownerId === me.id) break;
        relay(tab.ownerId, { type: 'control', from: me.id, tabKey: tab.key, event: msg.event });
        const ev = msg.event || {};
        if (ev.type === 'move' || ev.type === 'leave' || ev.type === 'click') {
          // other viewers see this person's pointer too
          toSubscribers(tab.key, { type: 'cursor', from: me.id, tabKey: tab.key, x: ev.x, y: ev.y, gone: ev.type === 'leave', click: ev.type === 'click' }, me.id);
        }
        break;
      }
      case 'request-control': {
        const tab = room.tabs.get(msg.tabKey);
        if (tab && tab.ownerId !== me.id) relay(tab.ownerId, { type: 'control-request', from: me.id, tabKey: tab.key });
        break;
      }
      case 'control-response':
        relay(msg.to, { type: 'control-response', from: me.id, tabKey: msg.tabKey, allowed: !!msg.allowed });
        break;
      case 'invite': {
        const tab = room.tabs.get(msg.tabKey);
        if (!tab) break;
        if (room.pending) broadcastNow(room); // make sure everyone knows the tab before the invite lands
        for (const m of room.members.values()) {
          if (m.id !== me.id) sendTo(m.ws, { type: 'invite', from: me.id, tabKey: tab.key, tab });
        }
        break;
      }
      // ---- AI helpers working on someone else's shared tab (the owner's browser runs each step)
      case 'agent-rpc': {
        const tab = room.tabs.get(msg.tabKey);
        if (tab && tab.ownerId !== me.id) relay(tab.ownerId, { ...msg, from: me.id });
        else sendTo(ws, { type: 'agent-rpc-result', rpcId: msg.rpcId, ok: false, error: 'That tab is not shared anymore.' });
        break;
      }
      case 'agent-rpc-result':
        relay(msg.to, { ...msg, from: me.id });
        break;
      case 'agent-stop':
        relay(msg.to, { type: 'agent-stop', from: me.id, agentId: clean(msg.agentId, 64) });
        break;

      case 'leave':
        removeMember(room, me.id);
        room = me = null;
        break;
    }
  });

  ws.on('close', () => {
    if (!room || !me || me.ws !== ws) return;
    me.ws = null;
    scheduleBroadcast(room);
    const r = room;
    const id = me.id;
    me.leaveTimer = setTimeout(() => removeMember(r, id), GRACE_MS);
  });
}

function onRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const invite = url.pathname.match(/^\/r\/([A-Za-z0-9]{4,12})\/?$/);
  if (invite) {
    const code = invite[1].toUpperCase();
    const https = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    const wsUrl = `${https ? 'wss' : 'ws'}://${req.headers.host}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(invitePage(code, wsUrl, rooms.get(code)));
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  const secure = (req.headers['x-forwarded-proto'] || '').startsWith('https');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page('CoTab server', `${LOGO}<h1>CoTab server is running</h1>
    <div class="card"><p class="muted">${rooms.size} active room${rooms.size === 1 ? '' : 's'}. Extensions connect to
    <code>${esc(`${secure ? 'wss' : 'ws'}://${req.headers.host}`)}</code></p></div>`));
}

export function startServer({ port = PORT, quiet = false } = {}) {
  const server = http.createServer(onRequest);
  wss = new WebSocketServer({ server, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
  wss.on('connection', onConnection);

  // Drop sockets that silently died (laptop lid closed, Wi-Fi switch...).
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000).unref();

  return new Promise(resolve =>
    server.listen(port, () => {
      if (!quiet) {
        console.log(`\n  CoTab server is running\n`);
        console.log(`  This computer        ws://localhost:${port}`);
        for (const ip of lanAddresses()) console.log(`  Same Wi-Fi / network ws://${ip}:${port}`);
        console.log(`\n  Invite links point at your network address automatically.`);
        console.log(`  To invite people on other networks, run:  npm run online\n`);
      }
      resolve(server);
    }),
  );
}

// ---------------------------------------------------------------- pages

const LOGO = `<svg width="44" height="44" viewBox="0 0 128 128" aria-hidden="true"><defs>
<linearGradient id="f" x1="0" y1="0" x2=".35" y2="1"><stop offset="0" stop-color="#ff6ad5"/><stop offset=".55" stop-color="#ff3d7f"/><stop offset="1" stop-color="#ff5a36"/></linearGradient>
<linearGradient id="b" x1="0" y1="0" x2=".4" y2="1"><stop offset="0" stop-color="#5b8cff"/><stop offset="1" stop-color="#8a6bff"/></linearGradient>
<mask id="m"><rect width="128" height="128" fill="#fff"/><path d="M0 0 L0 64 L16 49 L27 74 L39 69 L28 44 L50 44 Z" transform="translate(50 37) scale(1.15)" stroke="#000" stroke-width="16" stroke-linejoin="round"/></mask></defs>
<g mask="url(#m)"><path d="M0 0 L0 64 L16 49 L27 74 L39 69 L28 44 L50 44 Z" transform="translate(20 6) scale(1.15)" fill="url(#b)" stroke="url(#b)" stroke-width="8" stroke-linejoin="round"/></g>
<path d="M0 0 L0 64 L16 49 L27 74 L39 69 L28 44 L50 44 Z" transform="translate(50 37) scale(1.15)" fill="url(#f)" stroke="url(#f)" stroke-width="8" stroke-linejoin="round"/></svg>`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;display:grid;place-items:center;padding:24px;color:#f2f2f2;
  font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;
  background:#121212 linear-gradient(in oklab 180deg,#15161b 0%,#1f2a52 22%,#3d62e6 40%,#9a86f2 56%,#f07dd6 70%,#ff4b98 84%,#ff3b5c 100%) no-repeat;
  background-size:100% 100%}
body::before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(120% 60% at 50% -5%,#141418 30%,transparent 72%)}
.wrap{position:relative;width:min(460px,100%);display:grid;gap:22px;justify-items:center;text-align:center}
h1{margin:0;font-size:34px;line-height:1.1;font-weight:650;letter-spacing:-.035em;text-wrap:balance}
.muted{color:#a3a3a3;margin:0}
.card{width:100%;padding:22px;border-radius:26px;background:#232323;border:1px solid rgba(255,255,255,.09);text-align:left;
  box-shadow:0 30px 80px -24px rgba(0,0,0,.6)}
.code{font:600 13px ui-monospace,"SF Mono",Consolas,monospace;letter-spacing:.14em;color:#a3a3a3}
label{display:block;font-size:13px;color:#a3a3a3;margin:14px 0 8px}
input{width:100%;height:46px;padding:0 14px;border-radius:12px;border:0;background:#2e2e2e;color:#f2f2f2;font:inherit;outline:none}
input:focus{box-shadow:0 0 0 2px #6c9cff}
button{margin-top:12px;width:100%;height:46px;border:0;border-radius:12px;background:#f2f2f2;color:#121212;font:inherit;font-weight:600;cursor:pointer;
  display:flex;align-items:center;justify-content:center;gap:8px;transition:background .15s}
button:hover{background:#fff}
button:disabled{opacity:.6;cursor:default}
ol{margin:4px 0 0;padding-left:20px;color:#cfcfcf}
li{margin:8px 0}
code{background:#2e2e2e;padding:2px 6px;border-radius:6px;font-size:13px;color:#e5e5e5}
.people{display:inline-flex;align-items:center;gap:8px;height:34px;padding:0 14px 0 6px;border-radius:999px;background:rgba(20,20,20,.75);font-size:13px;color:#e5e5e5}
.dot{width:22px;height:22px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:700;color:#fff;margin-left:-6px;box-shadow:0 0 0 2px #1a1a1a}
.dot:first-child{margin-left:0}
.has-ext,.joined{display:none}
html[data-cotab] .has-ext{display:block}
html[data-cotab] .needs-ext{display:none}
html[data-cotab="joined"] .has-ext{display:none}
html[data-cotab="joined"] .joined{display:block}
</style></head><body><div class="wrap">${body}</div></body></html>`;
}

function invitePage(code, wsUrl, room) {
  const members = room ? [...room.members.values()] : [];
  const host = members.sort((a, b) => a.joinedAt - b.joinedAt)[0];
  const online = members.filter(m => m.ws);
  const title = host ? `Join ${host.name}'s room` : 'Join a CoTab room';
  const people = online.length
    ? `<div class="people">${online.slice(0, 4).map(m => `<span class="dot" style="background:${esc(m.color)}">${esc(m.name[0] || '?')}</span>`).join('')}
       ${online.length} browsing now</div>`
    : '';
  return page(title, `
<meta name="cotab-invite" content="${esc(code)}">
<meta name="cotab-server" content="${esc(wsUrl)}">
${LOGO}
<h1>${esc(title)}</h1>
${people}
<div class="card">
  <div class="code">ROOM ${esc(code)}</div>
  <div class="has-ext">
    <label for="cotab-name">Your name</label>
    <input id="cotab-name" placeholder="How should people see you?" maxlength="40" autocomplete="off">
    <button id="cotab-join">Join room <span aria-hidden="true">→</span></button>
  </div>
  <div class="joined"><p class="muted" style="margin-top:12px">You're in. Opening the room…</p></div>
  <div class="needs-ext">
    <p class="muted" style="margin:12px 0 6px">You'll need the CoTab extension first:</p>
    <ol>
      <li>Open <code>chrome://extensions</code> and turn on <b>Developer mode</b></li>
      <li>Click <b>Load unpacked</b> and pick the <code>extension</code> folder</li>
      <li>Come back and reload this page</li>
    </ol>
  </div>
</div>`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) startServer();
