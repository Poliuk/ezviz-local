# The EZVIZ command port and the PTZ command

This is how ezviz-local talks to an EZVIZ camera on the local network. It covers
the command port (TCP 8000), the pan/tilt command we send over it, and the RTSP
request that reveals two-way audio. Everything here was tested on an EZVIZ C6N
(CS-C6N-R101-1G2WF). We have not checked other models.

EZVIZ and Hikvision are trademarks of their respective owners. This project is
not affiliated with either company.

## Where this comes from

The login, framing and auth-word logic were worked out by
[pyEzvizApi](https://github.com/RenierM26/pyEzvizApi) (Apache-2.0, by Renier
Moorcroft). `lib/protocol.js` and `lib/control.js` are a JavaScript port of
that code; NOTICE lists exactly what was ported.

The PTZ command id, its body layout and the stop rule were not in pyEzvizApi.
We established them on our own camera, on our own network:

- We relayed a vendor client's session with the camera through a logging TCP
  proxy and read the frames it sent while panning left and right. That gave the
  command id, the body layout and the left/right codes.
- Up and down were not in that capture. We sent them ourselves and confirmed
  them by comparing camera snapshots taken before, during and after each tilt.
  They agree with the direction map in pyEzvizApi.

No vendor binaries, SDK headers or decompiled code are used by or included in
this project.

## Frames

Every message on the command port is a frame with a 16-byte header. All header
fields are unsigned 32-bit big-endian.

```
offset  size  field
0       4     total length, header included
4       4     family (0x5a000000 login, 0x63000000 control) or, in replies, a value
8       4     auth word (control frames), otherwise 0
12      4     command id (control frames), 0x00010000 (login frames)
```

A reply whose length field is 16 has no body. The camera uses that for acks.

## Login

The login happens on its own TCP connection, which is closed afterwards.

1. The client sends a login frame. Its body is a 20-byte prefix, the username
   NUL-padded to 48 bytes, and a fresh RSA-1024 public key in PKCS#1 DER form.
   The prefix is `05 01 3d 4b 00 00 00 01`, the client's IPv4 address with its
   bytes reversed, then `00 00 00 00 00 00 6f 00`.
