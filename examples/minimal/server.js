'use strict';

// A small reference app on top of ezviz-local and go2rtc:
//   - live video through go2rtc's WebRTC (this server relays the signalling),
//   - a hold-to-move pan/tilt pad (this server talks to the camera's port 8000),
//   - hold-to-talk through the camera's speaker, only when TALK=1.
//
// Start go2rtc with examples/go2rtc.yaml, then:
//   npm install
//   read -rs EZVIZ_PASSWORD && export EZVIZ_PASSWORD
//   EZVIZ_HOST=192.0.2.10 node server.js
// and open http://127.0.0.1:8080
//
// Environment:
//   EZVIZ_HOST, EZVIZ_PASSWORD  the camera (password = verification code).
//                               Without them the pad is hidden.
//   EZVIZ_PORT                  command port, default 8000
//   GO2RTC_URL                  default http://127.0.0.1:1984
//   STREAM, TALK_STREAM         go2rtc stream names, default camera and talk
//   TALK=1                      allow hold-to-talk
//   HOST, PORT                  default 127.0.0.1 and 8080
//   PASSWORD                    HTTP Basic auth password (any user name).
//                               Required to listen on a non-loopback address.
//
// Known gap: closing a go2rtc /api/ws socket does not close the WebRTC peer
// connection it set up (go2rtc v1.9.9). The media flows browser <-> go2rtc
// :8555 and never through this server. So the talk time limit and closing a
// viewer's socket only end the media if the page hangs up, which app.js does.
// A modified page that ignores the close keeps its picture, or the speaker,
// until it hangs up itself. docs/GO2RTC-PITFALLS.md (4) has ways to enforce
// it; this example does not.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { control, ptzFrameTail, PTZ } = require('../../lib');

const env = process.env;
const CAMERA = { host: env.EZVIZ_HOST || '', password: env.EZVIZ_PASSWORD || '', port: Number(env.EZVIZ_PORT || 8000) };
const PTZ_ON = Boolean(CAMERA.host && CAMERA.password);
const GO2RTC_WS = (env.GO2RTC_URL || 'http://127.0.0.1:1984').replace(/^http/i, 'ws').replace(/\/+$/, '');
const STREAM = env.STREAM || 'camera';
const TALK_STREAM = env.TALK_STREAM || 'talk';
const TALK = env.TALK === '1';
const HOST = env.HOST || '127.0.0.1';
const PORT = Number(env.PORT || 8080);
const PASSWORD = env.PASSWORD || '';
const HOLD_MS = 900; // a move stops this long after the browser's last renewal
const MAX_RUN_MS = 8000; // and never runs longer than this
const TALK_MAX_MS = 60000;

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|localhost)$/i;
if (!LOOPBACK.test(HOST) && !PASSWORD) {
  console.error(`Refusing to listen on ${HOST} without PASSWORD. Set PASSWORD (HTTP Basic auth) or use HOST=127.0.0.1.`);
  process.exit(1);
}

/* ---- who may ask */

function authorised(req) {
  if (!PASSWORD) return true;
  const m = /^Basic\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const given = Buffer.from(m[1], 'base64').toString('utf8');
  const digest = (s) => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(digest(given.slice(given.indexOf(':') + 1)), digest(PASSWORD));
}

// Without a password, only accept loopback Host headers: a web page on
// another site cannot then reach this server through DNS rebinding.
function hostAllowed(req) {
  if (PASSWORD) return true;
  const host = (req.headers.host || '').replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  return LOOPBACK.test(host);
}

