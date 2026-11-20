'use strict';

// bin/ezviz-local and lib/cli.js. The password must never be taken from argv.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { main, parseArgs, formatProbe } = require('../lib/cli');
const { fakeRtsp, fakeListener, fakeCommandPort } = require('./support/fakes');

const BIN = path.join(__dirname, '..', 'bin', 'ezviz-local');

function sink() {
  const s = { text: '', write: (d) => ((s.text += d), true) };
  return s;
}

function io({ env = {}, api, onSignal } = {}) {
  const stdout = sink();
  const stderr = sink();
  return {
    stdout,
    stderr,
    io: { env, stdin: { isTTY: false }, stdout, stderr, api, onSignal: onSignal || (() => () => {}) },
  };
}

function run(args, { env = {}, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('cli timed out'));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// ------------------------------------------------------------- parseArgs

test('password options are refused in every spelling, and never echoed', () => {
  const spellings = [
    ['--password', 'S3CRET1'],
    ['--password=S3CRET1'],
    ['-p', 'S3CRET1'],
    ['--pass', 'S3CRET1'],
    ['--pw=S3CRET1'],
    ['-P', 'S3CRET1'],
    ['--verification-code', 'S3CRET1'],
  ];
  for (const extra of spellings) {
    for (const cmd of [
      ['probe', '192.0.2.10'],
      ['move', '192.0.2.10', 'left'],
    ]) {
      assert.throws(
        () => parseArgs([...cmd, ...extra]),
        (err) => err.code === 'usage' && /not accepted on the command line/.test(err.message) && !err.message.includes('S3CRET1'),
        extra.join(' '),
      );
    }
  }
});

test('stray arguments that might be a password are not echoed', () => {
  for (const argv of [
    ['probe', '192.0.2.10', 'S3CRET1'],
    ['move', '192.0.2.10', 'S3CRET1'],
    ['move', '192.0.2.10', 'left', 'S3CRET1'],
    ['move', '192.0.2.10', 'left', '500', 'S3CRET1'],
    ['probe', 'admin:S3CRET1@192.0.2.10'],
  ]) {
    assert.throws(
      () => parseArgs(argv),
      (err) => err.code === 'usage' && !err.message.includes('S3CRET1'),
      argv.join(' '),
    );
  }
});

test('parseArgs: probe and move', () => {
  assert.deepEqual(parseArgs(['probe', '192.0.2.10', '--json', '--rtsp-port', '8554', '--port=8001']), {
    json: true,
    help: false,
    version: false,
    rtspPort: 8554,
    port: 8001,
    command: 'probe',
    host: '192.0.2.10',
  });
  const m = parseArgs(['move', '192.0.2.10', 'up']);
  assert.equal(m.direction, 'up');
  assert.equal(m.durationMs, 500);
  assert.equal(parseArgs(['move', '192.0.2.10', 'right', '1200', '--speed', '7']).durationMs, 1200);
  assert.equal(parseArgs(['move', '192.0.2.10', 'right', '--speed', '7']).speed, 7);
  for (const bad of [
    [],
    ['zoom', '192.0.2.10'],
    ['probe'],
    ['move', '192.0.2.10'],
    ['move', '192.0.2.10', 'north'],
    ['move', '192.0.2.10', 'up', '50'],
    ['move', '192.0.2.10', 'up', '9000'],
    ['move', '192.0.2.10', 'up', '--speed', '9'],
    ['probe', '192.0.2.10', '--speed', '3'],
    ['move', '192.0.2.10', 'up', '--rtsp-port', '554'],
    ['probe', '192.0.2.10', '--bogus'],
    ['probe', '192.0.2.10', '--port'],
  ]) {
    assert.throws(() => parseArgs(bad), { code: 'usage' }, bad.join(' '));
  }
});

// ------------------------------------------------------------------ main

test('main passes EZVIZ_PASSWORD to the library', async () => {
  const calls = [];
  const api = {
    move: async (o) => {
      calls.push(o);
      return { ok: true, durationMs: 400 };
    },
  };
  const t = io({ env: { EZVIZ_PASSWORD: 'FROMENV' }, api });
  const code = await main(['move', '192.0.2.10', 'left', '400', '--user', 'viewer'], t.io);
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].password, 'FROMENV');
  assert.equal(calls[0].username, 'viewer');
  assert.equal(calls[0].direction, 'left');
  assert.equal(calls[0].durationMs, 400);
  assert.ok(calls[0].signal, 'move gets an abort signal');
  assert.match(t.stdout.text, /Moved left for 400 ms/);
  assert.ok(!t.stdout.text.includes('FROMENV') && !t.stderr.text.includes('FROMENV'));
});

test('move without a password and without a terminal exits 2 and calls nothing', async () => {
  const api = { move: () => assert.fail('must not move') };
  const t = io({ api });
  assert.equal(await main(['move', '192.0.2.10', 'up'], t.io), 2);
  assert.match(t.stderr.text, /EZVIZ_PASSWORD/);
});

test('--password is refused before anything runs', async () => {
  const api = { move: () => assert.fail('must not move'), probe: () => assert.fail('must not probe') };
  const t = io({ env: { EZVIZ_PASSWORD: 'x' }, api });
  assert.equal(await main(['move', '192.0.2.10', 'up', '--password', 'S3CRET1'], t.io), 2);
  assert.ok(!t.stderr.text.includes('S3CRET1'));
});

