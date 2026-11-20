'use strict';

// Browser side of examples/minimal: watch, move, talk.
// go2rtc's signalling over a WebSocket: {type:'webrtc/offer', value:sdp} out,
// {type:'webrtc/answer', value:sdp} back, {type:'webrtc/candidate', value}
// both ways.

const video = document.getElementById('video');
const statusEl = document.getElementById('status');
const soundBtn = document.getElementById('sound');
const pad = document.getElementById('pad');
const talkBtn = document.getElementById('talk');
const note = document.getElementById('note');

const say = (text) => (note.textContent = text || '');
const wsUrl = (p) => (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + p;
const capture = (el, e) => {
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    /* the pointer is already gone */
  }
};
const send = (ws, type, value) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type, value }));

function parse(data) {
  try {
    return JSON.parse(data);
  } catch {
    return {};
  }
}

/* ---- watch: receive only */

function watch() {
  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  const stream = new MediaStream();
  pc.ontrack = (e) => {
    stream.addTrack(e.track);
    video.srcObject = stream;
  };
  const ws = new WebSocket(wsUrl('/api/ws'));
  pc.onicecandidate = (e) => send(ws, 'webrtc/candidate', e.candidate ? e.candidate.candidate : '');
  pc.onconnectionstatechange = () => {
    statusEl.textContent = pc.connectionState;
    if (pc.connectionState === 'failed') ws.close();
  };
  ws.onopen = async () => {
    await pc.setLocalDescription(await pc.createOffer());
    send(ws, 'webrtc/offer', pc.localDescription.sdp);
  };
  ws.onmessage = async (e) => {
    const msg = parse(e.data);
    if (msg.type === 'webrtc/answer') await pc.setRemoteDescription({ type: 'answer', sdp: msg.value });
    else if (msg.type === 'webrtc/candidate' && msg.value) pc.addIceCandidate({ candidate: msg.value, sdpMid: '0' }).catch(() => {});
    else if (msg.type === 'error') statusEl.textContent = 'go2rtc: ' + msg.value;
  };
  // When the server closes the socket, hang up the media too: go2rtc keeps
  // the peer connection otherwise (docs/GO2RTC-PITFALLS.md).
  ws.onclose = () => {
    pc.close();
    statusEl.textContent = 'disconnected, retrying';
    setTimeout(watch, 3000);
  };
}

soundBtn.addEventListener('click', () => {
  video.muted = !video.muted;
  soundBtn.textContent = video.muted ? 'Sound on' : 'Sound off';
});

/* ---- move: hold a key; the server stops the camera if renewals stop */

let holdEvery = 300;
let holding = null; // { press, dir, key, timer }

function randomId() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function post(p, body) {
  return fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), keepalive: true });
}

function press(key) {
  if (holding) release();
  const h = { press: randomId(), dir: key.dataset.dir, key, timer: 0 };
  holding = h;
  key.classList.add('on');
  const move = () =>
    post('/api/ptz/move', { press: h.press, direction: h.dir }).then(
      async (res) => {
        if (res.ok || holding !== h) return;
        const data = await res.json().catch(() => ({}));
        say(data.error === 'busy' ? 'Someone else is moving the camera.' : `Camera did not move (${data.error || res.status}).`);
        release();
      },
      () => holding === h && (say('Server not reachable.'), release())
    );
  move();
  h.timer = setInterval(move, holdEvery);
}

function release() {
  const h = holding;
  if (!h) return;
  holding = null;
  clearInterval(h.timer);
  h.key.classList.remove('on');
  post('/api/ptz/stop', { press: h.press }).catch(() => {});
}

for (const key of pad.querySelectorAll('[data-dir]')) {
  key.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    capture(key, e);
    press(key);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) key.addEventListener(type, release);
  key.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), e.repeat || press(key)));
  key.addEventListener('keyup', (e) => (e.key === 'Enter' || e.key === ' ') && release());
  key.addEventListener('contextmenu', (e) => e.preventDefault());
}

/* ---- talk: hold to send the microphone to the camera's speaker */

let talking = null;