// Browsers send Origin on WebSocket upgrades and POSTs; another site's page
// must not drive the camera with this browser's credentials.
function sameOrigin(req) {
  if (!req.headers.origin) return true;
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/* ---- pan/tilt: hold to move, with a lease */

const DIRS = { up: PTZ.UP, down: PTZ.DOWN, left: PTZ.LEFT, right: PTZ.RIGHT };
let moving = null; // { press, dir, command, startedAt, leaseUntil, timer }
const released = new Set(); // presses that ended: a late renewal must not restart them
let chain = Promise.resolve(); // camera writes in order, so a stop never overtakes its start
let closing = false; // set on shutdown: no new moves after that

function enqueue(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

const send = (command) =>
  control({ ...CAMERA, commandId: PTZ.COMMAND_ID, bodyTail: ptzFrameTail(command, { speed: 4 }), timeoutMs: 4000 });

const PRESS = /^[0-9a-f]{16,64}$/; // a random id per key press, from app.js

function remember(press) {
  released.add(press);
  if (released.size > 64) released.delete(released.values().next().value);
}

async function sendStop(command) {
  for (let i = 1; i <= 3; i++) {
    if (i > 1) await new Promise((r) => setTimeout(r, 200));
    try {
      return await send(PTZ.stopOf(command));
    } catch (err) {
      console.warn(`ptz: stop attempt ${i} failed (${err.code})`);
    }
  }
  console.error('ptz: could not confirm the stop. Check the camera.');
}

// Every way a move ends comes through here, and here the stop is queued.
function endMove(reason) {
  if (!moving) return Promise.resolve();
  const m = moving;
  moving = null;
  clearTimeout(m.timer);
  remember(m.press);
  console.log(`ptz: ${m.dir} stopped (${reason}) after ${Date.now() - m.startedAt} ms`);
  return enqueue(() => sendStop(m.command));
}

function arm(m) {
  clearTimeout(m.timer);
  const capAt = m.startedAt + MAX_RUN_MS;
  const at = Math.min(m.leaseUntil, capAt);
  m.timer = setTimeout(() => moving === m && endMove(Date.now() >= capAt ? 'cap' : 'lease'), Math.max(0, at - Date.now()));
}

async function ptzMove({ press, direction }) {
  if (closing) return [503, { error: 'shutting_down' }];
  if (!Object.hasOwn(DIRS, direction) || !PRESS.test(String(press))) return [400, { error: 'bad_request' }];
  if (released.has(press)) return [409, { error: 'released' }];
  if (moving && moving.press !== press) return [409, { error: 'busy' }]; // one mover at a time
  if (moving) {
    if (moving.dir !== direction) return [400, { error: 'bad_request' }];
    moving.leaseUntil = Date.now() + HOLD_MS;
    arm(moving);
    return [200, { moving: direction }];
  }
  const m = { press, dir: direction, command: DIRS[direction], startedAt: Date.now(), timer: null };
  m.leaseUntil = m.startedAt + HOLD_MS;
  moving = m;
  arm(m);
  try {
    await enqueue(() => send(m.command));
    return [200, { moving: direction }];
  } catch (err) {
    // The start may have reached the camera anyway: stop regardless.
    if (moving === m) await endMove('start_failed');
    return [502, { error: 'camera', code: err.code }];
  }
}

function ptzStop({ press }) {
  if (!PRESS.test(String(press))) return [400, { error: 'bad_request' }];
  remember(press);
  if (moving && moving.press === press) endMove('release');
  return [200, { moving: null }];
}

/* ---- what the browser may say to go2rtc */

const DIRECTIONS = ['sendrecv', 'sendonly', 'recvonly', 'inactive'];

// Which way each media section points. A section with no direction takes the
// session's, else sendrecv (RFC 4566). Two directions at one level, or a line
// we cannot read, is refused rather than guessed.
function sdpSections(sdp) {
  if (sdp.length > 64 * 1024) return null;
  // Browsers end lines with CRLF. A lone CR may split lines differently here
  // than in go2rtc's SDP parser, so refuse it.
  if (/\r(?!\n)/.test(sdp)) return null;
  const session = [];
  const sections = [];
  let cur = null;
  for (const line of sdp.split(/\r\n|\n|\r/)) {
    if (!line) continue;
    if (!/^[a-z]=/.test(line)) return null;
    if (line.startsWith('m=')) {
      const m = /^m=(\S+) (\d+)(?:\/\d+)? \S+((?: \S+)*)\s*$/.exec(line);
      if (!m) return null;
      cur = { kind: m[1].toLowerCase(), port: Number(m[2]), formats: m[3].trim().split(/\s+/).filter(Boolean), dirs: [], codecs: {} };
      sections.push(cur);
    } else if (line.startsWith('a=')) {
      const key = line.slice(2).split(':')[0].trim().toLowerCase();
      if (DIRECTIONS.includes(key)) (cur ? cur.dirs : session).push(key);
      const r = /^a=rtpmap:(\d+)\s+([^/\s]+)\/(\d+)/i.exec(line);
      if (r && cur) cur.codecs[r[1]] = `${r[2].toUpperCase()}/${r[3]}`;
    }
  }
  if (session.length > 1 || sections.some((s) => s.dirs.length > 1)) return null;
  for (const s of sections) s.direction = s.dirs[0] || session[0] || 'sendrecv';
  return sections;
}

// Watching only receives. Anything that could send into go2rtc (and from
// there to a backchannel) is refused.
function viewProblem(sdp) {
  const sections = sdpSections(sdp);
  if (!sections) return 'unreadable sdp';
  const bad = sections.find((s) => s.kind !== 'application' && s.direction !== 'recvonly' && s.direction !== 'inactive');
  return bad ? `${bad.kind} ${bad.direction}` : null;
}

// Talking is one audio section, sendonly, offering PCMU or PCMA.
function talkProblem(sdp) {
  const sections = sdpSections(sdp);
  if (!sections) return 'unreadable sdp';
  const [s] = sections;
  if (sections.length !== 1 || s.kind !== 'audio' || s.direction !== 'sendonly' || s.port === 0) {
    return 'want one sendonly audio section';
  }
  const g711 = s.formats.some((pt) => ['PCMU/8000', 'PCMA/8000'].includes(s.codecs[pt] || { 0: 'PCMU/8000', 8: 'PCMA/8000' }[pt]));
  return g711 ? null : 'no PCMU or PCMA';
}

// An allow-list. go2rtc reads JSON keys case-insensitively and lets the last
// duplicate win, so we never forward the client's bytes, only our own copy.
function screen(data, isBinary, kind, offered) {
  let msg;
  try {
    msg = isBinary ? null : JSON.parse(data.toString('utf8'));
  } catch {
    /* refused below */
  }
  if (!msg || typeof msg !== 'object' || typeof msg.value !== 'string') return { error: 'bad message' };
  if (msg.type === 'webrtc/candidate') return { text: JSON.stringify({ type: msg.type, value: msg.value }) };
  if (msg.type !== 'webrtc/offer') return { error: 'type not allowed' };
  if (offered) return { error: 'one offer per socket' };
  const problem = kind === 'talk' ? talkProblem(msg.value) : viewProblem(msg.value);
  if (problem) return { error: `offer refused: ${problem}` };
  return { offer: true, text: JSON.stringify({ type: msg.type, value: msg.value }) };
}

let talker = null;

function relay(client, kind) {
  client.on('error', () => client.terminate()); // an unhandled 'error' would end the process
  if (kind === 'talk' && talker) return client.close(4409, 'busy');
  const src = kind === 'talk' ? TALK_STREAM : STREAM;
  const upstream = new WebSocket(`${GO2RTC_WS}/api/ws?src=${encodeURIComponent(src)}`, { handshakeTimeout: 5000, perMessageDeflate: false });
  let offered = false;
  let pending = [];
  let ended = false;
  let cap = null;
  const end = (code = 1000, reason = '') => {
    if (ended) return;
    ended = true;
    clearTimeout(cap);
    if (talker === client) talker = null;
    if (client.readyState === WebSocket.OPEN) client.close(code, reason);
    upstream.terminate();
  };
  if (kind === 'talk') {
    talker = client;
    cap = setTimeout(() => end(4408, 'time limit'), TALK_MAX_MS);
  }

  client.on('message', (data, isBinary) => {
    const out = screen(data, isBinary, kind, offered);
    if (out.error) return end(1008, out.error);
    offered = offered || Boolean(out.offer);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(out.text);
    else if (pending.length < 32) pending.push(out.text);
    else end(1008, 'too many frames');
  });
  client.on('close', () => end());
  upstream.on('open', () => {
    for (const text of pending) upstream.send(text);
    pending = [];
  });
  upstream.on('message', (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(data, { binary: isBinary }));
  upstream.on('close', () => end(1011, 'go2rtc closed'));
  upstream.on('error', (err) => {
    if (ended) return; // we closed it ourselves
    console.warn(`go2rtc (${src}): ${err.message}`);
    end(1011, 'go2rtc unavailable');
  });
}

/* ---- HTTP */

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};
const HEADERS = {
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  'permissions-policy': TALK ? 'microphone=(self), camera=()' : 'microphone=(), camera=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

function json(res, status, body) {
  res.writeHead(status, { ...HEADERS, 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : null);
      } catch {
        resolve(null);
      }
    });
    req.on('close', () => resolve(null));
  });
}

