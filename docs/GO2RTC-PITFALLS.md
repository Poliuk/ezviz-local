# go2rtc behind your own auth: pitfalls

[go2rtc](https://github.com/AlexxIT/go2rtc) is the easiest way to get an EZVIZ
camera into a browser. It was designed for trusted networks and has no access
control of its own. These are the things we learned putting it behind an
authenticated server. Source references are to go2rtc v1.9.9; check them
again if you run another version.

## 1. The API has no authentication: bind it to loopback

Anyone who can reach go2rtc's API (port 1984 by default, on every interface)
can watch every stream, add streams, and read the running config through
`/api/config`, camera passwords included.

```yaml
api:
  listen: "127.0.0.1:1984"
  origin: ""
```

Put your own server in front, authenticate there, and forward only what you
need. [examples/minimal/server.js](../examples/minimal/server.js) forwards one
WebSocket path and nothing else. Do not port-forward 1984 or put it behind a
tunnel as is.

Loopback does not protect it from a browser on the same machine. go2rtc's
WebSocket origin check (`internal/api/ws/ws.go`, `initWS`) accepts any
request whose `Origin` host matches its `Host` header, which is exactly what a
DNS-rebinding page sends, and its HTTP API has no such check at all. A web
page opened on that machine can then watch, read `/api/config` and talk.
go2rtc's own `api: username/password` does not apply to loopback clients (in
newer versions, unless `local_auth: true`). So run go2rtc on a machine nobody
browses the web from, or give the API a unix socket (`api: unix_listen`) and
no TCP port.

## 2. Its RTSP server listens on every interface by default

go2rtc re-serves every stream over RTSP on `:8554`, with no password unless
you set one. With a backchannel stream configured, that means anyone on your
network can open `rtsp://<your-machine>:8554/talk` and speak through the
camera, whatever your web server allows. `":8554"` and `"0.0.0.0:8554"` are
the same thing.

```yaml
rtsp:
  listen: "127.0.0.1:8554"   # or "" to turn it off
```

Keep it on loopback if you want the camera's sound in browsers (item 5 needs
it); otherwise turn it off. Use `127.0.0.1`, not `[::1]`: go2rtc points its
ffmpeg at `127.0.0.1` (`internal/ffmpeg/ffmpeg.go`).

Loopback still lets any process on the same machine reach the speaker. If
other users or services share that machine, item 4's reconciliation can catch
it.

## 3. An RTSP source requests the backchannel by default

In v1.9.9 an RTSP URL with no `#...` part is opened with the backchannel on
(`internal/rtsp/rtsp.go`, `rtspHandler`: only a `#` parameter sets it from
`backchannel=1`). On a camera that offers one, such as the C6N, the speaker
is then a `sendonly` producer media on your viewing stream. Any WebRTC viewer
whose offer sends audio is paired with it: the offer's `sendrecv` or
`sendonly` audio becomes a `recvonly` consumer media
(`pkg/webrtc/helpers.go`, `UnmarshalMedias`), and
`internal/streams/add_consumer.go` (`AddConsumer`) matches it to the
backchannel.

Two locks, use both:

- Mark viewing streams `#backchannel=0`, and give talking a stream of its own
  with `#backchannel=1` ([examples/go2rtc.yaml](../examples/go2rtc.yaml)).
- Screen offers on the viewing path. Refuse any media section (data channels
  aside) whose direction is `sendrecv`, `sendonly`, or missing: a section with
  no direction attribute takes the session's, and with none at all it is
  `sendrecv` (RFC 4566). Refuse two direction attributes at one level and
  anything you cannot parse.

How go2rtc reads a frame matters for the screening. `internal/api/ws/ws.go`
(`apiWS`) decodes every frame, text or binary, with Go's JSON decoder, which
matches keys case-insensitively, lets the last duplicate key win, and ignores
anything after the first value. So `{"type":"webrtc/candidate","Type":"webrtc/offer",...}`
or a valid object followed by junk can mean something different to go2rtc
than to `JSON.parse`. Do not forward the client's bytes. Parse, check, and
send your own `JSON.stringify({type, value})`.

Use an allow-list of message types. A viewer needs `webrtc/offer` and
`webrtc/candidate`. The `webrtc` type also takes an `ice_servers` list, which
would make go2rtc contact STUN or TURN servers of the client's choosing. One
offer per socket: a second is a renegotiation.

