'use strict';

// Command-line front end for bin/ezviz-local.
//
//   ezviz-local probe <host> [options]
//   ezviz-local move <host> <up|down|left|right> [ms] [options]
//
// The password comes from EZVIZ_PASSWORD or a hidden prompt. It is never
// accepted as an argument: arguments end up in shell history and in the
// process list, where other users on the machine can read them.

const lib = require('./index');
const { MIN_DURATION_MS, MAX_DURATION_MS } = require('./move');

const DEFAULT_MOVE_MS = 500;

const USAGE = `Usage:
  ezviz-local probe <host> [options]
  ezviz-local move <host> <up|down|left|right> [ms] [options]

Commands:
  probe   Check the command port and RTSP service, and whether the camera
          offers two-way audio. It only reads; nothing moves or plays.
  move    Pan or tilt for <ms> milliseconds (default ${DEFAULT_MOVE_MS}, ${MIN_DURATION_MS} to ${MAX_DURATION_MS}), then stop.

Options:
  --user <name>       camera user (default admin)
  --port <n>          command port (default 8000)
  --rtsp-port <n>     RTSP port, probe only (default 554)
  --speed <1-7>       pan/tilt speed, move only (default 4; only 4 tested)
  --timeout <ms>      per-step network timeout
  --json              print one JSON object instead of text
  -h, --help          show this help
  -v, --version       show the version

Password:
  Set EZVIZ_PASSWORD, or type it at the prompt. On most EZVIZ cameras it is
  the six-character verification code on the camera's label. It is not accepted
  as an argument.
`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.code = 'usage';
  }
}

const VALUE_OPTIONS = new Set(['--user', '--port', '--rtsp-port', '--speed', '--timeout']);
const PASSWORD_OPTION = /^(--?(pass(word)?|pw|pwd|p|secret|code|verification-code))(=.*)?$/i;

function intOption(name, raw, min, max) {
  if (!/^\d+$/.test(raw || '')) throw new UsageError(`${name} must be a whole number`);
  const n = Number(raw);
  if (n < min || n > max) throw new UsageError(`${name} must be from ${min} to ${max}`);
  return n;
}

