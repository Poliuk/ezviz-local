'use strict';

// move(): start, wait, stop, against a fake command port on 127.0.0.1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { move, PTZ, EzvizLanError } = require('../lib');
const { STOP_ATTEMPTS } = require('../lib/move');
const { fakeCommandPort } = require('./support/fakes');

const KEY_PEM = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ptz-left-start.json'), 'utf8'))
  .rsaPrivateKeyPem;

const base = (port, extra = {}) => ({
  host: '127.0.0.1',
  port,
  password: 'ABCDEF',
  rsaKey: KEY_PEM,
  timeoutMs: 1000,
  ...extra,
});

test('sends the start, waits, then sends the matching stop', async () => {
  const cam = await fakeCommandPort();
  try {
    const res = await move(base(cam.port, { direction: 'left', durationMs: 300, speed: 6 }));
    assert.equal(res.ok, true);
    assert.equal(res.startAcked, true);
    assert.equal(res.interrupted, undefined);
    assert.ok(res.durationMs >= 290 && res.durationMs < 1500, `durationMs ${res.durationMs}`);
    assert.deepEqual(cam.commands(), [PTZ.LEFT, PTZ.stopOf(PTZ.LEFT)]);
    const ctl = cam.events.filter((e) => e.type === 'control');
    assert.ok(ctl[1].at - ctl[0].at >= 290, 'stop comes after the wait');
    assert.deepEqual(
      ctl.map((e) => [e.channel, e.speed]),
      [
        [1, 6],
        [1, 6],
      ],
    );
    assert.equal(cam.connections, 4, 'login + control for the start, then for the stop');
  } finally {
    await cam.stop();
  }
});

test('each direction maps to its start and stop codes', async () => {
  const cam = await fakeCommandPort();
  try {
    for (const direction of ['up', 'down', 'right']) {
      await move(base(cam.port, { direction, durationMs: 100 }));
    }
    assert.deepEqual(cam.commands(), [21, -22, 22, -23, 24, -25]);
  } finally {
    await cam.stop();
  }
});

test('a failed stop is retried until the camera acknowledges it', async () => {
  const cam = await fakeCommandPort({
    // n=0 is the start; the first two stops get the connection dropped.
    onControl: (cmd, n) => (n === 1 || n === 2 ? 'close' : 'ack'),
  });
  try {
    const res = await move(base(cam.port, { direction: 'up', durationMs: 100 }));
    assert.equal(res.ok, true);
    assert.deepEqual(cam.commands(), [21, -22, -22, -22]);
  } finally {
    await cam.stop();
  }
});

test('rejects with stop_failed after STOP_ATTEMPTS unacknowledged stops', async () => {
  const cam = await fakeCommandPort({ onControl: (cmd) => (cmd < 0 ? 'close' : 'ack') });
  try {
    await assert.rejects(move(base(cam.port, { direction: 'right', durationMs: 100 })), (err) => {
      assert.ok(err instanceof EzvizLanError);
      assert.equal(err.code, 'stop_failed');
      assert.equal(err.attempts, STOP_ATTEMPTS);
      assert.equal(err.cause.code, 'closed');
      return true;
    });
    assert.equal(STOP_ATTEMPTS, 3);
    assert.deepEqual(cam.commands(), [24, -25, -25, -25]);
  } finally {
    await cam.stop();
  }
});

test('an aborted wait stops the camera at once', async () => {
  const cam = await fakeCommandPort();
  const ac = new AbortController();
  try {
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 150);
    const res = await move(base(cam.port, { direction: 'down', durationMs: 8000, signal: ac.signal }));
    assert.equal(res.ok, true);
    assert.equal(res.interrupted, true);
    assert.ok(res.durationMs < 2000, `durationMs ${res.durationMs}`);
    assert.ok(Date.now() - t0 < 3000);
    assert.deepEqual(cam.commands(), [22, -23]);
  } finally {
    await cam.stop();
  }
});

test('an abort during the start still waits for the start, then stops', async () => {
  const cam = await fakeCommandPort();
  const ac = new AbortController();
  try {
    const p = move(base(cam.port, { direction: 'left', durationMs: 5000, signal: ac.signal }));
    setImmediate(() => ac.abort());
    const res = await p;
    assert.equal(res.interrupted, true);
    assert.deepEqual(cam.commands(), [23, -24]);
  } finally {
    await cam.stop();
  }
});

test('a start that fails after login is followed by a stop', async () => {
  // The camera takes the start frame and hangs up without an ack: the start
  // may have been applied, so a stop must go out.
  const cam = await fakeCommandPort({ onControl: (cmd, n) => (n === 0 ? 'close' : 'ack') });
  try {
    await assert.rejects(move(base(cam.port, { direction: 'left', durationMs: 1000 })), (err) => {
      assert.equal(err.code, 'closed');
      assert.equal(err.phase, 'control');
      assert.equal(err.stopSent, true);
      return true;
    });
    assert.deepEqual(cam.commands(), [23, -24]);
  } finally {
    await cam.stop();
  }
});

// Time from the start frame reaching the camera to the stop reaching it.
const runTime = (cam) => {
  const ctl = cam.events.filter((e) => e.type === 'control');
  return ctl[1].at - ctl[0].at;
};

