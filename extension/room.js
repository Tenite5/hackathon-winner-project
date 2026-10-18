import { connect, esc, icon, avatar, favicon, hostOf, copyText, toast, menu, logo, reachText } from './client.js';

const $ = sel => document.querySelector(sel);
const wall = $('#wall');
const stageHead = $('#stageHead');
const hero = $('#hero');
const audio = $('#audio');
const ROOM_URL = chrome.runtime.getURL('room.html');
const SHAREABLE = /^(https?|file):/;
const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

let S = null;                                  // state pushed by the service worker
let focusKey = null;
let pendingFocus = null;                       // focus request for a tab that hasn't arrived yet
let mode = localStorage.getItem('cotab-mode') === 'grid' ? 'grid' : 'focus';
let followId = null;
let audioOn = true;
let audioBlocked = false;
let lastWatching;
let known = null;                              // previous members/tabs, for "X joined" toasts
let headSig = '';
const requested = new Set();
const viewers = new Map();                     // tabKey -> Viewer
const viewChoice = new Map();                  // tabKey -> 'page' | 'video' picked by you
const htmlCache = {};
const serverToasts = new Map();
const sharingToasts = new Map();
const invitedAt = new Map();
const collapsed = new Set(JSON.parse(localStorage.getItem('cotab-collapsed') || '[]'));

const hashFocus = decodeURIComponent(location.hash.match(/focus=([^&]+)/)?.[1] || '');
if (hashFocus) pendingFocus = { key: hashFocus, until: Date.now() + 10000 };

// static chrome
$('#brand').innerHTML = `${logo(24)}<span>CoTab</span>`;
$('#navShare').innerHTML = `${icon('plus')}<span>Share a tab</span>`;
$('#navInvite').innerHTML = `${icon('userPlus')}<span>Invite people</span>`;
for (const head of document.querySelectorAll('.section-head')) {
  head.insertAdjacentHTML('beforeend', icon('chevronDown'));
  head.parentElement.classList.toggle('collapsed', collapsed.has(head.dataset.section));
  head.onclick = () => {
    const name = head.dataset.section;
    collapsed.has(name) ? collapsed.delete(name) : collapsed.add(name);
    head.parentElement.classList.toggle('collapsed', collapsed.has(name));
    localStorage.setItem('cotab-collapsed', JSON.stringify([...collapsed]));
  };
}
$('#modeSeg [data-mode=focus]').innerHTML = `${icon('square')} Focus`;
$('#modeSeg [data-mode=grid]').innerHTML = `${icon('grid')} All tabs`;
for (const b of document.querySelectorAll('#modeSeg button')) b.onclick = () => setMode(b.dataset.mode);
$('#navAi').innerHTML = `${icon('sparkles')}<span>AI helpers</span>`;
$('#menuBtn').innerHTML = icon('menu');
$('#navShare').onclick = () => (closeDrawer(), openPicker());
$('#navInvite').onclick = () => (closeDrawer(), copyInvite());
$('#navAi').onclick = () => (closeDrawer(), openAiPanel());
$('#menuBtn').onclick = () => $('#app').classList.toggle('side-open');
$('#sideScrim').onclick = () => closeDrawer();

// On narrow windows the sidebar is a drawer.
function closeDrawer() {
  $('#app').classList.remove('side-open');
}

// AI helpers live in Chrome's side panel next to this page.
let myWindowId = null;
chrome.windows.getCurrent().then(w => (myWindowId = w.id));
function openAiPanel(pending) {
  if (myWindowId != null) chrome.sidePanel.open({ windowId: myWindowId }).catch(() => {});
  if (pending) chrome.storage.session.set({ aiTarget: { ...pending, at: Date.now() } });
}
$('#presence').onclick = copyInvite;
$('#promo').onclick = copyInvite;

const client = connect('room', onMessage);

function onMessage(msg) {
  switch (msg.type) {
    case 'state':
      S = msg.state;
      render();
      break;
    case 'mirror':
      viewers.get(msg.tabKey)?.mirrorBatch(msg);
      break;
    case 'mirror-init':
      viewers.get(msg.tabKey)?.mirrorInit(msg);
      break;
    case 'cursor':
      viewers.get(msg.tabKey)?.remoteCursor(msg);
      break;
    case 'signal':
      for (const v of viewers.values()) if (v.rtc.pcId === msg.data?.pcId) v.onSignal(msg.data);
      break;
    case 'focus':
      followId = null;
      setMode('focus');
      setFocus(msg.key, true);
      break;
    case 'toast': {
      const t = msg.toast;
      serverToasts.set(t.id, toast(t, actionId => client.call('toastAction', t.id, actionId)));
      if (t.tabKey) {
        // an invite supersedes the generic "started sharing" note for the same tab
        invitedAt.set(t.tabKey, Date.now());
        sharingToasts.get(t.tabKey)?.close();
      }
      break;
    }
    case 'toast-close':
      serverToasts.get(msg.id)?.close();
      serverToasts.delete(msg.id);
      break;
    case 'control-response':
      onControlResponse(msg);
      break;
  }
}

const member = id => S?.room?.members.find(m => m.id === id);
const firstName = name => String(name || '').split(' ')[0];
const remoteTabs = () =>
  (S?.room?.tabs || []).filter(t => t.ownerId !== S.me.id).sort((a, b) => a.sharedAt - b.sharedAt);

function setHtml(el, key, html) {
  if (htmlCache[key] === html) return false;
  htmlCache[key] = html;
  el.innerHTML = html;
  return true;
}

async function copyInvite() {
  if (!S?.inviteLink) return;
  await copyText(S.inviteLink);
  const reach = reachText(S.reach);
  toast({ title: 'Invite link copied', body: `${reach.long}`, timeout: 4500 });
}

// ------------------------------------------------------------------ render

function render() {
  renderGate();
  if (!S.room) {
    for (const v of viewers.values()) v.destroy();
    viewers.clear();
    known = null;
    focusKey = null;
    renderStageHead();
    layout();
    return;
  }
  syncViewers();
  notifyChanges();
  applyFollow();
  ensureFocus();
  renderSidebar();
  renderTopbar();
  renderStageHead();
  renderHero();
  layout();
  updateQualities();
  refreshAudio();
  reportWatching();
}

function renderGate() {
  const gate = $('#gate');
  $('#app').classList.toggle('blurred', !S.room);
  if (S.room) {
    gate.hidden = true;
    gate.classList.remove('aurora');
    return;
  }
  gate.hidden = false;
  gate.classList.add('aurora');
  const connecting = S.roomCode && S.status !== 'idle';
  const html = connecting
    ? `${logo(44)}<h1>Getting you back into<br>room ${esc(S.roomCode)}…</h1><div class="spinner"></div>`
    : `${logo(44)}<h1>Browse together</h1>
      <div class="prompt">
        <form class="prompt-form" id="gJoin"><input id="gCode" placeholder="Paste an invite link or room code" autocomplete="off" spellcheck="false"></form>
        <div class="prompt-bar"><span class="grow"></span><button class="send" id="gSend" title="Join" disabled>${icon('arrowRight')}</button></div>
        <div class="prompt-sep"></div>
        <div class="prompt-list"><button class="row arrow-row" id="gCreate">${icon('arrowRight')}<span>Start a new room</span></button></div>
      </div>
      <div class="err" id="gErr" hidden></div>`;
  if (!setHtml(gate, 'gate', html) || connecting) return;
  const fail = e => {
    $('#gErr').hidden = false;
    $('#gErr').textContent = e.message;
  };
  $('#gCreate').onclick = () => client.call('createRoom').catch(fail);
  $('#gCode').oninput = () => ($('#gSend').disabled = !$('#gCode').value.trim());
  const join = e => {
    e?.preventDefault();
    client.call('joinRoom', $('#gCode').value).catch(fail);
  };
  $('#gJoin').onsubmit = join;
  $('#gSend').onclick = join;
}

