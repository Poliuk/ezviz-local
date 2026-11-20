'use strict';

// Fake servers for the tests. Everything listens on 127.0.0.1; no test talks
// to a real camera.

const net = require('node:net');
const crypto = require('node:crypto');
const P = require('../../lib/protocol');

const ACK = Buffer.from('00000010000000010000000100000000', 'hex');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function stopper(server, sockets) {
  return async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
}

// A port that refuses connections: bind, note the port, close.
async function closedPort() {
  const srv = net.createServer();
  const port = await listen(srv);
  await new Promise((r) => srv.close(r));
  return port;
}

// Splits a byte stream into command-port frames (u32 BE total length first).
function frameReader(onFrame) {
  let buf = Buffer.alloc(0);
  return (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 16 && buf.length >= buf.readUInt32BE(0)) {
      const total = buf.readUInt32BE(0);
      const frame = buf.subarray(0, total);
      buf = buf.subarray(total);
      onFrame(frame);
    }
  };
}

/**
 * A command-port camera that accepts any number of logins and PTZ frames.
 * It encrypts a random challenge to whatever public key the client sends, so
 * it works with any client key.
 *
 * options.authFail        answer every login with an all-zero session id
 * options.onControl(cmd, n) return 'ack' (default), 'close' or 'silent'
 *                          for the n-th control frame (0-based)
 */
async function fakeCommandPort(options = {}) {
  const sockets = [];
  const events = []; // { type: 'login'|'control', command?, speed?, channel?, at }
  let controls = 0;
  let connections = 0;
  const server = net.createServer((sock) => {
    sockets.push(sock);
    connections += 1;
    sock.on('error', () => {});
    let challenge;
    sock.on(
      'data',
      frameReader((frame) => {
        const family = frame.readUInt32BE(4);
        if (family === P.LOGIN_FAMILY && !challenge) {
          // Login request: prefix (20) + username (48) + PKCS#1 public key DER.
          const der = frame.subarray(16 + 20 + 48);
          const pub = crypto.createPublicKey({ key: der, format: 'der', type: 'pkcs1' });
          challenge = crypto.randomBytes(32);
          const ct = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, challenge);
          sock.write(P.buildFrame(Buffer.concat([ct, crypto.randomBytes(64)]), 0x10));
        } else if (family === P.LOGIN_FAMILY) {
          events.push({ type: 'login', at: Date.now() });
          const body = Buffer.alloc(48);
          if (!options.authFail) body.writeUInt32BE(0x01020304, 0);
          body.write('FAKE00001', 4, 'ascii');
          sock.write(P.buildFrame(body, 0x1234));
        } else if (family === P.CONTROL_FAMILY) {
          const tail = frame.subarray(32);
          const ev = {
            type: 'control',
            channel: tail.readUInt32BE(0),
            command: tail.readInt32BE(4),
            speed: tail.readUInt32BE(8),
            at: Date.now(),
          };
          events.push(ev);
          const n = controls;
          controls += 1;
          const action = options.onControl ? options.onControl(ev.command, n) : 'ack';
          if (action === 'close') sock.destroy();
          else if (action === 'ack' && options.ackDelayMs) setTimeout(() => sock.write(ACK), options.ackDelayMs);
          else if (action === 'ack') sock.write(ACK);
        }
      }),
    );
  });
  const port = await listen(server);
  return {
    port,
    events,
    commands: () => events.filter((e) => e.type === 'control').map((e) => e.command),
    get connections() {
      return connections;
    },
    stop: stopper(server, sockets),
  };
}

/** A TCP listener that records how many bytes anyone sent it. */
async function fakeListener() {
  const sockets = [];
  let bytes = 0;
  let connections = 0;
  const server = net.createServer((sock) => {
    sockets.push(sock);
    connections += 1;
    sock.on('error', () => {});
    sock.on('data', (d) => {
      bytes += d.length;
    });
  });
  const port = await listen(server);
  return {
    port,
    get bytes() {
      return bytes;
    },
    get connections() {
      return connections;
    },
    stop: stopper(server, sockets),
  };
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function parseAuthParams(value) {
  const out = {};
  const re = /([a-z]+)=(?:"([^"]*)"|([^,\s]*))/gi;
  let m;
  while ((m = re.exec(value)) !== null) out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  return out;
}

