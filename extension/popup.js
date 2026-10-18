import { connect, esc, icon, avatar, favicon, hostOf, copyText, logo, menu, reachText } from './client.js';

const app = document.getElementById('app');
const ROOM_URL = chrome.runtime.getURL('room.html');
const SHAREABLE = /^(https?|file):/;

let S = null;          // state pushed by the service worker
let activeTab = null;
let view = null;
let busy = null;       // which action is in flight
let error = null;
let copied = false;
let lastHtml = '';

const client = connect('popup', msg => {
  if (msg.type === 'state') {
    S = msg.state;
    render();
  }
});

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  activeTab = tab || null;
  render();
});

async function run(name, fn) {
  busy = name;
  error = null;
  render();
  try {
    return await fn();
  } catch (e) {
    error = e.message || String(e);
  } finally {
    busy = null;
    render();
  }
}

const spin = (name, fallback) => (busy === name ? '<span class="spinner sm"></span>' : fallback);

function render() {
  if (!S) return;
  const next = S.room ? 'room' : S.roomCode && S.status !== 'idle' ? 'connecting' : 'welcome';
  if (next === 'welcome') {
    if (view !== 'welcome') renderWelcome();
    else updateWelcome();
  } else {
    const html = next === 'room' ? roomHtml() : connectingHtml();
    if (html !== lastHtml || view !== next) {
      app.innerHTML = lastHtml = html;
      next === 'room' ? bindRoom() : bindConnecting();
    }
  }
  view = next;
}

// ------------------------------------------------------------------ not in a room

function renderWelcome() {
  lastHtml = '';
  app.innerHTML = `<div class="welcome">
    <div class="hero aurora">
      ${logo(34)}
      <h1>Browse together</h1>
      <p>Share the tabs you pick. Everyone keeps browsing their own way.</p>
    </div>
    <div class="body">
      <div class="prompt">
        <form class="prompt-input" id="joinForm">
          <input id="code" placeholder="Paste an invite link or room code" autocomplete="off" spellcheck="false">
          <button class="send" id="join" title="Join room" disabled>${icon('arrowRight')}</button>
        </form>
        <div class="prompt-sep"></div>
        <button class="row arrow-row" id="create">${icon('arrowRight')}<span>Start a new room</span></button>
      </div>
      <div class="err" id="err" hidden></div>
      <label class="name-row">You'll appear as <input id="name" maxlength="40" autocomplete="off" spellcheck="false" value="${esc(S.me?.name)}"></label>
      <button class="server-link" id="serverToggle">${icon('settings')}<span id="serverLabel"></span></button>
      <form class="server-form" id="serverForm" hidden>
        <input class="input mono" id="server" spellcheck="false">
        <button class="btn" type="submit">Save</button>
      </form>
    </div>
  </div>`;

  const $ = id => document.getElementById(id);
  const saveName = () => client.call('setName', $('name').value).catch(() => {});
  $('name').addEventListener('change', saveName);
  $('code').addEventListener('input', () => ($('join').disabled = !$('code').value.trim() || !!busy));
  $('create').onclick = () =>
    run('create', async () => {
      await saveName();
      await client.call('createRoom');
    });
  $('joinForm').onsubmit = e => {
    e.preventDefault();
    run('join', async () => {
      await saveName();
      await client.call('joinRoom', $('code').value.trim());
      await client.call('openRoom');
      window.close();
    });
  };
  $('serverToggle').onclick = () => {
    $('serverForm').hidden = !$('serverForm').hidden;
    if (!$('serverForm').hidden) $('server').focus();
  };
  $('serverForm').onsubmit = async e => {
    e.preventDefault();
    await client.call('setServer', $('server').value);
    $('serverForm').hidden = true;
  };
  updateWelcome();
  $('code').focus();
}

function updateWelcome() {
  const $ = id => document.getElementById(id);
  $('create').disabled = !!busy;
  $('create').innerHTML = `${spin('create', icon('arrowRight'))}<span>${busy === 'create' ? 'Starting your room…' : 'Start a new room'}</span>`;
  $('join').disabled = !!busy || !$('code').value.trim();
  $('join').innerHTML = spin('join', icon('arrowRight'));
  $('err').hidden = !error;
  $('err').textContent = error || '';
  $('serverLabel').textContent = `Server: ${S.serverUrl.replace(/^wss?:\/\//, '')}`;
  if (document.activeElement !== $('server')) $('server').value = S.serverUrl;
}

// ------------------------------------------------------------------ reconnecting

function connectingHtml() {
  return `<div class="pop"><div class="center"><div class="spinner"></div>
    <div>Getting you back into room <b class="mono">${esc(S.roomCode)}</b>…</div>
    ${S.error ? `<div class="faint">${esc(S.error)}</div>` : ''}
    <button class="btn sm danger" id="leave">${icon('logout')} Leave room</button></div></div>`;
}

function bindConnecting() {
  document.getElementById('leave').onclick = () => run('leave', () => client.call('leaveRoom'));
}

// ------------------------------------------------------------------ in a room