function renderSidebar() {
  const { room, me } = S;
  const reach = reachText(S.reach);
  if (setHtml($('#roomSwitch'), 'switch', `${avatar({ name: room.code, color: '#3d62ea' }, { square: true, title: false })}<span class="grow ellipsis">Room <span class="mono">${esc(room.code)}</span></span>${icon('chevronDown').replace('<svg', '<svg class="chev"')}`)) {
    $('#roomSwitch').onclick = e => openRoomMenu(e.currentTarget);
  }

  // AI helpers anyone in the room is running, by the shared tab they work on
  const helpers = room.members.flatMap(m => (m.online ? (m.agents || []).map(a => ({ ...a, by: m })) : []));
  const helpersOn = key => helpers.filter(a => a.tabKey === key);

  // live tabs: other people's first, then yours
  const tabs = [...remoteTabs(), ...room.tabs.filter(t => t.ownerId === me.id)];
  const tabsHtml = tabs.length
    ? tabs
        .map(t => {
          const mine = t.ownerId === me.id;
          const owner = member(t.ownerId);
          const watchers = room.members.filter(m => m.id !== me.id && m.online && m.watching === t.key).length;
          const ai = helpersOn(t.key);
          const aiNote = ai.length ? ` · ✦ ${esc(ai.map(a => a.name).join(', '))} working` : '';
          const sub = mine
            ? `You${t.interactive ? ' · control on' : ''}${watchers ? ` · ${watchers} watching` : ''}${aiNote}`
            : `${esc(owner?.name || 'Someone')}${t.loading ? ' · loading' : ''}${aiNote}`;
          const active = !mine && mode === 'focus' && t.key === focusKey;
          return `<div class="row item ${active ? 'active' : ''}" data-key="${esc(t.key)}" data-mine="${mine ? t.tabId : ''}" tabindex="0" title="${mine ? 'Go to this tab' : 'Watch this tab'}">
            ${favicon(t.favIconUrl, t.title)}
            <span class="grow"><span class="t ellipsis">${esc(t.title)}</span><span class="sub ellipsis">${sub}</span></span>
            ${mine
              ? `<span class="tools">
                   <button class="icon-btn ${t.interactive ? 'on' : ''}" data-ctl="${t.tabId}" data-on="${t.interactive ? 1 : 0}" title="${t.interactive ? 'Stop letting others control' : 'Let others control this tab'}">${icon('pointer')}</button>
                   <button class="icon-btn" data-invite="${t.tabId}" title="Ask everyone to look">${icon('megaphone')}</button>
                   <button class="icon-btn" data-stop="${t.tabId}" title="Stop sharing">${icon('x')}</button>
                 </span><span class="live-dot when-idle"></span>`
              : avatar(owner, { size: 'sm' })}
          </div>`;
        })
        .join('')
    : `<div class="side-empty">Nothing shared yet. Hit <b>Share a tab</b> to show the room what you're looking at.</div>`;
  if (setHtml($('#tabsList'), 'tabs', tabsHtml)) {
    for (const el of document.querySelectorAll('#tabsList .item')) {
      el.onclick = e => {
        if (e.target.closest('.tools')) return;
        closeDrawer();
        if (el.dataset.mine) client.call('focusTab', Number(el.dataset.mine));
        else {
          followId = null;
          setMode('focus');
          setFocus(el.dataset.key, true);
        }
      };
    }
    for (const b of document.querySelectorAll('[data-ctl]')) b.onclick = () => client.call('setInteractive', Number(b.dataset.ctl), b.dataset.on !== '1');
    for (const b of document.querySelectorAll('[data-stop]')) b.onclick = () => client.call('unshareTab', Number(b.dataset.stop));
    for (const b of document.querySelectorAll('[data-invite]')) {
      b.onclick = async () => {
        await client.call('inviteHere', Number(b.dataset.invite));
        toast({ title: 'Everyone got a nudge', body: 'They can jump in and watch your tab.', timeout: 3000 });
      };
    }
  }

  // people
  const people = [...room.members].sort((a, b) => (b.id === me.id) - (a.id === me.id) || a.joinedAt - b.joinedAt);
  const peopleHtml = people
    .map(m => {
      const isMe = m.id === me.id;
      const active = room.tabs.find(t => t.key === m.activeTabKey);
      const watching = room.tabs.find(t => t.key === m.watching);
      let status;
      if (!m.online) status = 'Reconnecting…';
      else if (active) status = `On “${esc(active.title)}”`;
      else if (watching) status = `Watching ${watching.ownerId === me.id ? 'your' : `${esc(firstName(member(watching.ownerId)?.name))}'s`} tab`;
      else status = 'Browsing privately';
      const canFollow = !isMe && room.tabs.some(t => t.ownerId === m.id);
      const theirHelpers = m.online ? m.agents || [] : [];
      return `<div class="row person">
        ${avatar(m, { presence: true })}
        <span class="grow"><span class="t ellipsis" style="display:block">${esc(m.name)}${isMe ? ' <span class="faint">(you)</span>' : ''}</span><span class="sub ellipsis">${status}</span></span>
        ${canFollow ? `<button class="btn sm ghost follow ${followId === m.id ? 'on' : ''}" data-follow="${esc(m.id)}" title="Jump to whichever shared tab ${esc(m.name)} is on">${followId === m.id ? 'Following' : 'Follow'}</button>` : ''}
      </div>${theirHelpers.map(a => {
        const tab = a.tabKey && room.tabs.find(t => t.key === a.tabKey);
        const what = tab ? `On “${esc(tab.title)}”${a.step ? ` · ${esc(a.step)}` : ''}` : 'Working in a private tab';
        return `<div class="row person helper" ${tab ? `data-helper-tab="${esc(tab.key)}"` : ''} title="${esc(a.task || '')}">
          <span class="avatar sm helper-av" style="--c:${esc(a.color)}">${icon('sparkles')}</span>
          <span class="grow"><span class="t ellipsis" style="display:block">${esc(a.name)} <span class="faint">· ${isMe ? 'your' : `${esc(firstName(m.name))}'s`} AI</span></span><span class="sub ellipsis">${what}</span></span>
        </div>`;
      }).join('')}`;
    })
    .join('');
  if (setHtml($('#peopleList'), 'people', peopleHtml)) {
    for (const b of document.querySelectorAll('[data-follow]')) b.onclick = () => toggleFollow(b.dataset.follow);
    for (const r of document.querySelectorAll('[data-helper-tab]')) {
      r.onclick = () => {
        const key = r.dataset.helperTab;
        if (!viewers.has(key)) return; // it's one of your own tabs
        closeDrawer();
        setMode('focus');
        setFocus(key, true);
      };
    }
  }

  setHtml($('#promo'), 'promo', `<span class="grow"><b>Invite people</b><span class="sub">${icon(reach.icon)}${reach.short}</span></span><span class="art aurora">${icon('userPlus')}</span>`);

  if (document.activeElement?.id !== 'meName') {
    const meHtml = `${avatar(me)}<input class="name-input" id="meName" value="${esc(me.name)}" maxlength="40" title="Rename yourself" spellcheck="false">`;
    if (setHtml($('#meBox'), 'me', meHtml)) {
      const input = $('#meName');
      input.onchange = () => client.call('setName', input.value);
      input.onkeydown = e => e.key === 'Enter' && input.blur();
    }
  }
}

