'use strict';

// cloud: the one thing an EZVIZ C6N does NOT expose on the local network —
// toggling a device feature switch (privacy, the status LED, sleep, IR, ...).
// Those switches are set through EZVIZ's cloud, so this module logs in to an
// EZVIZ account and calls the cloud `switchStatus` endpoint. Everything else
// in ezviz-local is cloud-free; this is the deliberate exception, kept in its
// own file and its own `cloud` namespace.
//
// It needs the EZVIZ ACCOUNT (the email/phone and password used in the EZVIZ
// app), not the camera's local verification code, and it changes device state
// over the internet. PRIVACY and SLEEP stop the camera recording; use with
// care. The password is only ever hashed (MD5, and RSA for the v6 login) and
// sent to EZVIZ's own login endpoint; it is never logged or stored here.
//
// The switch ids and the login/switch REST shape were traced from pyezvizapi
// 2.5.1 by Renier Moorcroft (Apache-2.0, https://github.com/RenierM26/pyEzvizApi);
// NOTICE lists what was taken. This is a from-scratch JavaScript implementation
// built from that protocol description, not a copy of its code.

const crypto = require('node:crypto');
const https = require('node:https');
const os = require('node:os');
const { Buffer } = require('node:buffer');

const DEFAULT_DOMAIN = 'apiieu.ezvizlife.com';
// The headers the EZVIZ web/app login uses. featureCode and sessionId are added
// per request.
const BASE_HEADERS = Object.freeze({
  clientType: '3',
  customno: '1000001',
  clientNo: 'web_site',
  appId: 'ys7',
  'User-Agent': 'okhttp/3.12.1',
});

const LOGIN_V5 = '/v3/users/login/v5';
const LOGIN_V6 = '/v3/users/login/v6';
const PUBLIC_KEY = '/v3/users/publickey';

// EZVIZ meta codes we handle by name.
const META_OK = 200;
const META_REGION_REDIRECT = 1100; // account lives in another region; retry there
const META_MFA_REQUIRED = 6002; // a verification code is needed

/**
 * EZVIZ feature switches (pyezvizapi DeviceSwitchType). Pass a value or its
 * name to setSwitch(). Type 3 (LIGHT, the status LED) is the one this project
 * first captured on the wire. Not every camera has every switch.
 */
const DeviceSwitchType = Object.freeze({
  ALARM_TONE: 1,
  STREAM_ADAPTIVE: 2,
  LIGHT: 3,
  INTELLIGENT_ANALYSIS: 4,
  LOG_UPLOAD: 5,
  DEFENCE_PLAN: 6,
  PRIVACY: 7,
  SOUND_LOCALIZATION: 8,
  CRUISE: 9,
  INFRARED_LIGHT: 10,
  WIFI: 11,
  WIFI_MARKETING: 12,
  WIFI_LIGHT: 13,
  PLUG: 14,
  SLEEP: 21,
  SOUND: 22,
  BABY_CARE: 23,
  LOGO: 24,
  MOBILE_TRACKING: 25,
  CHANNELOFFLINE: 26,
  ALL_DAY_VIDEO: 29,
  AUTO_SLEEP: 32,
  ROAMING_STATUS: 34,
  DEVICE_4G: 35,
  ALARM_REMIND_MODE: 37,
  OUTDOOR_RINGING_SOUND: 39,
  INTELLIGENT_PQ_SWITCH: 40,
  DEVICE_HUMAN_RELATE_LIGHT: 41,
  DOORBELL_TALK: 101,
  HUMAN_INTELLIGENT_DETECTION: 200,
  LIGHT_FLICKER: 301,
  ALARM_LIGHT: 303,
  ALARM_LIGHT_RELEVANCE: 305,
  TAMPER_ALARM: 306,
  DETECTION_TYPE: 451,
  REMOTE_UNLOCK: 458,
  OUTLET_RECOVER: 600,
  WIDE_DYNAMIC_RANGE: 604,
  CHIME_INDICATOR_LIGHT: 611,
  DISTORTION_CORRECTION: 617,
  TRACKING: 650,
  CRUISE_TRACKING: 651,
  PARTIAL_IMAGE_OPTIMIZE: 700,
  FEATURE_TRACKING: 701,
  LOGO_WATERMARK: 702,
});

class EzvizCloudError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'EzvizCloudError';
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

const md5hex = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');

/**
 * A stable-ish per-machine feature code: MD5 of the first real MAC, like the
 * EZVIZ clients. Reusing one keeps the account from treating each login as a
 * new device (which can trigger a verification code). Pass your own to
 * setSwitch/cloudLogin to pin it.
 */
function featureCode() {
  let mac = null;
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.mac && ni.mac !== '00:00:00:00:00:00' && !ni.internal) {
          mac = ni.mac.replace(/:/g, '');
          break;
        }
      }
      if (mac) break;
    }
  } catch {
    // fall through to the default below
  }
  return md5hex(mac || '000000000000');
}

// ------------------------------------------------------------------ transport

/**
 * The default HTTPS request. Resolves { status, text, json } (json is null if
 * the body is not JSON). `form` is sent URL-encoded, `body` as JSON. Injectable
 * so callers (and the tests) can swap it; every function here takes `request`.
 */