test('probe without a password and without a terminal runs unauthenticated', async () => {
  const calls = [];
  const api = {
    probe: async (o) => {
      calls.push(o);
      return {
        commandPort: { open: true },
        rtsp: { open: true, auth: 'unknown', paths: { main: '/Streaming/Channels/101', sub: '/Streaming/Channels/102' } },
      };
    },
  };
  const t = io({ api });
  assert.equal(await main(['probe', '192.0.2.10'], t.io), 0);
  assert.equal(calls[0].password, '');
  assert.match(t.stdout.text, /Login: not checked/);
});

test('an interrupted move reports it and exits 130', async () => {
  let fire;
  const api = {
    move: (o) =>
      new Promise((resolve) => {
        o.signal.addEventListener('abort', () => resolve({ ok: true, durationMs: 120, interrupted: true }));
        fire();
      }),
  };
  const t = io({
    env: { EZVIZ_PASSWORD: 'x' },
    api,
    onSignal: (handler) => {
      fire = handler;
      return () => {};
    },
  });
  assert.equal(await main(['move', '192.0.2.10', 'up', '5000'], t.io), 130);
  assert.match(t.stdout.text, /\(interrupted\)/);
});

test('a failed stop is reported loudly', async () => {
  const api = {
    move: async () => {
      const err = new Error('the camera did not acknowledge the stop after 3 attempts');
      err.code = 'stop_failed';
      throw err;
    },
  };
  const t = io({ env: { EZVIZ_PASSWORD: 'x' }, api });
  assert.equal(await main(['move', '192.0.2.10', 'up'], t.io), 1);
  assert.match(t.stderr.text, /stop_failed/);
  assert.match(t.stderr.text, /may still be moving/);
});

test('formatProbe prints a placeholder, never the password', () => {
  const text = formatProbe(
    '192.0.2.10',
    {
      commandPort: { open: true },
      rtsp: {
        open: true,
        auth: 'ok',
        paths: { main: '/Streaming/Channels/101', sub: '/Streaming/Channels/102' },
        video: 'H264',
        audio: { codec: 'MPEG4-GENERIC', rate: 16000 },
        backchannel: { codecs: ['PCMU/8000'] },
      },
    },
    {},
  );
  assert.match(text, /rtsp:\/\/admin:PASSWORD@192\.0\.2\.10:554\/Streaming\/Channels\/101#backchannel=1/);
  assert.match(text, /Two-way audio \(ONVIF backchannel\): yes, PCMU\/8000/);
});

// ------------------------------------------------------------ the binary

test('bin: --password exits 2 and does not echo the value', async () => {
  const r = await run(['move', '192.0.2.10', 'left', '--password=S3CRET1']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /not accepted on the command line/);
  assert.ok(!r.stderr.includes('S3CRET1') && !r.stdout.includes('S3CRET1'));
});

test('bin: --help and --version', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /ezviz-local probe <host>/);
  const version = await run(['--version']);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), require('../package.json').version);
});

test('bin: probe --json against fake servers', async () => {
  const rtsp = await fakeRtsp();
  const cmd = await fakeListener();
  try {
    const r = await run(
      ['probe', '127.0.0.1', '--json', '--rtsp-port', String(rtsp.port), '--port', String(cmd.port), '--timeout', '2000'],
      { env: { EZVIZ_PASSWORD: 'ABCDEF' } },
    );
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.commandPort.open, true);
    assert.equal(out.rtsp.auth, 'ok');
    assert.deepEqual(out.rtsp.backchannel, { codecs: ['PCMU/8000'] });
    assert.equal(cmd.bytes, 0);
  } finally {
    await rtsp.stop();
    await cmd.stop();
  }
});

test('bin: move against a fake command port', async () => {
  const cam = await fakeCommandPort();
  try {
    const r = await run(['move', '127.0.0.1', 'right', '200', '--port', String(cam.port), '--json'], {
      env: { EZVIZ_PASSWORD: 'ABCDEF' },
    });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.direction, 'right');
    assert.deepEqual(cam.commands(), [24, -25]);
  } finally {
    await cam.stop();
  }
});

test('--json: usage, password and probe errors are JSON on stdout', async () => {
  const usage = io();
  assert.equal(await main(['move', '192.0.2.10', 'north', '--json'], usage.io), 2);
  assert.deepEqual(JSON.parse(usage.stdout.text).error.code, 'usage');
  assert.equal(usage.stderr.text, '');

  const nopw = io();
  assert.equal(await main(['move', '192.0.2.10', 'left', '--json'], nopw.io), 2);
  assert.equal(JSON.parse(nopw.stdout.text).ok, false);

  const failing = io({
    api: {
      probe: async () => {
        const err = new Error('boom');
        err.code = 'invalid_argument';
        throw err;
      },
    },
  });
  assert.equal(await main(['probe', '192.0.2.10', '--json'], failing.io), 1);
  assert.deepEqual(JSON.parse(failing.stdout.text), { ok: false, error: { code: 'invalid_argument', message: 'boom' } });
});

test('bin: a second Ctrl-C does not kill the process before the stop', async () => {
  const cam = await fakeCommandPort({ ackDelayMs: 600 });
  try {
    const child = spawn(process.execPath, [BIN, 'move', '127.0.0.1', 'left', '3000', '--port', String(cam.port)], {
      env: { PATH: process.env.PATH, EZVIZ_PASSWORD: 'ABCDEF' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const exited = new Promise((resolve) => child.on('close', resolve));
    const deadline = Date.now() + 5000;
    while (cam.commands().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    child.kill('SIGINT'); // while the start is waiting for its ack
    await new Promise((r) => setTimeout(r, 200));
    child.kill('SIGINT'); // the impatient second press
    const code = await exited;
    assert.deepEqual(cam.commands(), [23, -24]);
    assert.equal(code, 130, stderr);
    assert.match(stderr, /stopping the camera/);
  } finally {
    await cam.stop();
  }
});