function openRoomMenu(anchor) {
  const reach = reachText(S.reach);
  menu(anchor, [
    { label: 'Copy invite link', icon: 'link', onClick: copyInvite },
    { label: 'Copy room code', icon: 'copy', onClick: () => copyText(S.room.code) },
    { note: esc(reach.long) },
    'sep',
    { label: 'Leave room', icon: 'logout', danger: true, onClick: () => client.call('leaveRoom') },
  ]);
}

function renderTopbar() {
  const online = S.room.members.filter(m => m.online);
  setHtml(
    $('#presence'),
    'presence',
    `<span class="faces">${online.slice(0, 4).map(m => avatar(m, { title: true })).join('')}</span>
     <span>${online.length === 1 ? 'Just you' : `${online.length} here`}</span><span class="divider"></span>
     <span>Invite</span>${icon('arrowRight')}`,
  );
  const ok = S.status === 'connected';
  setHtml($('#conn'), 'conn', ok ? '' : '<span class="status-dot warn"></span>Reconnecting…');
  const n = viewers.size;
  for (const b of document.querySelectorAll('#modeSeg button')) {
    b.classList.toggle('on', b.dataset.mode === mode);
    b.disabled = n < 2 && b.dataset.mode === 'grid' && mode !== 'grid';
  }
}

function renderHero() {
  const show = viewers.size === 0;
  hero.hidden = !show;
  if (!show) return;
  const mine = S.room.tabs.filter(t => t.ownerId === S.me.id);
  const others = S.room.members.filter(m => m.online && m.id !== S.me.id);
  const title = mine.length
    ? `You're live, ${esc(firstName(S.me.name))}`
    : `What are we browsing, ${esc(firstName(S.me.name))}?`;
  const lead = mine.length
    ? `<p class="lead">${others.length ? 'Everyone in the room can watch your tab right now.' : 'Invite someone and they can watch your tab instantly.'}</p>`
    : others.length
      ? `<p class="lead">${esc(others.map(m => firstName(m.name)).join(', '))} ${others.length === 1 ? 'is' : 'are'} here. Share something to get started.</p>`
      : '';
  const html = `<h1>${title}</h1>${lead}
    <div class="prompt">
      <form class="prompt-form" id="openForm"><input id="openInput" placeholder="Open a website for everyone… (e.g. github.com)" autocomplete="off" spellcheck="false"></form>
      <div class="prompt-bar">
        <button class="btn sm ghost" id="heroShare">${icon('plus')} Share a tab you have open</button>
        <span class="grow"></span>
        <button class="send" id="openSend" title="Open and share" disabled>${icon('arrowUp')}</button>
      </div>
      <div class="prompt-sep"></div>
      <div class="prompt-list">
        <button class="row arrow-row" id="heroInvite">${icon('arrowRight')}<span>Invite people to this room</span></button>
        <button class="row arrow-row" data-url="https://en.wikipedia.org/wiki/Special:Random">${icon('arrowRight')}<span>Explore a random Wikipedia article together</span></button>
        <button class="row arrow-row" data-url="https://news.ycombinator.com">${icon('arrowRight')}<span>Browse Hacker News together</span></button>
        <button class="row arrow-row" data-url="https://github.com/trending">${icon('arrowRight')}<span>See what's trending on GitHub</span></button>
      </div>
    </div>
    <div class="private-note">${icon('lock')} Tabs you don't share stay private</div>`;
  if (!setHtml(hero, 'hero', html)) return;
  const openShare = async url => {
    try {
      await client.call('openAndShare', url);
    } catch (e) {
      toast({ title: "Couldn't open that", body: e.message });
    }
  };
  $('#openInput').oninput = () => ($('#openSend').disabled = !$('#openInput').value.trim());
  $('#openForm').onsubmit = e => {
    e.preventDefault();
    const v = $('#openInput').value.trim();
    if (v) openShare(v);
  };
  $('#openSend').onclick = () => $('#openForm').requestSubmit();
  $('#heroShare').onclick = openPicker;
  $('#heroInvite').onclick = copyInvite;
  for (const b of hero.querySelectorAll('[data-url]')) b.onclick = () => openShare(b.dataset.url);
}

function notifyChanges() {
  const { room, me } = S;
  const now = { members: new Map(room.members.map(m => [m.id, m])), tabs: new Map(room.tabs.map(t => [t.key, t])) };
  if (known) {
    for (const [id, m] of now.members) {
      if (!known.members.has(id) && id !== me.id) toast({ title: `${m.name} joined`, color: m.color, initial: m.name[0], timeout: 3500 });
    }
    for (const [id, m] of known.members) {
      if (!now.members.has(id) && id !== me.id) toast({ title: `${m.name} left`, color: m.color, initial: m.name[0], timeout: 3000 });
    }
    for (const [key, t] of now.tabs) {
      if (t.ownerId === me.id) continue;
      const prev = known.tabs.get(key);
      const o = member(t.ownerId);
      const who = { color: o?.color, initial: o?.name?.[0] };
      if (!prev && viewers.size > 1 && !(Date.now() - (invitedAt.get(key) || 0) < 5000)) {
        const handle = toast(
          { title: `${o?.name || 'Someone'} is sharing a tab`, body: t.title, favicon: t.favIconUrl, ...who, timeout: 6000, actions: [{ id: 'watch', label: 'Watch', primary: true }] },
          a => a === 'watch' && (setMode('focus'), setFocus(key, true)),
        );
        sharingToasts.set(key, handle);
        setTimeout(() => sharingToasts.get(key) === handle && sharingToasts.delete(key), 7000);
      } else if (prev && prev.interactive !== t.interactive) {
        toast({
          title: t.interactive ? `${o?.name} handed over control` : `${o?.name} took control back`,
          body: t.interactive ? `You can click, type and scroll in “${t.title}”.` : t.title,
          ...who,
          timeout: 4500,
        });
      }
    }
  }
  known = now;
}

// ------------------------------------------------------------------ focus, follow, modes

function ensureFocus() {
  if (pendingFocus) {
    if (viewers.has(pendingFocus.key)) {
      focusKey = pendingFocus.key;
      pendingFocus = null;
    } else if (Date.now() > pendingFocus.until) {
      pendingFocus = null;
    }
  }
  if (!viewers.has(focusKey)) focusKey = remoteTabs()[0]?.key || null;
}

function setFocus(key, byUser) {
  if (!viewers.has(key)) {
    pendingFocus = { key, until: Date.now() + 8000 };
    return;
  }
  if (byUser && followId && member(followId)?.activeTabKey !== key) followId = null;
  focusKey = key;
  history.replaceState(null, '', `#focus=${encodeURIComponent(key)}`);
  afterViewChange();
}

function setMode(next) {
  if (mode === next) return;
  mode = next;
  localStorage.setItem('cotab-mode', mode);
  afterViewChange();
}

function afterViewChange() {
  if (S?.room) {
    renderTopbar();
    renderSidebar();
  }
  renderStageHead();
  layout();
  updateQualities();
  refreshAudio();
  reportWatching();
}

function toggleFollow(id) {
  followId = followId === id ? null : id;
  if (followId) {
    const m = member(followId);
    toast({ title: `Following ${m?.name}`, body: "You'll jump to whichever shared tab they're on.", color: m?.color, initial: m?.name?.[0], timeout: 3500 });
    mode = 'focus';
    localStorage.setItem('cotab-mode', mode);
  }
  render();
}

function applyFollow() {
  if (!followId) return;
  const m = member(followId);
  if (!m) {
    followId = null;
    return;
  }
  if (m.activeTabKey && viewers.has(m.activeTabKey)) {
    focusKey = m.activeTabKey;
    mode = 'focus';
  }
}

