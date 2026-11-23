# Changelog

## Unreleased

- `cloud`: a new module to toggle device feature switches (privacy, the status
  LED, sleep, infrared) through the EZVIZ account, since the camera does not
  expose them on the LAN. Adds `cloud.cloudLogin()`, `cloud.setSwitch()`,
  `cloud.setDeviceSwitch()` and the `DeviceSwitchType` ids. Cloud-only, and not
  yet verified against real hardware; see docs/CLOUD.md.

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