function roomHtml() {
  const { room, me } = S;
  const online = room.members.filter(m => m.online);
  const mine = new Map(S.sharedTabs.map(t => [t.tabId, t]));
  const tab = activeTab;
  const share = tab && mine.get(tab.id);
  const canShare = tab && SHAREABLE.test(tab.url || '');
  const others = room.tabs.filter(t => t.ownerId !== me.id);
  const reach = reachText(S.reach);
  const conn = S.status === 'connected' ? '<span class="status-dot"></span>' : '<span class="status-dot warn"></span>';

  let tabCard = '';
  if (tab && !canShare) {
    const isRoom = (tab.url || '').startsWith(ROOM_URL);
    tabCard = `<div class="card"><div class="note" style="margin:0">${icon('lock')}<span>${
      isRoom ? 'This is your room view. Open any website to share it.' : "Chrome's own pages can't be shared. Open a website to share it."
    }</span></div></div>`;
  } else if (tab && !share) {
    tabCard = `<div class="card">
      <div class="tab-line">${favicon(tab.favIconUrl, tab.title)}<div class="grow"><div class="t ellipsis">${esc(tab.title)}</div><div class="h">${esc(hostOf(tab.url))}</div></div></div>
      <button class="btn primary lg block" id="share" ${busy ? 'disabled' : ''}>${spin('share', icon('share'))} Share this tab</button>
      <button class="row arrow-row" id="invite" ${busy ? 'disabled' : ''}>${spin('invite', icon('arrowRight'))}<span>Share it and ask everyone to look</span></button>
      <div class="note">${icon('lock')}<span>Only this tab is shared. Your other tabs stay private.</span></div>
    </div>`;
  } else if (tab) {
    const key = `${me.id}:${tab.id}`;
    const watchers = room.members.filter(m => m.id !== me.id && m.online && m.watching === key);
    tabCard = `<div class="card">
      <div class="tab-line">${favicon(tab.favIconUrl, tab.title)}
        <div class="grow"><div class="t ellipsis">${esc(tab.title)}</div>
          <div class="h"><span class="live-dot"></span>Live${watchers.length ? ` · ${watchers.length} watching` : ' · nobody watching yet'}</div></div>
        <div class="faces">${watchers.slice(0, 3).map(m => avatar(m, { size: 'sm' })).join('')}</div></div>
      <div class="toggle" id="toggleCtl">
        <div class="grow"><b>Let others control</b><span>They can click, type and scroll here</span></div>
        <span class="switch ${share.interactive ? 'on' : ''}"></span>
      </div>
      ${share.video ? '' : `<button class="row arrow-row" id="addVideo" ${busy ? 'disabled' : ''}>${spin('video', icon('arrowRight'))}<span>Add video &amp; sound<span class="sub">Best for videos, games and canvas apps</span></span></button>`}
      <button class="row arrow-row" id="invite" ${busy ? 'disabled' : ''}>${spin('invite', icon('arrowRight'))}<span>Ask everyone to look at this tab</span></button>
      <button class="row arrow-row danger" id="stop" ${busy ? 'disabled' : ''}>${spin('stop', icon('x'))}<span>Stop sharing</span></button>
    </div>`;
  }

  const list = others
    .map(t => {
      const owner = room.members.find(m => m.id === t.ownerId);
      return `<button class="row" data-key="${esc(t.key)}">${favicon(t.favIconUrl, t.title)}
        <span class="grow"><span class="t ellipsis" style="display:block">${esc(t.title)}</span><span class="sub">${esc(owner?.name || 'Someone')}</span></span>
        ${avatar(owner, { size: 'sm' })}</button>`;
    })
    .join('');

  return `<div class="pop">
    <header class="head">${logo(24)}
      <div class="grow"><div class="title">Room <span class="mono">${esc(room.code)}</span></div>
        <div class="sub">${conn}${online.length} here · ${reach.short}</div></div>
      <button class="icon-btn" id="more" title="More">${icon('more')}</button>
    </header>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    ${tabCard}
    <div>
      <div class="label">Live in this room</div>
      <div class="list">${list || '<div class="empty-line">Nobody else is sharing yet.</div>'}</div>
    </div>
    <div class="foot">
      <button class="btn" id="copyLink">${icon(copied ? 'check' : 'link')} ${copied ? 'Copied' : 'Copy invite'}</button>
      <button class="btn primary" id="openRoom">Open room ${icon('arrowRight')}</button>
    </div>
  </div>`;
}

function bindRoom() {
  const $ = id => document.getElementById(id);
  const on = (id, fn) => $(id) && ($(id).onclick = fn);
  const openRoom = async key => {
    await client.call('openRoom', key);
    window.close();
  };
  on('openRoom', () => openRoom());
  on('copyLink', async () => {
    await copyText(S.inviteLink);
    copied = true;
    render();
    setTimeout(() => ((copied = false), render()), 1500);
  });
  on('share', () => run('share', () => client.call('shareTab', activeTab.id)));
  on('addVideo', () => run('video', () => client.call('shareTab', activeTab.id)));
  on('invite', () => run('invite', () => client.call('inviteHere', activeTab.id)));
  on('stop', () => run('stop', () => client.call('unshareTab', activeTab.id)));
  on('toggleCtl', () => {
    const cur = S.sharedTabs.find(t => t.tabId === activeTab.id);
    client.call('setInteractive', activeTab.id, !cur?.interactive);
  });
  on('more', e =>
    menu(e.currentTarget, [
      { label: 'Copy invite link', icon: 'link', onClick: () => copyText(S.inviteLink) },
      { label: 'Copy room code', icon: 'copy', onClick: () => copyText(S.room.code) },
      { note: esc(reachText(S.reach).long) },
      'sep',
      { label: 'Leave room', icon: 'logout', danger: true, onClick: () => run('leave', () => client.call('leaveRoom')) },
    ], { align: 'right' }),
  );
  for (const item of document.querySelectorAll('[data-key]')) item.onclick = () => openRoom(item.dataset.key);
}
