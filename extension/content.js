// CoTab content script (runs on every page, isolated from the page's own JS).
// Shows the "Live" badge on tabs you share, invite / permission prompts and other people's
// cursors, and bridges the page recorder (recorder.js) to the extension.
(() => {
  // Last copy wins: clean up a copy left behind by an extension reload or a double injection.
  window.__cotab?.destroy?.();
  document.querySelectorAll('cotab-ui').forEach(el => el.remove());

  let state = { shared: false, interactive: false, watchers: [] };
  let host = null;
  let root = null;
  let vpTimer = 0;
  const cursors = new Map();    // userId -> { el, timer }
  const openToasts = new Map(); // toastId -> close()

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  function call(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      return Promise.resolve(null); // extension was reloaded; this copy is orphaned
    }
  }

  // ---------------------------------------------------------------- overlay UI (shadow DOM)

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
  .toasts{position:fixed;top:16px;right:16px;display:flex;flex-direction:column;gap:10px;width:340px;max-width:calc(100vw - 32px)}
  .toast{pointer-events:auto;display:flex;gap:12px;padding:14px;border-radius:16px;color:#f2f2f2;background:#1e1e1e;
    border:1px solid rgba(255,255,255,.08);box-shadow:0 18px 50px -12px rgba(0,0,0,.55);animation:in .32s cubic-bezier(.2,.8,.2,1) both}
  .toast.out{animation:out .2s ease forwards}
  @keyframes in{from{opacity:0;transform:translateY(-8px) scale(.98)}}
  @keyframes out{to{opacity:0;transform:translateY(-6px)}}
  .av{flex:none;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-weight:650;font-size:13px;color:#fff;background:var(--c)}
  .main{min-width:0;flex:1}
  .title{font-size:14px;font-weight:600;line-height:1.35;padding-right:18px}
  .text{margin-top:2px;font-size:13px;color:#a1a1a1;line-height:1.45;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .text img{width:14px;height:14px;vertical-align:-2px;margin-right:6px;border-radius:3px}
  .actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
  .actions:empty{display:none}
  button{all:unset;cursor:pointer;font-size:13px;font-weight:550;height:32px;padding:0 14px;display:inline-flex;align-items:center;border-radius:9px;
    background:#2c2c2c;color:#f2f2f2;transition:background .15s}
  button:hover{background:#363636}
  button.primary{background:#f2f2f2;color:#141414}
  button.primary:hover{background:#fff}
  .x{position:absolute;top:10px;right:10px;width:24px;height:24px;padding:0;justify-content:center;background:none;color:#7a7a7a;border-radius:6px}
  .x:hover{background:rgba(255,255,255,.07);color:#f2f2f2}
  .toast{position:relative}

  .cursor{position:fixed;left:0;top:0;transition:transform .08s linear,opacity .3s;will-change:transform}
  .cursor.idle{opacity:0}
  .cursor svg{display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))}
  .cursor .label{position:absolute;left:14px;top:18px;padding:2px 7px;border-radius:6px;background:var(--c);color:#fff;font-size:11.5px;font-weight:600;white-space:nowrap}
  .ripple{position:fixed;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:2px solid var(--c);animation:ripple .5s ease-out forwards}
  @keyframes ripple{from{transform:scale(.3);opacity:.9}to{transform:scale(1.5);opacity:0}}

  .pill{pointer-events:auto;position:fixed;left:16px;bottom:16px;display:flex;align-items:center;gap:8px;height:32px;padding:0 12px 0 11px;border-radius:999px;
    color:#ececec;font-size:12.5px;font-weight:550;background:rgba(28,28,28,.94);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.1);
    box-shadow:0 10px 30px -10px rgba(0,0,0,.5);animation:in .3s both;user-select:none;cursor:default}
  .pill[hidden]{display:none}
  .dot{width:7px;height:7px;border-radius:50%;background:#ff4d6d;box-shadow:0 0 0 3px rgba(255,77,109,.18)}
  .muted{color:#9a9a9a;font-weight:500}
  .faces{display:flex;padding-left:4px}
  .faces span{width:18px;height:18px;margin-left:-5px;border-radius:50%;display:grid;place-items:center;font-size:9.5px;font-weight:700;color:#fff;background:var(--c);box-shadow:0 0 0 2px #1c1c1c}
  .menu{position:absolute;left:0;bottom:calc(100% + 8px);width:240px;padding:5px;border-radius:14px;background:#1e1e1e;border:1px solid rgba(255,255,255,.08);
    box-shadow:0 18px 40px -12px rgba(0,0,0,.6);opacity:0;transform:translateY(4px);pointer-events:none;transition:opacity .15s,transform .15s}
  .menu::after{content:"";position:absolute;left:0;right:0;bottom:-10px;height:10px}
  .pill:hover .menu{opacity:1;transform:none;pointer-events:auto}
  .row{display:flex;width:100%;height:36px;justify-content:space-between;gap:10px;padding:0 10px;border-radius:9px;background:none;font-weight:500}
  .row:hover{background:rgba(255,255,255,.06)}
  .switch{position:relative;width:30px;height:18px;border-radius:999px;background:#3a3a3a;transition:background .2s}
  .switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .2s}
  .switch.on{background:#4c8dff}
  .switch.on::after{transform:translateX(12px)}
  .stop{color:#ff7a90}

  .cursor.ai{transition:transform .32s cubic-bezier(.3,.7,.2,1),opacity .3s}
  .cursor.ai .label::before{content:"\\2726  ";font-size:10px}
  .ai-frame{position:fixed;inset:0;opacity:0;transition:opacity .35s;
    box-shadow:inset 0 0 0 2px var(--c),inset 0 0 26px 0 color-mix(in srgb,var(--c) 40%,transparent)}
  .ai-frame.on{opacity:1;animation:breathe 2.6s ease-in-out infinite}
  @keyframes breathe{50%{box-shadow:inset 0 0 0 2px var(--c),inset 0 0 44px 4px color-mix(in srgb,var(--c) 50%,transparent)}}
  .ai-pill{pointer-events:auto;position:fixed;left:50%;bottom:16px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;
    max-width:min(560px,calc(100vw - 32px));height:42px;padding:0 6px 0 7px;border-radius:999px;color:#ececec;font-size:13px;
    background:rgba(28,28,28,.95);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.1);box-shadow:0 14px 40px -12px rgba(0,0,0,.55);
    animation:rise .3s cubic-bezier(.2,.8,.2,1) both}
  .ai-pill[hidden]{display:none}
  @keyframes rise{from{opacity:0;transform:translate(-50%,8px)}}
  .ai-av{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--c);color:#fff}
  .ai-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ai-text b{font-weight:600}
  .ai-text span{color:#a1a1a1}
  .ai-pill button{flex:none;height:30px;padding:0 13px;border-radius:999px;background:#f2f2f2;color:#141414;font-size:12.5px;font-weight:600}
  .ai-pill button:hover{background:#fff}
  `;
  const SPARKLE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.13 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z"/></svg>';

  function ui() {
    if (root && host.isConnected) return root;
    host = document.createElement('cotab-ui');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><div class="ai-frame"></div><div class="cursors"></div><div class="toasts"></div><div class="pill" hidden></div><div class="ai-pill" hidden></div>`;
    (document.body || document.documentElement).appendChild(host);
    renderPill();
    return root;
  }

  // ---------------------------------------------------------------- "Live" badge on shared tabs

  function renderPill() {
    if (!root) return;
    const pill = root.querySelector('.pill');
    pill.hidden = !state.shared;
    if (!state.shared) return;
    const n = state.watchers.length;
    const faces = state.watchers
      .slice(0, 4)
      .map(w => `<span style="--c:${esc(w.color)}" title="${esc(w.name)}">${esc((w.name[0] || '?').toUpperCase())}</span>`)
      .join('');
    pill.innerHTML = `
      <span class="dot"></span><span>Live</span>
      ${n ? `<span class="faces">${faces}</span><span class="muted">watching</span>` : '<span class="muted">· shared with your room</span>'}
      ${state.interactive ? '<span class="muted">· control on</span>' : ''}
      <div class="menu">
        <button class="row" data-act="control"><span>Let others control this tab</span><span class="switch ${state.interactive ? 'on' : ''}"></span></button>
        <button class="row stop" data-act="stop"><span>Stop sharing</span></button>
      </div>`;
    pill.querySelector('[data-act=control]').onclick = () => call({ type: 'set-interactive', on: !state.interactive });
    pill.querySelector('[data-act=stop]').onclick = () => call({ type: 'stop-sharing' });
  }

  function setState(next) {
    const wasShared = state.shared;
    state = { shared: !!next.shared, interactive: !!next.interactive, watchers: next.watchers || [] };
    if (state.shared && !wasShared) reportViewport();
    if (!state.shared && wasShared) toRecorder({ t: 'stop' });
    if (state.shared || root) {
      ui();
      renderPill();
    }
  }

  function reportViewport() {
    clearTimeout(vpTimer);
    vpTimer = setTimeout(() => call({ type: 'viewport', w: innerWidth, h: innerHeight, dpr: devicePixelRatio }), 120);
  }
  const onResize = () => state.shared && reportViewport();
  addEventListener('resize', onResize);

  // ---------------------------------------------------------------- toasts

  function showToast(t) {
    const layer = ui().querySelector('.toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    const timeout = t.timeout || 15000;
    el.innerHTML = `
      <div class="av" style="--c:${esc(t.color || '#7b2ff7')}">${esc((t.initial || '•').toUpperCase())}</div>
      <div class="main">
        <div class="title">${esc(t.title)}</div>
        ${t.body ? `<div class="text">${t.favicon ? `<img src="${esc(t.favicon)}" alt="">` : ''}${esc(t.body)}</div>` : ''}
        <div class="actions"></div>
      </div>
      <button class="x" title="Dismiss">&#10005;</button>`;
    el.querySelector('img')?.addEventListener('error', e => e.target.remove());
    let closed = false;
    const close = () => {
      closed = true;
      openToasts.delete(t.id);
      el.classList.add('out');
      setTimeout(() => el.remove(), 220);
    };
    const done = actionId => {
      if (closed) return;
      close();
      call({ type: 'toast-action', toastId: t.id, actionId });
    };
    openToasts.set(t.id, () => !closed && close());
    for (const a of t.actions || []) {
      const b = document.createElement('button');
      b.textContent = a.label;
      if (a.primary) b.className = 'primary';
      b.onclick = () => done(a.id);
      el.querySelector('.actions').appendChild(b);
    }
    el.querySelector('.x').onclick = () => done(null);
    setTimeout(() => done(null), timeout);
    layer.prepend(el);
  }

  // ---------------------------------------------------------------- other people's cursors

  const ARROW = c =>
    `<svg width="20" height="22" viewBox="0 0 20 22"><path d="M2.5 2 2.5 17.6 6.6 13.8 9.4 20 12.2 18.8 9.5 12.7 15.3 12.4Z" fill="${esc(c)}" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

  function moveCursor(from, x, y, idleAfter = 3000) {
    let c = cursors.get(from.id);
    if (!c) {
      const el = document.createElement('div');
      el.className = `cursor ${from.ai ? 'ai' : ''}`;
      el.style.setProperty('--c', from.color);
      el.innerHTML = `${ARROW(from.color)}<span class="label">${esc(from.name)}</span>`;
      c = { el, timer: 0 };
      cursors.set(from.id, c);
    }
    if (!c.el.isConnected) ui().querySelector('.cursors').appendChild(c.el);
    c.el.classList.remove('idle');
    c.el.style.transform = `translate3d(${x - 2}px,${y - 2}px,0)`;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => c.el.classList.add('idle'), idleAfter);
  }

  function ripple(color, x, y) {
    const r = document.createElement('div');
    r.className = 'ripple';
    r.style.cssText = `left:${x}px;top:${y}px;--c:${color}`;
    ui().querySelector('.cursors').appendChild(r);
    setTimeout(() => r.remove(), 550);
  }

  // ---------------------------------------------------------------- live page mirror (bridge to recorder.js)

  const ZIP_MIN = 32 * 1024;
  const toRecorder = msg => document.dispatchEvent(new CustomEvent('cotab:cmd', { detail: JSON.stringify(msg) }));
  let rec = null;                 // { session, seq, batches: [{ seq0, n, p, z }], size, checkoutAsked }
  let chain = Promise.resolve();  // keeps batches in order while big ones are being compressed
  const enqueue = fn => (chain = chain.then(fn).catch(() => {}));

  async function gzip(text) {
    const blob = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
    return new Promise(resolve => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result.slice(fr.result.indexOf(',') + 1));
      fr.readAsDataURL(blob);
    });
  }

  function onRecorderEvents(raw) {
    // "E|session|reset|seq0|count|[...events]"
    let i = 2;
    const field = () => {
      const j = raw.indexOf('|', i);
      const v = raw.slice(i, j);
      i = j + 1;
      return v;
    };
    const session = field();
    const reset = field() === '1';
    const seq0 = Number(field());
    const n = Number(field());
    const p = raw.slice(i);
    // A buffer that didn't start with a full snapshot can't catch anyone up (we joined mid-stream).
    if (!rec || rec.session !== session) rec = { session, batches: [], size: 0, partial: !reset, checkoutAsked: false };
    if (reset) {
      rec.batches = [];
      rec.size = 0;
      rec.partial = false;
      rec.checkoutAsked = false;
    }
    const batch = { seq0, n, p, z: null, reset };
    rec.batches.push(batch);
    rec.size += p.length;
    const s = rec;
    enqueue(async () => {
      if (batch.p.length > ZIP_MIN) {
        batch.z = await gzip(batch.p);
        batch.p = null;
      }
      call({ type: 'mirror-batch', session: s.session, seq0, n, p: batch.p, z: batch.z, reset });
    });
    // Keep the catch-up buffer for late joiners small: start a fresh snapshot now and then.
    if ((rec.size > 6e6 || rec.batches.length > 3000) && !rec.checkoutAsked) {
      rec.checkoutAsked = true;
      toRecorder({ t: 'checkout' });
    }
  }

  function sendInit(to) {
    if (!rec || rec.partial) toRecorder({ t: 'resync' }); // they'll get the fresh snapshot live
    enqueue(() =>
      call({
        type: 'mirror-init',
        to,
        session: rec && !rec.partial ? rec.session : null,
        batches: rec && !rec.partial ? rec.batches.map(b => ({ seq0: b.seq0, n: b.n, p: b.p, z: b.z, reset: b.reset })) : [],
      }),
    );
  }

  const onRecorder = e => {
    const raw = e.detail;
    if (typeof raw !== 'string') return; // the recorder only runs in shared tabs
    if (raw.startsWith('E|')) return onRecorderEvents(raw);
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'cursor') call({ type: 'owner-cursor', x: msg.x, y: msg.y, gone: !!msg.gone });
    else if (msg.t === 'media') call({ type: 'media', media: !!msg.media });
  };
  document.addEventListener('cotab:rec', onRecorder);

  // ---------------------------------------------------------------- remote control

  function onControl(from, ev) {
    const x = (ev.x ?? 0.5) * innerWidth;
    const y = (ev.y ?? 0.5) * innerHeight;
    if (ev.type === 'move') moveCursor(from, x, y);
    if (ev.type === 'leave') cursors.get(from.id)?.el.classList.add('idle');
    if (ev.type === 'click') {
      moveCursor(from, x, y);
      ripple(from.color, x, y);
    }
    if (ev.type === 'wheel') moveCursor(from, x, y);
    if (ev.type === 'leave' || (ev.type === 'move' && !state.interactive)) return;
    toRecorder({ t: 'control', event: ev });
  }

  // ---------------------------------------------------------------- AI helpers: read the page, act on it

  const input = window.__cotabInput;
  // Element numbers from each helper's latest look at the page. Kept on window so they survive
  // this script being replaced by a fresh copy mid-task.
  const agentRefs = (window.__cotabAgentRefs ||= {});

  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'embed', 'video', 'audio', 'picture', 'map', 'head', 'cotab-ui']);
  const BLOCK = new Set(['div', 'p', 'li', 'ul', 'ol', 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'tr', 'table', 'tbody', 'thead', 'form', 'fieldset', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'figure', 'figcaption', 'details', 'br', 'hr', 'dialog', 'label']);
  const ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'combobox',
    'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem', 'gridcell']);
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const squash = s => String(s || '').replace(/\s+/g, ' ').trim();
  const q = s => `"${clip(squash(s), 80).replace(/"/g, "'")}"`;

  function visible(el) {
    if (el.checkVisibility) return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function interactive(el) {
    const tag = el.localName;
    if (tag === 'a') return el.hasAttribute('href') || el.hasAttribute('onclick');
    if (tag === 'input') return el.type !== 'hidden';
    if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') return true;
    // custom checkboxes / radios hide the real input: their label is what you click
    if (tag === 'label') return !!el.control && !visible(el.control);
    const role = el.getAttribute('role');
    if (role && ROLES.has(role)) return true;
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return true;
    if (el.hasAttribute('onclick')) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && ti !== '-1' && tag !== 'div' && tag !== 'section') return true;
    return false;
  }

  // Divs that act as buttons in single-page apps: pointer cursor, small, and not inside a real control.
  function looksClickable(el, r) {
    if (r.width * r.height > innerWidth * innerHeight * 0.25 || r.width < 8 || r.height < 8) return false;
    if (getComputedStyle(el).cursor !== 'pointer') return false;
    const parent = el.parentElement;
    return !parent || getComputedStyle(parent).cursor !== 'pointer';
  }

  function labelOf(el) {
    const by = el.getAttribute('aria-labelledby');
    const aria = el.getAttribute('aria-label') || (by && squash(by.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ')));
    let text = squash(el.innerText ?? el.textContent);
    if (!text) text = squash(el.querySelector?.('img[alt]')?.alt || el.getAttribute('title') || '');
    return { aria: squash(aria), text };
  }

  function shortName(el) {
    if (!el) return 'the page';
    const field = /^(input|select|textarea)$/.test(el.localName);
    const { aria, text } = labelOf(el);
    const label = squash(el.labels?.[0]?.innerText || '');
    const name = field
      ? label || aria || el.getAttribute('placeholder') || el.getAttribute('name') || el.localName
      : aria || text || el.getAttribute('title') || el.localName;
    return `“${clip(squash(name), 40)}”`;
  }

  function describe(el) {
    const tag = el.localName;
    const role = el.getAttribute('role');
    const attrs = [];
    const { aria, text } = labelOf(el);
    let inner = '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (tag === 'input') attrs.push(`type=${el.type}`);
      if (el.name) attrs.push(`name=${q(el.name)}`);
      const label = el.labels?.[0] ? squash(el.labels[0].innerText) : '';
      if (label) attrs.push(`label=${q(label)}`);
      if (aria && aria !== label) attrs.push(`aria-label=${q(aria)}`);
      if (el.placeholder) attrs.push(`placeholder=${q(el.placeholder)}`);
      if (tag === 'select') {
        const opts = [...el.options].slice(0, 25).map(o => squash(o.text)).filter(Boolean);
        attrs.push(`value=${q(el.selectedOptions[0]?.text || '')}`, `options=${q(opts.join(' | '))}`);
      } else if (/^(checkbox|radio)$/.test(el.type)) {
        if (el.checked) attrs.push('checked');
      } else if (el.type === 'password') {
        attrs.push(`value=${el.value ? '"••••"' : '""'}`);
      } else if (!/^(submit|button|reset|file|image)$/.test(el.type)) {
        attrs.push(`value=${q(el.value)}`);
      } else if (el.value) {
        inner = el.value;
      }
    } else {
      if (tag === 'a') {
        const href = el.getAttribute('href') || '';
        if (href && !href.startsWith('javascript:')) attrs.push(`href=${q(href.replace(location.origin, ''))}`);
      }
      if (aria && aria !== text) attrs.push(`aria-label=${q(aria)}`);
      inner = text;
    }
    if (role && role !== tag) attrs.push(`role=${role}`);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') attrs.push('disabled');
    const exp = el.getAttribute('aria-expanded');
    if (exp) attrs.push(`expanded=${exp}`);
    if (el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current')) attrs.push('selected');
    if (el.getAttribute('aria-checked') === 'true' || (tag === 'label' && el.control?.checked)) attrs.push('checked');
    const open = `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
    return tag === 'input' || tag === 'select' || tag === 'textarea' ? open : `${open}${clip(inner, 100)}</${tag}>`;
  }

  // Chess boards (chess.com and similar) draw each piece as a div named square-XY, and the squares are not elements at all.
  // So a board is one numbered entry, and its squares are clicked by name.
  const SQUARE_RE = /(?:^|\s)square-([1-8])([1-8])(?=\s|$)/;
  const PIECE_RE = /(?:^|\s)([wb])([kqrbnp])(?=\s|$)/;
  const FILES = 'abcdefgh';
  const LETTER = { k: 'K', q: 'Q', r: 'R', b: 'B', n: 'N', p: '' };

  function findChessBoards() {
    const count = new Map();
    for (const el of document.querySelectorAll('[class*="square-"]')) {
      const cls = el.getAttribute('class') || '';
      if (!el.parentElement || !SQUARE_RE.test(cls) || !PIECE_RE.test(cls)) continue;
      count.set(el.parentElement, (count.get(el.parentElement) || 0) + 1);
    }
    return new Set([...count].filter(([, n]) => n >= 2).map(([el]) => el));
  }

  function boardPieces(board) {
    const out = [];
    for (const el of board.children) {
      const cls = el.getAttribute('class') || '';
      const s = SQUARE_RE.exec(cls);
      const p = PIECE_RE.exec(cls);
      if (s && p) out.push({ el, color: p[1] === 'w' ? 'white' : 'black', type: p[2], file: +s[1] - 1, rank: +s[2] - 1 });
    }
    return out;
  }

  // The board's box, and whether it is flipped (black at the bottom). Read from where the pieces are drawn.
  function boardGeometry(board) {
    const rect = board.getBoundingClientRect();
    const sq = rect.width / 8;
    let normal = 0;
    let flipped = 0;
    for (const p of boardPieces(board)) {
      const c = p.el.getBoundingClientRect();
      const col = Math.floor((c.left + c.width / 2 - rect.left) / sq);
      const row = Math.floor((c.top + c.height / 2 - rect.top) / sq);
      if (col === p.file && row === 7 - p.rank) normal++;
      else if (col === 7 - p.file && row === p.rank) flipped++;
    }
    return { rect, sq, flipped: flipped > normal };
  }

  function squarePoint(board, name) {
    const { rect, sq, flipped } = boardGeometry(board);
    const file = FILES.indexOf(name[0]);
    const rank = +name[1] - 1;
    const col = flipped ? 7 - file : file;
    const row = flipped ? rank : 7 - rank;
    return { x: rect.left + (col + 0.5) * sq, y: rect.top + (row + 0.5) * sq };
  }

  function describeBoard(board, n) {
    const { flipped } = boardGeometry(board);
    const pieces = boardPieces(board).sort((a, b) => b.rank - a.rank || a.file - b.file);
    const side = color => pieces.filter(p => p.color === color).map(p => `${LETTER[p.type]}${FILES[p.file]}${p.rank + 1}`).join(' ') || 'none';
    return [
      `<chess board, ${flipped ? 'black' : 'white'} at the bottom. Click a square with index ${n} and square="e4", empty squares too>`,
      `  White: ${side('white')}`,
      `  Black: ${side('black')}`,
    ].join('\n');
  }

  // A compact text view of what's on screen (plus about one screen below), with numbered controls.
  function observe(agentId) {
    const vh = innerHeight;
    const top = -0.3 * vh;
    const bottom = 2 * vh;
    const lines = [];
    const refs = [];
    const boards = findChessBoards();
    let line = '';
    let chars = 0;
    let below = false;
    const MAX_CHARS = 15000;
    const flush = () => {
      const t = squash(line);
      if (t) {
        lines.push(t);
        chars += t.length;
      }
      line = '';
    };
    const visit = node => {
      if (chars > MAX_CHARS || refs.length > 600) return;
      if (node.nodeType === 3) {
        line += node.nodeValue;
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      const tag = el.localName;
      if (SKIP.has(tag) || !visible(el)) return;
      if (boards.has(el)) {
        const r = el.getBoundingClientRect();
        if (r.bottom < top) return;
        if (r.top > bottom) {
          below = true;
          return;
        }
        flush();
        refs.push({ el, board: true });
        const entry = `[${refs.length}]${describeBoard(el, refs.length)}`;
        lines.push(entry);
        chars += entry.length;
        return;
      }
      const block = BLOCK.has(tag);
      const isCtl = interactive(el);
      if (block || isCtl || tag === 'img' || el.shadowRoot) {
        const r = el.getBoundingClientRect();
        if (r.bottom < top) return;
        if (r.top > bottom) {
          below = true;
          return;
        }
        if (isCtl || (tag !== 'body' && !block && looksClickable(el, r)) || (block && tag === 'div' && looksClickable(el, r) && squash(el.innerText).length < 80)) {
          if (r.width < 1 || r.height < 1) return;
          flush();
          refs.push(el);
          const entry = `[${refs.length}]${describe(el)}`;
          lines.push(entry);
          chars += entry.length;
          return;
        }
      }
      if (tag === 'img') {
        if (el.alt && el.width > 40) line += ` [image: ${clip(squash(el.alt), 60)}] `;
        return;
      }
      if (block) flush();
      const heading = /^h([1-6])$/.exec(tag);
      if (heading) line += `${'#'.repeat(+heading[1])} `;
      if (tag === 'li') line += '- ';
      for (const child of el.childNodes) visit(child);
      if (el.shadowRoot) for (const child of el.shadowRoot.childNodes) visit(child);
      if (block) flush();
      else if (tag === 'td' || tag === 'th') line += ' | ';
    };
    visit(document.body || document.documentElement);
    flush();
    agentRefs[agentId] = refs;

    const se = document.scrollingElement || document.documentElement;
    const max = se.scrollHeight - innerHeight;
    const pct = max > 4 ? Math.round((se.scrollTop / max) * 100) : 0;
    const focusIdx = refs.indexOf(input.deepActive()) + 1;
    const where = max <= 4 ? 'the whole page fits on screen' : `scrolled ${pct}% down${below || pct < 98 ? ' · more below' : ' · end of page'}`;
    const header = [`URL: ${location.href}`, `Title: ${document.title}`, `Scroll: ${where}`];
    if (focusIdx) header.push(`Focused: [${focusIdx}]`);
    if (chars > MAX_CHARS) header.push('(page text cut short; scroll or use read_page for the rest)');
    return { url: location.href, title: document.title, text: `${header.join('\n')}\n---\n${lines.join('\n') || '(nothing readable on screen)'}` };
  }

  function readPage() {
    const text = squash((document.body?.innerText || '').replace(/\n{2,}/g, '\n')).slice(0, 30000);
    return { url: location.href, title: document.title, text };
  }

  const KEYCODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ' ': 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35 };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pressKey = k => input.key({ key: k, code: k === ' ' ? 'Space' : k.length === 1 ? `Key${k.toUpperCase()}` : k, keyCode: KEYCODES[k] || k.toUpperCase().charCodeAt(0) });

  function typeInto(el, text, clear) {
    if (input.isTextField(el)) {
      el.focus({ preventScroll: true });
      const value = clear ? text : el.value + text;
      input.setValue(el, value, value.length, 'insertText', text);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) {
      el.focus({ preventScroll: true });
      const sel = getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      if (!clear) range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, text);
      return true;
    }
    return false;
  }

  async function act(agentId, a, who) {
    const refs = agentRefs[agentId] || [];
    const ref = Number.isInteger(a.index) ? refs[a.index - 1] : null;
    const el = ref instanceof Element ? ref : ref?.el || null;
    if (Number.isInteger(a.index) && !el?.isConnected) {
      return { ok: false, text: `Element [${a.index}] isn't on the page anymore. Use the numbers from the latest page view.` };
    }
    const square = ref?.board && a.square ? String(a.square).trim().toLowerCase() : null;
    if (square && !/^[a-h][1-8]$/.test(square)) return { ok: false, text: `“${a.square}” isn't a square name. Use something like e4.` };
    if (!el && ['click', 'type', 'select', 'hover'].includes(a.type)) {
      return { ok: false, text: `${a.type} needs the [number] of an element from the page view.` };
    }
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    }
    const r = el?.getBoundingClientRect();
    const onSquare = square && r?.width ? squarePoint(el, square) : null;
    const x = onSquare ? onSquare.x : r ? r.left + Math.min(r.width / 2, 120) : innerWidth / 2;
    const y = onSquare ? onSquare.y : r ? r.top + r.height / 2 : innerHeight / 2;
    if (who) moveCursor({ ...who, ai: true }, x, y, 12000);
    await sleep(document.hidden ? 0 : 280); // let people see where the helper is going
    const name = square ? `square ${square}` : shortName(el);
    let text = '';
    switch (a.type) {
      case 'click':
        if (who) ripple(who.color, x, y);
        // A square has no element of its own: the click goes to whatever is drawn there (a piece, or the board).
        input.click(square ? input.topElementAt(x, y) : el, x, y, 1);
        text = `Clicked ${name}`;
        break;
      case 'type': {
        let target = el;
        if (target.localName === 'select') return act(agentId, { ...a, type: 'select', option: a.text }, who);
        if (!input.isTextField(target) && !target.isContentEditable) {
          input.click(target, x, y, 1);
          target = input.deepActive();
        }
        if (!target || !typeInto(target, a.text, a.clear !== false)) return { ok: false, text: `${name} isn't a text field. Click it first or pick another element.` };
        if (a.submit) {
          await sleep(50);
          pressKey('Enter');
        }
        text = `Typed “${clip(a.text, 60)}” into ${name}${a.submit ? ' and pressed Enter' : ''}`;
        break;
      }
      case 'select': {
        if (el.localName !== 'select') return { ok: false, text: `${name} isn't a dropdown list. Click it to open it instead.` };
        const want = squash(a.option).toLowerCase();
        const opt = [...el.options].find(o => squash(o.text).toLowerCase() === want || o.value.toLowerCase() === want) ||
          [...el.options].find(o => squash(o.text).toLowerCase().includes(want));
        if (!opt) return { ok: false, text: `No option like “${a.option}” in ${name}. Options: ${[...el.options].map(o => squash(o.text)).join(' | ')}` };
        el.value = opt.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        text = `Picked “${squash(opt.text)}” in ${name}`;
        break;
      }
      case 'hover':
        input.hover(el, x, y);
        text = `Hovered over ${name}`;
        break;
      case 'scroll': {
        const dir = a.direction === 'up' ? -1 : 1;
        const start = el || input.topElementAt(innerWidth / 2, innerHeight / 2);
        const sc = input.findScroller(start, 0, dir);
        const amount = a.amount === 'little' ? innerHeight * 0.4 : innerHeight * 0.85;
        if (a.direction === 'top' || a.direction === 'bottom') input.scrollBy(sc, 0, a.direction === 'top' ? -sc.scrollHeight : sc.scrollHeight);
        else input.scrollBy(sc, 0, dir * amount);
        text = a.direction === 'top' || a.direction === 'bottom' ? `Scrolled to the ${a.direction}` : `Scrolled ${a.direction === 'up' ? 'up' : 'down'}`;
        break;
      }
      case 'key':
        if (el) el.focus({ preventScroll: true });
        pressKey(String(a.key || 'Enter'));
        text = `Pressed ${a.key}`;
        break;
      default:
        return { ok: false, text: `Unknown action ${a.type}` };
    }
    return { ok: true, text, x: x / innerWidth, y: y / innerHeight };
  }

  // Glow around the page + a pill with Stop while a helper is working here.
  function renderAgents(list) {
    if (!list.length && !root) return;
    const r = ui();
    const frame = r.querySelector('.ai-frame');
    const pill = r.querySelector('.ai-pill');
    if (!list.length) {
      frame.classList.remove('on');
      pill.hidden = true;
      for (const [id, c] of cursors) if (id.startsWith('ai-')) c.el.classList.add('idle');
      return;
    }
    const a = list[0];
    frame.style.setProperty('--c', a.color);
    frame.classList.add('on');
    pill.style.setProperty('--c', a.color);
    pill.hidden = false;
    const more = list.length > 1 ? ` <span>+${list.length - 1} more</span>` : '';
    pill.innerHTML = `<span class="ai-av">${SPARKLE}</span>
      <span class="ai-text"><b>${esc(a.name)}</b>${a.by ? ` <span>(${esc(a.by)}'s AI)</span>` : ''} <span>· ${esc(a.label || 'Working…')}</span>${more}</span>
      <button title="Stop this AI helper">Stop</button>`;
    pill.querySelector('button').onclick = () => call({ type: 'agent-stop-from-page', agentId: a.id });
  }

  // ---------------------------------------------------------------- invite landing page

  const inviteMeta = document.querySelector('meta[name="cotab-invite"]');
  if (inviteMeta) {
    const code = inviteMeta.content;
    const server = document.querySelector('meta[name="cotab-server"]')?.content;
    const nameInput = document.getElementById('cotab-name');
    const btn = document.getElementById('cotab-join');
    document.documentElement.dataset.cotab = 'ready';
    call({ type: 'invite-info' }).then(r => {
      if (r?.ok && nameInput && !nameInput.value) nameInput.value = r.value.name;
    });
    if (btn) {
      const join = async () => {
        btn.disabled = true;
        btn.textContent = 'Joining…';
        const r = await call({ type: 'invite-join', code, server, name: nameInput?.value });
        if (r?.ok) {
          document.documentElement.dataset.cotab = 'joined';
        } else {
          btn.disabled = false;
          btn.textContent = r?.error ? `Couldn't join: ${r.error}` : 'Join room →';
        }
      };
      btn.onclick = join;
      if (nameInput) nameInput.onkeydown = e => e.key === 'Enter' && join();
    }
  }

  // ---------------------------------------------------------------- wiring

  const onMessage = (msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'ping':
        sendResponse('pong');
        return;
      case 'share-state':
        setState(msg);
        return;
      case 'control':
        if (msg.from && msg.event) onControl(msg.from, msg.event);
        return;
      case 'toast':
        showToast(msg.toast);
        return;
      case 'toast-close':
        openToasts.get(msg.id)?.();
        return;
      case 'mirror-init-request':
        sendInit(msg.to);
        return;
      case 'agent-observe':
        sendResponse(observe(msg.agentId));
        return;
      case 'agent-read':
        sendResponse(readPage());
        return;
      case 'agent-act':
        act(msg.agentId, msg.action, msg.who).then(sendResponse, e => sendResponse({ ok: false, text: e.message }));
        return true;
      case 'agent-ui':
        renderAgents(msg.agents || []);
        return;
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);

  // Back/forward can restore a page from Chrome's cache without reloading it: stream it fresh.
  const onPageShow = e => {
    if (!e.persisted) return;
    call({ type: 'hello' }).then(r => {
      if (!r?.ok) return;
      setState(r.value);
      if (r.value.shared) toRecorder({ t: 'start' });
    });
  };
  addEventListener('pageshow', onPageShow);

  window.__cotab = {
    destroy() {
      try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
      removeEventListener('pageshow', onPageShow);
      removeEventListener('resize', onResize);
      document.removeEventListener('cotab:rec', onRecorder);
      host?.remove();
    },
  };

  call({ type: 'hello' }).then(r => {
    if (!r?.ok) return;
    setState(r.value);
    // If this copy replaced an older one, the page recorder is already running and the old copy
    // holds the snapshot. Ask for a fresh one so we can catch up late joiners.
    if (r.value.shared) setTimeout(() => !rec && toRecorder({ t: 'resync' }), 600);
  });
})();
