'use strict';

// Minimal client for the "command port" (TCP 8000) on EZVIZ cameras: an
// RSA/challenge login on one socket, then one authenticated control frame on a
// fresh socket, then the camera's ack. Enough to pan and tilt an EZVIZ C6N.
//
// Ported from pyezvizapi 2.5.1 by Renier Moorcroft (Apache-2.0,
// https://github.com/RenierM26/pyEzvizApi): hcnetsdk_command_port_execute_template
// and HcNetSdkCommandPortClient (login, send_command_frame, read_tcp_frame).
// Rewritten in JavaScript and modified; see NOTICE. The PTZ command id and
// body layout are not from pyezvizapi; they are described in docs/PROTOCOL.md.
//
// Dependency-free: node:net, node:crypto and node:buffer only.

const net = require('node:net');
const { Buffer } = require('node:buffer');
const P = require('./protocol');

const { EzvizLanError } = P;
const MAX_FRAME_BYTES = 64 * 1024;
// Per-step network timeout limit. Node's setTimeout fires at once for delays
// above 2^31-1 ms, which would make every step time out immediately.
const MAX_TIMEOUT_MS = 60000;

function checkTimeout(timeoutMs) {
  if (typeof timeoutMs !== 'number' || !(timeoutMs > 0) || timeoutMs > MAX_TIMEOUT_MS) {
    throw new EzvizLanError('invalid_argument', `timeoutMs must be a number above 0 and at most ${MAX_TIMEOUT_MS}`);
  }
}

const PTZ = Object.freeze({
  COMMAND_ID: 0x00030203,
  UP: 21,
  DOWN: 22,
  LEFT: 23,
  RIGHT: 24,
  // Stop is folded into the sign of the command word: -(start + 1).
  stopOf: (cmd) => -(cmd + 1),
});

// Body tail for PTZ_COMMAND_ID: u32 channel, *signed* i32 command, u32 speed,
// all big-endian.
function ptzFrameTail(command, { channel = 1, speed = 4 } = {}) {
  if (!Number.isInteger(command) || command < -(2 ** 31) || command >= 2 ** 31) {
    throw new EzvizLanError('invalid_argument', 'command must be a signed 32-bit integer');
  }
  if (!Number.isInteger(channel) || channel < 1 || channel >= 2 ** 32) {
    throw new EzvizLanError('invalid_argument', 'channel must be a positive integer');
  }
  if (!Number.isInteger(speed) || speed < 1 || speed > 7) {
    throw new EzvizLanError('invalid_argument', 'speed must be an integer from 1 to 7');
  }
  const tail = Buffer.alloc(12);
  tail.writeUInt32BE(channel, 0);
  tail.writeInt32BE(command, 4);
  tail.writeUInt32BE(speed, 8);
  return tail;
}

function wrapSocketError(err, phase) {
  if (err instanceof EzvizLanError) return err;
  const e = new EzvizLanError(err.code || 'socket_error', `${phase}: ${err.message}`, { phase });
  e.cause = err;
  return e;
}

// A socket plus a byte buffer; every read is bounded by a timeout.
class Conn {
  constructor(socket, phase) {
    this.socket = socket;
    this.phase = phase;
    this.chunks = [];
    this.buffered = 0;
    this.error = null;
    this.ended = false;
    this.waiter = null;
    socket.on('data', (d) => {
      this.chunks.push(d);
      this.buffered += d.length;
      this.wake();
    });
    socket.on('error', (err) => {
      this.error = err;
      this.wake();
    });
    socket.on('end', () => {
      this.ended = true;
      this.wake();
    });
    socket.on('close', () => {
      this.ended = true;
      this.wake();
    });
  }

  wake() {
    const w = this.waiter;
    this.waiter = null;
    if (w) w();
  }

  wait(deadline, what) {
    return new Promise((resolve, reject) => {
      const ms = Math.max(0, deadline - Date.now());
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new EzvizLanError('timeout', `${this.phase}: timed out waiting for ${what}`, { phase: this.phase }));
      }, ms);
      this.waiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async connected(timeoutMs) {
    const s = this.socket;
    if (s.connecting !== true) {
      if (this.error) throw wrapSocketError(this.error, this.phase);
      if (s.destroyed) throw new EzvizLanError('closed', `${this.phase}: socket closed`, { phase: this.phase });
      return;
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new EzvizLanError('timeout', `${this.phase}: timed out connecting`, { phase: this.phase }));
      }, timeoutMs);
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(wrapSocketError(err, this.phase));
      };
      const onClose = () => {
        cleanup();
        reject(new EzvizLanError('closed', `${this.phase}: socket closed while connecting`, { phase: this.phase }));
      };
      const cleanup = () => {
        clearTimeout(timer);
        s.off('connect', onConnect);
        s.off('error', onError);
        s.off('close', onClose);
      };
      s.once('connect', onConnect);
      s.once('error', onError);
      s.once('close', onClose);
    });
  }

  async readExact(n, deadline, what) {
    while (this.buffered < n) {
      if (this.error) throw wrapSocketError(this.error, this.phase);
      if (this.ended) {
        throw new EzvizLanError('closed', `${this.phase}: connection closed before ${what}`, { phase: this.phase });
      }
      await this.wait(deadline, what);
    }
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = Buffer.from(all.subarray(0, n));
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return out;
  }

  // read_hcnetsdk_tcp_frame(allow_short_ack=True): a declared length below 16
  // is a header-only ack.
  async readFrame(timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    const head = await this.readExact(P.HEADER_LENGTH, deadline, what);
    const header = P.parseHeader(head);
    if (header.totalLength > MAX_FRAME_BYTES) {
      throw new EzvizLanError('bad_response', `${this.phase}: ${what} declares ${header.totalLength} bytes`, {
        phase: this.phase,
      });
    }
    const bodyLength = Math.max(0, header.totalLength - P.HEADER_LENGTH);
    const body = bodyLength ? await this.readExact(bodyLength, deadline, what) : Buffer.alloc(0);
    return { header, body, raw: Buffer.concat([head, body]) };
  }

  write(buf, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new EzvizLanError('timeout', `${this.phase}: timed out writing`, { phase: this.phase }));
      }, timeoutMs);
      this.socket.write(buf, (err) => {
        clearTimeout(timer);
        if (err) reject(wrapSocketError(err, this.phase));
        else resolve();
      });
    });
  }

  destroy() {
    this.wake();
    try {
      this.socket.destroy();
    } catch {
      // already gone
    }
  }
}