async function handle(req, res) {
  if (!hostAllowed(req)) return json(res, 403, { error: 'host' });
  if (!authorised(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="camera", charset="UTF-8"' });
    return res.end();
  }
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && Object.hasOwn(FILES, pathname)) {
    const [file, type] = FILES[pathname];
    res.writeHead(200, { ...HEADERS, 'content-type': type });
    return res.end(fs.readFileSync(path.join(__dirname, file)));
  }
  if (req.method === 'GET' && pathname === '/api/info') {
    return json(res, 200, { ptz: PTZ_ON, talk: TALK, holdMs: HOLD_MS, maxRunMs: MAX_RUN_MS, talkMaxMs: TALK_MAX_MS });
  }
  if (req.method === 'POST' && (pathname === '/api/ptz/move' || pathname === '/api/ptz/stop')) {
    if (!PTZ_ON) return json(res, 404, { error: 'ptz not configured' });
    // A JSON content type forces a CORS preflight, which this server never answers.
    if (!sameOrigin(req) || !/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 403, { error: 'forbidden' });
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: 'bad_request' });
    const [status, out] = pathname.endsWith('/move') ? await ptzMove(body) : ptzStop(body);
    return json(res, status, out);
  }
  json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) =>
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'internal' });
  })
);

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    ({ pathname } = new URL(req.url, 'http://localhost'));
  } catch {
    return socket.destroy();
  }
  const kind = pathname === '/api/ws' ? 'view' : pathname === '/api/talk' && TALK ? 'talk' : null;
  let refuse = null;
  if (!kind) refuse = 404;
  else if (!hostAllowed(req) || !sameOrigin(req)) refuse = 403;
  else if (!authorised(req)) refuse = 401;
  if (refuse) return socket.end(`HTTP/1.1 ${refuse} ${http.STATUS_CODES[refuse]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  wss.handleUpgrade(req, socket, head, (client) => relay(client, kind));
});

// On the way out, stop the camera first. New moves are refused from here on,
// and the loop catches one that started while the stop was in flight.
async function shutdown(code, reason) {
  if (closing) return;
  closing = true;
  server.close();
  do {
    await endMove(reason);
    await chain;
  } while (moving);
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(0, 'shutdown'));
process.on('uncaughtException', (err) => {
  console.error(err);
  shutdown(1, 'crash');
});

server.listen(PORT, HOST, () => {
  console.log(`Listening on http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`);
  console.log(`pad: ${PTZ_ON ? 'on' : 'off (set EZVIZ_HOST and EZVIZ_PASSWORD)'}, talk: ${TALK ? 'on' : 'off'}, auth: ${PASSWORD ? 'Basic' : 'none (loopback only)'}`);
});
