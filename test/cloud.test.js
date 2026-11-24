'use strict';

// cloud.js against an injected fake HTTPS function. Nothing here reaches the
// network or a camera. The fake records every request so the tests can check
// the URL, form and headers, and prove the account password is never sent in
// the clear.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  cloudLogin,
  setSwitch,
  setDeviceSwitch,
  getDevices,
  getSwitchStates,
  switchName,
  DeviceSwitchType,
  EzvizCloudError,
  featureCode,
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
  soundSiren,
  reboot,
  upgradeFirmware,
  remoteUnlock,
  DefenseModeType,
  NightVisionMode,
  DisplayMode,
  AlarmDetectHumanCar,
  SoundMode,
  IntelligentApp,
} = require('../lib/cloud');

const md5hex = (s) => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');

// A fake request() that answers from `handler(opts, index)` and records calls.
function recorder(handler) {
  const request = async (opts) => {
    request.calls.push(opts);
    return handler(opts, request.calls.length - 1) || { status: 200, json: {}, text: '' };
  };
  request.calls = [];
  return request;
}

const ok = (json) => ({ status: 200, json, text: JSON.stringify(json) });
const PASSWORD = 's3cr3t-pass';

test('cloudLogin v5: returns the session and sends md5(password), not the password', async () => {
  const request = recorder((o) => {
    if (o.url.endsWith('/v3/users/login/v5')) {
      return ok({ meta: { code: 200 }, loginSession: { sessionId: 'SID123' }, loginArea: { apiDomain: 'apieu.ezvizlife.com' } });
    }
    assert.fail(`unexpected ${o.method} ${o.url}`);
  });
  const session = await cloudLogin({ account: 'me@example.com', password: PASSWORD, request });
  assert.deepEqual(session, { apiDomain: 'apieu.ezvizlife.com', sessionId: 'SID123', feature: session.feature });
  assert.equal(request.calls.length, 1);
  assert.equal(request.calls[0].form.password, md5hex(PASSWORD));
  assert.equal(request.calls[0].form.msgType, '0');
  assert.ok(request.calls[0].headers.featureCode, 'a feature code is sent');
  assert.ok(!JSON.stringify(request.calls).includes(PASSWORD), 'the plaintext password is never sent');
});

test('cloudLogin follows a region redirect (meta 1100)', async () => {
  const request = recorder((o) => {
    if (o.url.startsWith('https://apiieu.ezvizlife.com/')) {
      return ok({ meta: { code: 1100 }, loginArea: { apiDomain: 'apius.ezvizlife.com' } });
    }
    if (o.url.startsWith('https://apius.ezvizlife.com/v3/users/login/v5')) {
      return ok({ meta: { code: 200 }, loginSession: { sessionId: 'S2' }, loginArea: { apiDomain: 'apius.ezvizlife.com' } });
    }
    assert.fail(`unexpected ${o.url}`);
  });
  const session = await cloudLogin({ account: 'a', password: PASSWORD, request });
  assert.equal(session.apiDomain, 'apius.ezvizlife.com');
  assert.equal(session.sessionId, 'S2');
});

test('cloudLogin falls back to v6 (RSA) when v5 is rejected', async () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const request = recorder((o) => {
    if (o.url.endsWith('/v3/users/login/v5')) return ok({ meta: { code: 1013, message: 'use v6' } });
    if (o.url.endsWith('/v3/users/publickey')) return ok({ meta: { code: 200 }, publicKey: pubDer });
    if (o.url.endsWith('/v3/users/login/v6')) {
      return ok({ meta: { code: 200 }, loginSession: { sessionId: 'V6' }, loginArea: { apiDomain: 'apiieu.ezvizlife.com' } });
    }
    assert.fail(`unexpected ${o.url}`);
  });
  const session = await cloudLogin({ account: 'a', password: PASSWORD, request });
  assert.equal(session.sessionId, 'V6');
  const v6 = request.calls.find((c) => c.url.endsWith('/v3/users/login/v6'));
  assert.ok(v6, 'v6 was attempted');
  assert.notEqual(v6.form.password, md5hex(PASSWORD), 'v6 sends RSA ciphertext, not the md5');
  assert.ok(!JSON.stringify(request.calls).includes(PASSWORD), 'the plaintext password is never sent');
});

