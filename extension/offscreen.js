// CoTab video engine (offscreen document). The live page mirror is the main view; this adds
// a video + sound feed of a shared tab for things a page mirror can't show (players, canvas apps).
// One RTCPeerConnection per (viewer, tab).

const captures = new Map(); // tabId -> { stream, audioCtx }
const peers = new Map();    // pcId -> { pc, tabId, viewerId, quality }
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

// Thumbnails get a cheap, small stream; the tab you're focused on gets the sharp one.
const QUALITY = {
  full: { maxBitrate: 8_000_000, maxFramerate: 30, scaleResolutionDownBy: 1 },
  thumb: { maxBitrate: 300_000, maxFramerate: 8, scaleResolutionDownBy: 4 },
};
const MAX_W = 2560;
const MAX_H = 1600;

// While we're sharing, keep nudging the service worker: if Chrome ever stops it, this wakes
// it right back up and it rejoins the room before anyone notices.
setInterval(() => {
  if (captures.size) chrome.runtime.sendMessage({ target: 'background', type: 'keepalive' }).catch(() => {});
}, 10000);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  handle(msg).then(
    value => sendResponse({ ok: true, value }),
    e => sendResponse({ ok: false, error: e?.message || String(e) }),
  );
  return true;
});

async function handle(msg) {
  switch (msg.type) {
    case 'start-capture':
      return startCapture(msg);
    case 'stop-capture':
      return stopCapture(msg.tabId);
    case 'list-captures':
      return [...captures.keys()];
    case 'set-ice':
      if (Array.isArray(msg.iceServers) && msg.iceServers.length) iceServers = msg.iceServers;
      return true;
    case 'content-hint': {
      const track = captures.get(msg.tabId)?.stream.getVideoTracks()[0];
      if (track) track.contentHint = msg.hint;
      return true;
    }
    case 'signal':
      return onSignal(msg.from, msg.data);
    case 'drop-viewer':
      for (const [pcId, p] of peers) if (p.viewerId === msg.viewerId) closePeer(pcId);
      return true;
  }
}

async function startCapture({ tabId, streamId, width, height, dpr }) {
  stopCapture(tabId);
  const video = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxFrameRate: 30 };
  if (width && height) {
    // Capture at the screen's real pixel density (capped) so text stays sharp.
    const w = width * Math.min(dpr || 1, 2);
    const h = height * Math.min(dpr || 1, 2);
    const scale = Math.min(1, MAX_W / w, MAX_H / h);
    video.maxWidth = Math.round(w * scale);
    video.maxHeight = Math.round(h * scale);
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { mandatory: video },
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  });

  const [videoTrack] = stream.getVideoTracks();
  videoTrack.contentHint = 'detail'; // keep text crisp, drop frames before resolution

  // Capturing a tab mutes it for its owner: play the audio back locally.
  let audioCtx = null;
  if (stream.getAudioTracks().length) {
    audioCtx = new AudioContext();
    audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);
    audioCtx.resume().catch(() => {});
  }

  videoTrack.addEventListener('ended', () => {
    if (captures.get(tabId)?.stream !== stream) return;
    stopCapture(tabId);
    chrome.runtime.sendMessage({ target: 'background', type: 'capture-ended', tabId }).catch(() => {});
  });
  captures.set(tabId, { stream, audioCtx });
  return true;
}

function stopCapture(tabId) {
  const cap = captures.get(tabId);
  if (!cap) return false;
  captures.delete(tabId);
  for (const [pcId, p] of peers) if (p.tabId === tabId) closePeer(pcId, true);
  cap.stream.getTracks().forEach(t => t.stop());
  cap.audioCtx?.close().catch(() => {});
  return true;
}

function signalOut(to, data) {
  chrome.runtime.sendMessage({ target: 'background', type: 'signal-out', to, data: { dir: 'down', ...data } }).catch(() => {});
}

function closePeer(pcId, notify) {
  const p = peers.get(pcId);
  if (!p) return;
  peers.delete(pcId);
  if (notify) signalOut(p.viewerId, { kind: 'unavailable', pcId });
  try { p.pc.close(); } catch {}
}

async function applyQuality(peer) {
  const sender = peer.pc.getSenders().find(s => s.track?.kind === 'video');
  if (!sender) return;
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  Object.assign(params.encodings[0], QUALITY[peer.quality] || QUALITY.full);
  params.degradationPreference = 'maintain-resolution';
  try {
    await sender.setParameters(params);
  } catch (e) {
    console.warn('setParameters failed', e);
  }
}

async function onSignal(from, data) {
  const { kind, pcId } = data || {};
  if (kind === 'subscribe') {
    const cap = captures.get(data.tabId);
    if (!cap) return signalOut(from, { kind: 'unavailable', pcId });
    closePeer(pcId);
    const pc = new RTCPeerConnection({ iceServers });
    const peer = { pc, tabId: data.tabId, viewerId: from, quality: data.quality || 'full' };
    peers.set(pcId, peer);
    for (const track of cap.stream.getTracks()) pc.addTrack(track, cap.stream);
    pc.onicecandidate = e => {
      if (e.candidate) signalOut(from, { kind: 'ice', pcId, candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') applyQuality(peer);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(pcId);
    };
    await pc.setLocalDescription(await pc.createOffer());
    applyQuality(peer);
    signalOut(from, { kind: 'offer', pcId, sdp: pc.localDescription.toJSON() });
    return true;
  }

  const peer = peers.get(pcId);
  if (!peer || peer.viewerId !== from) return false;
  if (kind === 'answer') {
    await peer.pc.setRemoteDescription(data.sdp);
  } else if (kind === 'ice') {
    await peer.pc.addIceCandidate(data.candidate).catch(() => {});
  } else if (kind === 'quality') {
    peer.quality = data.quality;
    await applyQuality(peer);
  } else if (kind === 'bye') {
    closePeer(pcId);
  }
  return true;
}
