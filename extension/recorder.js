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
  if (!rr?.record || !window.__cotabInput) return;

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

  const input = window.__cotabInput;

  // Viewers watching the live page tell us exactly which element they pointed at.
  function targetOf(ev, x, y) {
    if (ev.id != null && rr.record.mirror) {
      let n = rr.record.mirror.getNode(ev.id);
      if (n && n.nodeType !== 1) n = n.parentElement;
      if (n?.isConnected) return n;
    }
    return input.topElementAt(x, y);
  }

  function control(ev) {
    const x = (Number.isFinite(+ev.x) ? +ev.x : 0.5) * innerWidth;
    const y = (Number.isFinite(+ev.y) ? +ev.y : 0.5) * innerHeight;
    switch (ev.type) {
      case 'move':
        input.hover(targetOf(ev, x, y), x, y);
        break;
      case 'click':
        input.click(targetOf(ev, x, y), x, y, ev.count === 2 ? 2 : 1);
        break;
      case 'wheel':
        input.wheel(targetOf(ev, x, y), x, y, Number(ev.dx) || 0, Number(ev.dy) || 0);
        break;
      case 'key':
        if (typeof ev.key === 'string' && ev.key) input.key(ev);
        break;
      case 'text':
        if (typeof ev.text === 'string') input.insertText(input.deepActive(), ev.text.slice(0, 5000));
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