2. The camera answers with 128 bytes of RSA (PKCS#1 v1.5) ciphertext, which
   decrypts to a challenge, followed by a 64-byte password seed.
3. The client sends a second login frame with the same prefix, then
   HMAC-MD5(challenge, username) padded with zeros to 32 bytes, then
   HMAC-MD5(challenge, hex(SHA-256(username + seed + password))), where hex()
   is the lowercase hex string. Trailing zero bytes are stripped from the challenge before it is
   used as a key.
4. The camera answers with the session. The first 4 body bytes are the session
   id (all zero means the login was refused), the header word at offset 4 is
   the auth seed, and body bytes 4 to 48 hold the serial number as
   NUL-terminated ASCII.

The username is `admin`. On most EZVIZ cameras the password is the six-character
verification code printed on the camera's label, not the EZVIZ account
password.

## Control frames

Each command goes on a new TCP connection after the login.

```
header
  0    total length
  4    0x63000000
  8    auth word
  12   command id
body
  0    client IPv4 address, bytes reversed
  4    session id from the login
  8    eight zero bytes
  16   command-specific tail
```

The auth word ties the frame to the session and the command id. Take
`(auth seed + 2 * command id) mod 2^32`, write it little-endian into the first
4 bytes of a zeroed 16-byte block, and encrypt that block with AES-128 cut down
to four rounds, keyed with the first 16 bytes of the challenge. XOR the four
32-bit words of the result together, read that as a little-endian integer, and
add the session id (read big-endian), mod 2^32.

The camera replies with a 16-byte ack, `00000010 00000001 00000001 00000000`.
An ack only means the frame was well formed. It does not prove the motor
turned.

ezviz-local logs in again for every command, as pyEzvizApi does, so a move is
two logins and two control frames.

## The PTZ command

Command id `0x00030203`. The tail is three 32-bit big-endian values.

```
0    channel   unsigned, 1 on a single-lens camera
4    command   signed
8    speed     unsigned, see below
```

We only sent speed 4, the value the vendor client used. 1 to 7 is the usual
range for this command; other values are untested.

| direction | start | stop |
|-----------|------:|-----:|
| up        | 21    | -22  |
| down      | 22    | -23  |
| left      | 23    | -24  |
| right     | 24    | -25  |

There is no separate stop flag. The stop for a direction is the start code
plus one, negated: `stop = -(start + 1)`. That is why the command field has to
be read as signed. These are the four tails we observed for left and right:

```
00000001 00000017 00000004   channel 1, 23 (left start),  speed 4
00000001 ffffffe8 00000004   channel 1, -24 (left stop),  speed 4
00000001 00000018 00000004   channel 1, 24 (right start), speed 4
00000001 ffffffe7 00000004   channel 1, -25 (right stop), speed 4
```

A complete left-start control frame, with the fake session from
`test/fixtures/ptz-left-start.json`:

```
0000002c 63000000 1fcce906 00030203   length 44, control, auth word, PTZ
0100007f                              client 127.0.0.1, reversed
9abcdef0                              session id
00000000 00000000                     zeros
00000001 00000017 00000004            channel 1, left, speed 4
```

## Rules for code that moves the camera

1. Always send the stop, from a `finally` or equivalent, with a hard cap on how
   long a move can run. A start with no stop drives the motor into its end
   stop. `move()` sends the stop whenever the start may have reached the
   camera, including when the wait is interrupted or the start failed after
   login. It tries the stop up to three times and rejects if none is
   acknowledged.
2. Count the run time from the moment the start frame is written, not from its
   ack, and never wait for the start's ack past that deadline. The ack can be
   slow or lost while the motor is already turning; waiting for it with a
   5 s socket timeout turns a 0.5 s move into a 5 s one. At the deadline, send
   the stop whether or not the ack came. Do not send the stop before the start
   frame has been written. `move()` does this with `control()`'s
   `onFrameSent`, `ackTimeoutMs` and `ackSignal` options, and reports
   `startAcked: false` when the ack did not come in time.
3. The motor then runs for at most the requested time plus the time the stop
   takes to reach the camera: one login and one frame, usually tens of
   milliseconds on a LAN. A stop attempt that fails adds its own timeouts and
   a 200 ms pause before the retry. Each frame logs in afresh; we have not
   tried sending the stop on the start's session, so we do not rely on it.
4. An ack is not movement. Check the picture.
5. Do not scan the command id space. It is large and sparse, ids follow no
   formula we know of, and some nearby ids return device configuration,
   including Wi-Fi credentials. Every unknown id is an unknown write to the
   camera.
6. Presets use a different command id that we have not captured.

## RTSP and two-way audio

Port 554 opens once the camera's RTSP service switch is on; on our C6N it was
off out of the box (CAMERA-SETUP.md, step 3). The stream paths are:

```
rtsp://admin:PASSWORD@<camera>:554/Streaming/Channels/101   main stream
rtsp://admin:PASSWORD@<camera>:554/Streaming/Channels/102   sub stream
```

The C6N supports the ONVIF audio backchannel, which lets a client send audio to
the camera's speaker, but only advertises it when the DESCRIBE request asks for
it:

```
DESCRIBE rtsp://192.0.2.10:554/Streaming/Channels/101 RTSP/1.0
CSeq: 3
Accept: application/sdp
Require: www.onvif.org/ver20/backchannel
Authorization: Digest ...
```

Without the `Require` header the SDP has two media sections: H.264 video and
the camera's microphone as AAC (`MPEG4-GENERIC/16000`, `a=recvonly`). With the
header there is a third:

```
m=audio 0 RTP/AVP 0 104
a=rtpmap:0 PCMU/8000/1
a=sendonly
```

That is G.711 µ-law at 8 kHz, which browsers can send over WebRTC without
transcoding. `probe()` makes exactly this request and reports the result. It
never sends SETUP or PLAY, so it never opens a media session.

In go2rtc, an RTSP source with `#backchannel=1` uses this track and
`#backchannel=0` leaves it out. go2rtc 1.9.9 asks for the backchannel by
default on a plain RTSP URL, so put `#backchannel=0` on every stream that is
only for watching and keep a separate stream for talking.
