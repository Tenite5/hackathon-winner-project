// Shared helpers for the popup and the room page: a port to the service worker with
// promise-based calls, the icon set, toasts, menus and a few rendering helpers.

export function connect(name, onMessage) {
  let port = null;
  let seq = 0;
  const pending = new Map();

  function open() {
    port = chrome.runtime.connect({ name });
    port.onMessage.addListener(msg => {
      if (msg.type === 'result') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        msg.ok ? p.resolve(msg.value) : p.reject(new Error(msg.error));
        return;
      }
      onMessage(msg);
    });
    port.onDisconnect.addListener(() => {
      for (const p of pending.values()) p.reject(new Error('Lost connection to the extension, try again'));
      pending.clear();
      setTimeout(open, 250); // service worker restarted: reconnect and get fresh state
    });
  }
  open();

  return {
    call(fn, ...args) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        try {
          port.postMessage({ type: 'call', id, fn, args });
        } catch (e) {
          pending.delete(id);
          reject(e);
        }
      });
    },
    post(msg) {
      try { port.postMessage(msg); } catch {}
    },
  };
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export function hostOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' ? 'local file' : u.host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function avatar(m, { size = '', presence = false, square = false, title = true } = {}) {
  if (!m) return '';
  const cls = ['avatar', size, square && 'square', m.online === false && 'offline'].filter(Boolean).join(' ');
  return `<span class="${cls}" style="--c:${esc(m.color)}" ${title ? `title="${esc(m.name)}"` : ''}>${esc((m.name || '?')[0])}${
    presence && m.online !== false ? '<i class="presence"></i>' : ''
  }</span>`;
}

export function favicon(url, title = '') {
  const letter = esc((title || '?').trim()[0] || '?');
  if (!url || !/^(https?:|data:image)/.test(url)) return `<span class="fav-fallback">${letter}</span>`;
  return `<img class="fav" src="${esc(url)}" alt="" data-letter="${letter}">`;
}

// Broken favicons fall back to a letter badge.
document.addEventListener(
  'error',
  e => {
    const img = e.target;
    if (img?.classList?.contains('fav')) {
      const span = document.createElement('span');
      span.className = 'fav-fallback';
      span.textContent = img.dataset.letter || '?';
      img.replaceWith(span);
    }
  },
  true,
);

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function toast(t, onAction) {
  let layer = document.getElementById('toasts');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'toasts';
    layer.className = 'toasts';
    document.body.appendChild(layer);
  }
  const timeout = t.timeout || 5000;
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `
    ${t.initial || t.color ? avatar({ name: t.initial || '•', color: t.color || '#7b2ff7' }, { title: false }) : ''}
    <div class="toast-main">
      <div class="toast-title">${esc(t.title)}</div>
      ${t.body ? `<div class="toast-text">${t.favicon ? `<img src="${esc(t.favicon)}" alt="">` : ''}${esc(t.body)}</div>` : ''}
      <div class="toast-actions"></div>
    </div>
    <button class="icon-btn toast-x" title="Dismiss">${icon('x')}</button>`;
  el.querySelector('.toast-text img')?.addEventListener('error', e => e.target.remove());
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };
  const done = actionId => {
    if (closed) return;
    close();
    onAction?.(actionId);
  };
  for (const a of t.actions || []) {
    const b = document.createElement('button');
    b.className = `btn sm ${a.primary ? 'primary' : ''}`;
    b.textContent = a.label;
    b.onclick = () => done(a.id);
    el.querySelector('.toast-actions').appendChild(b);
  }
  el.querySelector('.toast-x').onclick = () => done(null);
  setTimeout(() => done(null), timeout);
  layer.prepend(el);
  while (layer.children.length > 4) layer.lastElementChild.remove();
  return { close };
}