test('cloudLogin reports MFA, then accepts an smsCode', async () => {
  const mfa = recorder(() => ok({ meta: { code: 6002 } }));
  await assert.rejects(cloudLogin({ account: 'a', password: PASSWORD, request: mfa }), { code: 'mfa_required' });

  const withCode = recorder((o) => {
    if (o.url.endsWith('/v3/users/login/v5')) {
      return ok({ meta: { code: 200 }, loginSession: { sessionId: 'S' }, loginArea: { apiDomain: 'd' } });
    }
    assert.fail('only v5 expected');
  });
  const session = await cloudLogin({ account: 'a', password: PASSWORD, smsCode: '123456', request: withCode });
  assert.equal(session.sessionId, 'S');
  assert.equal(withCode.calls[0].form.msgType, '320000');
  assert.equal(withCode.calls[0].form.smsCode, '123456');
  assert.equal(withCode.calls[0].form.bizType, 'TERMINAL_BIND');
});

test('cloudLogin validates its arguments', async () => {
  await assert.rejects(cloudLogin({ password: PASSWORD }), { code: 'invalid_argument' });
  await assert.rejects(cloudLogin({ account: 'a' }), { code: 'invalid_argument' });
});

test('cloudLogin surfaces a login failure with the meta code', async () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  const pubDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const request = recorder((o) => {
    if (o.url.endsWith('/publickey')) return ok({ meta: { code: 200 }, publicKey: pubDer });
    return ok({ meta: { code: 1013, message: 'wrong password' } });
  });
  await assert.rejects(cloudLogin({ account: 'a', password: 'bad', request }), (err) => {
    assert.equal(err.code, 'login_failed');
    assert.equal(err.metaCode, 1013);
    return true;
  });
});

const SESSION = { apiDomain: 'apieu.ezvizlife.com', sessionId: 'SID', feature: 'feat' };

test('setSwitch: v3 PUT with the right URL and session header', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'PUT');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/devices/BK0341402/0/1/3/switchStatus');
    assert.equal(o.headers.sessionId, 'SID');
    return ok({ meta: { code: 200 } });
  });
  const r = await setSwitch({ session: SESSION, serial: 'BK0341402', type: 'LIGHT', enable: true, request });
  assert.deepEqual(r, { ok: true, serial: 'BK0341402', type: 3, enable: true, channel: 0, via: 'v3' });
  assert.equal(request.calls.length, 1);
});

test('setSwitch: accepts a numeric type and enable=false', async () => {
  const request = recorder((o) => {
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/devices/S/0/0/7/switchStatus');
    return ok({ meta: { code: 200 } });
  });
  const r = await setSwitch({ session: SESSION, serial: 'S', type: 7, enable: false, request });
  assert.equal(r.type, 7);
  assert.equal(r.enable, false);
});

test('setSwitch: falls back to the legacy endpoint when v3 does not answer 200', async () => {
  const request = recorder((o) => {
    if (o.method === 'PUT') return ok({ meta: { code: 404 } });
    assert.equal(o.method, 'POST');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/api/device/switchStatus');
    assert.deepEqual(o.form, { serial: 'S', enable: '1', type: '3', channel: '0' });
    return ok({ meta: { code: 200 } });
  });
  const r = await setSwitch({ session: SESSION, serial: 'S', type: 'LIGHT', enable: true, request });
  assert.equal(r.via, 'legacy');
});

