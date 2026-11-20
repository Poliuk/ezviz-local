# Two-way audio

Measured on an EZVIZ C6N (`CS-C6N-R101-1G2WF`). The camera's speaker is
reachable over standard RTSP, with no cloud, no vendor library and no
reverse engineering, through an ONVIF audio backchannel. The camera only
offers it to a client that asks.

## The finding

A plain `DESCRIBE` returns two media sections: H.264 video and the camera's
microphone (AAC, 16 kHz, `a=recvonly`). Nothing in it suggests a way back,
and for a while we concluded there was none.

Adding the ONVIF header changes the answer:

```
DESCRIBE rtsp://192.0.2.10:554/Streaming/Channels/101 RTSP/1.0
CSeq: 2
Accept: application/sdp
Authorization: Digest ...   (or Basic; user admin, the verification code)
Require: www.onvif.org/ver20/backchannel
```

| | plain `DESCRIBE` | with `Require` |
|---|---|---|
| video, H.264 | yes | yes |
| camera microphone, AAC 16 kHz, `a=recvonly` | yes | yes |
| camera speaker, PCMU 8 kHz, `a=sendonly` | no | yes |

The third section, as the camera returned it:

```
m=audio 0 RTP/AVP 0 104
a=rtpmap:0 PCMU/8000/1
a=sendonly
```

`a=sendonly` is from the camera's point of view: it is the track the client
sends on. The backchannel is opt-in by design in ONVIF, so ordinary players
are not confused by a send-only track they cannot use.

`ezviz-local probe` sends exactly this `DESCRIBE` and reports the section. It
does not `SETUP` or `PLAY`, and sends no audio.

## Why it works well in a browser

PCMU is G.711 µ-law, 8 kHz, 64 kbit/s. Every browser can encode it for
WebRTC, so the audio needs no transcoding anywhere:

```
browser microphone ──PCMU over WebRTC──► go2rtc ──RTSP backchannel──► camera speaker
```

## go2rtc

go2rtc (v1.9.9 here) supports the RTSP backchannel. In
[examples/go2rtc.yaml](../examples/go2rtc.yaml):

```yaml
streams:
  camera:
    - rtsp://admin:CAMERA_PASSWORD@192.0.2.10:554/Streaming/Channels/101#backchannel=0
  talk:
    - rtsp://admin:CAMERA_PASSWORD@192.0.2.10:554/Streaming/Channels/101#backchannel=1
```

`#backchannel=1` makes go2rtc send the `Require` header. Keep a separate
`talk` stream and mark the viewing streams `#backchannel=0`. In v1.9.9 an RTSP
source with no `#` part requests the backchannel by default, so without the
`=0` every viewer of `camera` could reach the speaker
([GO2RTC-PITFALLS.md](GO2RTC-PITFALLS.md), item 3).

The browser connects to `/api/ws?src=talk` and offers exactly one media
section:

```
m=audio 9 UDP/TLS/RTP/SAVPF 0 8
a=sendonly
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
```

What go2rtc does with it (v1.9.9 source):

- `?src=` makes the browser a consumer of the stream
  (`internal/webrtc/webrtc.go`, `asyncHandler`).
- The browser's `sendonly` audio becomes a `recvonly` consumer media
  (`pkg/webrtc/helpers.go`, `UnmarshalMedias`), which
  `internal/streams/add_consumer.go` (`AddConsumer`) pairs with the producer's
  `sendonly` media: the backchannel.
- The RTSP side sets up only that track (`pkg/rtsp/consumer.go`, `AddTrack`).
  Because the offer receives nothing, the camera's video and microphone are
  not pulled through the talk stream.

In the browser, `RTCRtpTransceiver.setCodecPreferences` with PCMU first keeps
the offer to G.711. [examples/minimal/app.js](../examples/minimal/app.js) has
the whole client in about 80 lines.

## Things to get right

- `getUserMedia` needs a secure context: `https://` or `http://localhost`.
  On a plain `http://192.0.2.x` address the browser will not open the
  microphone.
- Make it push-to-talk, not an open microphone, with a time limit and one
  talker at a time. We have not tried two senders at once and would not rely
  on the camera to handle it.
- Mute the camera's own sound in the page while talking, or the room is played
  back into the microphone.
- Treat talking as a separate permission from watching. Someone who can watch
  should not automatically be able to speak into the room.
- Closing the signalling socket does not end the call in go2rtc v1.9.9; only
  the browser hanging up does. See [GO2RTC-PITFALLS.md](GO2RTC-PITFALLS.md),
  item 4.

## Other models

Unverified. The `Require` header costs nothing to try: run
`ezviz-local probe <host>` and look for the two-way audio line.
