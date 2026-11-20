'use strict';

// probe(): what does this camera offer on the LAN? Read-only.
//
//   - Command port (default 8000): TCP connect, then close. No login, no frame.
//   - RTSP (default 554): OPTIONS, then DESCRIBE of the main stream with
//     "Require: www.onvif.org/ver20/backchannel", authenticated with Digest
//     or Basic. The SDP answer tells us the video codec, the camera's
//     microphone codec and whether the camera has a speaker we can send to
//     (the ONVIF audio backchannel, an a=sendonly audio section).
//
// It never sends SETUP or PLAY, never sends audio and never sends a control
// frame. The RTSP client in ./rtsp.js cannot do any of those.

const net = require('node:net');
const P = require('./protocol');
const { RtspClient, chooseChallenge, authorization, parseSdp, rtspUrl } = require('./rtsp');
const { checkTimeout } = require('./control');

const { EzvizLanError } = P;

const PATHS = Object.freeze({ main: '/Streaming/Channels/101', sub: '/Streaming/Channels/102' });
const BACKCHANNEL = 'www.onvif.org/ver20/backchannel';

function checkPort({ host, port, timeoutMs, connect }) {
  return new Promise((resolve) => {
    let socket;
    let done = false;
    const finish = (open, code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (socket) socket.destroy();
      resolve(open ? { open: true } : { open: false, code });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    try {
      socket = (connect || net.connect)({ host, port });
    } catch (err) {
      finish(false, err.code || 'error');
      return;
    }
    socket.once('connect', () => finish(true));
    socket.once('error', (err) => finish(false, err.code || 'error'));
  });
}

// DESCRIBE with auth handling. Returns the final response and whether
// credentials were sent with it.
async function describe(client, url, { username, password, headers }) {
  const base = { Accept: 'application/sdp', ...headers };
  let res = await client.request('DESCRIBE', url, base);
  let sentCredentials = false;
  for (let round = 0; round < 2 && res.status === 401; round += 1) {
    if (!password) break;
    const challenge = chooseChallenge(res.headers['www-authenticate'] || []);
    if (!challenge) break;
    // A second round only for a stale nonce.
    if (round === 1 && !(challenge.scheme === 'digest' && /^true$/i.test(challenge.params.stale || ''))) break;
    const auth = authorization(challenge, { username, password, method: 'DESCRIBE', uri: url });
    res = await client.request('DESCRIBE', url, { ...base, Authorization: auth });
    sentCredentials = true;
  }
  return { res, sentCredentials };
}

async function probeRtsp({ host, port, username, password, timeoutMs, connect }) {
  const out = { open: false, auth: 'unknown', paths: { ...PATHS } };
  const client = new RtspClient({ host, port, timeoutMs, connect });
  try {
    try {
      await client.open();
    } catch (err) {
      out.code = err.code;
      return out;
    }
    out.open = true;
    const url = rtspUrl(host, port, PATHS.main);
    try {
      await client.request('OPTIONS', url);
      let { res, sentCredentials } = await describe(client, url, {
        username,
        password,
        headers: { Require: BACKCHANNEL },
      });
      let askedBackchannel = true;
      // 551 Option Not Supported: the server does not know the backchannel
      // extension. Ask again without it.
      if (res.status === 551) {
        askedBackchannel = false;
        ({ res, sentCredentials } = await describe(client, url, { username, password, headers: {} }));
      }
      out.status = res.status;
      if (res.status === 200) {
        out.auth = 'ok';
        const media = parseSdp(res.body || '');
        const video = media.find((m) => m.type === 'video');
        if (video && video.codecs.length) out.video = video.codecs[0].split('/')[0];
        const mic = media.find((m) => m.type === 'audio' && m.direction !== 'sendonly');
        if (mic && mic.codecs.length) {
          const [codec, rate] = mic.codecs[0].split('/');
          out.audio = { codec, rate: Number(rate) };
        }
        const back = media.find((m) => m.type === 'audio' && m.direction === 'sendonly');
        out.backchannel = back ? { codecs: back.codecs } : null;
        if (!askedBackchannel) out.backchannel = null;
      } else if (res.status === 401 && sentCredentials) {
        out.auth = 'failed';
      }
    } catch (err) {
      if (err instanceof EzvizLanError && err.code === 'unsupported') out.code = 'unsupported_auth';
      else out.code = err.code || 'error';
    }
    return out;
  } finally {
    client.close();
  }
}

/**
 * Probe a camera's command port and RTSP service. Read-only; see the file
 * header for exactly what is sent.
 *
 * Resolves:
 *   {
 *     commandPort: { open },
 *     rtsp: { open, auth: 'ok'|'failed'|'unknown', paths: { main, sub },
 *             video?, audio?: { codec, rate }, backchannel?: { codecs } | null }
 *   }
 * `backchannel` is null when the camera answered DESCRIBE without a send-only
 * audio section, and absent when DESCRIBE did not succeed. Without a
 * password, auth stays 'unknown' if the camera asks for credentials.
 * Unreachable ports are reported as closed, never thrown.
 */
async function probe({
  host,
  password,
  username = P.DEFAULT_USERNAME,
  rtspPort = 554,
  commandPort = 8000,
  timeoutMs = 4000,
  connect,
} = {}) {
  if (typeof host !== 'string' || !host) throw new EzvizLanError('invalid_argument', 'host is required');
  for (const [name, v] of [
    ['rtspPort', rtspPort],
    ['commandPort', commandPort],
  ]) {
    if (!Number.isInteger(v) || v < 1 || v > 65535) throw new EzvizLanError('invalid_argument', `bad ${name}`);
  }
  checkTimeout(timeoutMs);
  if (typeof username !== 'string' || !username) throw new EzvizLanError('invalid_argument', 'username is required');

  const [cmd, rtsp] = await Promise.all([
    checkPort({ host, port: commandPort, timeoutMs, connect }),
    probeRtsp({ host, port: rtspPort, username, password: password || '', timeoutMs, connect }),
  ]);
  // Internal diagnostics (code, status) stay out of the public shape.
  const result = {
    commandPort: { open: cmd.open },
    rtsp: { open: rtsp.open, auth: rtsp.auth, paths: rtsp.paths },
  };
  for (const k of ['video', 'audio', 'backchannel']) if (k in rtsp) result.rtsp[k] = rtsp[k];
  Object.defineProperty(result, 'details', {
    value: { commandPort: cmd.code || null, rtsp: rtsp.code || null, rtspStatus: rtsp.status || null },
    enumerable: false,
  });
  return result;
}

module.exports = { probe, PATHS, BACKCHANNEL };
