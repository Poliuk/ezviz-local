'use strict';

// move(): one timed pan or tilt. Start, wait, stop.
//
// The stop frame is the one with a physical consequence: a start with no stop
// leaves the motor driving into its end stop. So the stop is attempted
// whenever the start may have reached the camera, including when the wait is
// interrupted through `signal` or the start failed after login. The stop is
// tried up to STOP_ATTEMPTS times, and move() only resolves once the camera
// has acknowledged it.
//
// The run time is counted from the moment the start frame is written, not
// from its ack. The wait for the start's ack ends at that deadline, so a slow
// or lost ack cannot hold the stop back. The stop is only sent after the
// start frame was written, so it cannot overtake it.

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
 * Resolves { ok: true, durationMs, startAcked } where durationMs is the
 * measured time between the start frame being written and the stop being
 * sent, and startAcked is false when the camera did not acknowledge the start
 * before that deadline (it may or may not have moved). When `signal` aborts,
 * the stop is sent as soon as the start frame has been written, and the
 * result also has `interrupted: true`.
 *
 * The motor runs for at most durationMs plus the time the stop takes to reach
 * the camera (one login and one frame; more if a stop attempt fails and is
 * retried).
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
  // A fresh login for every frame, as for the start: reusing the start's
  // session for the stop has not been tried on a camera.
  const send = (bodyTail, extra) =>
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
      ...extra,
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

  // The ack wait ends at the deadline (ackTimeoutMs, timed from the write) or
  // as soon as `signal` aborts. Neither cuts the login or the write short.
  const ackWait = new AbortController();
  const onAbort = () => ackWait.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let sentAt = null;
  let startAcked = false;
  try {
    await send(startTail, {
      ackTimeoutMs: durationMs,
      ackSignal: ackWait.signal,
      onFrameSent: () => {
        sentAt = Date.now();
      },
    });
    startAcked = true;
  } catch (err) {
    const ackMissing =
      err instanceof EzvizLanError && err.frameSent === true && (err.code === 'timeout' || err.code === 'aborted');
    if (!ackMissing) {
      // A failure during login means the start frame was never built, so the
      // camera cannot be moving. Anything later and the start may have arrived.
      const mayHaveMoved = !(err instanceof EzvizLanError && (err.phase === 'login' || err.code === 'invalid_argument'));
      if (!mayHaveMoved) throw err;
      const stop = await sendStop();
      if (!stop.ok) throw stopFailed(stop, err);
      err.stopSent = true;
      throw err;
    }
    // The frame went out but no ack came in time: carry on to the deadline.
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const interrupted = await wait(Math.max(0, sentAt + durationMs - Date.now()), signal);
  const elapsed = Date.now() - sentAt;
  const stop = await sendStop();
  if (!stop.ok) throw stopFailed(stop, null);

  const result = { ok: true, durationMs: elapsed, startAcked };
  if (interrupted) result.interrupted = true;
  return result;
}

module.exports = { move, DIRECTIONS, MIN_DURATION_MS, MAX_DURATION_MS, STOP_ATTEMPTS };