// A small dropdown anchored to an element. items: [{ label, icon, danger, onClick } | 'sep' | { note }]
let openMenu = null;
export function menu(anchor, items, { align = 'left' } = {}) {
  openMenu?.remove();
  const el = document.createElement('div');
  el.className = 'menu';
  for (const item of items) {
    if (item === 'sep') {
      el.insertAdjacentHTML('beforeend', '<div class="sep"></div>');
    } else if (item.note) {
      el.insertAdjacentHTML('beforeend', `<div class="note">${item.note}</div>`);
    } else {
      const b = document.createElement('button');
      b.className = `row ${item.danger ? 'danger' : ''}`;
      b.innerHTML = `${item.icon ? icon(item.icon) : ''}<span>${esc(item.label)}</span>`;
      b.onclick = () => {
        close();
        item.onClick();
      };
      el.appendChild(b);
    }
  }
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const left = align === 'right' ? r.right - w : r.left;
  el.style.left = `${Math.max(8, Math.min(left, innerWidth - w - 8))}px`;
  el.style.top = `${Math.min(r.bottom + 6, innerHeight - el.offsetHeight - 8)}px`;
  const close = () => {
    el.remove();
    if (openMenu === el) openMenu = null;
    removeEventListener('pointerdown', outside, true);
    removeEventListener('keydown', onKey, true);
  };
  const outside = e => !el.contains(e.target) && !anchor.contains(e.target) && close();
  const onKey = e => e.key === 'Escape' && close();
  setTimeout(() => {
    addEventListener('pointerdown', outside, true);
    addEventListener('keydown', onKey, true);
  });
  openMenu = el;
  return close;
}

let logoSeq = 0;
export function logo(size = 28) {
  const id = `lg${++logoSeq}`;
  const arrow = 'M0 0 L0 64 L16 49 L27 74 L39 69 L28 44 L50 44 Z';
  return `<svg class="logo" width="${size}" height="${size}" viewBox="0 0 128 128" aria-hidden="true"><defs>
    <linearGradient id="${id}f" x1="0" y1="0" x2=".35" y2="1"><stop offset="0" stop-color="#ff6ad5"/><stop offset=".55" stop-color="#ff3d7f"/><stop offset="1" stop-color="#ff5a36"/></linearGradient>
    <linearGradient id="${id}b" x1="0" y1="0" x2=".4" y2="1"><stop offset="0" stop-color="#5b8cff"/><stop offset="1" stop-color="#8a6bff"/></linearGradient>
    <mask id="${id}m"><rect width="128" height="128" fill="#fff"/><path d="${arrow}" transform="translate(50 37) scale(1.15)" stroke="#000" stroke-width="16" stroke-linejoin="round"/></mask></defs>
    <g mask="url(#${id}m)"><path d="${arrow}" transform="translate(20 6) scale(1.15)" fill="url(#${id}b)" stroke="url(#${id}b)" stroke-width="8" stroke-linejoin="round"/></g>
    <path d="${arrow}" transform="translate(50 37) scale(1.15)" fill="url(#${id}f)" stroke="url(#${id}f)" stroke-width="8" stroke-linejoin="round"/></svg>`;
}

// Icon paths adapted from Lucide (ISC license).
const ICONS = {
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" x2="19" y1="8" y2="14"/><line x1="22" x2="16" y1="11" y2="11"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  share: '<path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M8 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-2"/>',
  tabs: '<rect width="18" height="14" x="3" y="6" rx="2"/><path d="M7 6V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-1"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  pointer: '<path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.12 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.12a.5.5 0 0 1-.95.06z"/>',
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  forward: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  reload: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
  pip: '<path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4"/><rect width="10" height="7" x="12" y="13" rx="2"/>',
  volume: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
  mute: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/>',
  square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  navigation: '<polygon points="3 11 22 2 13 21 11 13 3 11"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  stop: '<rect width="12" height="12" x="6" y="6" rx="2"/>',
  settings: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  video: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  page: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h8"/><path d="M8 17h5"/>',
  keyboard: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01"/><path d="M10 8h.01"/><path d="M14 8h.01"/><path d="M18 8h.01"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/><path d="M7 16h10"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  sparkles: '<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.13 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
  menu: '<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  wifi: '<path d="M12 20h.01"/><path d="M2 8.82a15 15 0 0 1 20 0"/><path d="M5 12.859a10 10 0 0 1 14 0"/><path d="M8.5 16.429a5 5 0 0 1 7 0"/>',
  laptop: '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
};

export function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

// What an invite link from this room can reach, in plain words.
export function reachText(reach) {
  if (reach === 'public') return { icon: 'globe', short: 'Works from anywhere', long: 'Anyone with the link can join, on any network.' };
  if (reach === 'network') return { icon: 'wifi', short: 'Works on your Wi-Fi', long: 'People on the same network can join. For other networks, run npm run online on the server.' };
  return { icon: 'laptop', short: 'Only this computer', long: 'The server runs on localhost. Run npm run online on the server to invite people on other devices.' };
}