// ------------------------------------------------------------------ stage head (above the focused tab)

function renderStageHead() {
  const n = viewers.size;
  if (!S?.room || !n) {
    stageHead.hidden = true;
    headSig = '';
    return;
  }
  stageHead.hidden = false;
  if (mode === 'grid') {
    const sig = `grid:${n}`;
    if (sig !== headSig) {
      headSig = sig;
      stageHead.innerHTML = `<div class="sh-info"><div><div class="sh-title">All shared tabs</div>
        <div class="sh-sub">${n} live · click one to focus it, or press <kbd>1</kbd>–<kbd>9</kbd></div></div></div>`;
    }
    return;
  }
  const v = viewers.get(focusKey);
  if (!v) return;
  const t = v.tab;
  const owner = member(t.ownerId);
  const following = followId && member(followId);
  const req = requested.has(t.key);
  const sig = JSON.stringify([t.key, t.title, t.url, t.favIconUrl, t.interactive, t.mirror, t.video, t.loading, v.mode, owner?.name, owner?.color, req, audioOn, audioBlocked, followId]);
  if (sig === headSig || document.activeElement?.id === 'address') return; // don't clobber what they're typing
  headSig = sig;

  const modeSeg = t.mirror && t.video
    ? `<div class="seg small" id="viewSeg">
        <button data-view="page" class="${v.mode === 'page' ? 'on' : ''}" title="The real page: sharp and instant">${icon('page')} Page</button>
        <button data-view="video" class="${v.mode === 'video' ? 'on' : ''}" title="A video feed with sound: best for videos, games and canvas apps">${icon('video')} Video</button>
      </div>`
    : '';
  const nav = t.interactive
    ? `<div class="glass">
        <button class="icon-btn" data-nav="back" title="Back">${icon('back')}</button>
        <button class="icon-btn" data-nav="forward" title="Forward">${icon('forward')}</button>
        <button class="icon-btn" data-nav="reload" title="Reload">${icon('reload')}</button>
        <form class="address" id="addressForm">${icon(/^https:/.test(t.url) ? 'lock' : 'globe')}<input id="address" value="${esc(t.url)}" spellcheck="false" autocomplete="off"></form>
      </div>`
    : '';
  const controlHtml = t.interactive
    ? `<span class="in-control">${icon('pointer')} You can control</span>
       <button class="btn sm" id="askAi" title="Let an AI helper do something on this tab">${icon('sparkles')} Ask AI</button>`
    : `<button class="btn sm primary" id="askCtl" ${req ? 'disabled' : ''}>${icon('hand')} ${req ? 'Asked…' : 'Ask to control'}</button>`;
  const media = v.mode === 'video'
    ? `<button class="icon-btn" id="mute" title="${audioBlocked ? 'Click to hear this tab' : audioOn ? 'Mute' : 'Unmute'}">${icon(audioOn && !audioBlocked ? 'volume' : 'mute')}</button>
       <button class="icon-btn" id="pip" title="Pop out and keep watching while you browse">${icon('pip')}</button>`
    : '';

  stageHead.innerHTML = `
    <div class="sh-info">${favicon(t.favIconUrl, t.title)}
      <div class="grow">
        <div class="sh-title ellipsis">${esc(t.title)}</div>
        <div class="sh-sub">${avatar(owner, { size: 'xs' })}<span class="ellipsis">${esc(firstName(owner?.name) || 'Someone')}'s tab · ${esc(hostOf(t.url))}</span>
          ${t.loading ? '<span class="spinner sm"></span>' : ''}
          ${following ? `<span class="follow-chip">${icon('navigation')} Following<button id="unfollow" title="Stop following">${icon('x')}</button></span>` : ''}</div>
      </div>
    </div>
    <div class="sh-actions">${modeSeg}${nav}${controlHtml}
      <div class="glass">${media}
        <button class="icon-btn" id="openCopy" title="Open this page in my own tab">${icon('external')}</button>
        <button class="icon-btn" id="fs" title="Fullscreen (F)">${icon('maximize')}</button>
      </div>
    </div>`;

  for (const b of stageHead.querySelectorAll('[data-view]')) {
    b.onclick = () => {
      viewChoice.set(v.key, b.dataset.view);
      v.setMode(v.wantedMode());
      headSig = '';
      renderStageHead();
    };
  }
  for (const b of stageHead.querySelectorAll('[data-nav]')) b.onclick = () => control(v, { type: 'nav', action: b.dataset.nav });
  const addr = $('#addressForm');
  if (addr) {
    addr.onsubmit = e => {
      e.preventDefault();
      let url = $('#address').value.trim();
      if (!/^https?:\/\//i.test(url)) url = /^[^\s]+\.[^\s]{2,}$/.test(url) ? `https://${url}` : `https://www.google.com/search?q=${encodeURIComponent(url)}`;
      control(v, { type: 'nav', action: 'url', url });
      $('#address').blur();
    };
    $('#address').onfocus = e => e.target.select();
  }
  $('#askCtl') && ($('#askCtl').onclick = () => requestControl(t.key));
  $('#askAi') && ($('#askAi').onclick = () => openAiPanel({ kind: 'remote', tabKey: t.key }));
  $('#unfollow') && ($('#unfollow').onclick = () => toggleFollow(followId));
  $('#mute') && ($('#mute').onclick = () => {
    audioOn = audioBlocked ? true : !audioOn;
    audioBlocked = false;
    audio.muted = !audioOn;
    if (audioOn) audio.play().catch(() => (audioBlocked = true));
    headSig = '';
    renderStageHead();
  });
  $('#pip') && ($('#pip').onclick = () => v.video.requestPictureInPicture?.().catch(() => toast({ title: 'Pop-out needs the video to be playing first' })));
  $('#openCopy').onclick = () => client.call('openUrl', t.url);
  $('#fs').onclick = () => v.el.requestFullscreen?.();
}

let nudgeAt = 0;
function nudgeAsk() {
  const b = $('#askCtl');
  if (b) {
    b.classList.remove('nudge');
    void b.offsetWidth;
    b.classList.add('nudge');
  }
  if (Date.now() - nudgeAt > 5000) {
    nudgeAt = Date.now();
    toast({ title: "You're watching", body: 'Ask to control if you want to click, type or scroll in this tab.', timeout: 3500 });
  }
}

async function requestControl(key) {
  requested.add(key);
  headSig = '';
  renderStageHead();
  await client.call('requestControl', key).catch(() => {});
  setTimeout(() => {
    requested.delete(key);
    headSig = '';
    renderStageHead();
  }, 20000);
}

function onControlResponse({ from, tabKey, allowed }) {
  requested.delete(tabKey);
  headSig = '';
  renderStageHead();
  if (!allowed) {
    const o = member(from);
    toast({ title: `${o?.name || 'The owner'} said not now`, body: 'You can keep watching the tab live.', color: o?.color, initial: o?.name?.[0], timeout: 4000 });
  }
}

// ------------------------------------------------------------------ live tab viewer

async function gunzip(b64) {
  const res = await fetch(`data:application/octet-stream;base64,${b64}`);
  return new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
}

function cursorOf(el) {
  if (!el?.ownerDocument?.defaultView) return '';
  const c = el.ownerDocument.defaultView.getComputedStyle(el).cursor;
  if (c && c !== 'auto') return c;
  if (el.closest('a[href],button,[role=button],label,summary,select,[onclick]')) return 'pointer';
  if (el.closest('input,textarea,[contenteditable=""],[contenteditable=true]')) return 'text';
  return 'default';
}

const CURSOR_SVG = c =>
  `<svg width="20" height="22" viewBox="0 0 20 22"><path d="M2.5 2 2.5 17.6 6.6 13.8 9.4 20 12.2 18.8 9.5 12.7 15.3 12.4Z" fill="${esc(c)}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

class Viewer {
  constructor(tab) {
    this.tab = tab;
    this.key = tab.key;
    this.owner = tab.ownerId;
    this.mode = null;
    this.placed = false;
    this.dead = false;
    this.subscribed = false;
    this.sawMedia = false;
    this.el = document.createElement('div');
    this.el.className = 'tile waiting';
    this.el.innerHTML = `
      <div class="screen">
        <div class="mirror"></div>
        <video autoplay playsinline muted></video>
        <div class="cursors"></div>
        <div class="hit" tabindex="0"></div>
      </div>
      <div class="cap"></div>
      <div class="status"><div class="spinner"></div><span class="status-text"></span></div>
      <div class="float loading-chip"><span class="spinner sm"></span><span class="loading-text">Loading page…</span></div>
      <div class="float kbd-hint">${icon('keyboard')} Your typing goes to this tab · click outside to stop</div>`;
    this.screen = this.el.querySelector('.screen');
    this.mirrorEl = this.el.querySelector('.mirror');
    this.video = this.el.querySelector('video');
    this.cursorLayer = this.el.querySelector('.cursors');
    this.hit = this.el.querySelector('.hit');
    // live page mirror
    this.m = { replayer: null, session: null, next: 0, ready: false, pending: [], vp: null, scale: 1, chain: Promise.resolve(), resubAt: 0, resubTimer: 0, hoverEl: null };
    // video feed
    this.rtc = { pc: null, pcId: null, stream: null, quality: null, retry: 0, pendingIce: [] };
    this.cursors = new Map();
    this.video.addEventListener('playing', () => this.refreshStatus());
    this.video.addEventListener('resize', () => layout());
    this.video.addEventListener('enterpictureinpicture', () => (updateQualities(), reportWatching()));
    this.video.addEventListener('leavepictureinpicture', () => (updateQualities(), reportWatching()));
    wall.appendChild(this.el);
    // Fullscreen (and anything else that resizes the tile outside our layout) rescales the page copy.
    new ResizeObserver(() => this.fit()).observe(this.el);
    bindTile(this);
    this.update(tab);
  }

  update(tab) {
    this.tab = tab;
    const owner = member(tab.ownerId);
    this.el.classList.toggle('interactive', !!tab.interactive);
    this.el.classList.toggle('page-loading', !!tab.loading);
    setHtml(this.el.querySelector('.cap'), `cap:${this.key}`, `${favicon(tab.favIconUrl, tab.title)}<span class="ellipsis">${esc(tab.title)}</span>${avatar(owner, { size: 'xs' })}`);
    if (tab.mirror && !this.subscribed) {
      this.subscribed = true;
      client.post({ type: 'mirror-sub', tabKey: this.key });
    } else if (!tab.mirror && this.subscribed) {
      this.subscribed = false;
      client.post({ type: 'mirror-unsub', tabKey: this.key });
    }
    if (tab.media && tab.video) this.sawMedia = true; // a video started playing: the video feed shows it best
    this.setMode(this.wantedMode());
    this.refreshStatus();
  }

  wantedMode() {
    const t = this.tab;
    const choice = viewChoice.get(this.key);
    if (choice === 'video' && t.video) return 'video';
    if (choice === 'page' && t.mirror) return 'page';
    if (!t.mirror) return 'video';
    return t.video && this.sawMedia ? 'video' : 'page';
  }

  setMode(next) {
    if (this.mode === next) return;
    this.mode = next;
    this.el.dataset.mode = next;
    if (next === 'video') this.connectVideo();
    else this.stopVideo();
    this.clearHover();
    this.refreshStatus();
    layout();
  }

  refreshStatus() {
    const owner = firstName(member(this.owner)?.name) || 'their';
    let waiting = false;
    let text = '';
    if (this.mode === 'page' && !this.m.ready) {
      waiting = true;
      text = `Loading ${owner}'s tab…`;
    } else if (this.mode === 'video' && !(this.video.videoWidth > 0)) {
      waiting = true;
      text = `Connecting to ${owner}'s video…`;
    }
    this.el.classList.toggle('waiting', waiting);
    this.el.querySelector('.status-text').textContent = text;
  }

  // ---- live page mirror (rrweb replay of the owner's real DOM)

  mirrorInit(msg) {
    this.m.chain = this.m.chain.then(() => this.applyInit(msg)).catch(e => console.warn('[CoTab] mirror init', e));
  }

  mirrorBatch(msg) {
    this.m.chain = this.m.chain.then(() => this.applyLive(msg)).catch(e => console.warn('[CoTab] mirror batch', e));
  }

  async applyInit(msg) {
    const m = this.m;
    if (!msg.session || !msg.batches?.length) return; // the page hasn't started streaming yet: its first batch will set us up
    this.resetReplayer(msg.session);
    for (const b of msg.batches) await this.applyBatch(b);
    const last = msg.batches[msg.batches.length - 1];
    m.next = last.seq0 + last.n;
    m.ready = true;
    const pending = m.pending.splice(0);
    for (const b of pending) await this.applyLive(b);
    this.refreshStatus();
  }

  async applyLive(b) {
    const m = this.m;
    if (b.reset && !(m.ready && b.session === m.session && b.seq0 === m.next)) {
      // a full snapshot (new page, or a fresh copy we asked for): start over from it
      this.resetReplayer(b.session);
      await this.applyBatch(b);
      m.next = b.seq0 + b.n;
      m.ready = true;
      m.pending = [];
      this.refreshStatus();
      return;
    }
    if (!m.ready) {
      if (m.pending.length < 500) m.pending.push(b);
      return;
    }
    if (b.session !== m.session || b.seq0 > m.next) return this.resync(); // missed something
    if (b.seq0 + b.n <= m.next) return; // already have it
    await this.applyBatch(b);
    m.next = b.seq0 + b.n;
  }

  resync() {
    const m = this.m;
    m.ready = false;
    m.pending = [];
    clearTimeout(m.resubTimer);
    m.resubTimer = setTimeout(() => {
      m.resubAt = Date.now();
      client.post({ type: 'mirror-sub', tabKey: this.key });
    }, Math.max(0, 2500 - (Date.now() - m.resubAt)));
  }

  async applyBatch(b) {
    const events = JSON.parse(b.z ? await gunzip(b.z) : b.p);
    const r = this.m.replayer;
    for (const e of events) r.addEvent(e);
    // live mode remembers every event; we only ever need the current page
    const list = r.service?.state?.context?.events;
    if (list && list.length > 400) list.splice(0, list.length - 100);
  }

  resetReplayer(session) {
    const m = this.m;
    try { m.replayer?.destroy(); } catch {}
    this.mirrorEl.innerHTML = '';
    const r = new window.rrwebReplay.Replayer([], {
      root: this.mirrorEl,
      liveMode: true,
      mouseTail: false,
      showWarning: false,
      showDebug: false,
      triggerFocus: false,
      pauseAnimation: false,
      useVirtualDom: false, // we apply changes one by one as they arrive, so write straight to the DOM
    });
    r.on('resize', d => {
      m.vp = { w: d.width, h: d.height };
      this.fit();
      layout();
    });
    r.on('custom-event', e => {
      if (e.data?.tag !== 'cotab-scrollbar') return;
      m.scrollbar = Number(e.data.payload?.w) || 0;
      this.applyScrollbar();
    });
    r.on('fullsnapshot-rebuilded', () => this.applyScrollbar());
    r.startLive(Number.MAX_SAFE_INTEGER); // apply every change the moment it arrives, no playback delay
    m.replayer = r;
    m.session = session;
    m.next = 0;
    m.ready = false;
    m.hoverEl = null;
  }

  // Give the copy the owner's scrollbar so it lays out exactly as wide as the real page.
  applyScrollbar() {
    const r = this.m.replayer;
    const doc = r?.iframe?.contentDocument;
    if (!doc?.documentElement) return;
    r.iframe.setAttribute('scrolling', 'auto');
    let style = doc.getElementById('cotab-scrollbar');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'cotab-scrollbar';
    }
    // first in <head>, so a page that styles its own scrollbars still wins (as it does for the owner)
    const head = doc.head || doc.documentElement;
    if (head.firstChild !== style) head.insertBefore(style, head.firstChild);
    const w = this.m.scrollbar ?? 0;
    style.textContent = w
      ? `::-webkit-scrollbar{width:${w}px;height:${w}px;background:#f1f1f1}::-webkit-scrollbar-thumb{background:#c1c1c1;border-radius:${w}px;border:${Math.round(w / 4)}px solid transparent;background-clip:padding-box}::-webkit-scrollbar-corner{background:#f1f1f1}`
      : '::-webkit-scrollbar{width:0;height:0}';
  }

  // Scale the copy to fit the tile (or the whole screen in fullscreen), centered.
  fit() {
    const vp = this.m.vp;
    if (!vp) return;
    const full = document.fullscreenElement === this.el;
    const W = (!full && parseFloat(this.el.style.width)) || this.el.clientWidth;
    const H = (!full && parseFloat(this.el.style.height)) || this.el.clientHeight;
    const s = Math.min(W / vp.w, H / vp.h);
    this.m.scale = s;
    this.mirrorEl.style.width = `${vp.w}px`;
    this.mirrorEl.style.height = `${vp.h}px`;
    this.mirrorEl.style.transform = `translate(${(W - vp.w * s) / 2}px, ${(H - vp.h * s) / 2}px) scale(${s})`;
  }

  // Which element of the real page is under the pointer. Measured from where the copy actually
  // is on screen, so it stays exact mid-animation and in fullscreen.
  mirrorTarget(e) {
    const m = this.m;
    const doc = m.replayer?.iframe?.contentDocument;
    if (!doc || !m.vp || !m.ready) return null;
    const r = this.mirrorEl.getBoundingClientRect();
    const s = r.width / m.vp.w;
    const x = (e.clientX - r.left) / s;
    const y = (e.clientY - r.top) / s;
    if (x < 0 || y < 0 || x > m.vp.w || y > m.vp.h) return null;
    let el = doc.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    const id = el ? m.replayer.getMirror().getId(el) : -1;
    return { el, id: id > 0 ? id : undefined, x: x / m.vp.w, y: y / m.vp.h };
  }

  // Hover effects happen right here, without waiting for the network.
  hoverAt(el) {
    const m = this.m;
    if (m.hoverEl === el) return;
    const doc = m.replayer?.iframe?.contentDocument;
    if (!doc) return;
    doc.querySelectorAll('.\\:hover').forEach(n => n.classList.remove(':hover'));
    for (let n = el; n?.classList; n = n.parentElement) n.classList.add(':hover');
    m.hoverEl = el;
    this.hit.style.cursor = cursorOf(el);
  }

  clearHover() {
    const doc = this.m.replayer?.iframe?.contentDocument;
    doc?.querySelectorAll('.\\:hover').forEach(n => n.classList.remove(':hover'));
    this.m.hoverEl = null;
    this.hit.style.cursor = '';
  }

  // Where the shared page sits inside the tile, in tile pixels.
  contentBox() {
    const W = this.screen.clientWidth;
    const H = this.screen.clientHeight;
    if (this.mode === 'page') {
      if (!this.m.vp) return null;
      const mr = this.mirrorEl.getBoundingClientRect();
      const sr = this.screen.getBoundingClientRect();
      const k = sr.width / W || 1;
      return { x: (mr.left - sr.left) / k, y: (mr.top - sr.top) / k, w: mr.width / k, h: mr.height / k };
    }
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return null;
    const s = Math.min(W / vw, H / vh);
    let w = vw * s;
    let h = vh * s;
    let x = (W - w) / 2;
    let y = (H - h) / 2;
    const vp = this.tab.viewport;
    if (vp?.w && vp?.h) {
      const page = vp.w / vp.h;
      const frame = w / h;
      if (Math.abs(page - frame) / frame > 0.02) {
        if (page > frame) {
          const nh = w / page;
          y += (h - nh) / 2;
          h = nh;
        } else {
          const nw = h * page;
          x += (w - nw) / 2;
          w = nw;
        }
      }
    }
    return { x, y, w, h };
  }

  remoteCursor({ from, x, y, gone, click, ai }) {
    // AI helpers working on the owner's tab get their own named cursor
    const who = ai?.id ? { id: ai.id, name: ai.name, color: ai.color, ai: true } : member(from);
    if (!who) return;
    const id = who.ai ? who.id : from;
    let c = this.cursors.get(id);
    if (!c) {
      const el = document.createElement('div');
      el.className = `rcursor idle ${who.ai ? 'ai' : ''}`;
      el.style.setProperty('--c', who.color);
      el.innerHTML = `${CURSOR_SVG(who.color)}<span>${who.ai ? '✦ ' : ''}${esc(firstName(who.name))}</span>`;
      this.cursorLayer.appendChild(el);
      c = { el, timer: 0 };
      this.cursors.set(id, c);
    }
    if (gone) {
      c.el.classList.add('idle');
      return;
    }
    const box = this.contentBox();
    if (!box || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const px = box.x + x * box.w;
    const py = box.y + y * box.h;
    c.el.classList.remove('idle');
    c.el.style.transform = `translate(${px}px, ${py}px)`;
    if (click) {
      const r = document.createElement('div');
      r.className = 'ripple';
      r.style.cssText = `left:${px}px;top:${py}px;--c:${who.color}`;
      this.cursorLayer.appendChild(r);
      setTimeout(() => r.remove(), 550);
    }
    clearTimeout(c.timer);
    c.timer = setTimeout(() => c.el.classList.add('idle'), who.ai ? 12000 : 4000);
  }

  // ---- video feed (WebRTC from the owner's offscreen document)

  desiredQuality() {
    const pip = document.pictureInPictureElement === this.video;
    const visible = document.visibilityState === 'visible';
    return pip || (visible && (mode === 'grid' || this.key === focusKey)) ? 'full' : 'thumb';
  }

  connectVideo() {
    this.stopVideo();
    if (this.dead || this.mode !== 'video') return;
    const rtc = this.rtc;
    const pcId = (rtc.pcId = rid());
    const pc = (rtc.pc = new RTCPeerConnection({ iceServers: S.iceServers || DEFAULT_ICE }));
    rtc.pendingIce = [];
    pc.ontrack = e => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (this.video.srcObject !== stream) this.video.srcObject = stream;
      rtc.stream = stream;
      if (this.key === focusKey) refreshAudio();
    };
    pc.onicecandidate = e => e.candidate && signal(this.owner, { kind: 'ice', pcId, candidate: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => {
      if (rtc.pc !== pc) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        rtc.retry = 0;
        clearTimeout(rtc.watchdog);
      } else if (st === 'failed') {
        this.retryVideo();
      } else if (st === 'disconnected') {
        clearTimeout(rtc.dcTimer);
        rtc.dcTimer = setTimeout(() => rtc.pc === pc && pc.connectionState !== 'connected' && this.retryVideo(0), 4000);
      }
    };
    rtc.quality = this.desiredQuality();
    signal(this.owner, { kind: 'subscribe', pcId, tabId: this.tab.tabId, quality: rtc.quality });
    clearTimeout(rtc.watchdog);
    rtc.watchdog = setTimeout(() => rtc.pc === pc && pc.connectionState !== 'connected' && this.retryVideo(), 15000);
  }

  async onSignal(d) {
    const rtc = this.rtc;
    const pc = rtc.pc;
    if (!pc || d.pcId !== rtc.pcId) return;
    try {
      if (d.kind === 'offer') {
        await pc.setRemoteDescription(d.sdp);
        await pc.setLocalDescription(await pc.createAnswer());
        signal(this.owner, { kind: 'answer', pcId: rtc.pcId, sdp: pc.localDescription.toJSON() });
        for (const c of rtc.pendingIce.splice(0)) pc.addIceCandidate(c).catch(() => {});
      } else if (d.kind === 'ice') {
        if (pc.remoteDescription) await pc.addIceCandidate(d.candidate).catch(() => {});
        else rtc.pendingIce.push(d.candidate);
      } else if (d.kind === 'unavailable') {
        this.retryVideo(3000);
      }
    } catch (e) {
      console.warn('[CoTab] video signaling', e);
      this.retryVideo();
    }
  }

  retryVideo(delay) {
    if (this.dead || this.mode !== 'video') return;
    const rtc = this.rtc;
    clearTimeout(rtc.reconnectTimer);
    clearTimeout(rtc.watchdog);
    rtc.reconnectTimer = setTimeout(() => this.connectVideo(), delay ?? Math.min(800 * 2 ** rtc.retry++, 8000));
  }

  setQuality(q) {
    const rtc = this.rtc;
    if (q === rtc.quality || !rtc.pc) return;
    rtc.quality = q;
    signal(this.owner, { kind: 'quality', pcId: rtc.pcId, quality: q });
  }

  stopVideo() {
    const rtc = this.rtc;
    clearTimeout(rtc.watchdog);
    clearTimeout(rtc.dcTimer);
    clearTimeout(rtc.reconnectTimer);
    if (!rtc.pc) return;
    signal(this.owner, { kind: 'bye', pcId: rtc.pcId });
    rtc.pc.close();
    rtc.pc = null;
  }

  destroy() {
    this.dead = true;
    this.stopVideo();
    if (this.subscribed) client.post({ type: 'mirror-unsub', tabKey: this.key });
    clearTimeout(this.m.resubTimer);
    try { this.m.replayer?.destroy(); } catch {}
    if (document.pictureInPictureElement === this.video) document.exitPictureInPicture().catch(() => {});
    this.el.classList.add('leaving');
    setTimeout(() => this.el.remove(), 320);
  }
}