test('a late start ack does not delay the stop past durationMs', async () => {
  const cam = await fakeCommandPort({ onControl: (cmd, n) => (n === 0 ? 2000 : 'ack') });
  try {
    const t0 = Date.now();
    const res = await move(base(cam.port, { direction: 'left', durationMs: 300, timeoutMs: 5000 }));
    assert.equal(res.ok, true);
    assert.equal(res.startAcked, false);
    assert.equal(res.interrupted, undefined);
    assert.deepEqual(cam.commands(), [23, -24]);
    const run = runTime(cam);
    assert.ok(run >= 290 && run < 900, `stop reached the camera ${run} ms after the start`);
    assert.ok(Date.now() - t0 < 1500, 'did not wait for the ack');
  } finally {
    await cam.stop();
  }
});

test('a start ack that never comes: stop at durationMs, reported unacknowledged', async () => {
  const cam = await fakeCommandPort({ onControl: (cmd, n) => (n === 0 ? 'silent' : 'ack') });
  try {
    const res = await move(base(cam.port, { direction: 'up', durationMs: 300, timeoutMs: 5000 }));
    assert.equal(res.ok, true);
    assert.equal(res.startAcked, false);
    assert.deepEqual(cam.commands(), [21, -22]);
    const run = runTime(cam);
    assert.ok(run >= 290 && run < 900, `stop reached the camera ${run} ms after the start`);
  } finally {
    await cam.stop();
  }
});

test('a missing start ack with timeoutMs below durationMs still runs the full duration', async () => {
  const cam = await fakeCommandPort({ onControl: (cmd, n) => (n === 0 ? 'silent' : 'ack') });
  try {
    const res = await move(base(cam.port, { direction: 'up', durationMs: 600, timeoutMs: 200 }));
    assert.equal(res.ok, true);
    assert.equal(res.startAcked, false);
    const run = runTime(cam);
    assert.ok(run >= 590 && run < 1200, `stop reached the camera ${run} ms after the start`);
  } finally {
    await cam.stop();
  }
});

test('an abort while waiting for the start ack stops the camera at once', async () => {
  const ac = new AbortController();
  const cam = await fakeCommandPort({
    onControl: (cmd, n) => {
      if (n !== 0) return 'ack';
      setTimeout(() => ac.abort(), 100); // the start frame has arrived
      return 'silent';
    },
  });
  try {
    const t0 = Date.now();
    const res = await move(base(cam.port, { direction: 'right', durationMs: 8000, signal: ac.signal }));
    assert.equal(res.ok, true);
    assert.equal(res.interrupted, true);
    assert.equal(res.startAcked, false);
    assert.deepEqual(cam.commands(), [24, -25]);
    const run = runTime(cam);
    assert.ok(run >= 90 && run < 700, `stop reached the camera ${run} ms after the start`);
    assert.ok(Date.now() - t0 < 2000);
  } finally {
    await cam.stop();
  }
});

test('a start that fails at login is never followed by a stop', async () => {
  // The camera never answers the login: nothing was sent, nothing can move.
  const net = require('node:net');
  const sockets = [];
  const srv = net.createServer((s) => sockets.push(s));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(move(base(srv.address().port, { direction: 'up', durationMs: 100, timeoutMs: 200 })), {
      code: 'timeout',
      phase: 'login',
    });
    assert.equal(sockets.length, 1, 'only the start login connected');
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => srv.close(r));
  }
});

test('start failure plus stop failure is reported as stop_failed', async () => {
  const cam = await fakeCommandPort({ onControl: () => 'close' });
  try {
    await assert.rejects(move(base(cam.port, { direction: 'up', durationMs: 100 })), (err) => {
      assert.equal(err.code, 'stop_failed');
      assert.equal(err.startError.code, 'closed');
      return true;
    });
    assert.deepEqual(cam.commands(), [21, -22, -22, -22]);
  } finally {
    await cam.stop();
  }
});

test('a login failure sends nothing else', async () => {
  const cam = await fakeCommandPort({ authFail: true });
  try {
    await assert.rejects(move(base(cam.port, { direction: 'up', durationMs: 100, password: 'WRONG' })), {
      code: 'auth_failed',
      phase: 'login',
    });
    assert.deepEqual(cam.commands(), []);
    assert.equal(cam.connections, 1);
  } finally {
    await cam.stop();
  }
});

test('arguments are checked before anything is sent', async () => {
  const connect = () => assert.fail('must not connect');
  const ok = { host: '127.0.0.1', password: 'x', direction: 'up', durationMs: 500, rsaKey: KEY_PEM, connect };
  const bad = [
    { durationMs: undefined },
    { durationMs: 99 },
    { durationMs: 8001 },
    { durationMs: 250.5 },
    { direction: 'north' },
    { direction: undefined },
    { speed: 0 },
    { speed: 8 },
    { password: '' },
    { host: '' },
    { timeoutMs: 0 },
    { timeoutMs: 60001 },
    { timeoutMs: 2 ** 31 },
  ];
  for (const b of bad) {
    await assert.rejects(move({ ...ok, ...b }), { code: 'invalid_argument' }, JSON.stringify(b));
  }
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(move({ ...ok, signal: ac.signal }), { code: 'aborted' });
});
