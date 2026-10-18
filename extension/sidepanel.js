import { connect, esc, icon, favicon, hostOf, toast, logo } from './client.js';

// The AI helpers panel: tell an AI what to do on a tab and watch it work. Each request starts its
// own helper, so several can run side by side on different tabs.

const $ = sel => document.querySelector(sel);
const ROOM_URL = chrome.runtime.getURL('room.html');
const SHAREABLE = /^(https?|file):/;
const SUGGESTIONS = [
  'Summarize this page in 3 bullet points',
  'Find the cheapest option on this page',
  'Fill in this form with realistic test data',
  'Find a contact email on this site',
];

let S = null;            // room state from the service worker
let agents = [];
let settings = null;
let target = null;       // what a new helper will work on
let pinned = false;      // false = follow whatever tab is active in this window
let windowId = null;
let settingsOpen = false;
let feedMode = '';
const cards = new Map(); // agentId -> { el, cache, expanded }

let firstState = true;
const client = connect('panel', msg => {
  if (msg.type === 'state') {
    S = msg.state;
    if (firstState) {
      firstState = false;
      refreshTarget().then(takePendingTarget); // a remote target can only be resolved once we know the room
    } else {
      refreshTarget();
    }
  } else if (msg.type === 'agents') {
    agents = msg.agents;
    settings = msg.settings;
    render();
  }
});

// ------------------------------------------------------------------ which tab the next helper works on

const ownerName = id => S?.room?.members.find(m => m.id === id)?.name || 'Someone';
const firstName = n => String(n || '').split(' ')[0];
const clipText = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

function localTarget(t) {
  const ok = SHAREABLE.test(t.url || '');
  return { kind: 'local', tabId: t.id, title: t.title || hostOf(t.url), url: t.url, favIconUrl: t.favIconUrl, ok, why: ok ? '' : 'Open a website to use AI helpers here' };
}

function remoteTarget(rt) {
  const owner = firstName(ownerName(rt.ownerId));
  return {
    kind: 'remote', tabKey: rt.key, title: rt.title, url: rt.url, favIconUrl: rt.favIconUrl, owner,
    ok: !!rt.interactive, why: rt.interactive ? '' : `Ask ${owner} for control first`,
  };
}

async function refreshTarget() {
  if (pinned && target) {
    if (target.kind === 'local') {
      const t = await chrome.tabs.get(target.tabId).catch(() => null);
      if (t) target = localTarget(t);
      else pinned = false;
    } else {
      const rt = S?.room?.tabs.find(t => t.key === target.tabKey);
      if (rt) target = remoteTarget(rt);
      else pinned = false;
    }
    if (pinned) return renderComposer();
  }
  const [tab] = await chrome.tabs.query({ active: true, windowId: windowId ?? chrome.windows.WINDOW_ID_CURRENT });
  // Watching someone's tab in the room? Default to helping there.
  if (tab?.url?.startsWith(ROOM_URL) && S?.watching) {
    const rt = S.room?.tabs.find(t => t.key === S.watching);
    if (rt) {
      target = remoteTarget(rt);
      return renderComposer();
    }
  }
  target = tab ? localTarget(tab) : null;
  if (tab?.url?.startsWith(ROOM_URL)) target.why = 'Pick a tab for the helper';
  renderComposer();
}

async function takePendingTarget() {
  const { aiTarget } = await chrome.storage.session.get('aiTarget').catch(() => ({}));
  if (!aiTarget || Date.now() - aiTarget.at > 30000) return;
  chrome.storage.session.remove('aiTarget');
  if (aiTarget.kind === 'remote') {
    const rt = S?.room?.tabs.find(t => t.key === aiTarget.tabKey);
    target = rt ? remoteTarget(rt) : target;
  } else {
    const t = await chrome.tabs.get(aiTarget.tabId).catch(() => null);
    if (t) target = localTarget(t);
  }
  pinned = true;
  renderComposer();
  $('#prompt').focus();
}

chrome.storage.onChanged.addListener((changes, area) => area === 'session' && changes.aiTarget?.newValue && takePendingTarget());
chrome.tabs.onActivated.addListener(info => info.windowId === windowId && refreshTarget());
chrome.tabs.onUpdated.addListener((id, info) => (info.title || info.url || info.favIconUrl) && target?.tabId === id && refreshTarget());