function httpsRequest({ method = 'GET', url, headers = {}, form, body, timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new EzvizCloudError('invalid_argument', `bad URL: ${url}`));
      return;
    }
    const h = { ...headers };
    let payload;
    if (form !== undefined) {
      payload = new URLSearchParams(form).toString();
      h['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      h['Content-Type'] = h['Content-Type'] || 'application/json';
    }
    if (payload !== undefined) h['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(
      { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers: h },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // left as text
          }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new EzvizCloudError('timeout', 'cloud request timed out')));
    req.on('error', (err) => reject(err instanceof EzvizCloudError ? err : wrap(err)));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function wrap(err) {
  const e = new EzvizCloudError(err.code || 'network_error', `cloud: ${err.message}`);
  e.cause = err;
  return e;
}

const metaCode = (r) => (r && r.json && r.json.meta && typeof r.json.meta.code === 'number' ? r.json.meta.code : null);
const metaMessage = (r) => (r && r.json && r.json.meta ? r.json.meta.message : undefined);

// ---------------------------------------------------------------------- login

// The v6 login encrypts "md5(password),epoch" with the server's RSA public key
// (PKCS#1 v1.5) and base64s it. The key arrives as base64 DER, usually SPKI.
async function rsaLoginPassword(apiDomain, digest, feature, request, timeoutMs) {
  const r = await request({
    method: 'GET',
    url: `https://${apiDomain}${PUBLIC_KEY}`,
    headers: { ...BASE_HEADERS, featureCode: feature },
    timeoutMs,
  });
  if (metaCode(r) !== META_OK || !(r.json && r.json.publicKey)) {
    throw new EzvizCloudError('login_failed', 'could not fetch the login public key (v6)');
  }
  const der = Buffer.from(String(r.json.publicKey).replace(/\s+/g, ''), 'base64');
  let key = null;
  for (const type of ['spki', 'pkcs1']) {
    try {
      key = crypto.createPublicKey({ key: der, format: 'der', type });
      break;
    } catch {
      // try the next encoding
    }
  }
  if (!key) throw new EzvizCloudError('login_failed', 'the login public key is not valid DER');
  const plain = Buffer.from(`${digest},${Math.floor(Date.now() / 1000)}`, 'utf8');
  const ct = crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, plain);
  return ct.toString('base64');
}

/**
 * Log in to an EZVIZ account and get a session for setSwitch().
 *
 * Options:
 *   account      the EZVIZ email or phone (required)
 *   password     the EZVIZ account password (required; only hashed, never stored)
 *   domain       the first API host to try (default apiieu.ezvizlife.com); the
 *                account's real region is followed automatically
 *   smsCode      the verification code, when a prior call threw 'mfa_required'
 *   featureCode  override the per-machine device id (see featureCode())
 *   timeoutMs    per request (default 25000)
 *   request      the HTTPS function (default httpsRequest); injectable for tests
 *
 * Resolves { apiDomain, sessionId, feature }. Pass the whole object to
 * setSwitch() as `session`.
 *
 * Rejects with EzvizCloudError .code:
 *   'invalid_argument'  account or password missing
 *   'mfa_required'      EZVIZ wants a verification code; call again with smsCode
 *   'login_failed'      wrong credentials, or the login did not complete
 *                       (err.metaCode is EZVIZ's meta code when there was one)
 *   'timeout' / 'network_error'  the request did not complete
 */
async function cloudLogin({
  account,
  password,
  domain = DEFAULT_DOMAIN,
  smsCode = null,
  featureCode: fc,
  timeoutMs = 25000,
  request = httpsRequest,
} = {}) {
  if (typeof account !== 'string' || account === '') {
    throw new EzvizCloudError('invalid_argument', 'account (EZVIZ email or phone) is required');
  }
  if (password == null || password === '') {
    throw new EzvizCloudError('invalid_argument', 'password is required');
  }
  const feature = fc || featureCode();
  const digest = md5hex(password);
  let apiDomain = domain;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let redirected = false;
    for (const ver of ['v5', 'v6']) {
      const path = ver === 'v5' ? LOGIN_V5 : LOGIN_V6;
      const pw = ver === 'v5' ? digest : await rsaLoginPassword(apiDomain, digest, feature, request, timeoutMs);
      const form = {
        account,
        password: pw,
        featureCode: feature,
        msgType: smsCode == null ? '0' : '320000',
        bizType: smsCode == null ? '' : 'TERMINAL_BIND',
        cuName: 'SGFzc2lv',
        smsCode: smsCode == null ? '' : smsCode,
      };
      const r = await request({
        method: 'POST',
        url: `https://${apiDomain}${path}`,
        headers: { ...BASE_HEADERS, featureCode: feature },
        form,
        timeoutMs,
      });
      const code = metaCode(r);
      if (code === META_OK) {
        const ls = r.json.loginSession || {};
        const la = r.json.loginArea || {};
        if (!ls.sessionId || !la.apiDomain) {
          throw new EzvizCloudError('login_failed', 'login succeeded but the session was incomplete');
        }
        return { apiDomain: String(la.apiDomain), sessionId: String(ls.sessionId), feature };
      }
      if (code === META_REGION_REDIRECT) {
        const dom = r.json.loginArea && r.json.loginArea.apiDomain;
        if (!dom) throw new EzvizCloudError('login_failed', 'region redirect without an apiDomain');
        apiDomain = String(dom);
        redirected = true;
        break; // restart the version loop on the new region
      }
      if (code === META_MFA_REQUIRED) {
        throw new EzvizCloudError(
          'mfa_required',
          'EZVIZ sent a verification code; call cloudLogin() again with smsCode set',
          { metaCode: code },
        );
      }
      if (ver === 'v5') continue; // v5 rejected: fall through and try v6
      throw new EzvizCloudError('login_failed', `login failed (meta ${code}: ${metaMessage(r)})`, { metaCode: code });
    }
    if (!redirected) break;
  }
  throw new EzvizCloudError('login_failed', 'login did not complete (too many region redirects)');
}

