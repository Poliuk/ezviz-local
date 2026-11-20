'use strict';

// move(): one timed pan or tilt. Start, wait, stop.
//
// The stop frame is the one with a physical consequence: a start with no stop
// leaves the motor driving into its end stop. So the stop is attempted
// whenever the start may have reached the camera, including when the wait is
// interrupted through `signal` or the start failed after login. The stop is
// tried up to STOP_ATTEMPTS times, and move() only resolves once the camera
// has acknowledged it.

const { control, ptzFrameTail, PTZ, checkTimeout } = require('./control');
const P = require('./protocol');

const { EzvizLanError } = P;

const DIRECTIONS = Object.freeze({ up: PTZ.UP, down: PTZ.DOWN, left: PTZ.LEFT, right: PTZ.RIGHT });
const MIN_DURATION_MS = 100;
const MAX_DURATION_MS = 8000;
const STOP_ATTEMPTS = 3;
const STOP_RETRY_DELAY_MS = 200;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolves after `ms`, or early when `signal` aborts. Resolves true when it
// was cut short.
function wait(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve(true);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Pan or tilt for a fixed time, then stop.
 *
 * Resolves { ok: true, durationMs } where durationMs is the measured time
 * between the start being acknowledged and the stop being sent. When `signal`
 * aborts during the wait, the stop is sent at once and the result also has
 * `interrupted: true`.
 *
 * Rejects with an EzvizLanError:
 *   - 'invalid_argument' before anything is sent;
 *   - 'aborted' if `signal` was already aborted (nothing is sent);
 *   - the start's own error (err.stopSent tells whether a precautionary stop
 *     was acknowledged) when the start failed;
 *   - 'stop_failed' when no stop was acknowledged after STOP_ATTEMPTS tries.
 *     err.attempts and err.cause carry the details; err.startError is set
 *     when the start had failed too.
 */
async function move({
  host,
  password,
  port = 8000,
  username = P.DEFAULT_USERNAME,
  direction,
  durationMs,
  speed = 4,
  timeoutMs = 5000,
  channel = 1,
  signal,
  // For tests and unusual networks; passed through to control().
  localIp,
  rsaKey,
  connect,
} = {}) {
  if (typeof host !== 'string' || !host) throw new EzvizLanError('invalid_argument', 'host is required');
  if (password === undefined || password === null || password === '') {
    throw new EzvizLanError('invalid_argument', 'password is required');
  }
  if (!Object.prototype.hasOwnProperty.call(DIRECTIONS, direction)) {
    throw new EzvizLanError('invalid_argument', 'direction must be up, down, left or right');
  }
  if (!Number.isInteger(durationMs) || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
    throw new EzvizLanError(
      'invalid_argument',
      `durationMs must be an integer from ${MIN_DURATION_MS} to ${MAX_DURATION_MS}`,
    );
  }
  checkTimeout(timeoutMs);
  // Validates speed and channel before anything is sent.
  const command = DIRECTIONS[direction];
  const startTail = ptzFrameTail(command, { channel, speed });
  const stopTail = ptzFrameTail(PTZ.stopOf(command), { channel, speed });
  if (signal && signal.aborted) throw new EzvizLanError('aborted', 'aborted before the move started');

  // One RSA key for both logins, so the stop is not delayed by key generation.
  const key = rsaKey ? P.toPrivateKeyObject(rsaKey) : await P.generateRsaKey();
  const send = (bodyTail) =>
    control({
      host,
      port,
      password,
      username,
      commandId: PTZ.COMMAND_ID,
      bodyTail,
      timeoutMs,
      localIp,
      rsaKey: key,
      connect,
    });

  async function sendStop() {
    const errors = [];
    for (let i = 0; i < STOP_ATTEMPTS; i += 1) {
      if (i > 0) await delay(STOP_RETRY_DELAY_MS);
      try {
        await send(stopTail);
        return { ok: true, attempts: i + 1, errors };
      } catch (err) {
        errors.push(err);
      }
    }
    return { ok: false, attempts: STOP_ATTEMPTS, errors };
  }

  function stopFailed(stop, startError) {
    const last = stop.errors[stop.errors.length - 1];
    const err = new EzvizLanError(
      'stop_failed',
      `the camera did not acknowledge the stop after ${stop.attempts} attempts` +
        (last ? ` (${last.code || 'error'}: ${last.message})` : ''),
      { attempts: stop.attempts, direction },
    );
    err.cause = last;
    if (startError) err.startError = startError;
    return err;
  }

  try {
    await send(startTail);
  } catch (err) {
    // A failure during login means the start frame was never built, so the
    // camera cannot be moving. Anything later and the start may have arrived.
    const mayHaveMoved = !(err instanceof EzvizLanError && (err.phase === 'login' || err.code === 'invalid_argument'));
    if (!mayHaveMoved) throw err;
    const stop = await sendStop();
    if (!stop.ok) throw stopFailed(stop, err);
    err.stopSent = true;
    throw err;
  }

  const startedAt = Date.now();
  const interrupted = await wait(durationMs, signal);
  const elapsed = Date.now() - startedAt;
  const stop = await sendStop();
  if (!stop.ok) throw stopFailed(stop, null);

  const result = { ok: true, durationMs: elapsed };
  if (interrupted) result.interrupted = true;
  return result;
}

module.exports = { move, DIRECTIONS, MIN_DURATION_MS, MAX_DURATION_MS, STOP_ATTEMPTS };