test('setSwitch: both endpoints fail -> switch_failed with the meta code', async () => {
  const request = recorder(() => ok({ meta: { code: 2009, message: 'device offline' } }));
  await assert.rejects(setSwitch({ session: SESSION, serial: 'S', type: 'LIGHT', enable: true, request }), (err) => {
    assert.equal(err.code, 'switch_failed');
    assert.equal(err.metaCode, 2009);
    return true;
  });
});

test('setSwitch: argument validation', async () => {
  const request = recorder(() => assert.fail('must not send anything'));
  await assert.rejects(setSwitch({ serial: 'S', type: 3, enable: true, request }), { code: 'invalid_argument' });
  await assert.rejects(setSwitch({ session: SESSION, type: 3, enable: true, request }), { code: 'invalid_argument' });
  await assert.rejects(setSwitch({ session: SESSION, serial: 'S', type: 'NOPE', enable: true, request }), { code: 'invalid_argument' });
  await assert.rejects(setSwitch({ session: SESSION, serial: 'S', type: 3, enable: 1, request }), { code: 'invalid_argument' });
  await assert.rejects(setSwitch({ session: SESSION, serial: 'S', type: 3, enable: true, channel: -1, request }), { code: 'invalid_argument' });
});

test('setDeviceSwitch: logs in then sets, and returns the session for reuse', async () => {
  const request = recorder((o) => {
    if (o.url.endsWith('/v3/users/login/v5')) {
      return ok({ meta: { code: 200 }, loginSession: { sessionId: 'SS' }, loginArea: { apiDomain: 'd.ezvizlife.com' } });
    }
    if (o.method === 'PUT') {
      assert.equal(o.url, 'https://d.ezvizlife.com/v3/devices/X/0/0/7/switchStatus');
      return ok({ meta: { code: 200 } });
    }
    assert.fail(`unexpected ${o.url}`);
  });
  const r = await setDeviceSwitch({ account: 'a', password: PASSWORD, serial: 'X', type: 'PRIVACY', enable: false, request });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'v3');
  assert.equal(r.session.sessionId, 'SS');
});

test('DeviceSwitchType has the expected ids and featureCode is 32 hex', () => {
  assert.equal(DeviceSwitchType.LIGHT, 3);
  assert.equal(DeviceSwitchType.PRIVACY, 7);
  assert.equal(DeviceSwitchType.INFRARED_LIGHT, 10);
  assert.equal(DeviceSwitchType.SLEEP, 21);
  assert.match(featureCode(), /^[0-9a-f]{32}$/);
  assert.ok(EzvizCloudError);
});

// --------------------------------------------------------------- read state

const PAGE = (switchSection) => ({ status: 200, json: { meta: { code: 200 }, SWITCH: switchSection }, text: '' });

test('getSwitchStates: reads the SWITCH section into a {type: boolean} map', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'GET');
    assert.match(o.url, /\/v3\/userdevices\/v1\/resources\/pagelist\?/);
    assert.match(o.url, /filter=/);
    assert.equal(o.headers.sessionId, 'SID');
    return PAGE({
      BK0341402: [
        { type: 7, enable: 1, channelNo: 0 },
        { type: 3, enable: 0, channelNo: 0 },
        { type: 10, enable: 1, channelNo: 0 },
      ],
    });
  });
  const states = await getSwitchStates({ session: SESSION, serial: 'BK0341402', request });
  assert.deepEqual(states, { 7: true, 3: false, 10: true });
  assert.equal(states[DeviceSwitchType.PRIVACY], true);
  assert.equal(states[DeviceSwitchType.LIGHT], false);
});

test('getSwitchStates: unknown serial -> not_found', async () => {
  const request = recorder(() => PAGE({ OTHER: [{ type: 3, enable: 1, channelNo: 0 }] }));
  await assert.rejects(getSwitchStates({ session: SESSION, serial: 'BK0341402', request }), { code: 'not_found' });
});

