# Security

## Reporting a problem

If you find a security problem in this library, the CLI or the examples,
please report it privately through the repository host's private
vulnerability reporting (on GitHub: the Security tab, "Report a
vulnerability") rather than in a public issue. Include what you found, how to
reproduce it, and the versions of ezviz-local, Node and go2rtc involved. We
will reply as soon as we can.

Problems in the camera's firmware belong with the manufacturer. Problems in
go2rtc belong with [go2rtc](https://github.com/AlexxIT/go2rtc).

## Your camera password

On EZVIZ cameras the local password is usually the verification code printed
on the camera's label. Anyone who has it, and can reach the camera on your
network, can watch it, move it and talk through it.

- Do not commit it. Keep filled-in configs (`go2rtc.yaml`, `.env`) out of git;
  `.gitignore` covers the usual names.
- Do not paste it into issues, logs or screenshots. Check `--json` output and
  go2rtc logs before sharing them.
- Do not put it on a command line. The CLI reads it from `EZVIZ_PASSWORD` or a
  hidden prompt for that reason.
- A go2rtc config contains it in every RTSP URL: `chmod 600` the file, keep
  go2rtc's API on loopback (its `/api/config` returns the file) on a machine
  nobody browses the web from, and keep its log level at `warn` or `info`.

## Exposure

go2rtc has no authentication, and its RTSP server and the camera's
backchannel make it possible to speak into the room. Read
[docs/GO2RTC-PITFALLS.md](docs/GO2RTC-PITFALLS.md) before making any of this
reachable from outside your own machine.
