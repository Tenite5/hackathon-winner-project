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
  `;

  function ui() {
    if (root && host.isConnected) return root;
    host = document.createElement('cotab-ui');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style><div class="cursors"></div><div class="toasts"></div><div class="pill" hidden></div>`;
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

  function moveCursor(from, x, y) {
    let c = cursors.get(from.id);
    if (!c) {
      const el = document.createElement('div');
      el.className = 'cursor';
      el.style.setProperty('--c', from.color);
      el.innerHTML = `${ARROW(from.color)}<span class="label">${esc(from.name)}</span>`;
      c = { el, timer: 0 };
      cursors.set(from.id, c);
    }
    if (!c.el.isConnected) ui().querySelector('.cursors').appendChild(c.el);
    c.el.classList.remove('idle');
    c.el.style.transform = `translate3d(${x - 2}px,${y - 2}px,0)`;
    clearTimeout(c.timer);
    c.timer = setTimeout(() => c.el.classList.add('idle'), 3000);
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