// ------------------------------------------------------------------ header + settings

const SPEED = { low: 'Fastest', medium: 'Balanced', high: 'Most careful' };

function renderHead() {
  const running = agents.filter(a => a.status === 'running').length;
  $('#head').innerHTML = `${logo(22)}
    <div class="grow"><div class="t">AI helpers</div></div>
    ${running ? `<span class="count"><span class="live-dot" style="background:#8b5cf6;box-shadow:none"></span>${running} working</span>` : ''}
    <button class="icon-btn ${settingsOpen ? 'on' : ''}" id="settingsBtn" title="AI settings">${icon('settings')}</button>`;
  $('#settingsBtn').onclick = () => {
    settingsOpen = !settingsOpen;
    render();
  };
}

function renderSettings() {
  const box = $('#settings');
  box.hidden = !settingsOpen || !settings;
  if (box.hidden || box.dataset.ready) return;
  box.dataset.ready = '1';
  box.innerHTML = `
    <label>API key <input class="input mono" id="sKey" type="password" placeholder="${settings.hasKey ? `Saved (${esc(settings.keyHint)}), paste to replace` : 'sk-or-…'}" autocomplete="off"></label>
    <label>Speed <span class="speed" id="sSpeed">${Object.entries(SPEED).map(([k, v]) => `<button type="button" data-effort="${k}" class="${settings.effort === k ? 'on' : ''}">${v}</button>`).join('')}</span></label>
    <label>Endpoint (OpenAI-compatible) <input class="input mono" id="sBase" value="${esc(settings.baseUrl)}" spellcheck="false"></label>
    <div class="row-btns"><button class="btn primary sm" id="sSave">Save</button><button class="btn sm" id="sTest">Test</button><span class="test-result" id="sResult"></span></div>
    <div class="faint" style="font-size:12px">Uses OpenRouter by default. Get a key at <a href="https://openrouter.ai/keys" target="_blank">openrouter.ai/keys</a>.</div>`;
  let effort = settings.effort;
  for (const b of box.querySelectorAll('[data-effort]')) {
    b.onclick = () => {
      effort = b.dataset.effort;
      box.querySelectorAll('[data-effort]').forEach(x => x.classList.toggle('on', x === b));
    };
  }
  const save = () => client.call('aiSaveSettings', { key: $('#sKey').value, baseUrl: $('#sBase').value, effort });
  $('#sSave').onclick = async () => {
    await save();
    $('#sKey').value = '';
    settingsOpen = false;
    delete box.dataset.ready;
    render();
    toast({ title: 'AI settings saved', timeout: 2500 });
  };
  $('#sTest').onclick = async () => {
    const out = $('#sResult');
    out.className = 'test-result';
    out.textContent = 'Testing…';
    try {
      if ($('#sKey').value || $('#sBase').value !== settings.baseUrl) await save();
      const r = await client.call('aiTest');
      out.className = 'test-result ok';
      out.textContent = `Connected · ${(r.ms / 1000).toFixed(1)}s`;
    } catch (e) {
      out.className = 'test-result bad';
      out.textContent = e.message;
    }
  };
}

// ------------------------------------------------------------------ feed: setup / empty / helper cards

function setFeed(mode, html, bind) {
  const feed = $('#feed');
  if (feedMode === mode && mode !== 'cards') return;
  feedMode = mode;
  cards.clear();
  feed.innerHTML = html;
  bind?.();
}

