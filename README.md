# ezviz-local

Control an EZVIZ camera on your own network, with no cloud account: pan and
tilt it over its local command port, and find out whether it offers RTSP video
and two-way audio. A small JavaScript library and command-line tool with no
dependencies, plus a go2rtc config and an example web page to build your own
viewer on.

## What works

Tested on an EZVIZ C6N (`CS-C6N-R101-1G2WF`):

- pan and tilt over TCP 8000, logged in with the camera's verification code;
- video over RTSP (`/Streaming/Channels/101` and `102`);
- two-way audio from a browser through go2rtc and the camera's ONVIF
  backchannel (PCMU, no transcoding).

Other EZVIZ and Hikvision-based models may work. We have not verified any.
Reports are welcome.

## Install

Node 18 or later.

```sh
npm install ezviz-local          # the library
npx ezviz-local probe 192.0.2.10  # or the command line, without installing
```

The examples and docs below are in the
[repository](https://github.com/Poliuk/ezviz-local), not in the npm package.

First turn on RTSP and find the password: [docs/CAMERA-SETUP.md](docs/CAMERA-SETUP.md).

## Command line

The password is the camera's verification code. It is read from
`EZVIZ_PASSWORD` or asked for at a hidden prompt, never taken as an argument.

```sh
ezviz-local probe 192.0.2.10            # what is open; read-only
ezviz-local move 192.0.2.10 left 500    # pan left for 500 ms, then stop
ezviz-local probe 192.0.2.10 --json
```

`probe` connects to the command port without logging in and sends RTSP
`OPTIONS` and `DESCRIBE`. It never starts a stream, sends audio or moves the
camera.

## Library

```js
const { probe, move, control, ptzFrameTail, PTZ } = require('ezviz-local');

const camera = { host: '192.0.2.10', password: process.env.EZVIZ_PASSWORD };

async function main() {
  // What does the camera offer?
  console.log(await probe(camera));
  // { commandPort: { open: true },
  //   rtsp: { open: true, auth: 'ok', paths: { main, sub }, video: 'H264',
  //           audio: { codec: 'MPEG4-GENERIC', rate: 16000 },
  //           backchannel: { codecs: ['PCMU/8000'] } } }

  // Pan right for 800 ms. move() sends the stop whenever the start may have
  // reached the camera, tries it up to three times, and rejects with
  // stop_failed if none is acknowledged. speed is 1 to 7; only 4 is tested.
  // The 800 ms count from when the start frame is written, not from its ack,
  // so a slow ack cannot stretch the move. startAcked is false if the ack
  // did not come in that time.
  const { durationMs, startAcked } = await move({ ...camera, direction: 'right', durationMs: 800, speed: 4 });

  // Lower level: one authenticated frame each. Start, then stop, yourself.
  const frame = (command) => ({ ...camera, commandId: PTZ.COMMAND_ID, bodyTail: ptzFrameTail(command) });
  try {
    await control(frame(PTZ.UP));
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    await control(frame(PTZ.stopOf(PTZ.UP)));
  }
}

main().catch((err) => console.error(err.code, err.message));
```

Errors are `EzvizLanError` with a `code` (`timeout`, `auth_failed`,
`ECONNREFUSED`, ...). If you use `control()` to start a move, send the stop
from a `finally` and cap the run time: a start with no stop drives the motor
into its end stop.

`control()` also takes three options for code that must not block on a slow
ack:

- `onFrameSent()`: called right after the control frame has been written,
  before the ack is read. Start your run-time timer here.
- `ackTimeoutMs`: how long to wait for the ack after the write (default
  `timeoutMs`).
- `ackSignal`: an `AbortSignal` that ends the wait for the ack early. It never
  cuts the login or the write short.

When the ack wait ends early the call rejects with `timeout` or `aborted`, and
`err.frameSent` is `true`: the frame is on its way, so send the stop. The
socket is then closed with a TCP reset, so a frame lost on the network is not
retransmitted after your stop. A
`control`-phase error with `err.frameSent === false` means the frame was never
written.

## Cloud: feature switches and settings

An EZVIZ C6N won't change its *feature switches* (privacy, the status LED, sleep,
infrared) or most of its settings over the LAN — those go through EZVIZ's cloud.
The `cloud` module is the one part of this package that uses your EZVIZ account
rather than the local network.

```js
const { cloud } = require('ezviz-local');

const session = await cloud.cloudLogin({ account: 'you@example.com', password: process.env.EZVIZ_ACCOUNT_PASSWORD });

// Toggle a feature switch:
await cloud.setSwitch({ session, serial: 'YOURSERIAL', type: 'PRIVACY', enable: true });

// Or change a setting:
await cloud.setNightVision({ session, serial: 'YOURSERIAL', mode: 'B_W', luminance: 100 });
```

It needs the EZVIZ **account** password (not the camera's verification code), and
it changes the camera over the internet. Beyond the switches it covers arm mode,
per-camera arm, do-not-disturb, night vision, display mode, detection type and
sensitivity, alarm sound, floodlight brightness, a generic devconfig setter,
mirror and device reboot, plus the matching reads.

Verified against a real EZVIZ C6N (login, the reads, and twelve setters); a few
calls are accepted by the API but do nothing on that model, and firmware upgrade
and smart-lock unlock are untested. See [docs/CLOUD.md](docs/CLOUD.md) for the
per-call status and the destructive-operation warnings.

## Video and talking in a browser

The library does not stream. For that we use
[go2rtc](https://github.com/AlexxIT/go2rtc):

- [examples/go2rtc.yaml](examples/go2rtc.yaml): an annotated config for
  viewing, browser sound and a separate talk stream.
- [examples/minimal](examples/minimal): a small server and page that shows
  the camera, moves it while you hold an arrow, and talks through its speaker
  while you hold a button. It is meant to be copied and changed.

go2rtc has no access control. Read
[docs/GO2RTC-PITFALLS.md](docs/GO2RTC-PITFALLS.md) before letting anyone but
yourself reach it.

## Docs

- [CAMERA-SETUP.md](docs/CAMERA-SETUP.md): password, RTSP switch, checking with `probe`
- [PROTOCOL.md](docs/PROTOCOL.md): the command-port login and the PTZ frame
- [TALKBACK.md](docs/TALKBACK.md): the ONVIF backchannel, and how go2rtc uses it
- [GO2RTC-PITFALLS.md](docs/GO2RTC-PITFALLS.md): putting go2rtc behind your own auth
- [CLOUD.md](docs/CLOUD.md): feature switches and settings (privacy, night vision, detection, alarm, reboot, …) through the EZVIZ account

## Credits

- [pyEzvizApi](https://github.com/RenierM26/pyEzvizApi) by Renier Moorcroft
  (Apache-2.0). The command-port login and framing in `lib/` are a JavaScript
  port of parts of it; see [NOTICE](NOTICE). Without it, PTZ would have taken
  weeks instead of an afternoon.
- [go2rtc](https://github.com/AlexxIT/go2rtc) by Alexey Khit, which handles the
  video and audio.

## How this was made

The PTZ command id, the frame body layout and the backchannel behaviour were
established by recording traffic to and from our own camera, on our own
network, and by watching the camera move. This repository contains only our
own descriptions and code: no Hikvision or EZVIZ binaries, SDK headers or
decompiled code.

## Disclaimer

Not affiliated with, endorsed by or supported by EZVIZ or Hikvision. EZVIZ and
Hikvision are trademarks of their respective owners. Using this may be outside
what the manufacturer supports; you use it at your own risk, on hardware you
own.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