function signal(to, data) {
  client.post({ type: 'signal', to, data: { dir: 'up', ...data } });
}

function syncViewers() {
  const remote = remoteTabs();
  const keys = new Set(remote.map(t => t.key));
  for (const [key, v] of viewers) {
    if (!keys.has(key)) {
      v.destroy();
      viewers.delete(key);
    }
  }
  for (const t of remote) {
    const v = viewers.get(t.key);
    if (v) v.update(t);
    else viewers.set(t.key, new Viewer(t));
  }
}

function updateQualities() {
  for (const v of viewers.values()) v.setQuality(v.desiredQuality());
}

function refreshAudio() {
  const v = viewers.get(focusKey);
  const track = v?.mode === 'video' ? v.rtc.stream?.getAudioTracks()[0] || null : null;
  const current = audio.srcObject?.getAudioTracks()[0] || null;
  if (track !== current) audio.srcObject = track ? new MediaStream([track]) : null;
  audio.muted = !audioOn;
  if (!audio.srcObject || !audioOn || !audio.paused) return;
  audio.play().then(
    () => {
      if (audioBlocked) {
        audioBlocked = false;
        headSig = '';
        renderStageHead();
      }
    },
    () => {
      if (!audioBlocked) {
        audioBlocked = true;
        headSig = '';
        renderStageHead();
      }
    },
  );
}