function renderFeed() {
  if (!settings) return;
  if (!settings.hasKey) {
    return setFeed('setup', `<div class="setup">
        <h2>Connect an AI model</h2>
        <p>Paste an OpenRouter API key to get started. Helpers are quick, and they work on any tab you point them at.</p>
        <form id="keyForm"><input class="input mono" id="keyInput" type="password" placeholder="sk-or-…" autocomplete="off"><button class="btn primary">Save</button></form>
        <a href="https://openrouter.ai/keys" target="_blank">Get a key at openrouter.ai/keys</a>
      </div>`, () => {
      $('#keyForm').onsubmit = async e => {
        e.preventDefault();
        const key = $('#keyInput').value.trim();
        if (!key) return;
        await client.call('aiSaveSettings', { key });
        $('#prompt').focus();
      };
      $('#keyInput').focus();
    });
  }
  if (!agents.length) {
    return setFeed('empty', `<div class="empty">
        <div class="orb aurora">${icon('sparkles')}</div>
        <h2>Tell AI what to do</h2>
        <p>It reads the page, then clicks, types and scrolls for you. Start as many helpers as you like, on any tab.</p>
        <div class="suggest">${SUGGESTIONS.map(s => `<button class="row arrow-row" data-suggest="${esc(s)}">${icon('arrowRight')}<span>${esc(s)}</span></button>`).join('')}</div>
      </div>`, () => {
      for (const b of document.querySelectorAll('[data-suggest]')) b.onclick = () => start(b.dataset.suggest);
    });
  }
  if (feedMode !== 'cards') setFeed('cards', '');
  const feed = $('#feed');
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  let added = false;
  const ids = new Set();
  for (const a of [...agents].reverse()) { // oldest at the top, newest next to the composer
    ids.add(a.id);
    let card = cards.get(a.id);
    if (!card) {
      card = createCard(a);
      cards.set(a.id, card);
      added = true;
    }
    updateCard(card, a);
    feed.appendChild(card.el); // keeps order; moving an existing node is cheap
  }
  for (const [id, card] of cards) {
    if (!ids.has(id)) {
      card.el.remove();
      cards.delete(id);
    }
  }
  if (added || nearBottom) feed.scrollTop = feed.scrollHeight;
}

function createCard(a) {
  const el = document.createElement('article');
  el.className = 'agent';
  el.innerHTML = `<div class="ag-head"></div><div class="ag-body"></div><div class="ag-foot"></div>
    <form class="reply"><input autocomplete="off"><button class="send" type="submit" title="Send">${icon('arrowUp')}</button></form>`;
  const card = { el, cache: {}, expanded: false, id: a.id };
  el.querySelector('.reply').onsubmit = async e => {
    e.preventDefault();
    const input = el.querySelector('.reply input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      await client.call('agentReply', card.id, text);
    } catch (err) {
      toast({ title: "Couldn't send that", body: err.message });
    }
  };
  return card;
}

function part(card, key, html, bind) {
  if (card.cache[key] === html) return;
  card.cache[key] = html;
  const el = card.el.querySelector(key);
  el.innerHTML = html;
  bind?.(el);
}

function statusHtml(a) {
  if (a.status === 'running') return `<span class="ag-status"><span class="dot"></span>${a.thinking ? 'Thinking' : 'Working'}</span>`;
  if (a.status === 'done') return `<span class="ag-status done">${icon('check').replace('<svg', '<svg width="13" height="13"')} Done</span>`;
  if (a.status === 'error') return '<span class="ag-status error">Needs attention</span>';
  return '<span class="ag-status">Stopped</span>';
}

function stepsHtml(a, expanded) {
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    let items = run;
    let hidden = 0;
    if (!expanded && items.length > 6) {
      hidden = items.length - 5;
      items = items.slice(-5);
    }
    out.push(`${hidden ? `<button class="more-steps" data-more>Show ${hidden} earlier step${hidden === 1 ? '' : 's'}</button>` : ''}
      <ol class="steps">${items.map(s => s.kind === 'live'
        ? `<li class="step live"><span class="spinner"></span><span>${esc(s.text)}</span></li>`
        : `<li class="step ${s.kind}"><i></i><span>${esc(s.text)}</span></li>`).join('')}</ol>`);
    run = [];
  };
  for (const s of a.steps) {
    if (s.kind === 'user') {
      flush();
      out.push(`<div class="bubble user">${esc(s.text)}</div>`);
    } else if (s.kind === 'final') {
      flush();
      out.push(`<div class="bubble ai">${esc(s.text)}</div>`);
    } else {
      run.push(s);
    }
  }
  if (a.status === 'running') run.push({ kind: 'live', text: a.thinking ? 'Thinking…' : 'Working…' });
  flush();
  return out.join('');
}

