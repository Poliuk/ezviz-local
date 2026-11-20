'use strict';

// probe(): against a fake RTSP server that answers like an EZVIZ C6N and a
// fake command port that only counts bytes. Nothing here reaches a camera.

const test = require('node:test');
const assert = require('node:assert/strict');

const { probe } = require('../lib');
const { RtspClient, parseChallenge, chooseChallenge, authorization, parseSdp, rtspUrl } = require('../lib/rtsp');
const { fakeRtsp, fakeListener, closedPort } = require('./support/fakes');

async function setup(rtspOptions) {
  const rtsp = await fakeRtsp(rtspOptions);
  const cmd = await fakeListener();
  return {
    rtsp,
    cmd,
    opts: { host: '127.0.0.1', rtspPort: rtsp.port, commandPort: cmd.port, timeoutMs: 1000 },
    async stop() {
      await rtsp.stop();
      await cmd.stop();
    },
  };
}

function assertReadOnly(env) {
  for (const r of env.rtsp.requests) {
    assert.ok(['OPTIONS', 'DESCRIBE'].includes(r.method), `unexpected ${r.method}`);
  }
  assert.equal(env.cmd.bytes, 0, 'nothing is written to the command port');
}

test('C6N-like camera: video, microphone and backchannel are reported', async () => {
  const env = await setup();
  try {
    const r = await probe({ ...env.opts, password: 'ABCDEF' });
    assert.deepEqual(r, {
      commandPort: { open: true },
      rtsp: {
        open: true,
        auth: 'ok',
        paths: { main: '/Streaming/Channels/101', sub: '/Streaming/Channels/102' },
        video: 'H264',
        audio: { codec: 'MPEG4-GENERIC', rate: 16000 },
        backchannel: { codecs: ['PCMU/8000'] },
      },
    });
    assertReadOnly(env);
    assert.equal(env.cmd.connections, 1);
    const describes = env.rtsp.requests.filter((q) => q.method === 'DESCRIBE');
    assert.equal(describes.length, 2, 'one 401, one authenticated');
    for (const d of describes) {
      assert.equal(d.headers.require, 'www.onvif.org/ver20/backchannel');
      assert.equal(d.headers.accept, 'application/sdp');
      assert.equal(d.url, `rtsp://127.0.0.1:${env.rtsp.port}/Streaming/Channels/101`);
    }
    assert.match(describes[1].headers.authorization, /^Digest /);
    assert.ok(!JSON.stringify(env.rtsp.requests).includes('ABCDEF'), 'password never sent in clear with Digest');
  } finally {
    await env.stop();
  }
});

test('the fake only offers the backchannel when asked, as the camera does', async () => {
  const env = await setup();
  const client = new RtspClient({ host: '127.0.0.1', port: env.rtsp.port, timeoutMs: 1000 });
  try {
    const url = rtspUrl('127.0.0.1', env.rtsp.port, '/Streaming/Channels/101');
    const first = await client.request('DESCRIBE', url);
    const challenge = chooseChallenge(first.headers['www-authenticate']);
    const auth = authorization(challenge, { username: 'admin', password: 'ABCDEF', method: 'DESCRIBE', uri: url });
    const plain = await client.request('DESCRIBE', url, { Authorization: auth });
    assert.equal(plain.status, 200);
    assert.equal(parseSdp(plain.body).filter((m) => m.direction === 'sendonly').length, 0);
  } finally {
    client.close();
    await env.stop();
  }
});

test('a camera that rejects the Require header is asked again without it', async () => {
  const env = await setup({ rejectRequire: true });
  try {
    const r = await probe({ ...env.opts, password: 'ABCDEF' });
    assert.equal(r.rtsp.auth, 'ok');
    assert.equal(r.rtsp.video, 'H264');
    assert.equal(r.rtsp.backchannel, null);
    assertReadOnly(env);
  } finally {
    await env.stop();
  }
});

test('wrong password: auth failed, no media details', async () => {
  const env = await setup();
  try {
    const r = await probe({ ...env.opts, password: 'WRONG1' });
    assert.equal(r.rtsp.open, true);
    assert.equal(r.rtsp.auth, 'failed');
    assert.ok(!('video' in r.rtsp));
    assert.ok(!('backchannel' in r.rtsp));
    assertReadOnly(env);
  } finally {
    await env.stop();
  }
});

test('no password: ports are checked, auth stays unknown', async () => {
  const env = await setup();
  try {
    const r = await probe({ ...env.opts });
    assert.deepEqual(r.commandPort, { open: true });
    assert.equal(r.rtsp.open, true);
    assert.equal(r.rtsp.auth, 'unknown');
    assert.ok(!('backchannel' in r.rtsp));
    const describes = env.rtsp.requests.filter((q) => q.method === 'DESCRIBE');
    assert.equal(describes.length, 1);
    assert.equal(describes[0].headers.authorization, undefined);
  } finally {
    await env.stop();
  }
});