async function open(connect, host, port, timeoutMs, phase) {
  let socket;
  try {
    socket = connect({ host, port });
  } catch (err) {
    throw wrapSocketError(err, phase);
  }
  const conn = new Conn(socket, phase);
  try {
    await conn.connected(timeoutMs);
  } catch (err) {
    conn.destroy();
    throw err;
  }
  return conn;
}

const defaultConnect = ({ host, port }) => net.connect({ host, port });

/**
 * Log in on the command port and send one authenticated control frame.
 *
 * Resolves { ack, ackHeader, sessionId, authSeed, serial, localIp, request }.
 * Rejects with an EzvizLanError whose .code is one of: a Node socket code
 * (ECONNREFUSED, EHOSTUNREACH, ECONNRESET, ...), 'timeout', 'closed',
 * 'auth_failed', 'bad_response', 'invalid_argument'. err.phase is 'login' or
 * 'control' when the failure happened on a socket.
 */
async function control({
  host,
  port = 8000,
  password,
  username = P.DEFAULT_USERNAME,
  commandId,
  bodyTail = Buffer.alloc(0),
  localIp,
  timeoutMs = 5000,
  rsaKey,
  connect = defaultConnect,
} = {}) {
  if (typeof host !== 'string' || !host) throw new EzvizLanError('invalid_argument', 'host is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new EzvizLanError('invalid_argument', 'bad port');
  if (password === undefined || password === null || password === '') {
    throw new EzvizLanError('invalid_argument', 'password is required');
  }
  if (typeof username !== 'string' || !username) throw new EzvizLanError('invalid_argument', 'username is required');
  if (Buffer.byteLength(username, 'utf8') > 48) throw new EzvizLanError('invalid_argument', 'username is too long (max 48 bytes)');
  if (!Number.isInteger(commandId) || commandId < 0 || commandId >= 2 ** 32) {
    throw new EzvizLanError('invalid_argument', 'commandId must be an unsigned 32-bit integer');
  }
  if (!Buffer.isBuffer(bodyTail)) throw new EzvizLanError('invalid_argument', 'bodyTail must be a Buffer');
  checkTimeout(timeoutMs);
  if (localIp !== undefined && localIp !== null) P.localIpWord(localIp); // validate early

  const key = rsaKey ? P.toPrivateKeyObject(rsaKey) : await P.generateRsaKey();

  // Login socket.
  let session;
  let ip;
  const login = await open(connect, host, port, timeoutMs, 'login');
  try {
    ip = localIp ?? P.normalizeIpv4(login.socket.localAddress);
    if (!ip) {
      throw new EzvizLanError('invalid_argument', 'localIp is required: the socket has no IPv4 local address');
    }
    await login.write(P.loginRequestFrame(P.publicKeyDer(key), { username, localIp: ip }), timeoutMs);
    const first = await login.readFrame(timeoutMs, 'login challenge');
    const { challenge, passwordSeed } = P.decodeLoginChallenge(first.body, key);
    await login.write(P.loginProofFrame({ username, password, challenge, passwordSeed, localIp: ip }), timeoutMs);
    const second = await login.readFrame(timeoutMs, 'login result');
    session = { ...P.parseLoginSession(second.header, second.body), challenge };
  } catch (err) {
    if (err instanceof EzvizLanError && !err.phase) err.phase = 'login';
    throw err;
  } finally {
    login.destroy();
  }

  const request = P.controlFrame({
    sessionId: session.sessionId,
    authSeed: session.authSeed,
    commandId,
    key: session.challenge,
    localIp: ip,
    bodyTail,
  });

  // Control socket.
  const ctl = await open(connect, host, port, timeoutMs, 'control');
  try {
    await ctl.write(request, timeoutMs);
    const ack = await ctl.readFrame(timeoutMs, 'control ack');
    return {
      ack: ack.raw,
      ackHeader: ack.header,
      sessionId: session.sessionId,
      authSeed: session.authSeed,
      serial: session.serial,
      localIp: ip,
      request,
    };
  } catch (err) {
    if (err instanceof EzvizLanError && !err.phase) err.phase = 'control';
    throw err;
  } finally {
    ctl.destroy();
  }
}

module.exports = { control, ptzFrameTail, PTZ, EzvizLanError, MAX_TIMEOUT_MS, checkTimeout };