function reportWatching() {
  const visible = document.visibilityState === 'visible' || !!document.pictureInPictureElement;
  const key = S?.room && visible && mode === 'focus' ? focusKey : null;
  // compare with the service worker's view too: it forgets if Chrome restarts it
  if (key === lastWatching && key === (S?.watching ?? null)) return;
  lastWatching = key;
  if (S) S.watching = key;
  client.call('setWatching', key).catch(() => {});
}

// ------------------------------------------------------------------ layout (tiles never leave the DOM, so switching is instant)

function aspectOf(v) {
  if (v.mode === 'page' && v.m.vp) return v.m.vp.w / v.m.vp.h;
  if (v.mode === 'video' && v.video.videoWidth) return v.video.videoWidth / v.video.videoHeight;
  const vp = v.tab.viewport;
  return vp?.w && vp?.h ? vp.w / vp.h : 16 / 10;
}
const fit = (w, h, a) => (w / h > a ? [h * a, h] : [w, w / a]);

function layout() {
  const tiles = remoteTabs().map(t => viewers.get(t.key)).filter(Boolean);
  wall.classList.toggle('grid', mode === 'grid');
  if (!tiles.length) return;
  const W = wall.clientWidth;
  const H = wall.clientHeight;
  const gap = 14;

  if (mode === 'grid') {
    const n = tiles.length;
    const a = tiles.reduce((s, v) => s + aspectOf(v), 0) / n;
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const [w, h] = fit((W - gap * (cols - 1)) / cols, (H - gap * (rows - 1)) / rows, a);
      if (!best || w * h > best.w * best.h) best = { cols, rows, w, h };
    }
    const { cols, rows, w, h } = best;
    const x0 = (W - (cols * w + gap * (cols - 1))) / 2;
    const y0 = (H - (rows * h + gap * (rows - 1))) / 2;
    tiles.forEach((v, i) => {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, n - row * cols); // center a short last row
      const rx = x0 + ((cols - inRow) * (w + gap)) / 2;
      place(v, rx + (i % cols) * (w + gap), y0 + row * (h + gap), w, h, 'grid');
    });
    return;
  }

  const others = tiles.filter(v => v.key !== focusKey);
  const stripH = others.length ? Math.round(Math.min(130, Math.max(84, H * 0.16))) : 0;
  const stageH = H - (others.length ? stripH + gap : 0);
  const focused = viewers.get(focusKey);
  if (focused) {
    const [w, h] = fit(W, stageH, aspectOf(focused));
    place(focused, (W - w) / 2, (stageH - h) / 2, w, h, 'stage');
  }
  if (!others.length) return;
  let widths = others.map(v => stripH * Math.min(2.2, Math.max(1.2, aspectOf(v))));
  const total = widths.reduce((s, w) => s + w, 0) + gap * (others.length - 1);
  if (total > W) widths = widths.map(w => (w * (W - gap * (others.length - 1))) / (total - gap * (others.length - 1)));
  let x = Math.max(0, (W - total) / 2);
  others.forEach((v, i) => {
    place(v, x, stageH + gap, widths[i], stripH, 'thumb');
    x += widths[i] + gap;
  });
}