function updateCard(card, a) {
  const el = card.el;
  el.style.setProperty('--c', a.color);
  el.classList.toggle('running', a.status === 'running');
  const t = a.target;
  const where = t.kind === 'remote' ? `${esc(firstName(t.owner))}'s tab · ${esc(t.title || '')}` : esc(t.title || hostOf(t.url));
  // Says what this helper is allowed to do, in the same words as the composer.
  const scope = t.kind === 'remote' ? `Stays on ${esc(firstName(t.owner))}'s tab` : 'Can open other tabs';
  const who = [a.startedBy ? `Started by ${esc(a.startedBy)}` : '', scope].filter(Boolean).join(' · ');
  const chips = a.tabs?.length > 1
    ? `<div class="ag-tabs">${a.tabs.map(x => `<button class="ag-chip ${x.current ? 'on' : ''}" data-tab="${x.tabId}" title="${esc(x.title)}">${esc(x.label)} ${esc(clipText(x.title, 22))}</button>`).join('')}</div>`
    : '';
  part(card, '.ag-head', `<span class="ag-av">${icon('sparkles')}</span>
    <div class="grow"><div class="ag-name">${esc(a.name)} ${statusHtml(a)}</div>
      <div class="ag-by">${who}</div>
      <button class="ag-target" title="Show this tab">${favicon(t.favIconUrl, t.title)}<span class="ellipsis">${where}</span></button>
      ${chips}</div>
    ${a.status === 'running'
      ? `<button class="icon-btn" data-stop title="Stop ${esc(a.name)}">${icon('stop')}</button>`
      : `<button class="icon-btn" data-dismiss title="Remove">${icon('x')}</button>`}`, head => {
    head.querySelector('.ag-target').onclick = () =>
      t.kind === 'remote' ? client.call('openRoom', t.tabKey) : client.call('focusTab', t.tabId).catch(() => toast({ title: 'That tab is closed' }));
    for (const chip of head.querySelectorAll('[data-tab]')) {
      chip.onclick = () => client.call('focusTab', Number(chip.dataset.tab)).catch(() => toast({ title: 'That tab is closed' }));
    }
    const stop = head.querySelector('[data-stop]');
    if (stop) stop.onclick = () => client.call('agentStop', a.id);
    const dismiss = head.querySelector('[data-dismiss]');
    if (dismiss) dismiss.onclick = () => client.call('agentDismiss', a.id);
  });
  part(card, '.ag-body', stepsHtml(a, card.expanded), body => {
    const more = body.querySelector('[data-more]');
    if (more) {
      more.onclick = () => {
        card.expanded = true;
        updateCard(card, agents.find(x => x.id === card.id) || a);
      };
    }
  });
  const actions = a.steps.filter(s => s.kind === 'action').length;
  part(card, '.ag-foot', a.status === 'running' || !actions ? '' : `${actions} action${actions === 1 ? '' : 's'}`);
  const input = el.querySelector('.reply input');
  input.placeholder = a.status === 'running' ? `Add a note for ${a.name}…` : `Reply to ${a.name}…`;
}

// ------------------------------------------------------------------ composer

function renderComposer() {
  const btn = $('#target');
  const comp = $('#composer');
  const ready = settings?.hasKey;
  comp.classList.toggle('disabled', !ready);
  if (!target) {
    btn.innerHTML = `${icon('globe')}<span>Pick a tab</span>${icon('chevronDown').replace('<svg', '<svg class="chev"')}`;
  } else {
    const label = target.kind === 'remote' ? `${esc(target.owner)}'s tab · ${esc(target.title || '')}` : esc(target.title || hostOf(target.url));
    btn.innerHTML = `${favicon(target.favIconUrl, target.title)}<span class="ellipsis">${target.ok ? label : esc(target.why)}</span>${pinned ? '' : '<span class="faint">· this tab</span>'}${icon('chevronDown').replace('<svg', '<svg class="chev"')}`;
  }
  $('#prompt').placeholder = target?.kind === 'remote' ? `What should AI do on ${target.owner}'s tab?` : 'What should AI do on this tab?';
  $('#rule').textContent = !target?.ok ? '' : scopeText(target);
  updateSend();
}

// Which tabs a helper may use. The same rule shows in the picker and on each helper card.
function scopeText(t) {
  return t.kind === 'remote'
    ? `Helpers stay on ${t.owner}'s tab and can't open others.`
    : 'Helpers can open other tabs in your browser.';
}

function updateSend() {
  $('#send').disabled = !settings?.hasKey || !target?.ok || !$('#prompt').value.trim();
}

