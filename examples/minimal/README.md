# Minimal example

One page that shows the camera, moves it while you hold an arrow, and, if you
turn it on, lets you talk through its speaker while you hold a button. About
400 lines of server code and 230 of browser code, with no build step. It is
meant to be read and copied, not deployed as is.

## Run it

1. Set up the camera ([docs/CAMERA-SETUP.md](../../docs/CAMERA-SETUP.md)) and
   check it with `node bin/ezviz-local probe 192.0.2.10` from the repository root.
2. Run [go2rtc](https://github.com/AlexxIT/go2rtc) with
   [examples/go2rtc.yaml](../go2rtc.yaml), filled in.
3. Here:

   ```sh
   npm install
   read -rs EZVIZ_PASSWORD && export EZVIZ_PASSWORD   # type the code
   EZVIZ_HOST=192.0.2.10 node server.js
   ```

4. Open <http://127.0.0.1:8080>.

For the talk button, uncomment the `talk` stream in go2rtc.yaml and add
`TALK=1`. The browser only opens the microphone on
`https://` or `http://localhost`, so on a plain `http://<lan-address>` the
button stays disabled.

## How it fits together

```
browser ──HTTP──► server.js ──TCP 8000──► camera        (pan/tilt, lib/)
browser ──WS────► server.js ──WS────────► go2rtc /api/ws (signalling only)
browser ◄──WebRTC media (UDP/TCP 8555)──► go2rtc ──RTSP──► camera
```

- Video: `/api/ws` is relayed to go2rtc's `/api/ws?src=camera`. The server
  only forwards `webrtc/offer` and `webrtc/candidate`, re-serialised, and
  refuses an offer with any media the browser could send.
- Pan/tilt: holding an arrow posts `/api/ptz/move` every 300 ms. The first
  one starts the camera; the rest renew a 900 ms lease. Letting go posts
  `/api/ptz/stop`. If renewals stop arriving, the lease ends and the server
  sends the stop itself; no move runs longer than 8 seconds. One mover at a
  time. Every stop is tried up to three times.
- Talk (`TALK=1`): `/api/talk` is relayed to `/api/ws?src=talk`. The only
  offer accepted is one audio section, `sendonly`, with PCMU or PCMA. One
  talker at a time, 60 seconds per press.

## Safe defaults, and what they do not cover

- It listens on `127.0.0.1` unless you set `HOST`, and refuses a non-loopback
  `HOST` without `PASSWORD`. With `PASSWORD` set, every request and WebSocket
  upgrade needs HTTP Basic auth. Basic auth over plain HTTP sends the password
  in the clear on your network; put it behind https if that matters to you.
- Without `PASSWORD`, requests with a non-loopback `Host` header are refused,
  so another web site cannot reach it through DNS rebinding. A reverse proxy
  that sends `Host: 127.0.0.1` (nginx does by default) gets past that check,
  so set `PASSWORD` before putting anything in front of it.
- Closing a socket does not end the WebRTC media. go2rtc keeps the peer
  connection until the browser hangs up, and this page does hang up. A
  modified page need not, so the talk time limit is only as strong as the
  page. See [GO2RTC-PITFALLS.md](../../docs/GO2RTC-PITFALLS.md) for how to
  enforce it.
- go2rtc's API on port 1984 has no authentication. Keep it on loopback.