function place(v, x, y, w, h, role) {
  const el = v.el;
  if (!v.placed) {
    el.style.transition = 'none';
    v.mirrorEl.style.transition = 'none';
  }
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  el.style.width = `${Math.round(w)}px`;
  el.style.height = `${Math.round(h)}px`;
  el.classList.toggle('stage', role === 'stage');
  el.classList.toggle('thumb', role === 'thumb');
  v.fit();
  if (!v.placed) {
    void el.offsetWidth;
    el.style.transition = '';
    v.mirrorEl.style.transition = '';
    v.placed = true;
  }
}

let resizeTimer = 0;
new ResizeObserver(() => {
  wall.classList.add('resizing');
  layout();
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => wall.classList.remove('resizing'), 150);
}).observe(wall);

// ------------------------------------------------------------------ remote interaction

function control(v, event) {
  client.post({ type: 'control', tabKey: v.key, event });
}

function norm(v, e) {
  const box = v.contentBox();
  if (!box) return null;
  const r = v.screen.getBoundingClientRect();
  const k = r.width / v.screen.clientWidth || 1; // fullscreen / zoom safety
  const x = (e.clientX - r.left - box.x * k) / (box.w * k);
  const y = (e.clientY - r.top - box.y * k) / (box.h * k);
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
}