async function openPicker() {
  document.querySelector('.picker')?.remove();
  const pick = document.createElement('div');
  pick.className = 'picker';
  const all = await chrome.tabs.query({});
  const mine = all
    .filter(t => SHAREABLE.test(t.url || ''))
    .sort((a, b) => (b.windowId === windowId) - (a.windowId === windowId) || b.lastAccessed - a.lastAccessed)
    .slice(0, 15);
  const remote = (S?.room?.tabs || []).filter(t => t.ownerId !== S.me.id);
  const row = (attrs, fav, title, sub, sel) =>
    `<button class="row ${sel ? 'sel' : ''}" ${attrs}>${fav}<span class="grow"><span class="ellipsis" style="display:block">${esc(title)}</span>${sub ? `<span class="sub ellipsis">${sub}</span>` : ''}</span></button>`;
  pick.innerHTML = `
    ${row('data-follow', icon('navigation'), 'The tab I’m on', 'Follows you as you switch tabs', !pinned)}
    <div class="head">Your tabs <span class="hint">helpers can open other tabs</span></div>
    ${mine.map(t => row(`data-tab="${t.id}"`, favicon(t.favIconUrl, t.title), t.title, esc(hostOf(t.url)), pinned && target?.tabId === t.id)).join('') || '<div class="side-empty" style="padding:6px 10px">No websites open.</div>'}
    ${remote.length ? `<div class="head">Shared in your room <span class="hint">helpers stay on that tab</span></div>${remote.map(t => {
      const owner = firstName(ownerName(t.ownerId));
      return row(`data-remote="${esc(t.key)}" ${t.interactive ? '' : 'disabled'}`, favicon(t.favIconUrl, t.title), t.title,
        t.interactive ? `${esc(owner)}'s tab · you can control it` : `${esc(owner)}'s tab · ask for control first`, pinned && target?.tabKey === t.key);
    }).join('')}` : ''}`;
  document.body.appendChild(pick);
  const r = $('#target').getBoundingClientRect();
  pick.style.bottom = `${innerHeight - r.top + 6}px`;
  const close = () => {
    pick.remove();
    removeEventListener('pointerdown', outside, true);
  };
  const outside = e => !pick.contains(e.target) && !$('#target').contains(e.target) && close();
  setTimeout(() => addEventListener('pointerdown', outside, true));
  pick.querySelector('[data-follow]').onclick = () => {
    pinned = false;
    close();
    refreshTarget();
  };
  for (const b of pick.querySelectorAll('[data-tab]')) {
    b.onclick = async () => {
      const t = await chrome.tabs.get(Number(b.dataset.tab)).catch(() => null);
      if (t) {
        target = localTarget(t);
        pinned = true;
      }
      close();
      renderComposer();
    };
  }
  for (const b of pick.querySelectorAll('[data-remote]')) {
    b.onclick = () => {
      const rt = S.room.tabs.find(t => t.key === b.dataset.remote);
      if (rt) {
        target = remoteTarget(rt);
        pinned = true;
      }
      close();
      renderComposer();
    };
  }
}

async function start(text) {
  const prompt = String(text ?? $('#prompt').value).trim();
  if (!prompt) return;
  if (!target?.ok) return toast({ title: target?.why || 'Pick a tab for the helper first' });
  try {
    await client.call('agentStart', { target: target.kind === 'remote' ? { kind: 'remote', tabKey: target.tabKey } : { kind: 'local', tabId: target.tabId }, prompt });
    $('#prompt').value = '';
    autosize();
    updateSend();
  } catch (e) {
    toast({ title: "Couldn't start the helper", body: e.message, timeout: 6000 });
  }
}

function autosize() {
  const ta = $('#prompt');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(140, ta.scrollHeight)}px`;
}

function render() {
  renderHead();
  renderSettings();
  renderFeed();
  renderComposer();
}

$('#send').innerHTML = icon('arrowUp');
$('#target').onclick = openPicker;
$('#form').onsubmit = e => {
  e.preventDefault();
  start();
};
$('#prompt').addEventListener('input', () => {
  autosize();
  updateSend();
});
$('#prompt').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    start();
  }
});

chrome.windows.getCurrent().then(w => {
  windowId = w.id;
  refreshTarget().then(takePendingTarget);
});