// --------------------------------------------------------------------- switch

function resolveType(type) {
  if (typeof type === 'number' && Number.isInteger(type)) return type;
  if (typeof type === 'string' && Object.prototype.hasOwnProperty.call(DeviceSwitchType, type)) {
    return DeviceSwitchType[type];
  }
  throw new EzvizCloudError('invalid_argument', 'type must be a DeviceSwitchType value or one of its names');
}

function checkSession(session) {
  if (!session || typeof session !== 'object' || !session.apiDomain || !session.sessionId) {
    throw new EzvizCloudError('invalid_argument', 'session must be { apiDomain, sessionId } from cloudLogin()');
  }
}

/**
 * Turn a device feature switch on or off, through the cloud.
 *
 * Options:
 *   session   the object from cloudLogin() (required)
 *   serial    the camera serial / device id (required)
 *   type      a DeviceSwitchType value or name, e.g. 'LIGHT' or 3 (required)
 *   enable    true to turn on, false to turn off (required, boolean)
 *   channel   device channel (default 0)
 *   timeoutMs per request (default 15000)
 *   request   the HTTPS function (default httpsRequest); injectable for tests
 *
 * Tries the v3 endpoint first, then the legacy one. Resolves
 * { ok: true, serial, type, enable, channel, via: 'v3' | 'legacy' }.
 *
 * Rejects with EzvizCloudError .code 'invalid_argument', or 'switch_failed'
 * (err.metaCode, err.v3, err.legacy carry EZVIZ's meta codes), or a transport
 * error ('timeout' / 'network_error').
 *
 * This changes the camera over the internet. It is NOT verified against real
 * hardware yet; test it on your own device before relying on it.
 */
