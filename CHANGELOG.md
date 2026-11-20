# Changelog

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

## 0.1.0

- First release.
