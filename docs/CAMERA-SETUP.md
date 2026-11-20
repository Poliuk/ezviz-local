# Camera setup

What an EZVIZ camera needs before anything in this repository can talk to it.
Written against a C6N (`CS-C6N-R101-1G2WF`). Other models differ in the app's
menus and in what the firmware offers at all.

## 1. Find the password and the address

- User: `admin`. Not your EZVIZ account e-mail.
- Password: the verification code, six upper-case letters on the label under
  or behind the camera (sometimes marked "Verification Code" or "VC"). The
  EZVIZ app also shows it in the device information. It is not your EZVIZ
  account password. If the device password was ever changed in the app, the
  new one replaces the label's code for local access too.
- Address: the camera's LAN IP, from your router or the app's device
  information. Give it a fixed lease in the router so it does not move.

Treat the verification code like a password. Do not commit it, paste it into
issues, or put it on a command line (shell history keeps it). The CLI reads it
from `EZVIZ_PASSWORD` or asks for it.

Hikvision-based firmware often locks local login after repeated failures. We
have not tested this on the C6N.

## 2. Check what is open

```sh
ezviz-local probe 192.0.2.10     # asks for the code at a hidden prompt
```

`probe` only reads. It opens and closes a TCP connection to the command port
(8000) without logging in, and sends RTSP `OPTIONS` and `DESCRIBE` to port
554. It never starts a stream and never moves the camera. Typical output when
everything is on:

```
Command port 8000: open (pan/tilt over the LAN should work)
RTSP port 554: open
  Login: accepted
  Main stream: rtsp://admin:PASSWORD@192.0.2.10:554/Streaming/Channels/101
  Sub stream:  rtsp://admin:PASSWORD@192.0.2.10:554/Streaming/Channels/102
  Video: H264
  Camera microphone: MPEG4-GENERIC, 16000 Hz
  Two-way audio (ONVIF backchannel): yes, PCMU/8000
  go2rtc source for talking: rtsp://admin:PASSWORD@192.0.2.10:554/Streaming/Channels/101#backchannel=1
```

Pan/tilt needs only the command port. Video and two-way audio need RTSP.

## 3. Turn RTSP on

On our C6N, port 554 was closed out of the box. Two settings are involved.

### Video/image encryption

In the EZVIZ app, open the camera's settings and turn off video encryption
(called "Image Encryption" or "Video Encryption" depending on app version).
Most guides say this is what opens RTSP. Our reading of pyEzvizApi and its
issue tracker is that it is not the switch for the port; it is tied to which
password local services accept. We turn it off anyway and have not tested
RTSP with it on.

### The RTSP service switch

The firmware has a separate switch for its local services (`hiksdk`, `web`,
`rtsp`, `upnp`), read and written over the command port. On our camera it was
`rtsp: 0`, and switching it to 1 opened port 554 in about five seconds.

[pyEzvizApi](https://github.com/RenierM26/pyEzvizApi)'s command-line tool can
read and set it over the LAN, with no cloud account. At the time of writing:

```sh
pipx install pyezvizapi
umask 077; read -rs CODE; printf '%s' "$CODE" > ~/.ezviz-devpw; unset CODE   # type the code
pyezvizapi lan rtsp status --host 192.0.2.10 --serial <SERIAL> --lan-password-file ~/.ezviz-devpw
pyezvizapi lan rtsp enable --host 192.0.2.10 --serial <SERIAL> --lan-password-file ~/.ezviz-devpw
```

The serial number is on the same label. Check `pyezvizapi --help` for the
current syntax. A successful write only means the switch changed; firmware
that has no RTSP server will not gain one this way.

Some versions of the EZVIZ app have the same switch under LAN Live View, then
the camera's Local Server Settings. Reboot the camera after changing it there.

Then run `ezviz-local probe` again.

## 4. Watch it

Any RTSP player will do. This puts the code in your shell history, which is
fine for a one-off check on your own machine; for anything longer, use go2rtc.

```sh
ffplay -rtsp_transport tcp 'rtsp://admin:ABCDEF@192.0.2.10:554/Streaming/Channels/101'
```

`/Streaming/Channels/101` is the main stream and `/102` the sub stream
(channel × 100 + stream). EZVIZ also documents `/ch1/main` for the C6N, which
is the same main stream.

For browsers, use go2rtc: [examples/go2rtc.yaml](../examples/go2rtc.yaml) and
[GO2RTC-PITFALLS.md](GO2RTC-PITFALLS.md).

## When something fails

| What you see | Likely cause |
|---|---|
| Command port closed | Wrong address, the camera is on another VLAN, or the router isolates clients. |
| RTSP port closed | The RTSP switch is off (step 3), or the camera needs a reboot after changing it. Some firmware has no RTSP server at all. |
| RTSP login rejected | Wrong code, or the device password was changed in the app. |
| Video starts, then stalls | The C6N accepts only a few RTSP clients at once; we have not measured the exact limit. Close other players; run one go2rtc and let everything else watch through it. |
| No two-way audio | The model or firmware does not offer the ONVIF backchannel. See [TALKBACK.md](TALKBACK.md). |
