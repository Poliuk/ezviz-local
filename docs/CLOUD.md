# Cloud feature switches

Everything else in ezviz-local is cloud-free. This one module is not: toggling a
device *feature switch* — privacy, the status LED, sleep, infrared — is not
something an EZVIZ C6N exposes on the local network, so `lib/cloud.js` does it
through EZVIZ's cloud instead.

## Why it has to be the cloud

The camera's local command port (TCP 8000) serves pan/tilt and a few ISAPI
reads, and it accepts exactly three ISAPI `PUT` writes: `servicesSwitch` (the
local-service enables — RTSP, web, UPnP, Hik SDK), `connectMode`, and
`netConfigAndVoiceFileUpload`. None of those is a feature switch. The feature
switches are set only over the cloud, with the account session:

- `PUT /v3/devices/{serial}/{channel}/{enable}/{type}/switchStatus`
- legacy `POST /api/device/switchStatus` with `{serial, enable, type, channel}`

The EZVIZ app can also send a feature toggle as an AES-encrypted CAS command —
`<Request><OperationCode/><Switch Channel Enable Type/></Request>` over TLS/MQTT
to the cloud — but the plain `switchStatus` REST call above does the same job
with just the account session, so that is what this module uses.

## Switch ids

`DeviceSwitchType` (in `lib/cloud.js`) maps names to the numeric `type`. The
common ones on a C6N-class camera:

| name | type | effect |
|------|-----:|--------|
| `LIGHT` | 3 | the status LED |
| `DEFENCE_PLAN` | 6 | scheduled recording / defence |
| `PRIVACY` | 7 | privacy cover / stop recording |
| `INFRARED_LIGHT` | 10 | IR night-vision illuminator |
| `SLEEP` | 21 | sleep (the camera stops) |

Not every camera has every switch; an unsupported one comes back as a
`switch_failed` error carrying EZVIZ's meta code.

## Credentials

This needs the **EZVIZ account** (the email or phone and password you use in the
app), not the camera's local verification code. The password is only hashed
(MD5, and RSA for the v6 login) and sent to EZVIZ's own login endpoint; the
module never logs or stores it. If the account uses two-factor login,
`cloudLogin()` throws `mfa_required`; call it again with `smsCode` set.

## Use

```js
const { cloud } = require('ezviz-local');

const session = await cloud.cloudLogin({
  account: process.env.EZVIZ_ACCOUNT, // email or phone
  password: process.env.EZVIZ_ACCOUNT_PASSWORD,
});

// Turn the status LED off:
await cloud.setSwitch({ session, serial: 'YOURSERIAL', type: 'LIGHT', enable: false });

// setDeviceSwitch() logs in and sets in one call:
await cloud.setDeviceSwitch({
  account: process.env.EZVIZ_ACCOUNT,
  password: process.env.EZVIZ_ACCOUNT_PASSWORD,
  serial: 'YOURSERIAL',
  type: cloud.DeviceSwitchType.PRIVACY,
  enable: true,
});
```

Reuse one `session` across many `setSwitch()` calls rather than logging in each
time. Errors are `EzvizCloudError` with a `code`: `invalid_argument`,
`mfa_required`, `login_failed`, `switch_failed` (with `err.metaCode`), `timeout`
or `network_error`.

## Status

Not yet verified against real hardware or a live account: the login flow and the
`switchStatus` calls are exercised only by mocked tests (`test/cloud.test.js`).
Try it against a camera you own before relying on it, and expect to adjust the
exact endpoint or meta-code handling if EZVIZ's API differs for your region.

The switch ids and the login / `switchStatus` request shapes were traced from
[pyEzvizApi](https://github.com/RenierM26/pyEzvizApi); see [NOTICE](../NOTICE).
