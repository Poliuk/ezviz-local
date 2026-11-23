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
