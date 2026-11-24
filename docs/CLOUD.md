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

## Reading state

One read backs a settings UI:

- `getSwitchStates({ session, serial })` → `{ type(number): boolean }` for every
  feature switch the device reports (read it with `DeviceSwitchType` /
  `switchName`).
- `getDevices({ session })` → the raw device "pagelist" (switches, online
  status, Wi-Fi, which features the device supports), when you need more than
  the switches.
- `getDefenceMode({ session })` → `{ mode }`, the account arm mode.
- `getSensitivity({ session, serial })` and
  `getDevConfig({ session, serial, key })` → the raw JSON for those settings.

## Feature settings (beyond switches)

Same session; writes reject `EzvizCloudError` with `.code` `command_failed` (or
`config_failed` for devconfig) and reads `request_failed`, each carrying
`.metaCode` / `.resultCode`. `channel` defaults to `1` — EZVIZ's usual camera
channel for these endpoints, though `setSwitch` uses `0`; override `channel` if
your device reports a different one.

| call | sets | values |
|------|------|--------|
| `setDefenceMode({ session, mode })` | account arm mode | `DefenseModeType`: `UNSET` `HOME` `AWAY` `SLEEP` |
| `setCameraDefence({ session, serial, enable })` | per-camera motion arm | boolean |
| `setDoNotDisturb({ session, serial, enable })` | suppress push (still records) | boolean |
| `setNightVision({ session, serial, mode, luminance })` | night-vision / IR | `NightVisionMode`: `B_W` `COLOUR` `SMART`; luminance 0–100 |
| `setDisplayMode({ session, serial, mode })` | image preset | `DisplayMode`: `ORIGINAL` `SOFT` `VIVID` |
| `setOsd({ session, serial, text })` | on-screen text | string (`''` clears) |
| `setMirror({ session, serial })` | flip the image | `command` default `CENTER` |
| `setDetectionType({ session, serial, type })` | detection target | `AlarmDetectHumanCar`: `HUMAN` `IMAGE_CHANGE` `PIR` |
| `setSensitivity({ session, serial, value, type })` | detection sensitivity | type `0` → 1–6, else 1–100 |
| `setIntelligentApp({ session, serial, resourceId, app, enable })` | a detection app | `IntelligentApp`: `HUMAN` `VEHICLE` `IMAGE_CHANGE` `GESTURE` |
| `setAlarmSound({ session, serial, soundType })` | alarm-sound mode | `SoundMode`: `SOFT` `INTENSE` `SILENT` |
| `setFloodlightBrightness({ session, serial, luminance })` | floodlight | 1–100 |
| `setDevConfig({ session, serial, key, value })` | any devconfig key | the catch-all behind several of the above |

`setIntelligentApp` needs the camera's `resourceId` (from the device list's
`resourceInfos`); the others need only the serial. Enum fields take the name or
the number (`'PRIVACY'` or `7`, `'HOME'` or `1`).

## Destructive operations

These physically act on the device or are hard to undo — gate them behind an
explicit confirmation in any UI:

- `soundSiren({ session, serial, enable })` — trigger the audible siren.
- `reboot({ session, serial })` — restart the device.
- `upgradeFirmware({ session, serial })` — start a firmware upgrade.
- `remoteUnlock({ session, serial, userId, lockNo })` — unlock a smart lock
  (lock devices, not cameras; some need an explicit `bindCode`).

There is no SD-card format / wipe in the cloud API, so this module has none.

## Status

Verified against a real account and camera: `cloudLogin`, the state read
(`getDevices` / `getSwitchStates`), and `setSwitch` both ways on a `LIGHT`
toggle (set, read back, restored). The other setters are exercised only by
mocked tests (`test/cloud.test.js`) — their request shapes were traced from
pyezvizapi but not yet confirmed on hardware. Try each against a camera you own
before relying on it, and expect to adjust the channel or meta-code handling if
EZVIZ's API differs for your region.

The switch ids, the login flow and every cloud request shape here were traced
from [pyEzvizApi](https://github.com/RenierM26/pyEzvizApi); see
[NOTICE](../NOTICE).