async function setSwitch({ session, serial, type, enable, channel = 0, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  if (typeof serial !== 'string' || serial === '') {
    throw new EzvizCloudError('invalid_argument', 'serial is required');
  }
  const t = resolveType(type);
  if (typeof enable !== 'boolean') throw new EzvizCloudError('invalid_argument', 'enable must be a boolean');
  if (!Number.isInteger(channel) || channel < 0) {
    throw new EzvizCloudError('invalid_argument', 'channel must be a non-negative integer');
  }
  const en = enable ? 1 : 0;
  const headers = {
    ...BASE_HEADERS,
    featureCode: session.feature || featureCode(),
    sessionId: session.sessionId,
  };

  const v3 = await request({
    method: 'PUT',
    url: `https://${session.apiDomain}/v3/devices/${encodeURIComponent(serial)}/${channel}/${en}/${t}/switchStatus`,
    headers,
    timeoutMs,
  });
  if (metaCode(v3) === META_OK) return { ok: true, serial, type: t, enable, channel, via: 'v3' };

  const legacy = await request({
    method: 'POST',
    url: `https://${session.apiDomain}/api/device/switchStatus`,
    headers,
    form: { serial, enable: String(en), type: String(t), channel: String(channel) },
    timeoutMs,
  });
  if (metaCode(legacy) === META_OK) return { ok: true, serial, type: t, enable, channel, via: 'legacy' };

  const code = metaCode(v3) ?? metaCode(legacy);
  throw new EzvizCloudError('switch_failed', `setSwitch failed (meta ${code}: ${metaMessage(v3) ?? metaMessage(legacy)})`, {
    metaCode: code,
    v3: metaCode(v3),
    legacy: metaCode(legacy),
  });
}

/**
 * Log in and set one switch, in one call. Options are cloudLogin()'s plus
 * setSwitch()'s (serial, type, enable, channel). Resolves setSwitch()'s result
 * with the `session` attached, so you can reuse it for more calls. Prefer
 * cloudLogin() once + setSwitch() many times when you toggle repeatedly.
 */
async function setDeviceSwitch({
  account,
  password,
  domain,
  smsCode,
  featureCode: fc,
  serial,
  type,
  enable,
  channel = 0,
  timeoutMs,
  request = httpsRequest,
} = {}) {
  const session = await cloudLogin({ account, password, domain, smsCode, featureCode: fc, timeoutMs, request });
  const res = await setSwitch({ session, serial, type, enable, channel, timeoutMs, request });
  return { ...res, session };
}

// ----------------------------------------------------------- reading state

const PAGELIST = '/v3/userdevices/v1/resources/pagelist';
// Sections of the device list to ask for. SWITCH carries every feature switch's
// current position; a home account's devices fit one page.
const PAGE_FILTER = 'SWITCH,STATUS,FEATURE,CONNECTION,WIFI,NODISTURB,UPGRADE';

const SWITCH_NAME = Object.freeze(
  Object.fromEntries(Object.entries(DeviceSwitchType).map(([name, value]) => [value, name])),
);

/** The name of a DeviceSwitchType value, or null. */
function switchName(type) {
  return Object.prototype.hasOwnProperty.call(SWITCH_NAME, type) ? SWITCH_NAME[type] : null;
}

/**
 * The raw EZVIZ device list ("pagelist") for the account. Read-only. Resolves
 * the parsed JSON, whose `SWITCH`, `STATUS`, `WIFI`, ... sections are keyed by
 * serial. One page by default (30 devices); pass `offset`/`limit` for more.
 *
 * Options: session (required), filter, limit, offset, timeoutMs, request.
 * Rejects 'invalid_argument', 'request_failed' (meta code in err.metaCode), or
 * a transport error.
 */
async function getDevices({
  session,
  filter = PAGE_FILTER,
  limit = 30,
  offset = 0,
  timeoutMs = 15000,
  request = httpsRequest,
} = {}) {
  checkSession(session);
  const query = new URLSearchParams({ groupId: '-1', limit: String(limit), offset: String(offset), filter });
  const r = await request({
    method: 'GET',
    url: `https://${session.apiDomain}${PAGELIST}?${query.toString()}`,
    headers: { ...BASE_HEADERS, featureCode: session.feature || featureCode(), sessionId: session.sessionId },
    timeoutMs,
  });
  if (metaCode(r) !== META_OK) {
    throw new EzvizCloudError('request_failed', `device list failed (meta ${metaCode(r)})`, { metaCode: metaCode(r) });
  }
  return r.json || {};
}

/**
 * The current feature-switch positions of one device, read from the device
 * list. Read-only; changes nothing. Resolves a map `{ type(number): boolean }`;
 * read it with DeviceSwitchType or switchName(), e.g. states[DeviceSwitchType.PRIVACY].
 *
 * Options: session (required), serial (required), timeoutMs, request.
 * Rejects 'invalid_argument', 'not_found' (no such serial in the first page of
 * the account's devices), 'request_failed', or a transport error.
 */
async function getSwitchStates({ session, serial, timeoutMs, request = httpsRequest } = {}) {
  checkSession(session);
  if (typeof serial !== 'string' || serial === '') throw new EzvizCloudError('invalid_argument', 'serial is required');
  const page = await getDevices({ session, timeoutMs, request });
  const section = page.SWITCH;
  let rows = null;
  if (section && !Array.isArray(section) && Array.isArray(section[serial])) rows = section[serial];
  else if (Array.isArray(section)) rows = section.filter((x) => x && x.deviceSerial === serial);
  if (!rows || rows.length === 0) {
    throw new EzvizCloudError('not_found', `no switch state for serial ${serial} in the device list`);
  }
  const out = {};
  for (const row of rows) {
    if (row && Number.isInteger(row.type)) out[row.type] = row.enable === 1 || row.enable === true;
  }
  return out;
}

// ------------------------------------------------- feature settings (cloud)
//
// Everything below is a session-only cloud setter — same authentication as
// setSwitch (the account sessionId), no cas_key. The request shapes were
// traced from pyezvizapi 2.5.1 and are NOT yet verified against real hardware;
// test each on your own device before relying on it. `channel` defaults to 1,
// EZVIZ's usual camera channel for these endpoints (setSwitch uses 0 for
// switchStatus); override it if your device reports a different channel.
//
// Success is accepted on EITHER a v3 meta.code 200 or a legacy resultCode "0"
// (isOk). Writes reject EzvizCloudError .code 'command_failed' (or
// 'config_failed' for devconfig); reads 'request_failed'. All carry .metaCode
// and .resultCode. Argument problems reject 'invalid_argument'.

/** Account arm mode — the app's home/away/sleep panel. */
const DefenseModeType = Object.freeze({ UNSET: 0, HOME: 1, AWAY: 2, SLEEP: 3 });
/** Night-vision / IR mode (the devconfig `graphicType`). */
const NightVisionMode = Object.freeze({ B_W: 0, COLOUR: 1, SMART: 2 });
/** Image display preset. */
const DisplayMode = Object.freeze({ ORIGINAL: 1, SOFT: 2, VIVID: 3 });
/** Motion-detection target for setDetectionType. */
const AlarmDetectHumanCar = Object.freeze({ HUMAN: 1, IMAGE_CHANGE: 3, PIR: 5 });
/** Alarm-sound mode for setAlarmSound: 0 soft/normal, 1 intense, 2 silent. */
const SoundMode = Object.freeze({ SOFT: 0, INTENSE: 1, SILENT: 2 });
/** Intelligent-detection apps for setIntelligentApp (URL path segments). */
const IntelligentApp = Object.freeze({
  HUMAN: 'app_human_detect',
  VEHICLE: 'app_car_detect',
  IMAGE_CHANGE: 'app_video_change',
  GESTURE: 'app_wave_recognize',
});

// EZVIZ answers v3 calls with meta.code 200 and legacy /api calls with
// resultCode "0". Accept either; never a boolean resultCode.
function isOk(r) {
  if (metaCode(r) === META_OK) return true;
  const rc = r && r.json ? r.json.resultCode : undefined;
  if (typeof rc === 'boolean') return false;
  return rc === 0 || rc === '0';
}

function sessionHeaders(session) {
  return { ...BASE_HEADERS, featureCode: session.feature || featureCode(), sessionId: session.sessionId };
}

// Throws an EzvizCloudError describing a non-OK response. Never returns.
function fail(op, r, code = 'command_failed') {
  const mc = metaCode(r);
  const rc = r && r.json ? r.json.resultCode : undefined;
  throw new EzvizCloudError(
    code,
    `${op} failed (meta ${mc}${rc !== undefined ? `, resultCode ${rc}` : ''}: ${metaMessage(r) || ''})`,
    { metaCode: mc, resultCode: rc },
  );
}

// Accept a numeric enum value or one of its names; return the number.
function resolveEnum(value, enumObj, label) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(enumObj, value)) return enumObj[value];
  throw new EzvizCloudError('invalid_argument', `${label} must be an integer or one of: ${Object.keys(enumObj).join(', ')}`);
}