// The camera's backchannel takes PCMU (G.711 u-law, 8 kHz). Offer only G.711.
function preferG711(transceiver) {
  const caps = window.RTCRtpSender && RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('audio');
  if (!caps || !transceiver.setCodecPreferences) return;
  const pick = (mime) => caps.codecs.filter((c) => c.mimeType.toLowerCase() === mime);
  const g711 = [...pick('audio/pcmu'), ...pick('audio/pcma')];
  if (g711.length) transceiver.setCodecPreferences(g711);
}

async function talkStart() {
  if (talking) return;
  const t = { done: false, stream: null, pc: null, ws: null, muted: video.muted };
  talking = t;
  talkBtn.classList.add('on');
  video.muted = true; // do not play the room back into the microphone
  try {
    t.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (err) {
    talkEnd(t);
    return say('Microphone not available: ' + err.name);
  }
  if (t.done) return t.stream.getTracks().forEach((track) => track.stop()); // released while the browser asked
  const pc = (t.pc = new RTCPeerConnection({ iceServers: [] }));
  const transceiver = pc.addTransceiver(t.stream.getAudioTracks()[0], { direction: 'sendonly' });
  preferG711(transceiver);
  const ws = (t.ws = new WebSocket(wsUrl('/api/talk')));
  pc.onicecandidate = (e) => send(ws, 'webrtc/candidate', e.candidate ? e.candidate.candidate : '');
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') say('Talking.');
    if (pc.connectionState === 'failed') talkEnd(t, 'Could not connect to the camera.');
  };
  ws.onopen = async () => {
    await pc.setLocalDescription(await pc.createOffer());
    send(ws, 'webrtc/offer', pc.localDescription.sdp);
  };
  ws.onmessage = async (e) => {
    const msg = parse(e.data);
    if (msg.type === 'webrtc/answer') await pc.setRemoteDescription({ type: 'answer', sdp: msg.value }).catch(() => talkEnd(t, 'go2rtc refused the call.'));
    else if (msg.type === 'webrtc/candidate' && msg.value) pc.addIceCandidate({ candidate: msg.value, sdpMid: transceiver.mid || '0' }).catch(() => {});
    else if (msg.type === 'error') talkEnd(t, 'go2rtc: ' + msg.value);
  };
  const why = { 4409: 'Someone else is talking.', 4408: 'Time limit reached.', 1008: 'The server refused the offer.' };
  ws.onclose = (e) => talkEnd(t, why[e.code] || (e.code === 1000 ? '' : 'Talk ended.'));
}

// Every way a press ends comes here: the microphone, the peer connection and
// the socket all close.
function talkEnd(t = talking, message) {
  if (!t || t.done) return;
  t.done = true;
  if (t.stream) t.stream.getTracks().forEach((track) => track.stop());
  if (t.pc) t.pc.close();
  if (t.ws) {
    t.ws.onclose = null;
    t.ws.close();
  }
  if (talking === t) talking = null;
  talkBtn.classList.remove('on');
  video.muted = t.muted;
  if (message !== undefined) say(message);
}

talkBtn.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || talkBtn.disabled) return;
  e.preventDefault();
  capture(talkBtn, e);
  talkStart();
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) talkBtn.addEventListener(type, () => talkEnd());
talkBtn.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), e.repeat || talkStart()));
talkBtn.addEventListener('keyup', (e) => (e.key === 'Enter' || e.key === ' ') && talkEnd());
talkBtn.addEventListener('contextmenu', (e) => e.preventDefault());

/* ---- anything that takes the page away ends a press */

const releaseAll = () => (release(), talkEnd());
window.addEventListener('blur', releaseAll);
window.addEventListener('pagehide', releaseAll);
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && releaseAll());

/* ---- start */

fetch('/api/info')
  .then((res) => res.json())
  .then((info) => {
    if (info.ptz) {
      holdEvery = Math.max(150, Math.floor(info.holdMs / 3));
      pad.hidden = false;
    }
    if (info.talk) {
      talkBtn.hidden = false;
      // Browsers only open the microphone on https:// or http://localhost.
      if (!window.isSecureContext || !navigator.mediaDevices) {
        talkBtn.disabled = true;
        say('Talking needs https:// or http://localhost; the browser will not open the microphone here.');
      }
    }
  })
  .catch(() => say('Could not read /api/info.'));

watch();