/** Parses argv (without node and the script path). Throws UsageError. */
function parseArgs(argv) {
  const opts = { json: false, help: false, version: false };
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (PASSWORD_OPTION.test(arg)) {
      throw new UsageError(
        'passwords are not accepted on the command line. Set EZVIZ_PASSWORD or type it at the prompt.',
      );
    }
    if (arg === '--json') opts.json = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '-v' || arg === '--version') opts.version = true;
    else if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (!VALUE_OPTIONS.has(name)) throw new UsageError(`unknown option ${name}`);
      let value;
      if (eq !== -1) value = arg.slice(eq + 1);
      else {
        value = argv[i + 1];
        i += 1;
        if (value === undefined) throw new UsageError(`${name} needs a value`);
      }
      if (name === '--user') {
        if (!value) throw new UsageError('--user needs a value');
        opts.username = value;
      } else if (name === '--port') opts.port = intOption(name, value, 1, 65535);
      else if (name === '--rtsp-port') opts.rtspPort = intOption(name, value, 1, 65535);
      else if (name === '--speed') opts.speed = intOption(name, value, 1, 7);
      else if (name === '--timeout') opts.timeoutMs = intOption(name, value, 100, 60000);
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new UsageError(`unknown option ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (opts.help || opts.version) return opts;

  const [command, host, ...rest] = positional;
  if (!command) throw new UsageError('missing command');
  if (command !== 'probe' && command !== 'move') throw new UsageError(`unknown command ${command}`);
  if (!host) throw new UsageError('missing <host>');
  if (/[@/]/.test(host)) {
    throw new UsageError('<host> must be a bare address such as 192.0.2.10, with no user, password or path');
  }
  opts.command = command;
  opts.host = host;

  if (command === 'probe') {
    if (rest.length) throw new UsageError('too many arguments for probe');
    if (opts.speed !== undefined) throw new UsageError('--speed is for move');
    return opts;
  }
  if (opts.rtspPort !== undefined) throw new UsageError('--rtsp-port is for probe');
  const [direction, ms, ...extra] = rest;
  if (!direction) throw new UsageError('missing direction (up, down, left or right)');
  if (!['up', 'down', 'left', 'right'].includes(direction)) {
    throw new UsageError('direction must be up, down, left or right');
  }
  if (extra.length) throw new UsageError('too many arguments for move');
  opts.direction = direction;
  opts.durationMs = ms === undefined ? DEFAULT_MOVE_MS : intOption('[ms]', ms, MIN_DURATION_MS, MAX_DURATION_MS);
  return opts;
}

/** Reads a line from a TTY without echoing it. */
function promptHidden(question, { stdin, stderr }) {
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      try {
        stdin.setRawMode(false);
      } catch {
        // not a TTY any more
      }
      stdin.pause();
      stderr.write('\n');
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          const err = new Error('cancelled');
          err.code = 'cancelled';
          reject(err);
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function getPassword({ env, stdin, stderr, required }) {
  if (env.EZVIZ_PASSWORD) return env.EZVIZ_PASSWORD;
  if (stdin && stdin.isTTY && typeof stdin.setRawMode === 'function') {
    return promptHidden(required ? 'Camera password: ' : 'Camera password (Enter to skip): ', { stdin, stderr });
  }
  if (required) throw new UsageError('no password. Set EZVIZ_PASSWORD, or run in a terminal to be prompted.');
  return '';
}

function formatProbe(host, r, opts) {
  const user = opts.username || 'admin';
  const rtspPort = opts.rtspPort || 554;
  const cmdPort = opts.port || 8000;
  const hostInUrl = host.includes(':') ? `[${host}]` : host;
  const lines = [];
  lines.push(`Command port ${cmdPort}: ${r.commandPort.open ? 'open (pan/tilt over the LAN should work)' : 'closed'}`);
  if (!r.rtsp.open) {
    lines.push(`RTSP port ${rtspPort}: closed`);
    lines.push("  RTSP is off or blocked. See docs/CAMERA-SETUP.md, step 3, to turn on the camera's RTSP service.");
    return lines.join('\n');
  }
  lines.push(`RTSP port ${rtspPort}: open`);
  const auth = {
    ok: 'accepted',
    failed: 'rejected (check the user and password)',
    unknown: 'not checked',
  }[r.rtsp.auth];
  lines.push(`  Login: ${auth}`);
  const url = (p) => `rtsp://${user}:PASSWORD@${hostInUrl}:${rtspPort}${p}`;
  lines.push(`  Main stream: ${url(r.rtsp.paths.main)}`);
  lines.push(`  Sub stream:  ${url(r.rtsp.paths.sub)}`);
  if (r.rtsp.video) lines.push(`  Video: ${r.rtsp.video}`);
  if (r.rtsp.audio) lines.push(`  Camera microphone: ${r.rtsp.audio.codec}, ${r.rtsp.audio.rate} Hz`);
  if (r.rtsp.backchannel) {
    lines.push(`  Two-way audio (ONVIF backchannel): yes, ${r.rtsp.backchannel.codecs.join(', ') || 'codec not listed'}`);
    lines.push(`  go2rtc source for talking: ${url(r.rtsp.paths.main)}#backchannel=1`);
  } else if (r.rtsp.backchannel === null) {
    lines.push('  Two-way audio (ONVIF backchannel): not offered');
  }
  return lines.join('\n');
}

/**
 * Runs the CLI. Returns the exit code: 0 done, 1 failed, 2 usage, 130 interrupted.
 * @param {string[]} argv
 * @param {{env?:object, stdin?:any, stdout?:any, stderr?:any, api?:object, onSignal?:Function, version?:string}} [io]
 */