function requireSerial(serial) {
  if (typeof serial !== 'string' || serial === '') throw new EzvizCloudError('invalid_argument', 'serial is required');
}

function requireChannel(channel) {
  if (!Number.isInteger(channel) || channel < 0) {
    throw new EzvizCloudError('invalid_argument', 'channel must be a non-negative integer');
  }
}

// How EZVIZ wants a devconfig value: a nested object becomes a compact JSON
// STRING in the single `value` form field, a boolean "1"/"0", everything else
// String()-ed. Matches pyezvizapi's set_dev_config_kv coercion.
function devConfigValue(value) {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// Shared PUT to the devconfig key/value endpoint used by several setters.
async function putKeyValue({ session, serial, channel, key, value, timeoutMs, request }) {
  const r = await request({
    method: 'PUT',
    url: `https://${session.apiDomain}/v3/devconfig/v1/keyValue/${encodeURIComponent(serial)}/${channel}/op`,
    headers: sessionHeaders(session),
    form: { key, value: devConfigValue(value) },
    timeoutMs,
  });
  if (!isOk(r)) fail('setDevConfig', r, 'config_failed');
  return r.json || {};
}

/** Arm/disarm the whole account (home/away/sleep). mode: DefenseModeType value or name. */
async function setDefenceMode({ session, mode, visualAlarm, soundMode, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  const m = resolveEnum(mode, DefenseModeType, 'mode');
  const form = { groupId: '-1', mode: String(m) };
  if (visualAlarm != null) form.visualAlarm = String(visualAlarm);
  if (soundMode != null) form.soundMode = String(soundMode);
  const r = await request({
    method: 'POST',
    url: `https://${session.apiDomain}/v3/userdevices/v1/group/switchDefenceMode`,
    headers: sessionHeaders(session),
    form,
    timeoutMs,
  });
  if (!isOk(r)) fail('setDefenceMode', r);
  return { ok: true, mode: m };
}

/** Read the account arm mode. Resolves { mode }, a DefenseModeType number (or null). */
async function getDefenceMode({ session, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  const query = new URLSearchParams({ groupId: '-1' });
  const r = await request({
    method: 'GET',
    url: `https://${session.apiDomain}/v3/userdevices/v1/group/defenceMode?${query.toString()}`,
    headers: sessionHeaders(session),
    timeoutMs,
  });
  if (!isOk(r)) fail('getDefenceMode', r, 'request_failed');
  const mode = r.json && r.json.mode != null ? Number(r.json.mode) : null;
  return { mode: Number.isNaN(mode) ? null : mode };
}

/** Arm/disarm motion detection on one camera (the REST path, not CAS). */
async function setCameraDefence({
  session,
  serial,
  enable,
  channel = 1,
  armType = 'Global',
  actor = 'V',
  timeoutMs = 15000,
  request = httpsRequest,
} = {}) {
  checkSession(session);
  requireSerial(serial);
  requireChannel(channel);
  if (typeof enable !== 'boolean') throw new EzvizCloudError('invalid_argument', 'enable must be a boolean');
  const r = await request({
    method: 'PUT',
    url: `https://${session.apiDomain}/v3/devices/${encodeURIComponent(serial)}/${channel}/changeDefenceStatusReq`,
    headers: sessionHeaders(session),
    form: { type: armType, status: String(enable ? 1 : 0), actor },
    timeoutMs,
  });
  if (!isOk(r)) fail('setCameraDefence', r);
  return { ok: true, serial, enable, channel };
}

/** Do-Not-Disturb: suppress push notifications (the event is still recorded). */
async function setDoNotDisturb({ session, serial, enable, channel = 1, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  requireSerial(serial);
  requireChannel(channel);
  if (typeof enable !== 'boolean') throw new EzvizCloudError('invalid_argument', 'enable must be a boolean');
  const r = await request({
    method: 'PUT',
    url: `https://${session.apiDomain}/v3/alarms/${encodeURIComponent(serial)}/${channel}/nodisturb`,
    headers: sessionHeaders(session),
    form: { enable: String(enable ? 1 : 0) },
    timeoutMs,
  });
  if (!isOk(r)) fail('setDoNotDisturb', r);
  return { ok: true, serial, enable, channel };
}

/** Night-vision / IR mode. mode: NightVisionMode value or name; luminance 0..100. */
async function setNightVision({
  session,
  serial,
  mode,
  luminance = 100,
  channel = 1,
  timeoutMs = 15000,
  request = httpsRequest,
} = {}) {
  checkSession(session);
  requireSerial(serial);
  requireChannel(channel);
  const m = resolveEnum(mode, NightVisionMode, 'mode');
  if (!Number.isInteger(luminance) || luminance < 0 || luminance > 100) {
    throw new EzvizCloudError('invalid_argument', 'luminance must be an integer 0..100');
  }
  await putKeyValue({ session, serial, channel, key: 'NightVision_Model', value: { graphicType: m, luminance }, timeoutMs, request });
  return { ok: true, serial, mode: m, luminance, channel };
}

/** Image display preset. mode: DisplayMode value or name. */
async function setDisplayMode({ session, serial, mode, channel = 1, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  requireSerial(serial);
  requireChannel(channel);
  const m = resolveEnum(mode, DisplayMode, 'mode');
  await putKeyValue({ session, serial, channel, key: 'display_mode', value: { mode: m }, timeoutMs, request });
  return { ok: true, serial, mode: m, channel };
}

/** On-screen display text. An empty string clears the overlay. */
async function setOsd({ session, serial, text = '', channel = 1, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  requireSerial(serial);
  requireChannel(channel);
  if (typeof text !== 'string') throw new EzvizCloudError('invalid_argument', 'text must be a string');
  const r = await request({
    method: 'PUT',
    url: `https://${session.apiDomain}/v3/userdevices/v1/devices/${encodeURIComponent(serial)}/${channel}/osd`,
    headers: sessionHeaders(session),
    form: { osd: text },
    timeoutMs,
  });
  if (!isOk(r)) fail('setOsd', r);
  return { ok: true, serial, text, channel };
}

/** Mirror/flip the image. command defaults to 'CENTER' (a full flip); no body. */
async function setMirror({ session, serial, command = 'CENTER', channel = 1, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  requireSerial(serial);
  requireChannel(channel);
  if (typeof command !== 'string' || command === '') {
    throw new EzvizCloudError('invalid_argument', 'command must be a non-empty string');
  }
  const r = await request({
    method: 'PUT',
    url: `https://${session.apiDomain}/v3/basics/v1/devices/${encodeURIComponent(serial)}/${channel}/${encodeURIComponent(command)}/mirror`,
    headers: sessionHeaders(session),
    timeoutMs,
  });
  if (!isOk(r)) fail('setMirror', r);
  return { ok: true, serial, command, channel };
}

/** Motion-detection target. type: AlarmDetectHumanCar value or name. */
async function setDetectionType({ session, serial, type, channel = 1, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  requireSerial(serial);
  requireChannel(channel);
  const t = resolveEnum(type, AlarmDetectHumanCar, 'type');
  await putKeyValue({ session, serial, channel, key: 'Alarm_DetectHumanCar', value: { type: t }, timeoutMs, request });
  return { ok: true, serial, type: t, channel };
}

/**
 * Detection sensitivity. `type` 0 takes a value 1..6; any other type 1..100.
 * (This is the v3 path setter; the value lives entirely in the URL.)
 */
async function setSensitivity({ session, serial, value, type = 0, channel = 1, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  requireSerial(serial);
  requireChannel(channel);
  if (!Number.isInteger(type) || type < 0) throw new EzvizCloudError('invalid_argument', 'type must be a non-negative integer');
  if (!Number.isInteger(value)) throw new EzvizCloudError('invalid_argument', 'value must be an integer');
  const outOfRange = type === 0 ? value < 1 || value > 6 : value < 1 || value > 100;
  if (outOfRange) {
    throw new EzvizCloudError('invalid_argument', type === 0 ? 'value must be 1..6 when type is 0' : 'value must be 1..100');
  }
  const r = await request({
    method: 'PUT',
    url: `https://${session.apiDomain}/v3/devconfig/v1/sensitivity/${encodeURIComponent(serial)}/${channel}/${type}/${value}`,
    headers: sessionHeaders(session),
    timeoutMs,
  });
  if (!isOk(r)) fail('setSensitivity', r);
  return { ok: true, serial, type, value, channel };
}

/** Read detection sensitivity (v3). Resolves the raw JSON. */
async function getSensitivity({ session, serial, channel = 1, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  requireSerial(serial);
  requireChannel(channel);
  const r = await request({
    method: 'GET',
    url: `https://${session.apiDomain}/v3/devconfig/v1/sensitivity/${encodeURIComponent(serial)}/${channel}`,
    headers: sessionHeaders(session),
    timeoutMs,
  });
  if (!isOk(r)) fail('getSensitivity', r, 'request_failed');
  return r.json || {};
}

/**
 * Enable (PUT) or disable (DELETE) an intelligent-detection app. `resourceId`
 * comes from the device list (a camera's resourceInfos[].resourceId). `app` is
 * an IntelligentApp name/value.
 */
async function setIntelligentApp({ session, serial, resourceId, app, enable, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  requireSerial(serial);
  if (typeof resourceId !== 'string' || resourceId === '') {
    throw new EzvizCloudError('invalid_argument', 'resourceId is required (from the device list resourceInfos)');
  }
  if (typeof enable !== 'boolean') throw new EzvizCloudError('invalid_argument', 'enable must be a boolean');
  let name = app;
  if (typeof app === 'string' && Object.prototype.hasOwnProperty.call(IntelligentApp, app)) name = IntelligentApp[app];
  if (typeof name !== 'string' || name === '') {
    throw new EzvizCloudError('invalid_argument', `app must be an IntelligentApp name/value (${Object.keys(IntelligentApp).join(', ')})`);
  }
  const r = await request({
    method: enable ? 'PUT' : 'DELETE',
    url: `https://${session.apiDomain}/v3/intelligent-app/load/${encodeURIComponent(serial)}/${encodeURIComponent(resourceId)}/${encodeURIComponent(name)}`,
    headers: sessionHeaders(session),
    timeoutMs,
  });
  if (!isOk(r)) fail('setIntelligentApp', r);
  return { ok: true, serial, app: name, enable };
}

/** Alarm-sound mode. soundType: SoundMode value or name (0 soft, 1 intense, 2 silent). */
async function setAlarmSound({ session, serial, soundType, enable = true, voiceId = 0, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  requireSerial(serial);
  const st = resolveEnum(soundType, SoundMode, 'soundType');
  if (![0, 1, 2].includes(st)) {
    throw new EzvizCloudError('invalid_argument', 'soundType must be 0 (soft), 1 (intense) or 2 (silent)');
  }
  if (typeof enable !== 'boolean') throw new EzvizCloudError('invalid_argument', 'enable must be a boolean');
  if (!Number.isInteger(voiceId) || voiceId < 0) throw new EzvizCloudError('invalid_argument', 'voiceId must be a non-negative integer');
  const r = await request({
    method: 'PUT',
    url: `https://${session.apiDomain}/v3/devices/${encodeURIComponent(serial)}/alarm/sound`,
    headers: sessionHeaders(session),
    form: { enable: String(enable ? 1 : 0), soundType: String(st), voiceId: String(voiceId), deviceSerial: serial },
    timeoutMs,
  });
  if (!isOk(r)) fail('setAlarmSound', r);
  return { ok: true, serial, soundType: st, enable, voiceId };
}

/** Floodlight brightness, 1..100. */
async function setFloodlightBrightness({ session, serial, luminance, channel = 1, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  requireSerial(serial);
  requireChannel(channel);
  if (!Number.isInteger(luminance) || luminance < 1 || luminance > 100) {
    throw new EzvizCloudError('invalid_argument', 'luminance must be an integer 1..100');
  }
  const r = await request({
    method: 'POST',
    url: `https://${session.apiDomain}/v3/alarms/device/alarmLight/${encodeURIComponent(serial)}/${channel}`,
    headers: sessionHeaders(session),
    form: { luminance: String(luminance) },
    timeoutMs,
  });
  if (!isOk(r)) fail('setFloodlightBrightness', r);
  return { ok: true, serial, luminance, channel };
}

/**
 * Write a device config key/value directly (the catch-all behind several of
 * the setters above). `value` may be an object (sent as a compact JSON string
 * in the `value` field), a boolean ("1"/"0"), a number or a string.
 */
async function setDevConfig({ session, serial, key, value, channel = 1, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  requireSerial(serial);
  if (typeof key !== 'string' || key === '') throw new EzvizCloudError('invalid_argument', 'key is required');
  if (value === undefined) throw new EzvizCloudError('invalid_argument', 'value is required');
  requireChannel(channel);
  await putKeyValue({ session, serial, channel, key, value, timeoutMs, request });
  return { ok: true, serial, key, channel };
}

/** Read a device config key. Resolves the raw JSON. */
async function getDevConfig({ session, serial, key, channel = 1, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  requireSerial(serial);
  if (typeof key !== 'string' || key === '') throw new EzvizCloudError('invalid_argument', 'key is required');
  requireChannel(channel);
  const query = new URLSearchParams({ key });
  const r = await request({
    method: 'GET',
    url: `https://${session.apiDomain}/v3/devconfig/v1/keyValue/${encodeURIComponent(serial)}/${channel}/op?${query.toString()}`,
    headers: sessionHeaders(session),
    timeoutMs,
  });
  if (!isOk(r)) fail('getDevConfig', r, 'request_failed');
  return r.json || {};
}

// ---------------------------------------------- destructive (confirm first!)
//
// These physically act on the device or are hard to undo. Any UI must gate them
// behind an explicit confirmation.

/** DESTRUCTIVE: trigger the audible siren. `enable` true/false, or a raw int. */
async function soundSiren({ session, serial, enable = true, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  requireSerial(serial);
  const en = typeof enable === 'number' ? enable : enable ? 1 : 0;
  if (!Number.isInteger(en) || en < 0) {
    throw new EzvizCloudError('invalid_argument', 'enable must be a boolean or a non-negative integer');
  }
  const r = await request({
    method: 'PUT',
    url: `https://${session.apiDomain}/v3/devices/${encodeURIComponent(serial)}/0/sendAlarm`,
    headers: sessionHeaders(session),
    form: { enable: String(en) },
    timeoutMs,
  });
  if (!isOk(r)) fail('soundSiren', r);
  return { ok: true, serial, enable: en };
}

/** DESTRUCTIVE: reboot the device. operation 1 = reboot. */
async function reboot({ session, serial, delay = 1, operation = 1, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  requireSerial(serial);
  if (!Number.isInteger(delay) || delay < 0) throw new EzvizCloudError('invalid_argument', 'delay must be a non-negative integer');
  if (!Number.isInteger(operation)) throw new EzvizCloudError('invalid_argument', 'operation must be an integer');
  const r = await request({
    method: 'POST',
    url: `https://${session.apiDomain}/api/device/v2/sysOper/${encodeURIComponent(serial)}`,
    headers: sessionHeaders(session),
    form: { oper: String(operation), deviceSerial: serial, delay: String(delay) },
    timeoutMs,
  });
  if (!isOk(r)) fail('reboot', r);
  return { ok: true, serial };
}

/** DESTRUCTIVE: start a firmware upgrade. No body; the URL carries everything. */
async function upgradeFirmware({ session, serial, timeoutMs = 15000, request = httpsRequest } = {}) {
  checkSession(session);
  requireSerial(serial);
  const r = await request({
    method: 'PUT',
    url: `https://${session.apiDomain}/v3/upgrades/v1/devices/${encodeURIComponent(serial)}/0/upgrade`,
    headers: sessionHeaders(session),
    timeoutMs,
  });
  if (!isOk(r)) fail('upgradeFirmware', r);
  return { ok: true, serial };
}

/**
 * DESTRUCTIVE: remotely unlock a smart lock. For lock devices, not cameras.
 * `bindCode` defaults to the legacy `${feature}${userId}` form; devices that
 * require terminal binding need an explicit bindCode. resourceId/localIndex
 * default to EZVIZ's 'Video' / 1.
 */
async function remoteUnlock({
  session,
  serial,
  userId,
  lockNo,
  resourceId = 'Video',
  localIndex = 1,
  streamToken = '',
  lockType,
  bindCode,
  userName,
  timeoutMs = 15000,
  request = httpsRequest,
} = {}) {
  checkSession(session);
  requireSerial(serial);
  if (userId == null || userId === '') throw new EzvizCloudError('invalid_argument', 'userId is required');
  if (!Number.isInteger(lockNo)) throw new EzvizCloudError('invalid_argument', 'lockNo must be an integer');
  const code = bindCode != null && bindCode !== '' ? String(bindCode) : `${session.feature || featureCode()}${userId}`;
  const unLockInfo = {
    bindCode: code,
    lockNo,
    streamToken: String(streamToken),
    userName: String(userName != null ? userName : userId),
  };
  if (lockType) unLockInfo.type = String(lockType);
  const r = await request({
    method: 'PUT',
    url: `https://${session.apiDomain}/v3/iot-feature/action/${encodeURIComponent(serial)}/${encodeURIComponent(resourceId)}/${encodeURIComponent(String(localIndex))}/DoorLockMgr/RemoteUnlockReq`,
    headers: sessionHeaders(session),
    body: { unLockInfo },
    timeoutMs,
  });
  if (!isOk(r)) fail('remoteUnlock', r);
  return { ok: true, serial };
}

module.exports = {
  EzvizCloudError,
  DeviceSwitchType,
  DefenseModeType,
  NightVisionMode,
  DisplayMode,
  AlarmDetectHumanCar,
  SoundMode,
  IntelligentApp,
  cloudLogin,
  setSwitch,
  setDeviceSwitch,
  getDevices,
  getSwitchStates,
  switchName,
  featureCode,
  // feature settings — session-only cloud setters
  setDefenceMode,
  getDefenceMode,
  setCameraDefence,
  setDoNotDisturb,
  setNightVision,
  setDisplayMode,
  setOsd,
  setMirror,
  setDetectionType,
  setSensitivity,
  getSensitivity,
  setIntelligentApp,
  setAlarmSound,
  setFloodlightBrightness,
  setDevConfig,
  getDevConfig,
  // destructive — gate behind an explicit confirm in any UI
  soundSiren,
  reboot,
  upgradeFirmware,
  remoteUnlock,
  DEFAULT_DOMAIN,
};
