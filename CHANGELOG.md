# Changelog

## Unreleased

- `cloud`: a new module to control the device features an EZVIZ camera does not
  expose on the LAN, through the EZVIZ account session. Login (`cloudLogin`,
  `setDeviceSwitch`), the feature switches (`setSwitch` with the
  `DeviceSwitchType` ids), and reading current state (`getDevices`,
  `getSwitchStates`, `getDefenceMode`, `getSensitivity`, `getDevConfig`). Plus
  session-only setters — `setDefenceMode`, `setCameraDefence`, `setDoNotDisturb`,
  `setNightVision`, `setDisplayMode`, `setOsd`, `setMirror`, `setDetectionType`,
  `setSensitivity`, `setIntelligentApp`, `setAlarmSound`,
  `setFloodlightBrightness` and a generic `setDevConfig` — and the destructive
  `soundSiren`, `reboot`, `upgradeFirmware` and `remoteUnlock` (gate these behind
  a confirm). Login, the state read and the `LIGHT` switch are verified against a
  real account; the other setters are traced from pyezvizapi and covered by
  mocked tests only. Cloud-only; see docs/CLOUD.md.

## 0.1.1

- `move()`: the run time now counts from when the start frame is written, not
  from its ack. A slow or lost start ack no longer delays the stop: the stop
  goes out at the deadline either way. The result has a new `startAcked` field,
  and `durationMs` is measured from the write. A missing start ack is no
  longer an error; the move runs its time, stops and reports
  `startAcked: false`.
- `control()`: new `onFrameSent`, `ackTimeoutMs` and `ackSignal` options, and
  `err.frameSent` on errors from the control socket.
- CLI: `move` says when the camera did not acknowledge the start.
- `move()` and `control()` time their deadlines with the monotonic clock, so
  a wall-clock step during a move no longer stretches it.
- `control()` closes a socket whose frame was written but got no ack with a
  TCP reset, so a start packet lost on the network is not retransmitted after
  the stop.

## 0.1.0

- First release.