test('getDevices / getSwitchStates: non-200 device list -> request_failed', async () => {
  const request = recorder(() => ({ status: 200, json: { meta: { code: 1013 } }, text: '' }));
  await assert.rejects(getDevices({ session: SESSION, request }), { code: 'request_failed' });
  await assert.rejects(getSwitchStates({ session: SESSION, serial: 'X', request }), { code: 'request_failed' });
});

test('getSwitchStates: validates its arguments', async () => {
  const request = recorder(() => assert.fail('must not send anything'));
  await assert.rejects(getSwitchStates({ serial: 'X', request }), { code: 'invalid_argument' });
  await assert.rejects(getSwitchStates({ session: SESSION, request }), { code: 'invalid_argument' });
});

test('switchName maps ids back to names', () => {
  assert.equal(switchName(3), 'LIGHT');
  assert.equal(switchName(7), 'PRIVACY');
  assert.equal(switchName(99999), null);
});

// --------------------------------------------------- feature settings (cloud)

// A legacy /api response envelope (resultCode instead of meta.code).
const legacy = (resultCode) => ({ status: 200, json: { resultCode }, text: '' });
const noPlaintext = (request, secret) => assert.ok(!JSON.stringify(request.calls).includes(secret));

test('setDefenceMode: POST switchDefenceMode with groupId -1 and the mode int', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'POST');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/userdevices/v1/group/switchDefenceMode');
    assert.equal(o.headers.sessionId, 'SID');
    assert.deepEqual(o.form, { groupId: '-1', mode: '1' });
    return ok({ meta: { code: 200 } });
  });
  const r = await setDefenceMode({ session: SESSION, mode: 'HOME', request });
  assert.deepEqual(r, { ok: true, mode: 1 });
});

test('setDefenceMode: numeric mode, optional visualAlarm/soundMode only when given', async () => {
  const request = recorder((o) => {
    assert.deepEqual(o.form, { groupId: '-1', mode: '2', visualAlarm: '1', soundMode: '0' });
    return ok({ meta: { code: 200 } });
  });
  await setDefenceMode({ session: SESSION, mode: 2, visualAlarm: 1, soundMode: 0, request });
});

test('setDefenceMode: rejects a bad mode and a missing session', async () => {
  const request = recorder(() => assert.fail('must not send anything'));
  await assert.rejects(setDefenceMode({ session: SESSION, mode: 'NOPE', request }), { code: 'invalid_argument' });
  await assert.rejects(setDefenceMode({ mode: 1, request }), { code: 'invalid_argument' });
});

test('setDefenceMode: non-OK meta -> command_failed with the meta code', async () => {
  const request = recorder(() => ok({ meta: { code: 1013, message: 'nope' } }));
  await assert.rejects(setDefenceMode({ session: SESSION, mode: 1, request }), (err) => {
    assert.equal(err.code, 'command_failed');
    assert.equal(err.metaCode, 1013);
    return true;
  });
});

test('getDefenceMode: GET defenceMode?groupId=-1 and returns the mode number', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'GET');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/userdevices/v1/group/defenceMode?groupId=-1');
    return ok({ meta: { code: 200 }, mode: 2 });
  });
  assert.deepEqual(await getDefenceMode({ session: SESSION, request }), { mode: 2 });
});

test('setCameraDefence: PUT changeDefenceStatusReq with Global/status/actor', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'PUT');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/devices/S/1/changeDefenceStatusReq');
    assert.deepEqual(o.form, { type: 'Global', status: '1', actor: 'V' });
    return ok({ meta: { code: 200 } });
  });
  const r = await setCameraDefence({ session: SESSION, serial: 'S', enable: true, request });
  assert.deepEqual(r, { ok: true, serial: 'S', enable: true, channel: 1 });
});

test('setCameraDefence: enable must be boolean', async () => {
  const request = recorder(() => assert.fail('must not send anything'));
  await assert.rejects(setCameraDefence({ session: SESSION, serial: 'S', enable: 1, request }), { code: 'invalid_argument' });
});

