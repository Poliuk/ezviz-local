'use strict';

// A deliberately small RTSP client: OPTIONS and DESCRIBE only, with Digest
// (RFC 2617, MD5 and MD5-sess, with or without qop=auth) or Basic auth, and
// an SDP reader. It has no SETUP, PLAY or TEARDOWN, so it cannot start a
// media session or send audio.

const net = require('node:net');
const crypto = require('node:crypto');
const { Buffer } = require('node:buffer');
const { EzvizLanError } = require('./protocol');

const MAX_HEAD_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const USER_AGENT = 'ezviz-local';

// ------------------------------------------------------------------ auth

// Splits a WWW-Authenticate value into its params: realm="x", nonce="y", qop="auth,auth-int".
function parseChallenge(value) {
  const m = /^\s*(\S+)\s*(.*)$/s.exec(value || '');
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const params = {};
  const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))/g;
  let p;
  while ((p = re.exec(m[2])) !== null) {
    params[p[1].toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : p[3];
  }
  return { scheme, params };
}

// Picks Digest over Basic when the server offers both.
function chooseChallenge(values) {
  const parsed = values.map(parseChallenge).filter(Boolean);
  return (
    parsed.find((c) => c.scheme === 'digest' && c.params.nonce) || parsed.find((c) => c.scheme === 'basic') || null
  );
}

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const quote = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

/**
 * Authorization header value for one request.
 * @param {{scheme:string, params:object}} challenge
 * @param {{username:string, password:string, method:string, uri:string, nc?:number, cnonce?:string}} req
 */
function authorization(challenge, { username, password, method, uri, nc = 1, cnonce }) {
  if (challenge.scheme === 'basic') {
    return 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  }
  const { realm = '', nonce, opaque, algorithm } = challenge.params;
  const algo = (algorithm || 'MD5').toUpperCase();
  if (algo !== 'MD5' && algo !== 'MD5-SESS') {
    throw new EzvizLanError('unsupported', `unsupported digest algorithm ${algorithm}`);
  }
  const qops = (challenge.params.qop || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const qop = qops.includes('auth') ? 'auth' : null;
  if (qops.length && !qop) throw new EzvizLanError('unsupported', 'server requires an unsupported digest qop');
  const cn = cnonce || crypto.randomBytes(8).toString('hex');
  const ncHex = nc.toString(16).padStart(8, '0');
  let ha1 = md5(`${username}:${realm}:${password}`);
  if (algo === 'MD5-SESS') ha1 = md5(`${ha1}:${nonce}:${cn}`);
  const ha2 = md5(`${method}:${uri}`);
  const response = qop ? md5(`${ha1}:${nonce}:${ncHex}:${cn}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [
    `username=${quote(username)}`,
    `realm=${quote(realm)}`,
    `nonce=${quote(nonce)}`,
    `uri=${quote(uri)}`,
    `response=${quote(response)}`,
  ];
  if (algorithm) parts.push(`algorithm=${algorithm}`);
  if (opaque !== undefined) parts.push(`opaque=${quote(opaque)}`);
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce=${quote(cn)}`);
  return 'Digest ' + parts.join(', ');
}

// ------------------------------------------------------------------- SDP

const STATIC_PAYLOADS = { 0: 'PCMU/8000', 8: 'PCMA/8000', 9: 'G722/8000', 26: 'JPEG/90000', 32: 'MPV/90000', 33: 'MP2T/90000' };

/**
 * Media sections of an SDP body.
 * @returns {Array<{type:string, payloads:string[], codecs:string[], direction:string|null, control:string|null}>}
 */
function parseSdp(text) {
  const media = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('m=')) {
      const [type, , , ...payloads] = line.slice(2).split(/\s+/);
      cur = { type, payloads, rtpmap: {}, direction: null, control: null };
      media.push(cur);
      continue;
    }
    if (!cur) continue;
    let m;
    if ((m = /^a=rtpmap:(\d+)\s+([^/\s]+)\/(\d+)/.exec(line))) {
      cur.rtpmap[m[1]] = `${m[2]}/${m[3]}`;
    } else if ((m = /^a=(sendonly|recvonly|sendrecv|inactive)$/.exec(line))) {
      cur.direction = m[1];
    } else if ((m = /^a=control:(.*)$/.exec(line))) {
      cur.control = m[1];
    }
  }
  return media.map(({ type, payloads, rtpmap, direction, control }) => ({
    type,
    payloads,
    codecs: payloads.map((pt) => rtpmap[pt] || STATIC_PAYLOADS[pt]).filter(Boolean),
    direction,
    control,
  }));
}