go2rtc also accepts offers over plain HTTP at `/api/webrtc`. If your proxy
forwards that path, it needs the same screening. Simpler not to forward it.

## 4. Closing the signalling socket does not end the media

In v1.9.9 `internal/webrtc/webrtc.go` (`asyncHandler`) removes a WebRTC
consumer only when its peer connection reaches `closed`, never when its
`/api/ws` socket closes. The media flows between the browser and go2rtc on
port 8555 and never passes through your server. So your server can close a
socket (a time limit, a revoked session, a removed permission) and the
picture, or the voice into the room, carries on until the browser hangs up.

Your own page should call `pc.close()` whenever its socket closes. A
modified page need not. Even a page that does hang up leaves the consumer in
go2rtc for a while: go2rtc notices when ICE gives up (`pkg/webrtc/conn.go`),
about 8 seconds after `pc.close()` in our measurements with Chrome, and about
30 seconds for a peer connection that never connected.

go2rtc v1.9.9 has no way to drop a single consumer. What we did instead:

- Tag each connection. Open every go2rtc WebSocket from your server with a
  User-Agent carrying a random per-socket tag. go2rtc copies it onto every
  consumer that socket creates (`asyncHandler`:
  `conn.UserAgent = tr.Request.UserAgent()`) and lists it as `user_agent` in
  `/api/streams`. The browser has no say in it.
- Reconcile. Look at `/api/streams` shortly after every socket closes and on
  a timer. Every connected consumer should belong to a socket of yours that is
  still open, one consumer per socket. Allow a grace period (we use 15
  seconds) for the ICE timeout above. A WebRTC consumer with no `remote_addr`
  has not connected and carries nothing yet. go2rtc's own ffmpeg consumer
  (item 5) is an `rtsp` consumer from 127.0.0.1; on the talk stream, judge
  every consumer, of any type.
- Enforce by restarting. On a violation, `POST /api/exit?code=75`
  (`internal/api/api.go`, `exitHandler`) and let the service manager start a
  clean go2rtc (systemd `Restart=always`). That drops every peer connection,
  so legitimate viewers reconnect. Rate-limit it, and do nothing when the API
  does not answer: unknown is not a violation.
- Avoid `/api/restart`. On macOS, go2rtc v1.9.9 restarted in place while an
  ffmpeg child held the ports came back unable to bind its API and RTSP
  listeners, and kept running with no API. Exiting under a service manager
  avoids that, and the unit's cgroup takes the ffmpeg child with it.

The cost is real: a page that ignores its cut-off interrupts everyone's
picture for about 15 seconds. If that is not acceptable, the alternative is
to keep media inside your server (MSE over the WebSocket, which ends when your
server closes it) and give up WebRTC's latency.

## 5. WebRTC cannot carry the camera's AAC

EZVIZ cameras send AAC (`MPEG4-GENERIC/16000` on the C6N). WebRTC browsers
take Opus or G.711, so the picture arrives without sound. go2rtc can
transcode the audio only:

```yaml
streams:
  camera:
    - rtsp://admin:CAMERA_PASSWORD@192.0.2.10:554/Streaming/Channels/101#backchannel=0
    - "ffmpeg:camera#audio=opus"
```

go2rtc runs ffmpeg on `rtsp://127.0.0.1:8554/camera?audio`, built from the
`rtsp:` port (`internal/ffmpeg/ffmpeg.go`), and adds the Opus track to the
stream. It needs ffmpeg installed and the loopback RTSP server from item 2.
The video is not transcoded, and ffmpeg runs only while a viewer needs that
track.

The talk direction needs nothing like this: browsers encode PCMU natively and
the camera takes it as is ([TALKBACK.md](TALKBACK.md)).

## Also

- Keep go2rtc's log level at `warn` or `info`. At `debug` or `trace` it prints
  stream URLs, which contain the camera password.
- `webrtc: ice_servers: []` on a LAN. STUN adds nothing there and tells a
  third party about every connection.
- The C6N accepts only a few RTSP clients at once; we have not measured the
  exact limit. Let go2rtc hold the one connection and have everything else
  watch through it.