test('setDoNotDisturb: PUT /v3/alarms/{serial}/{channel}/nodisturb with enable', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'PUT');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/alarms/S/1/nodisturb');
    assert.deepEqual(o.form, { enable: '0' });
    return ok({ meta: { code: 200 } });
  });
  const r = await setDoNotDisturb({ session: SESSION, serial: 'S', enable: false, request });
  assert.equal(r.enable, false);
});

test('setNightVision: devconfig NightVision_Model with a JSON-string value', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'PUT');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/devconfig/v1/keyValue/S/1/op');
    assert.equal(o.form.key, 'NightVision_Model');
    assert.equal(o.form.value, '{"graphicType":1,"luminance":100}');
    return ok({ meta: { code: 200 } });
  });
  const r = await setNightVision({ session: SESSION, serial: 'S', mode: 'COLOUR', request });
  assert.deepEqual(r, { ok: true, serial: 'S', mode: 1, luminance: 100, channel: 1 });
});

test('setNightVision: custom luminance; out-of-range rejected', async () => {
  const request = recorder((o) => {
    assert.equal(o.form.value, '{"graphicType":2,"luminance":40}');
    return ok({ meta: { code: 200 } });
  });
  await setNightVision({ session: SESSION, serial: 'S', mode: NightVisionMode.SMART, luminance: 40, request });
  const guard = recorder(() => assert.fail('must not send anything'));
  await assert.rejects(setNightVision({ session: SESSION, serial: 'S', mode: 0, luminance: 101, request: guard }), { code: 'invalid_argument' });
});

test('setDisplayMode: devconfig display_mode {"mode":N}', async () => {
  const request = recorder((o) => {
    assert.equal(o.form.key, 'display_mode');
    assert.equal(o.form.value, '{"mode":2}');
    return ok({ meta: { code: 200 } });
  });
  await setDisplayMode({ session: SESSION, serial: 'S', mode: DisplayMode.SOFT, request });
});

test('setOsd: PUT osd with the text; empty string clears', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'PUT');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/userdevices/v1/devices/S/1/osd');
    assert.deepEqual(o.form, { osd: 'Front Door' });
    return ok({ meta: { code: 200 } });
  });
  await setOsd({ session: SESSION, serial: 'S', text: 'Front Door', request });

  const clear = recorder((o) => {
    assert.deepEqual(o.form, { osd: '' });
    return ok({ meta: { code: 200 } });
  });
  await setOsd({ session: SESSION, serial: 'S', request: clear });
});

test('setMirror: PUT basics .../{command}/mirror, no body', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'PUT');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/basics/v1/devices/S/1/CENTER/mirror');
    assert.equal(o.form, undefined);
    assert.equal(o.body, undefined);
    return ok({ meta: { code: 200 } });
  });
  await setMirror({ session: SESSION, serial: 'S', request });
});

test('setDetectionType: devconfig Alarm_DetectHumanCar {"type":N}', async () => {
  const request = recorder((o) => {
    assert.equal(o.form.key, 'Alarm_DetectHumanCar');
    assert.equal(o.form.value, '{"type":1}');
    return ok({ meta: { code: 200 } });
  });
  const r = await setDetectionType({ session: SESSION, serial: 'S', type: 'HUMAN', request });
  assert.equal(r.type, AlarmDetectHumanCar.HUMAN);
});

test('setSensitivity: PUT path setter with range checks', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'PUT');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/devconfig/v1/sensitivity/S/1/0/3');
    assert.equal(o.form, undefined);
    return ok({ meta: { code: 200 } });
  });
  await setSensitivity({ session: SESSION, serial: 'S', value: 3, request });

  const guard = recorder(() => assert.fail('must not send anything'));
  await assert.rejects(setSensitivity({ session: SESSION, serial: 'S', value: 7, type: 0, request: guard }), { code: 'invalid_argument' });
  await assert.rejects(setSensitivity({ session: SESSION, serial: 'S', value: 150, type: 1, request: guard }), { code: 'invalid_argument' });
});