// ------------------------------------------------------------ connection

function rtspUrl(host, port, path) {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `rtsp://${h}:${port}${path}`;
}

function parseResponse(head) {
  const lines = head.split('\r\n');
  const m = /^RTSP\/1\.0\s+(\d{3})\s*(.*)$/.exec(lines[0]);
  if (!m) throw new EzvizLanError('bad_response', 'not an RTSP response');
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    (headers[name] = headers[name] || []).push(value);
  }
  return { status: Number(m[1]), reason: m[2], headers };
}

/**
 * One TCP connection to an RTSP server. request() reconnects if the server
 * closed the previous connection (some do after a 401).
 */
class RtspClient {
  constructor({ host, port = 554, timeoutMs = 4000, connect }) {
    this.host = host;
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.connect = connect || ((o) => net.connect(o));
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.cseq = 0;
    this.waiter = null;
    this.error = null;
    this.ended = true;
  }

  async open() {
    this.buf = Buffer.alloc(0);
    this.error = null;
    this.ended = false;
    const socket = this.connect({ host: this.host, port: this.port });
    this.socket = socket;
    // Handlers ignore events from an earlier, replaced socket.
    socket.on('data', (d) => {
      if (this.socket !== socket) return;
      this.buf = Buffer.concat([this.buf, d]);
      this.wake();
    });
    socket.on('error', (err) => {
      if (this.socket !== socket) return;
      this.error = err;
      this.wake();
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.ended = true;
      this.wake();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new EzvizLanError('timeout', 'rtsp: timed out connecting'));
      }, this.timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(wrap(err));
      });
    });
  }

  wake() {
    const w = this.waiter;
    this.waiter = null;
    if (w) w();
  }

  async readResponse(deadline) {
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end !== -1) {
        const res = parseResponse(this.buf.subarray(0, end).toString('latin1'));
        const length = Number((res.headers['content-length'] || ['0'])[0]) || 0;
        if (length > MAX_BODY_BYTES) throw new EzvizLanError('bad_response', 'rtsp: response body too large');
        if (this.buf.length >= end + 4 + length) {
          res.body = this.buf.subarray(end + 4, end + 4 + length).toString('utf8');
          this.buf = this.buf.subarray(end + 4 + length);
          return res;
        }
      } else if (this.buf.length > MAX_HEAD_BYTES) {
        throw new EzvizLanError('bad_response', 'rtsp: response header too large');
      }
      if (this.error) throw wrap(this.error);
      if (this.ended) throw new EzvizLanError('closed', 'rtsp: connection closed before a response');
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiter = null;
          reject(new EzvizLanError('timeout', 'rtsp: timed out waiting for a response'));
        }, Math.max(0, deadline - Date.now()));
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  /** Sends one request and reads one response. Only OPTIONS and DESCRIBE are allowed. */
  async request(method, url, headers = {}) {
    if (method !== 'OPTIONS' && method !== 'DESCRIBE') {
      throw new EzvizLanError('invalid_argument', `rtsp: ${method} is not supported by this client`);
    }
    for (let attempt = 0; ; attempt += 1) {
      const reused = !(this.ended || !this.socket || this.socket.destroyed);
      if (!reused) await this.open();
      this.cseq += 1;
      const lines = [`${method} ${url} RTSP/1.0`, `CSeq: ${this.cseq}`, `User-Agent: ${USER_AGENT}`];
      for (const [k, v] of Object.entries(headers)) {
        if (v !== undefined && v !== null) lines.push(`${k}: ${v}`);
      }
      this.socket.write(lines.join('\r\n') + '\r\n\r\n');
      try {
        return await this.readResponse(Date.now() + this.timeoutMs);
      } catch (err) {
        // The server may have closed a kept-alive connection just as we wrote
        // to it. Retry once on a fresh one.
        const dropped = ['closed', 'ECONNRESET', 'EPIPE'].includes(err.code);
        if (!reused || attempt > 0 || !dropped) throw err;
        this.close();
      }
    }
  }

  close() {
    this.wake();
    if (this.socket) this.socket.destroy();
    this.socket = null;
    this.ended = true;
  }
}

function wrap(err) {
  if (err instanceof EzvizLanError) return err;
  const e = new EzvizLanError(err.code || 'socket_error', `rtsp: ${err.message}`);
  e.cause = err;
  return e;
}

module.exports = { RtspClient, parseChallenge, chooseChallenge, authorization, parseSdp, rtspUrl };
