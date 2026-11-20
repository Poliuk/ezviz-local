'use strict';

// control(): the command-port client (port of parts of pyezvizapi). No real
// camera: every test talks to a fake one on 127.0.0.1.
//
// The fixtures in test/fixtures/ were recorded by driving
// pyezvizapi 2.5.1's hcnetsdk_command_port_execute_template against a fake
// camera with fixed server bytes and an injected RSA key. Replaying the same
// server bytes here, the Node client must send byte-identical frames.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');

const { control, ptzFrameTail, PTZ, EzvizLanError } = require('../lib');
const P = require('../lib/protocol');
const { fakeCommandPort, closedPort } = require('./support/fakes');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const fixtures = fs
  .readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')));

const hex = (b) => Buffer.from(b).toString('hex');
const ACK = Buffer.from('00000010000000010000000100000000', 'hex');

// A fake camera. `script` is one entry per expected TCP connection; each entry
// is a list of handlers, one per frame the client sends. A handler returns the
// bytes to reply with, or one of the actions below.
async function fakeCamera(script, { chunked = false } = {}) {
  const received = [];
  const sockets = [];
  let closed = 0;
  let index = 0;
  const server = net.createServer((sock) => {
    sockets.push(sock);
    sock.on('close', () => closed++);
    sock.on('error', () => {});
    const handlers = script[index] || [];
    const frames = [];
    received.push(frames);
    index++;
    let buf = Buffer.alloc(0);
    let step = 0;
    if (handlers.length === 0) return; // accept and stay silent
    sock.on('data', async (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 16 && buf.length >= buf.readUInt32BE(0)) {
        const total = buf.readUInt32BE(0);
        const frame = buf.subarray(0, total);
        buf = buf.subarray(total);
        frames.push(frame);
        const handler = handlers[step++];
        const reply = handler ? handler(frame) : 'silent';
        if (reply === 'silent') continue;
        if (reply === 'close') {
          sock.end();
          continue;
        }
        if (chunked) {
          for (const byte of reply) {
            sock.write(Buffer.from([byte]));
            await new Promise((r) => setImmediate(r));
          }
        } else {
          sock.write(reply);
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    received,
    get closed() {
      return closed;
    },
    get connections() {
      return index;
    },
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function scriptFromFixture(fx) {
  return [
    fx.server.login.map((h) => () => Buffer.from(h, 'hex')),
    fx.server.control.map((h) => () => Buffer.from(h, 'hex')),
  ];
}

async function waitFor(cond, ms = 1000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const KEY_PEM = fixtures[0].rsaPrivateKeyPem;

// A camera that works with any client key: decrypts nothing, just encrypts a
// fixed challenge to the public key in the login request.
function honestCameraScript({ challenge, passwordSeed, sessionId, authSeed, serial, onProof }) {
  return [
    [
      (frame) => {
        const der = frame.subarray(16 + 20 + 48);
        const pub = crypto.createPublicKey({ key: der, format: 'der', type: 'pkcs1' });
        const ct = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, challenge);
        return P.buildFrame(Buffer.concat([ct, passwordSeed]), 0x10);
      },
      (frame) => {
        if (onProof) onProof(frame);
        const body = Buffer.alloc(48);
        sessionId.copy(body, 0);
        body.write(serial, 4, 'ascii');
        return P.buildFrame(body, authSeed);
      },
    ],
    [() => ACK],
  ];
}

// ------------------------------------------------------- Python equivalence

for (const fx of fixtures) {
  test(`byte-identical to pyezvizapi: ${fx.name}`, async () => {
    const p = fx.params;
    const tail = ptzFrameTail(p.command, { channel: p.channel, speed: p.speed });
    assert.equal(hex(tail), p.bodyTail);

    const cam = await fakeCamera(scriptFromFixture(fx));
    try {
      const res = await control({
        host: '127.0.0.1',
        port: cam.port,
        password: p.password,
        username: p.username,
        commandId: p.commandId,
        bodyTail: tail,
        localIp: p.localIpExplicit ? p.localIp : undefined,
        rsaKey: fx.rsaPrivateKeyPem,
      });
      assert.equal(cam.connections, 2, 'login and control use separate sockets');
      assert.deepEqual(cam.received[0].map(hex), fx.client.login, 'login frames');
      assert.deepEqual(cam.received[1].map(hex), fx.client.control, 'control frame');
      assert.equal(hex(res.request), fx.client.control[0]);
      assert.equal(hex(res.sessionId), fx.expected.sessionId);
      assert.equal(res.authSeed, fx.expected.authSeed);
      assert.equal(res.serial, fx.expected.serial);
      assert.equal(hex(res.ack), fx.expected.ack);
      assert.equal(res.localIp, p.localIp);
      await waitFor(() => cam.closed === 2);
    } finally {
      await cam.stop();
    }
  });
}

test('fixtures cover left start, left stop and up start and contain no real secrets', () => {
  const byName = Object.fromEntries(fixtures.map((f) => [f.name, f]));
  assert.equal(byName['ptz-left-start'].params.command, PTZ.LEFT);
  assert.equal(byName['ptz-left-stop'].params.command, PTZ.stopOf(PTZ.LEFT));
  assert.equal(byName['ptz-up-start'].params.command, PTZ.UP);
  for (const f of fixtures) {
    assert.equal(f.params.password, 'ABCDEF');
    assert.match(f.expected.serial, /^FAKE/);
    assert.ok(!JSON.stringify(f).includes('192.168.'), 'no home-network addresses');
  }
});

test('pure frame builders reproduce the fixture frames', () => {
  for (const fx of fixtures) {
    const key = P.toPrivateKeyObject(fx.rsaPrivateKeyPem);
    const first = Buffer.from(fx.server.login[0], 'hex');
    const { challenge, passwordSeed } = P.decodeLoginChallenge(first.subarray(16), key);
    assert.equal(hex(challenge), fx.expected.challenge);
    const frame = P.controlFrame({
      sessionId: Buffer.from(fx.expected.sessionId, 'hex'),
      authSeed: fx.expected.authSeed,
      commandId: fx.params.commandId,
      key: challenge,
      localIp: fx.params.localIp,
      bodyTail: Buffer.from(fx.params.bodyTail, 'hex'),
    });
    assert.equal(hex(frame), fx.client.control[0]);
    const proof = P.loginProofFrame({
      username: fx.params.username,
      password: fx.params.password,
      challenge,
      passwordSeed,
      localIp: fx.params.localIp,
    });
    assert.equal(hex(proof), fx.client.login[1]);
  }
});

// ------------------------------------------------------------- behaviour

test('works with a generated RSA key and responses delivered one byte at a time', async () => {
  const challenge = crypto.randomBytes(32);
  const passwordSeed = crypto.randomBytes(64);
  let proof;
  const cam = await fakeCamera(
    honestCameraScript({
      challenge,
      passwordSeed,
      sessionId: Buffer.from('01020304', 'hex'),
      authSeed: 0xdeadbeef,
      serial: 'FAKE00009',
      onProof: (f) => (proof = f),
    }),
    { chunked: true },
  );
  try {
    const res = await control({
      host: '127.0.0.1',
      port: cam.port,
      password: 'ABCDEF',
      commandId: PTZ.COMMAND_ID,
      bodyTail: ptzFrameTail(PTZ.RIGHT),
    });
    assert.equal(res.serial, 'FAKE00009');
    assert.equal(res.authSeed, 0xdeadbeef);
    assert.equal(res.localIp, '127.0.0.1');
    assert.deepEqual(res.ack, ACK);
    // The camera can verify the proof: HMAC-MD5(challenge, "admin").
    const expected = crypto.createHmac('md5', challenge).update('admin').digest();
    assert.deepEqual(proof.subarray(16 + 20, 16 + 20 + 16), expected);
    // Control frame layout from docs/PROTOCOL.md.
    const ctl = cam.received[1][0];
    assert.equal(ctl.length, 44);
    assert.equal(ctl.readUInt32BE(4), 0x63000000);
    assert.equal(ctl.readUInt32BE(12), PTZ.COMMAND_ID);
    assert.equal(hex(ctl.subarray(16, 20)), '0100007f');
    assert.equal(hex(ctl.subarray(20, 24)), '01020304');
    assert.equal(hex(ctl.subarray(32)), '000000010000001800000004');
  } finally {
    await cam.stop();
  }
});

test('auth_failed when the camera returns an all-zero session id', async () => {
  const cam = await fakeCamera(
    honestCameraScript({
      challenge: crypto.randomBytes(32),
      passwordSeed: crypto.randomBytes(64),
      sessionId: Buffer.alloc(4),
      authSeed: 1,
      serial: 'FAKE',
    }),
  );
  try {
    await assert.rejects(
      control({ host: '127.0.0.1', port: cam.port, password: 'WRONG', commandId: 1, rsaKey: KEY_PEM }),
      (err) => err instanceof EzvizLanError && err.code === 'auth_failed' && err.phase === 'login',
    );
    assert.equal(cam.connections, 1, 'no control socket after a failed login');
    await waitFor(() => cam.closed === 1);
  } finally {
    await cam.stop();
  }
});

test('auth_failed when the login result is a header-only frame', async () => {
  const fx = fixtures[0];
  const cam = await fakeCamera([[() => Buffer.from(fx.server.login[0], 'hex'), () => P.buildFrame(Buffer.alloc(0), 0)]]);
  try {
    await assert.rejects(
      control({ host: '127.0.0.1', port: cam.port, password: 'x', commandId: 1, rsaKey: KEY_PEM }),
      { code: 'auth_failed' },
    );
  } finally {
    await cam.stop();
  }
});

test('timeout when the camera accepts but never answers; socket is destroyed', async () => {
  const cam = await fakeCamera([[() => 'silent']]);
  try {
    const t0 = Date.now();
    await assert.rejects(
      control({ host: '127.0.0.1', port: cam.port, password: 'x', commandId: 1, rsaKey: KEY_PEM, timeoutMs: 150 }),
      (err) => err.code === 'timeout' && err.phase === 'login',
    );
    assert.ok(Date.now() - t0 < 2000);
    await waitFor(() => cam.closed === 1);
  } finally {
    await cam.stop();
  }
});

test('timeout on the control socket when no ack arrives', async () => {
  const fx = fixtures[0];
  const cam = await fakeCamera([scriptFromFixture(fx)[0], [() => 'silent']]);
  try {
    await assert.rejects(
      control({
        host: '127.0.0.1',
        port: cam.port,
        password: fx.params.password,
        commandId: fx.params.commandId,
        bodyTail: Buffer.from(fx.params.bodyTail, 'hex'),
        rsaKey: KEY_PEM,
        timeoutMs: 150,
      }),
      (err) => err.code === 'timeout' && err.phase === 'control',
    );
    await waitFor(() => cam.closed === 2);
  } finally {
    await cam.stop();
  }
});

test('onFrameSent runs after the write and before the ack', async () => {
  const cam = await fakeCommandPort({ onControl: () => 300 });
  try {
    const order = [];
    const t0 = Date.now();
    const res = await control({
      host: '127.0.0.1',
      port: cam.port,
      password: 'x',
      commandId: PTZ.COMMAND_ID,
      bodyTail: ptzFrameTail(PTZ.UP),
      rsaKey: KEY_PEM,
      onFrameSent: () => order.push(['sent', Date.now() - t0]),
    });
    order.push(['acked', Date.now() - t0]);
    assert.deepEqual(res.ack, ACK);
    assert.deepEqual(order.map((o) => o[0]), ['sent', 'acked']);
    assert.ok(order[1][1] - order[0][1] >= 250, 'onFrameSent did not wait for the ack');
  } finally {
    await cam.stop();
  }
});

test('ackTimeoutMs and ackSignal bound the ack wait; errors say the frame was sent', async () => {
  const cam = await fakeCommandPort({ onControl: () => 'silent' });
  const opts = {
    host: '127.0.0.1',
    port: cam.port,
    password: 'x',
    commandId: PTZ.COMMAND_ID,
    bodyTail: ptzFrameTail(PTZ.UP),
    rsaKey: KEY_PEM,
    timeoutMs: 5000,
  };
  try {
    let t0 = Date.now();
    await assert.rejects(control({ ...opts, ackTimeoutMs: 150 }), {
      code: 'timeout',
      phase: 'control',
      frameSent: true,
    });
    assert.ok(Date.now() - t0 < 2000);

    const ac = new AbortController();
    t0 = Date.now();
    await assert.rejects(control({ ...opts, ackSignal: ac.signal, onFrameSent: () => setTimeout(() => ac.abort(), 50) }), {
      code: 'aborted',
      phase: 'control',
      frameSent: true,
    });
    assert.ok(Date.now() - t0 < 2000);

    // Aborted before the call: the login and the frame still go out.
    const early = new AbortController();
    early.abort();
    await assert.rejects(control({ ...opts, ackSignal: early.signal }), { code: 'aborted', frameSent: true });
    // Closing the socket right after the write still delivers the frame.
    await waitFor(() => cam.commands().length === 3);
  } finally {
    await cam.stop();
  }
});

test('a frame with no ack is closed with a reset; an acked one is not', async () => {
  const cam = await fakeCommandPort({ onControl: (cmd, n) => (n === 0 ? 'silent' : 'ack') });
  const opts = {
    host: '127.0.0.1',
    port: cam.port,
    password: 'x',
    commandId: PTZ.COMMAND_ID,
    bodyTail: ptzFrameTail(PTZ.UP),
    rsaKey: KEY_PEM,
    timeoutMs: 5000,
  };
  try {
    await assert.rejects(control({ ...opts, ackTimeoutMs: 150 }), { code: 'timeout', frameSent: true });
    // A lost frame is then dropped, not retransmitted after the caller moved on.
    await waitFor(() => cam.resets === 1);
    await control(opts);
    // Give a stray reset time to arrive before checking there was none.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(cam.resets, 1, 'the acked frame and the logins close normally');
  } finally {
    await cam.stop();
  }
});

test('a control socket that never connects reports frameSent false', async () => {
  let n = 0;
  const connect = (o) => {
    n += 1;
    return net.connect(n === 1 ? o : { host: '127.0.0.1', port: refused });
  };
  const refused = await closedPort();
  const cam = await fakeCommandPort();
  try {
    await assert.rejects(
      control({ host: '127.0.0.1', port: cam.port, password: 'x', commandId: 1, rsaKey: KEY_PEM, connect }),
      { code: 'ECONNREFUSED', phase: 'control', frameSent: false },
    );
  } finally {
    await cam.stop();
  }
});

test('ECONNREFUSED is passed through', async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  await assert.rejects(
    control({ host: '127.0.0.1', port, password: 'x', commandId: 1, rsaKey: KEY_PEM }),
    (err) => err instanceof EzvizLanError && err.code === 'ECONNREFUSED' && err.phase === 'login',
  );
});

test('closed when the camera hangs up mid-login', async () => {
  const cam = await fakeCamera([[() => 'close']]);
  try {
    await assert.rejects(
      control({ host: '127.0.0.1', port: cam.port, password: 'x', commandId: 1, rsaKey: KEY_PEM }),
      { code: 'closed' },
    );
  } finally {
    await cam.stop();
  }
});

test('bad_response for a truncated challenge or an undecryptable one', async () => {
  for (const reply of [P.buildFrame(Buffer.alloc(100, 1)), P.buildFrame(Buffer.alloc(192, 7))]) {
    const cam = await fakeCamera([[() => reply]]);
    try {
      await assert.rejects(
        control({ host: '127.0.0.1', port: cam.port, password: 'x', commandId: 1, rsaKey: KEY_PEM }),
        { code: 'bad_response' },
      );
    } finally {
      await cam.stop();
    }
  }
});

test('bad_response for an absurd declared frame length', async () => {
  const head = Buffer.alloc(16);
  head.writeUInt32BE(0x7fffffff, 0);
  const cam = await fakeCamera([[() => head]]);
  try {
    await assert.rejects(
      control({ host: '127.0.0.1', port: cam.port, password: 'x', commandId: 1, rsaKey: KEY_PEM }),
      { code: 'bad_response' },
    );
  } finally {
    await cam.stop();
  }
});

test('the connect factory is used for both sockets', async () => {
  const fx = fixtures[1];
  const cam = await fakeCamera(scriptFromFixture(fx));
  const seen = [];
  try {
    const res = await control({
      host: 'camera.invalid',
      port: 8000,
      password: fx.params.password,
      commandId: fx.params.commandId,
      bodyTail: Buffer.from(fx.params.bodyTail, 'hex'),
      localIp: fx.params.localIp,
      rsaKey: fx.rsaPrivateKeyPem,
      connect: ({ host, port }) => {
        seen.push(`${host}:${port}`);
        return net.connect({ host: '127.0.0.1', port: cam.port });
      },
    });
    assert.deepEqual(seen, ['camera.invalid:8000', 'camera.invalid:8000']);
    assert.equal(hex(res.request), fx.client.control[0]);
  } finally {
    await cam.stop();
  }
});

test('argument validation', async () => {
  const base = { host: '127.0.0.1', password: 'x', commandId: 1, rsaKey: KEY_PEM, connect: () => assert.fail('no connect') };
  await assert.rejects(control({ ...base, host: '' }), { code: 'invalid_argument' });
  await assert.rejects(control({ ...base, password: '' }), { code: 'invalid_argument' });
  await assert.rejects(control({ ...base, commandId: -1 }), { code: 'invalid_argument' });
  await assert.rejects(control({ ...base, localIp: '::1' }), { code: 'invalid_argument' });
  await assert.rejects(control({ ...base, bodyTail: 'nope' }), { code: 'invalid_argument' });
  await assert.rejects(control({ ...base, username: 'u'.repeat(49) }), { code: 'invalid_argument' });
  // setTimeout fires at once above 2^31-1 ms, so large timeouts are refused.
  await assert.rejects(control({ ...base, timeoutMs: 2 ** 31 }), { code: 'invalid_argument' });
  await assert.rejects(control({ ...base, timeoutMs: 60001 }), { code: 'invalid_argument' });
  await assert.rejects(control({ ...base, ackTimeoutMs: 0 }), { code: 'invalid_argument' });
  await assert.rejects(control({ ...base, ackTimeoutMs: 60001 }), { code: 'invalid_argument' });
  await assert.rejects(control({ ...base, onFrameSent: 'nope' }), { code: 'invalid_argument' });
  await assert.rejects(control({ ...base, ackSignal: {} }), { code: 'invalid_argument' });
  const small = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(control({ ...base, rsaKey: small }), { code: 'invalid_argument' });
});

// ------------------------------------------------------------- PTZ helpers

test('PTZ constants and ptzFrameTail', () => {
  assert.ok(Object.isFrozen(PTZ));
  assert.equal(PTZ.COMMAND_ID, 0x00030203);
  assert.deepEqual([PTZ.UP, PTZ.DOWN, PTZ.LEFT, PTZ.RIGHT], [21, 22, 23, 24]);
  assert.deepEqual([PTZ.UP, PTZ.DOWN, PTZ.LEFT, PTZ.RIGHT].map(PTZ.stopOf), [-22, -23, -24, -25]);
  // The four frames shown in docs/PROTOCOL.md.
  assert.equal(hex(ptzFrameTail(23)), '000000010000001700000004');
  assert.equal(hex(ptzFrameTail(-24)), '00000001ffffffe800000004');
  assert.equal(hex(ptzFrameTail(24)), '000000010000001800000004');
  assert.equal(hex(ptzFrameTail(-25)), '00000001ffffffe700000004');
  assert.equal(hex(ptzFrameTail(21, { channel: 2, speed: 7 })), '000000020000001500000007');
  assert.throws(() => ptzFrameTail(1.5), { code: 'invalid_argument' });
  assert.throws(() => ptzFrameTail(21, { speed: 0 }), { code: 'invalid_argument' });
  assert.throws(() => ptzFrameTail(21, { speed: 8 }), { code: 'invalid_argument' });
  assert.throws(() => ptzFrameTail(21, { channel: 0 }), { code: 'invalid_argument' });
});

test('AES S-box matches FIPS-197 spot values', () => {
  assert.equal(P.SBOX[0x00], 0x63);
  assert.equal(P.SBOX[0x01], 0x7c);
  assert.equal(P.SBOX[0x53], 0xed);
  assert.equal(P.SBOX[0xff], 0x16);
  assert.equal(new Set(P.SBOX).size, 256);
});