test('getSensitivity: GET the sensitivity base path', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'GET');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/devconfig/v1/sensitivity/S/1');
    return ok({ meta: { code: 200 }, value: 3 });
  });
  const r = await getSensitivity({ session: SESSION, serial: 'S', request });
  assert.equal(r.value, 3);
});

test('setIntelligentApp: PUT to enable, DELETE to disable', async () => {
  const add = recorder((o) => {
    assert.equal(o.method, 'PUT');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/intelligent-app/load/S/RES1/app_human_detect');
    return ok({ meta: { code: 200 } });
  });
  await setIntelligentApp({ session: SESSION, serial: 'S', resourceId: 'RES1', app: 'HUMAN', enable: true, request: add });

  const remove = recorder((o) => {
    assert.equal(o.method, 'DELETE');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/intelligent-app/load/S/RES1/app_car_detect');
    return ok({ meta: { code: 200 } });
  });
  await setIntelligentApp({ session: SESSION, serial: 'S', resourceId: 'RES1', app: IntelligentApp.VEHICLE, enable: false, request: remove });

  const guard = recorder(() => assert.fail('must not send anything'));
  await assert.rejects(setIntelligentApp({ session: SESSION, serial: 'S', app: 'HUMAN', enable: true, request: guard }), { code: 'invalid_argument' });
});

test('setAlarmSound: PUT alarm/sound with enable/soundType/voiceId/deviceSerial', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'PUT');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/devices/S/alarm/sound');
    assert.deepEqual(o.form, { enable: '1', soundType: '1', voiceId: '0', deviceSerial: 'S' });
    return ok({ meta: { code: 200 } });
  });
  const r = await setAlarmSound({ session: SESSION, serial: 'S', soundType: 'INTENSE', request });
  assert.equal(r.soundType, SoundMode.INTENSE);

  const guard = recorder(() => assert.fail('must not send anything'));
  await assert.rejects(setAlarmSound({ session: SESSION, serial: 'S', soundType: 9, request: guard }), { code: 'invalid_argument' });
});

test('setFloodlightBrightness: POST alarmLight with luminance; range checked', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'POST');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/alarms/device/alarmLight/S/1');
    assert.deepEqual(o.form, { luminance: '50' });
    return ok({ meta: { code: 200 } });
  });
  await setFloodlightBrightness({ session: SESSION, serial: 'S', luminance: 50, request });

  const guard = recorder(() => assert.fail('must not send anything'));
  await assert.rejects(setFloodlightBrightness({ session: SESSION, serial: 'S', luminance: 0, request: guard }), { code: 'invalid_argument' });
  await assert.rejects(setFloodlightBrightness({ session: SESSION, serial: 'S', luminance: 101, request: guard }), { code: 'invalid_argument' });
});

test('setDevConfig: coerces object->JSON, boolean->1/0, number/string passthrough', async () => {
  const obj = recorder((o) => {
    assert.equal(o.method, 'PUT');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/devconfig/v1/keyValue/S/1/op');
    assert.deepEqual(o.form, { key: 'K', value: '{"a":1}' });
    return ok({ meta: { code: 200 } });
  });
  await setDevConfig({ session: SESSION, serial: 'S', key: 'K', value: { a: 1 }, request: obj });

  const bool = recorder((o) => {
    assert.equal(o.form.value, '1');
    return ok({ meta: { code: 200 } });
  });
  await setDevConfig({ session: SESSION, serial: 'S', key: 'K', value: true, request: bool });

  const num = recorder((o) => {
    assert.equal(o.form.value, '5');
    return ok({ meta: { code: 200 } });
  });
  await setDevConfig({ session: SESSION, serial: 'S', key: 'K', value: 5, request: num });
});