async function main(argv, io = {}) {
  const env = io.env || process.env;
  const stdin = io.stdin || process.stdin;
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const api = io.api || lib;
  // The first signal aborts the wait so the stop goes out at once. Later ones
  // are ignored until move() returns: Node's default handler would end the
  // process before the stop is sent. SIGHUP covers a closed terminal.
  const onSignal = io.onSignal || ((handler) => {
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    let seen = false;
    const listener = () => {
      if (seen) {
        stderr.write('ezviz-local: stopping the camera, please wait\n');
        return;
      }
      seen = true;
      handler();
    };
    for (const s of signals) process.on(s, listener);
    return () => {
      for (const s of signals) process.removeListener(s, listener);
    };
  });

  // With --json, every failure is one JSON object on stdout.
  const wantsJson = argv.includes('--json');
  const fail = (exit, code, message, text = `ezviz-local: ${message}\n`) => {
    if (wantsJson) stdout.write(JSON.stringify({ ok: false, error: { code, message } }) + '\n');
    else stderr.write(text);
    return exit;
  };

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    return fail(2, err.code || 'usage', err.message, `ezviz-local: ${err.message}\n\n${USAGE}`);
  }
  if (opts.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (opts.version) {
    stdout.write(`${io.version || require('../package.json').version}\n`);
    return 0;
  }

  let password;
  try {
    password = await getPassword({ env, stdin, stderr, required: opts.command === 'move' });
  } catch (err) {
    if (err.code === 'cancelled') return wantsJson ? fail(130, 'cancelled', 'cancelled') : 130;
    return fail(2, err.code || 'usage', err.message);
  }
  if (opts.command === 'move' && !password) {
    return fail(2, 'usage', 'a password is required to move the camera');
  }

  const common = { host: opts.host, password, username: opts.username || 'admin' };
  if (opts.timeoutMs !== undefined) common.timeoutMs = opts.timeoutMs;

  if (opts.command === 'probe') {
    let r;
    try {
      r = await api.probe({
        ...common,
        commandPort: opts.port || 8000,
        rtspPort: opts.rtspPort || 554,
      });
    } catch (err) {
      const code = err.code || 'error';
      return fail(1, code, err.message, `ezviz-local: ${code}: ${err.message}\n`);
    }
    stdout.write(opts.json ? JSON.stringify(r) + '\n' : formatProbe(opts.host, r, opts) + '\n');
    return r.commandPort.open || r.rtsp.open ? 0 : 1;
  }

  const controller = new AbortController();
  let interrupted = false;
  const release = onSignal(() => {
    interrupted = true;
    controller.abort();
  });
  try {
    const r = await api.move({
      ...common,
      port: opts.port || 8000,
      direction: opts.direction,
      durationMs: opts.durationMs,
      speed: opts.speed || 4,
      signal: controller.signal,
    });
    if (opts.json) stdout.write(JSON.stringify({ direction: opts.direction, ...r }) + '\n');
    else {
      stdout.write(
        `Moved ${opts.direction} for ${r.durationMs} ms${r.interrupted ? ' (interrupted)' : ''}. Stop acknowledged.\n`,
      );
    }
    return interrupted ? 130 : 0;
  } catch (err) {
    const code = err.code || 'error';
    if (opts.json) {
      stdout.write(JSON.stringify({ ok: false, error: { code, message: err.message } }) + '\n');
    } else {
      stderr.write(`ezviz-local: ${code}: ${err.message}\n`);
      if (code === 'stop_failed') {
        stderr.write('The camera may still be moving. Run the same move again or power-cycle the camera.\n');
      } else if (code === 'auth_failed') {
        stderr.write('Check the user and password. Repeated failures may lock local login for a while.\n');
      }
    }
    if (code === 'aborted') return 130;
    return code === 'invalid_argument' ? 2 : 1;
  } finally {
    release();
  }
}

module.exports = { main, parseArgs, formatProbe, UsageError, USAGE, DEFAULT_MOVE_MS };