function pointAt(v, e) {
  if (v.mode === 'page') {
    const t = v.mirrorTarget(e);
    return t ? { x: t.x, y: t.y, id: t.id, el: t.el } : null;
  }
  return norm(v, e);
}

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS']);

function bindTile(v) {
  const hit = v.hit;
  const isStage = () => mode === 'focus' && v.key === focusKey;
  let lastMove = 0;
  let wheel = null;

  hit.addEventListener('pointermove', e => {
    if (!isStage()) return;
    const now = performance.now();
    const p = pointAt(v, e);
    if (p?.el && v.tab.interactive) v.hoverAt(p.el);
    if (now - lastMove < 33 || !p) return;
    lastMove = now;
    control(v, { type: 'move', x: p.x, y: p.y, id: p.id });
  });
  hit.addEventListener('pointerleave', () => {
    if (!isStage()) return;
    v.clearHover();
    control(v, { type: 'leave' });
  });
  hit.addEventListener('pointerdown', () => {
    if (isStage() && v.tab.interactive) hit.focus({ preventScroll: true });
  });
  hit.addEventListener('click', e => {
    if (!isStage()) {
      followId = null;
      setMode('focus');
      setFocus(v.key, true);
      return;
    }
    if (!v.tab.interactive) return nudgeAsk();
    const p = pointAt(v, e);
    if (p) control(v, { type: 'click', x: p.x, y: p.y, id: p.id, count: e.detail === 2 ? 2 : 1 });
  });
  hit.addEventListener(
    'wheel',
    e => {
      if (!isStage() || !v.tab.interactive) return;
      e.preventDefault();
      const p = pointAt(v, e);
      if (!p) return;
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      if (!wheel) {
        wheel = { dx: 0, dy: 0, p };
        requestAnimationFrame(() => {
          control(v, { type: 'wheel', x: wheel.p.x, y: wheel.p.y, id: wheel.p.id, dx: Math.round(wheel.dx), dy: Math.round(wheel.dy) });
          wheel = null;
        });
      }
      wheel.dx += e.deltaX * k;
      wheel.dy += e.deltaY * k;
      wheel.p = p;
    },
    { passive: false },
  );
  hit.addEventListener('keydown', e => {
    if (!isStage() || !v.tab.interactive || MODIFIERS.has(e.key)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'v') return; // handled by the paste event below
    if (mod && ['r', 't', 'w', 'n', 'l', 'tab'].includes(e.key.toLowerCase())) return; // leave browser shortcuts alone
    e.preventDefault();
    control(v, { type: 'key', key: e.key, code: e.code, keyCode: e.keyCode, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
  });
  hit.addEventListener('paste', e => {
    if (!isStage() || !v.tab.interactive) return;
    const text = e.clipboardData?.getData('text');
    if (!text) return;
    e.preventDefault();
    control(v, { type: 'text', text });
  });
  hit.addEventListener('focus', () => v.el.classList.add('kbd'));
  hit.addEventListener('blur', () => v.el.classList.remove('kbd'));
}

// ------------------------------------------------------------------ share-a-tab picker

async function openPicker() {
  const picker = $('#picker');
  const all = await chrome.tabs.query({});
  const live = new Set(S.sharedTabs.map(t => t.tabId));
  const tabs = all.filter(t => SHAREABLE.test(t.url || '') && !t.url.startsWith(ROOM_URL));
  picker.innerHTML = `<div class="dialog" role="dialog" aria-label="Share a tab">
    <div class="dialog-head"><div class="grow"><h2>Share a tab</h2><p>Pick one of your open tabs. Everything else stays private.</p></div>
      <button class="icon-btn" id="pickClose" title="Close">${icon('x')}</button></div>
    <form class="open-form" id="pickOpen"><input class="input" id="pickUrl" placeholder="Or open a new website, like github.com" autocomplete="off" spellcheck="false"><button class="btn primary">Open</button></form>
    <div class="dialog-list">${
      tabs.length
        ? tabs
            .map(t => `<button class="row" data-tab="${t.id}" ${live.has(t.id) ? 'disabled' : ''}>${favicon(t.favIconUrl, t.title)}
              <span class="grow"><span class="t ellipsis">${esc(t.title)}</span><span class="sub ellipsis">${esc(hostOf(t.url))}</span></span>
              ${live.has(t.id) ? '<span class="badge-live"><span class="live-dot"></span>Live</span>' : icon('arrowRight')}</button>`)
            .join('')
        : '<div class="side-empty">No other tabs open. Open a website above.</div>'
    }</div></div>`;
  picker.hidden = false;
  const close = () => {
    picker.hidden = true;
    picker.innerHTML = '';
    removeEventListener('keydown', onKey, true);
  };
  const onKey = e => e.key === 'Escape' && close();
  addEventListener('keydown', onKey, true);
  picker.onclick = e => e.target === picker && close();
  $('#pickClose').onclick = close;
  $('#pickOpen').onsubmit = async e => {
    e.preventDefault();
    const url = $('#pickUrl').value.trim();
    if (!url) return;
    close();
    await client.call('openAndShare', url).catch(err => toast({ title: "Couldn't open that", body: err.message }));
  };
  for (const b of picker.querySelectorAll('[data-tab]')) {
    b.onclick = async () => {
      close();
      try {
        await client.call('shareTab', Number(b.dataset.tab));
        toast({ title: 'Your tab is live', body: 'Everyone in the room can watch it now.', timeout: 3500 });
      } catch (err) {
        toast({ title: "Couldn't share that tab", body: err.message });
      }
    };
  }
  $('#pickUrl').focus();
}

// ------------------------------------------------------------------ page-level wiring

document.addEventListener('keydown', e => {
  if (e.target.closest?.('input, textarea, .hit') || e.ctrlKey || e.metaKey || e.altKey || !$('#picker').hidden) return;
  if (e.key === 'g' || e.key === 'G') setMode(mode === 'grid' ? 'focus' : 'grid');
  else if (e.key === 'f' || e.key === 'F') viewers.get(focusKey)?.el.requestFullscreen?.();
  else if (/^[1-9]$/.test(e.key)) {
    const t = remoteTabs()[Number(e.key) - 1];
    if (t) {
      setMode('focus');
      setFocus(t.key, true);
    }
  }
});

// Fullscreen resizes a tile outside our layout: rescale the page copy to fill the screen.
document.addEventListener('fullscreenchange', () => {
  for (const v of viewers.values()) v.fit();
});

document.addEventListener('visibilitychange', () => {
  updateQualities();
  reportWatching();
});

// Browsers block autoplaying sound until the first click: retry then.
document.addEventListener('pointerdown', () => audioBlocked && refreshAudio(), true);

addEventListener('pagehide', () => {
  for (const v of viewers.values()) v.stopVideo();
});