test('getDevConfig: GET the key/value op path with ?key=', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'GET');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/devconfig/v1/keyValue/S/1/op?key=display_mode');
    return ok({ meta: { code: 200 }, value: '{"mode":2}' });
  });
  const r = await getDevConfig({ session: SESSION, serial: 'S', key: 'display_mode', request });
  assert.equal(r.value, '{"mode":2}');
});

test('soundSiren: DESTRUCTIVE PUT /0/sendAlarm with enable', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'PUT');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/devices/S/0/sendAlarm');
    assert.deepEqual(o.form, { enable: '1' });
    return ok({ meta: { code: 200 } });
  });
  const r = await soundSiren({ session: SESSION, serial: 'S', request });
  assert.equal(r.enable, 1);
});

test('reboot: DESTRUCTIVE POST sysOper, accepts a legacy resultCode "0"', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'POST');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/api/device/v2/sysOper/S');
    assert.deepEqual(o.form, { oper: '1', deviceSerial: 'S', delay: '1' });
    return legacy('0');
  });
  const r = await reboot({ session: SESSION, serial: 'S', request });
  assert.deepEqual(r, { ok: true, serial: 'S' });

  const fail = recorder(() => legacy('-1'));
  await assert.rejects(reboot({ session: SESSION, serial: 'S', request: fail }), { code: 'command_failed' });
});

test('upgradeFirmware: DESTRUCTIVE PUT .../0/upgrade, no body', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'PUT');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/upgrades/v1/devices/S/0/upgrade');
    assert.equal(o.form, undefined);
    assert.equal(o.body, undefined);
    return ok({ meta: { code: 200 } });
  });
  await upgradeFirmware({ session: SESSION, serial: 'S', request });
});

test('remoteUnlock: DESTRUCTIVE PUT iot-feature with a JSON unLockInfo body', async () => {
  const request = recorder((o) => {
    assert.equal(o.method, 'PUT');
    assert.equal(o.url, 'https://apieu.ezvizlife.com/v3/iot-feature/action/S/Video/1/DoorLockMgr/RemoteUnlockReq');
    assert.equal(o.form, undefined);
    assert.deepEqual(o.body, { unLockInfo: { bindCode: 'featu1', lockNo: 5, streamToken: '', userName: 'u1' } });
    return ok({ meta: { code: 200 } });
  });
  await remoteUnlock({ session: SESSION, serial: 'S', userId: 'u1', lockNo: 5, request });
});

test('feature setters: every one validates session and serial, and never leaks a token', async () => {
  const guard = recorder(() => assert.fail('must not send anything'));
  const withSerial = [
    setCameraDefence, setDoNotDisturb, setNightVision, setDisplayMode, setOsd, setMirror,
    setDetectionType, setSensitivity, getSensitivity, setAlarmSound, setFloodlightBrightness,
    setDevConfig, getDevConfig, soundSiren, reboot, upgradeFirmware,
  ];
  for (const fn of withSerial) {
    await assert.rejects(fn({ serial: 'S', request: guard }), { code: 'invalid_argument' }, `${fn.name} needs a session`);
    await assert.rejects(fn({ session: SESSION, request: guard }), { code: 'invalid_argument' }, `${fn.name} needs a serial`);
  }
});

test('feature enums have the expected ids', () => {
  assert.equal(DefenseModeType.AWAY, 2);
  assert.equal(NightVisionMode.SMART, 2);
  assert.equal(DisplayMode.VIVID, 3);
  assert.equal(AlarmDetectHumanCar.PIR, 5);
  assert.equal(SoundMode.SILENT, 2);
  assert.equal(IntelligentApp.GESTURE, 'app_wave_recognize');
});

test('feature setters never put the sessionId in the body or URL', async () => {
  const request = recorder(() => ok({ meta: { code: 200 } }));
  await setOsd({ session: SESSION, serial: 'S', text: 'x', request });
  const call = request.calls[0];
  assert.equal(call.headers.sessionId, 'SID');
  assert.ok(!String(call.url).includes('SID'));
  assert.ok(!JSON.stringify(call.form || {}).includes('SID'));
});