/**
 * An RTSP server that behaves like the EZVIZ C6N as far as probe() can see:
 * OPTIONS 200; DESCRIBE 401 with a Digest challenge until the right
 * credentials arrive, then 200 with an SDP of H.264 video and AAC 16 kHz
 * audio (recvonly), plus a PCMU 8 kHz sendonly audio section only when the
 * request carries "Require: www.onvif.org/ver20/backchannel".
 *
 * options.username / options.password  expected credentials (admin / ABCDEF)
 * options.scheme       'digest' (default) or 'basic'
 * options.qop          offer qop="auth" with the Digest challenge
 * options.closeAfter401 close the connection after each 401
 * options.rejectRequire answer 551 to a DESCRIBE carrying Require
 */
async function fakeRtsp(options = {}) {
  const username = options.username || 'admin';
  const password = options.password || 'ABCDEF';
  const realm = 'IP Camera(C6N)';
  const nonce = crypto.randomBytes(16).toString('hex');
  const requests = []; // { method, url, headers }
  const sockets = [];
  let connections = 0;

  function sdp(backchannel) {
    const lines = [
      'v=0',
      'o=- 1 1 IN IP4 192.0.2.10',
      's=Media Presentation',
      't=0 0',
      'm=video 0 RTP/AVP 96',
      'a=rtpmap:96 H264/90000',
      'a=control:trackID=1',
      'm=audio 0 RTP/AVP 104',
      'a=rtpmap:104 MPEG4-GENERIC/16000/1',
      'a=control:trackID=2',
      'a=recvonly',
    ];
    if (backchannel) {
      lines.push('m=audio 0 RTP/AVP 0 104', 'a=rtpmap:0 PCMU/8000/1', 'a=control:trackID=3', 'a=sendonly');
    }
    return lines.join('\r\n') + '\r\n';
  }

  function authorized(req) {
    const h = req.headers.authorization;
    if (!h) return false;
    if (options.scheme === 'basic') {
      return h === 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    }
    if (!h.startsWith('Digest ')) return false;
    const a = parseAuthParams(h.slice(7));
    if (a.username !== username || a.realm !== realm || a.nonce !== nonce || a.uri !== req.url) return false;
    const ha1 = md5(`${username}:${realm}:${password}`);
    const ha2 = md5(`${req.method}:${req.url}`);
    const expected = options.qop
      ? a.qop === 'auth' && md5(`${ha1}:${nonce}:${a.nc}:${a.cnonce}:auth:${ha2}`)
      : md5(`${ha1}:${nonce}:${ha2}`);
    return a.response === expected;
  }

  const server = net.createServer((sock) => {
    sockets.push(sock);
    connections += 1;
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let end;
      while ((end = buf.indexOf('\r\n\r\n')) !== -1) {
        const head = buf.slice(0, end);
        buf = buf.slice(end + 4);
        const [first, ...rest] = head.split('\r\n');
        const [method, url] = first.split(' ');
        const headers = {};
        for (const line of rest) {
          const i = line.indexOf(':');
          headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
        }
        const req = { method, url, headers };
        requests.push(req);
        const cseq = headers.cseq;
        const reply = (status, reason, extra = [], body = '') => {
          const lines = [`RTSP/1.0 ${status} ${reason}`, `CSeq: ${cseq}`, ...extra];
          if (body) lines.push('Content-Type: application/sdp', `Content-Length: ${Buffer.byteLength(body)}`);
          sock.write(lines.join('\r\n') + '\r\n\r\n' + body);
        };
        if (method === 'OPTIONS') {
          reply(200, 'OK', ['Public: OPTIONS, DESCRIBE, PLAY, PAUSE, SETUP, TEARDOWN, SET_PARAMETER, GET_PARAMETER']);
        } else if (method === 'DESCRIBE') {
          const wantsBack = headers.require === 'www.onvif.org/ver20/backchannel';
          if (wantsBack && options.rejectRequire) {
            reply(551, 'Option not supported', ['Unsupported: www.onvif.org/ver20/backchannel']);
          } else if (!authorized(req)) {
            const challenge =
              options.scheme === 'basic'
                ? `Basic realm="${realm}"`
                : `Digest realm="${realm}", nonce="${nonce}"${options.qop ? ', qop="auth"' : ''}, stale="FALSE"`;
            reply(401, 'Unauthorized', [`WWW-Authenticate: ${challenge}`]);
            if (options.closeAfter401) sock.end();
          } else {
            reply(200, 'OK', [`Content-Base: ${url}/`], sdp(wantsBack));
          }
        } else {
          reply(405, 'Method Not Allowed');
        }
      }
    });
  });
  const port = await listen(server);
  return {
    port,
    requests,
    get connections() {
      return connections;
    },
    stop: stopper(server, sockets),
  };
}

module.exports = { fakeCommandPort, fakeListener, fakeRtsp, closedPort, frameReader, listen, ACK };
