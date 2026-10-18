// CoTab page recorder. Injected into the page's own JS world, only in tabs you share.
// It streams the live DOM with rrweb so viewers see the real page (not a video), reports
// your pointer, and replays remote clicks / typing / scrolling on the exact element.
(() => {
  const OUT = 'cotab:rec'; // recorder -> content script
  const IN = 'cotab:cmd';  // content script -> recorder

  if (window.__cotabRecorder) {
    window.__cotabRecorder.ensure();
    return;
  }
  const rr = window.rrwebRecord;
  if (!rr?.record) return;

  const send = detail => document.dispatchEvent(new CustomEvent(OUT, { detail }));
  const sendJson = msg => send(JSON.stringify(msg));

  let stopRecording = null;
  let session = '';
  let seq = 0;          // events sent so far in this session
  let queue = [];
  let reset = false;    // next batch starts with a full snapshot
  let flushQueued = false;
  let active = false;
  let startedAt = 0;

  // Batches go out once per task (microtasks keep working when the tab is in the background).
  function flush() {
    flushQueued = false;
    if (!queue.length) return;
    const events = queue;
    queue = [];
    // header|payload so the content script can forward the payload without re-parsing it
    send(`E|${session}|${reset ? 1 : 0}|${seq}|${events.length}|${JSON.stringify(events)}`);
    seq += events.length;
    reset = false;
  }

  // Viewers need the same scrollbar width as yours, or their copy of the page lays out a few
  // pixels wider and everything centered shifts sideways.
  function scrollbarWidth() {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden';
    (document.body || document.documentElement).appendChild(probe);
    const w = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    return w;
  }
  let sbWidth = 0;
  const announceScrollbar = () => {
    try { rr.record.addCustomEvent('cotab-scrollbar', { w: sbWidth }); } catch {}
  };
  const snapshot = () => {
    rr.record.takeFullSnapshot(true);
    announceScrollbar();
  };

  function start() {
    stopRecording?.();
    sbWidth = scrollbarWidth(); // measured before recording so the probe isn't streamed
    session = Math.random().toString(36).slice(2, 10);
    seq = 0;
    queue = [];
    reset = true;
    active = true;
    startedAt = performance.now();
    stopRecording = rr.record({
      emit(event, isCheckout) {
        if (isCheckout) {
          flush();
          reset = true;
        }
        queue.push(event);
        if (!flushQueued) {
          flushQueued = true;
          queueMicrotask(flush);
        }
      },
      blockSelector: 'cotab-ui',
      maskInputOptions: { password: true },
      sampling: { mousemove: false, mouseInteraction: false, scroll: 30, media: 400 },
      slimDOMOptions: {
        script: true,
        comment: true,
        headFavicon: true,
        headWhitespace: true,
        headMetaSocial: true,
        headMetaRobots: true,
        headMetaHttpEquiv: true,
        headMetaVerification: true,
        headMetaAuthorship: true,
        headMetaDescKeywords: true,
      },
      recordCanvas: false,
      recordAfter: 'DOMContentLoaded',
      errorHandler: () => true,
    });
    announceScrollbar();
    lastMedia = null;
    checkMedia();
  }

  function stop() {
    active = false;
    stopRecording?.();
    stopRecording = null;
    queue = [];
  }

  // ---------------------------------------------------------------- your pointer, for viewers

  let lastMove = 0;
  addEventListener(
    'pointermove',
    e => {
      if (!active || !e.isTrusted) return;
      const now = performance.now();
      if (now - lastMove < 30) return;
      lastMove = now;
      sendJson({ t: 'cursor', x: e.clientX / innerWidth, y: e.clientY / innerHeight });
    },
    { capture: true, passive: true },
  );
  document.documentElement.addEventListener('mouseleave', () => active && sendJson({ t: 'cursor', gone: true }));

  // ---------------------------------------------------------------- videos / canvases look better as a video feed

  let lastMedia = null;
  function checkMedia() {
    if (!active) return;
    const area = innerWidth * innerHeight;
    const big = el => {
      const r = el.getBoundingClientRect();
      return r.width * r.height > area * 0.18 && r.bottom > 0 && r.top < innerHeight;
    };
    const media =
      [...document.querySelectorAll('video')].some(v => !v.paused && !v.ended && big(v)) ||
      [...document.querySelectorAll('canvas')].some(c => big(c) && c.width * c.height > 200000);
    if (media !== lastMedia) {
      lastMedia = media;
      sendJson({ t: 'media', media });
    }
  }
  setInterval(checkMedia, 2000);
  document.addEventListener('play', checkMedia, true);
  document.addEventListener('pause', checkMedia, true);

  // ---------------------------------------------------------------- replaying remote input

  const isUi = el => el?.localName === 'cotab-ui';

  function topElementAt(x, y) {
    let el = document.elementsFromPoint(x, y).find(e => !isUi(e)) || document.body;
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // Viewers watching the live page tell us exactly which element they pointed at.
  function targetOf(ev, x, y) {
    if (ev.id != null && rr.record.mirror) {
      let n = rr.record.mirror.getNode(ev.id);
      if (n && n.nodeType !== 1) n = n.parentElement;
      if (n?.isConnected) return n;
    }
    return topElementAt(x, y);
  }

  function deepActive() {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return a && a !== document.body && a !== document.documentElement ? a : null;
  }

  const TEXT_INPUT = /^(text|search|email|url|tel|password|number)$/i;
  const isTextField = el => !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT_INPUT.test(el.type || 'text')));

  const mouseInit = (x, y, extra) => ({
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: x, clientY: y, screenX: x, screenY: y, button: 0, ...extra,
  });
  const PTR = { pointerId: 1, pointerType: 'mouse', isPrimary: true };

  let hoverEl = null;
  function hover(el, x, y) {
    if (hoverEl !== el) {
      hoverEl?.dispatchEvent(new MouseEvent('mouseout', mouseInit(x, y, { relatedTarget: el })));
      el.dispatchEvent(new PointerEvent('pointerover', mouseInit(x, y, PTR)));
      el.dispatchEvent(new MouseEvent('mouseover', mouseInit(x, y, { relatedTarget: hoverEl })));
      hoverEl = el;
    }
    el.dispatchEvent(new PointerEvent('pointermove', mouseInit(x, y, PTR)));
    el.dispatchEvent(new MouseEvent('mousemove', mouseInit(x, y)));
  }

  function focusFor(el, x, y) {
    const target =
      el.closest?.('input,textarea,select,button,a[href],[contenteditable=""],[contenteditable="true"],[tabindex]') ||
      (el.isContentEditable ? el : null);
    if (!target) {
      deepActive()?.blur?.();
      return;
    }
    target.focus({ preventScroll: true });
    if (isTextField(target)) {
      try {
        const n = target.value.length;
        target.setSelectionRange(n, n);
      } catch {}
    } else if (target.isContentEditable) {
      const range = document.caretRangeFromPoint?.(x, y);
      if (range) {
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }

  function click(el, x, y, count) {
    el.dispatchEvent(new PointerEvent('pointerdown', mouseInit(x, y, { ...PTR, buttons: 1 })));
    const ok = el.dispatchEvent(new MouseEvent('mousedown', mouseInit(x, y, { buttons: 1, detail: count })));
    if (ok) focusFor(el, x, y);
    el.dispatchEvent(new PointerEvent('pointerup', mouseInit(x, y, PTR)));
    el.dispatchEvent(new MouseEvent('mouseup', mouseInit(x, y, { detail: count })));
    el.dispatchEvent(new MouseEvent('click', mouseInit(x, y, { detail: count }))); // follows links, presses buttons
    if (count === 2) el.dispatchEvent(new MouseEvent('dblclick', mouseInit(x, y, { detail: 2 })));
  }

  function canScroll(el, dx, dy) {
    const s = getComputedStyle(el);
    if (dy) {
      if (!/(auto|scroll|overlay)/.test(s.overflowY) || el.scrollHeight <= el.clientHeight + 1) return false;
      return dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0;
    }
    if (!/(auto|scroll|overlay)/.test(s.overflowX) || el.scrollWidth <= el.clientWidth + 1) return false;
    return dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0;
  }

  function findScroller(start, dx, dy) {
    let el = start;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.nodeType === 1 && canScroll(el, dx, dy)) return el;
      el = el.parentElement || el.getRootNode?.().host || null;
    }
    return document.scrollingElement || document.documentElement;
  }

  // Background tabs don't fire scroll events (no rendering), so announce scrolls ourselves.
  function scrollBy(el, dx, dy) {
    el.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    (el === document.scrollingElement ? document : el).dispatchEvent(new Event('scroll'));
  }

  const anims = new WeakMap();
  function smoothScroll(el, dx, dy) {
    if (document.hidden) return scrollBy(el, dx, dy);
    let a = anims.get(el);
    if (!a) anims.set(el, (a = { dx: 0, dy: 0, raf: 0 }));
    a.dx += dx;
    a.dy += dy;
    if (a.raf) return;
    const step = () => {
      const sx = Math.abs(a.dx) < 2 ? a.dx : a.dx * 0.4;
      const sy = Math.abs(a.dy) < 2 ? a.dy : a.dy * 0.4;
      scrollBy(el, sx, sy);
      a.dx -= sx;
      a.dy -= sy;
      a.raf = Math.abs(a.dx) > 0.5 || Math.abs(a.dy) > 0.5 ? requestAnimationFrame(step) : 0;
      if (!a.raf) a.dx = a.dy = 0;
    };
    a.raf = requestAnimationFrame(step);
  }

  function wheel(el, x, y, dx, dy) {
    const ok = el.dispatchEvent(new WheelEvent('wheel', { ...mouseInit(x, y), deltaX: dx, deltaY: dy, deltaMode: 0 }));
    if (!ok) return;
    const vertical = Math.abs(dy) >= Math.abs(dx);
    smoothScroll(findScroller(el, vertical ? 0 : dx, vertical ? dy : 0), vertical ? 0 : dx, vertical ? dy : 0);
  }

  function selRange(el) {
    const n = el.value.length;
    try {
      return [el.selectionStart ?? n, el.selectionEnd ?? n];
    } catch {
      return [n, n];
    }
  }

  function setValue(el, value, caret, inputType, data = null) {
    if (!el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType, data }))) return;
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); // native setter, so React & co. notice
    try { el.setSelectionRange(caret, caret); } catch {}
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType, data }));
  }

  function insertText(el, text) {
    if (isTextField(el)) {
      const [s, e] = selRange(el);
      setValue(el, el.value.slice(0, s) + text + el.value.slice(e), s + text.length, 'insertText', text);
    } else if (el?.isContentEditable) {
      document.execCommand('insertText', false, text);
    }
  }

  function moveFocus(dir) {
    const items = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]')]
      .filter(e => !e.disabled && e.offsetParent !== null);
    if (!items.length) return;
    const i = items.indexOf(deepActive());
    items[(i + dir + items.length) % items.length].focus();
  }

  function editField(el, ev) {
    const k = ev.key;
    const v = el.value;
    let [s, e] = selRange(el);
    const caret = pos => { try { el.setSelectionRange(pos, pos); } catch {} };
    if (ev.ctrl || ev.meta) {
      if (k.toLowerCase() === 'a') el.select();
      if (k === 'Backspace') {
        const head = v.slice(0, s).replace(/\S+\s*$/, '');
        setValue(el, head + v.slice(e), head.length, 'deleteWordBackward');
      }
      return;
    }
    if (k.length === 1) return insertText(el, k);
    switch (k) {
      case 'Backspace':
        if (s === e && s > 0) s--;
        if (s !== e) setValue(el, v.slice(0, s) + v.slice(e), s, 'deleteContentBackward');
        return;
      case 'Delete':
        if (s === e && e < v.length) e++;
        if (s !== e) setValue(el, v.slice(0, s) + v.slice(e), s, 'deleteContentForward');
        return;
      case 'Enter': {
        const singleLine = el.tagName === 'INPUT' || el.getAttribute('role') === 'combobox' || el.rows <= 1;
        if (singleLine && !ev.shift) {
          if (el.form) {
            try { el.form.requestSubmit(); } catch { el.form.submit(); }
          }
          return;
        }
        return setValue(el, v.slice(0, s) + '\n' + v.slice(e), s + 1, 'insertLineBreak');
      }
      case 'ArrowLeft': return caret(s === e ? Math.max(0, s - 1) : s);
      case 'ArrowRight': return caret(s === e ? Math.min(v.length, e + 1) : e);
      case 'Home': return caret(0);
      case 'End': return caret(v.length);
      case 'ArrowUp': if (el.tagName === 'INPUT') caret(0); return;
      case 'ArrowDown': if (el.tagName === 'INPUT') caret(v.length); return;
      case 'Tab': return moveFocus(ev.shift ? -1 : 1);
      case 'Escape': return el.blur();
    }
  }

  function editRich(ev) {
    const k = ev.key;
    const sel = getSelection();
    const mode = ev.shift ? 'extend' : 'move';
    if (ev.ctrl || ev.meta) {
      const cmd = { a: 'selectAll', b: 'bold', i: 'italic', u: 'underline', z: 'undo', y: 'redo' }[k.toLowerCase()];
      if (cmd) document.execCommand(cmd);
      return;
    }
    if (k.length === 1) return document.execCommand('insertText', false, k);
    switch (k) {
      case 'Backspace': return document.execCommand('delete');
      case 'Delete': return document.execCommand('forwardDelete');
      case 'Enter': return document.execCommand(ev.shift ? 'insertLineBreak' : 'insertParagraph');
      case 'ArrowLeft': return sel.modify(mode, 'backward', 'character');
      case 'ArrowRight': return sel.modify(mode, 'forward', 'character');
      case 'ArrowUp': return sel.modify(mode, 'backward', 'line');
      case 'ArrowDown': return sel.modify(mode, 'forward', 'line');
      case 'Home': return sel.modify(mode, 'backward', 'lineboundary');
      case 'End': return sel.modify(mode, 'forward', 'lineboundary');
      case 'Tab': return moveFocus(ev.shift ? -1 : 1);
      case 'Escape': return deepActive()?.blur();
    }
  }

  function pageKey(el, ev) {
    const k = ev.key;
    if (ev.alt && k === 'ArrowLeft') return history.back();
    if (ev.alt && k === 'ArrowRight') return history.forward();
    if (k === 'Tab') return moveFocus(ev.shift ? -1 : 1);
    if (el && (k === 'Enter' || k === ' ') && (/^(A|BUTTON|SUMMARY)$/.test(el.tagName) || el.getAttribute('role') === 'button' || /^(checkbox|radio|submit|button)$/.test(el.type))) {
      return el.click();
    }
    const page = innerHeight * 0.85;
    const deltas = { ArrowDown: 80, ArrowUp: -80, PageDown: page, PageUp: -page, ' ': ev.shift ? -page : page };
    const center = topElementAt(innerWidth / 2, innerHeight / 2);
    if (k in deltas) return smoothScroll(findScroller(center, 0, deltas[k]), 0, deltas[k]);
    if (k === 'ArrowRight' || k === 'ArrowLeft') {
      const dx = k === 'ArrowRight' ? 80 : -80;
      return smoothScroll(findScroller(center, dx, 0), dx, 0);
    }
    if (k === 'Home' || k === 'End') {
      const sc = findScroller(center, 0, k === 'Home' ? -1 : 1);
      return scrollBy(sc, 0, k === 'Home' ? -sc.scrollHeight : sc.scrollHeight);
    }
    if (k === 'Escape') el?.blur?.();
  }

  function key(ev) {
    const el = deepActive();
    const target = el || document.body;
    const init = {
      key: ev.key, code: ev.code, keyCode: ev.keyCode, which: ev.keyCode,
      ctrlKey: !!ev.ctrl, shiftKey: !!ev.shift, altKey: !!ev.alt, metaKey: !!ev.meta,
      bubbles: true, cancelable: true, composed: true, view: window,
    };
    const ok = target.dispatchEvent(new KeyboardEvent('keydown', init));
    if (ok) {
      if (ev.key.length === 1 && !ev.ctrl && !ev.meta) {
        target.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: ev.key.charCodeAt(0) }));
      }
      if (isTextField(el)) editField(el, ev);
      else if (el?.isContentEditable) editRich(ev);
      else pageKey(el, ev);
    }
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function control(ev) {
    const x = (Number.isFinite(+ev.x) ? +ev.x : 0.5) * innerWidth;
    const y = (Number.isFinite(+ev.y) ? +ev.y : 0.5) * innerHeight;
    switch (ev.type) {
      case 'move':
        hover(targetOf(ev, x, y), x, y);
        break;
      case 'click':
        click(targetOf(ev, x, y), x, y, ev.count === 2 ? 2 : 1);
        break;
      case 'wheel':
        wheel(targetOf(ev, x, y), x, y, Number(ev.dx) || 0, Number(ev.dy) || 0);
        break;
      case 'key':
        if (typeof ev.key === 'string' && ev.key) key(ev);
        break;
      case 'text':
        if (typeof ev.text === 'string') insertText(deepActive(), ev.text.slice(0, 5000));
        break;
    }
  }

  document.addEventListener(IN, e => {
    let msg;
    try { msg = JSON.parse(e.detail); } catch { return; }
    if (msg.t === 'control' && msg.event) control(msg.event);
    else if (msg.t === 'checkout' && active) snapshot();
    // a fresh content script needs a full snapshot to hand to late joiners
    else if (msg.t === 'resync' && active && performance.now() - startedAt > 800) snapshot();
    else if (msg.t === 'stop') stop();
    else if (msg.t === 'start') start();
  });

  window.__cotabRecorder = { ensure: () => !active && start() };
  start();
})();