test('Digest with qop=auth, and a server that hangs up after each 401', async () => {
  const env = await setup({ qop: true, closeAfter401: true });
  try {
    const r = await probe({ ...env.opts, password: 'ABCDEF' });
    assert.equal(r.rtsp.auth, 'ok');
    assert.deepEqual(r.rtsp.backchannel, { codecs: ['PCMU/8000'] });
    assert.ok(env.rtsp.connections >= 2, 'reconnected after the server closed');
    const authHeader = env.rtsp.requests.find((q) => q.headers.authorization).headers.authorization;
    assert.match(authHeader, /qop=auth/);
    assert.match(authHeader, /nc=00000001/);
  } finally {
    await env.stop();
  }
});

test('Basic auth when the server offers only Basic', async () => {
  const env = await setup({ scheme: 'basic' });
  try {
    const r = await probe({ ...env.opts, password: 'ABCDEF' });
    assert.equal(r.rtsp.auth, 'ok');
    assert.equal(r.rtsp.video, 'H264');
  } finally {
    await env.stop();
  }
});

test('closed ports are reported, not thrown', async () => {
  const [a, b] = [await closedPort(), await closedPort()];
  const r = await probe({ host: '127.0.0.1', rtspPort: a, commandPort: b, password: 'x', timeoutMs: 500 });
  assert.deepEqual(r, {
    commandPort: { open: false },
    rtsp: { open: false, auth: 'unknown', paths: { main: '/Streaming/Channels/101', sub: '/Streaming/Channels/102' } },
  });
  assert.equal(r.details.rtsp, 'ECONNREFUSED');
});

test('probe argument validation', async () => {
  await assert.rejects(probe({}), { code: 'invalid_argument' });
  await assert.rejects(probe({ host: '127.0.0.1', rtspPort: 0 }), { code: 'invalid_argument' });
  await assert.rejects(probe({ host: '127.0.0.1', commandPort: 70000 }), { code: 'invalid_argument' });
  await assert.rejects(probe({ host: '127.0.0.1', timeoutMs: 0 }), { code: 'invalid_argument' });
  await assert.rejects(probe({ host: '127.0.0.1', timeoutMs: 2 ** 31 }), { code: 'invalid_argument' });
});

// ------------------------------------------------------------ RTSP pieces

test('Digest response matches the RFC 2617 worked example', () => {
  const challenge = parseChallenge(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"',
  );
  const header = authorization(challenge, {
    username: 'Mufasa',
    password: 'Circle Of Life',
    method: 'GET',
    uri: '/dir/index.html',
    nc: 1,
    cnonce: '0a4f113b',
  });
  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
  assert.match(header, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
});

test('Digest is preferred over Basic; Basic is used alone', () => {
  const both = chooseChallenge(['Basic realm="x"', 'Digest realm="x", nonce="n"']);
  assert.equal(both.scheme, 'digest');
  const basic = chooseChallenge(['Basic realm="x"']);
  assert.equal(
    authorization(basic, { username: 'admin', password: 'ABCDEF', method: 'DESCRIBE', uri: 'rtsp://h/' }),
    'Basic ' + Buffer.from('admin:ABCDEF').toString('base64'),
  );
  assert.equal(chooseChallenge(['Bearer x']), null);
});

test('parseSdp reads codecs, static payload types and directions', () => {
  const media = parseSdp(
    [
      'v=0',
      'm=video 0 RTP/AVP 96',
      'a=rtpmap:96 H264/90000',
      'm=audio 0 RTP/AVP 104',
      'a=rtpmap:104 MPEG4-GENERIC/16000/1',
      'a=recvonly',
      'm=audio 0 RTP/AVP 0 8',
      'a=sendonly',
    ].join('\r\n'),
  );
  assert.deepEqual(
    media.map((m) => [m.type, m.codecs, m.direction]),
    [
      ['video', ['H264/90000'], null],
      ['audio', ['MPEG4-GENERIC/16000'], 'recvonly'],
      ['audio', ['PCMU/8000', 'PCMA/8000'], 'sendonly'],
    ],
  );
});

test('the RTSP client refuses anything but OPTIONS and DESCRIBE', async () => {
  const client = new RtspClient({ host: '127.0.0.1', port: 1, connect: () => assert.fail('must not connect') });
  for (const method of ['SETUP', 'PLAY', 'TEARDOWN', 'ANNOUNCE', 'RECORD', 'SET_PARAMETER']) {
    await assert.rejects(client.request(method, 'rtsp://127.0.0.1/'), { code: 'invalid_argument' });
  }
});

test('rtspUrl brackets IPv6 hosts', () => {
  assert.equal(rtspUrl('192.0.2.10', 554, '/a'), 'rtsp://192.0.2.10:554/a');
  assert.equal(rtspUrl('2001:db8::1', 554, '/a'), 'rtsp://[2001:db8::1]:554/a');
});
