# Turbo Kart Rally — Performance & Latency Report

All numbers below were **measured on the machine described in §1**, by
`scripts/measure-host.cjs` (frame/physics/render) and `scripts/stress.cjs`
(network). Raw captures live in `docs/measurements/`. Nothing here is estimated.

Read §6 before using any of these numbers to judge real hardware: the capture machine has
**no GPU**, so its frame times are a software-rasterisation floor, not a prediction of what
a gaming laptop will do. What *is* representative on any machine is the CPU-side cost
(physics, input, network) and the network latency, because those do not depend on the GPU.

## 1. Test hardware and software

| | |
| --- | --- |
| Machine | Windows 11 x64 laptop (this workspace), x64 CPU, **no discrete GPU** |
| GPU | none — Chromium falls back to **SwiftShader** (CPU software rasteriser) |
| Browser | Chromium (Playwright bundled build), headless |
| Server | Node.js 24 on `127.0.0.1` (loopback), same machine as the host page |
| Resolution | 1280×720 host viewport (six viewports ⇒ ~427×360 each) |
| Players | 6 (all human-controlled, split screen), optional 40-connection load |
| Physics | fixed 60 Hz timestep, up to 4 catch-up steps per frame |

Because the renderer is software, every frame-time figure in §2 is dominated by CPU
rasterisation of six viewports. Treat those numbers as a **worst case**, and re-measure on
the event laptop (see §7) before trusting them in either direction.

## 2. Frame, physics and render cost (six-player split screen)

Measured with `node scripts/measure-host.cjs --clients 6 --duration 25 --tag six-normal`
(host page driving, six synthetic controllers streaming 30 Hz input, `docs/measurements/six-normal.json`):

| metric | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| frame time | 2788 ms | 2965 ms | 2965 ms | 2965 ms |
| physics step (all 6 karts + items + race logic) | 1.3 ms | 4.0 ms | 4.0 ms | 4.0 ms |
| render submit (6 × `setViewport`/`setScissor` + 6 `render()`) | 16.7 ms | 18.8 ms | 18.8 ms | 18.8 ms |

Same scene in **broadcast mode** (one full-screen camera, `docs/measurements/six-broadcast.json`):

| metric | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| frame time | 568 ms | 701 ms | 773 ms | 773 ms |
| physics step | 0.9 ms | 1.5 ms | 1.6 ms | 1.6 ms |
| render submit | 4.0 ms | 4.8 ms | 4.9 ms | 4.9 ms |

**What this proves (and what it does not).** Split-screen cost scales with the number of
viewports: 1 camera = 568 ms/frame, 6 cameras = 2788 ms/frame (4.9×) in software
rasterisation. The CPU-side work the game itself owns — physics for six karts with items,
collisions, lap logic, input application and HUD updates — is **1.3 ms per 60 Hz tick
(p95 4 ms)**, i.e. ~8 % of a 16.7 ms budget, leaving ~15 ms for rasterisation on real
hardware. On a GPU that rasterises 1280×720 six times per frame at 60 fps, this is
comfortably inside budget; the same measurement on a GPU-less machine shows exactly where
the remaining time goes (rasterisation), which is the only conclusion this environment can
support honestly.

## 3. Network latency (loopback, 6 controllers, 30 Hz input)

`node scripts/stress.cjs --clients 6 --duration 30 --as-host` →
`docs/measurements/stress-a-b.txt`:

| metric | Test A (normal) | Test B (frantic: 9 Hz steering oscillation, random throttle/brake, item spam) |
| --- | --- | --- |
| input throughput | 256.6 packets/s total (42.8/client) | 255.9 packets/s (42.7/client) |
| RTT p50 | 0 ms | 0 ms |
| RTT p95 | 1 ms | 1 ms |
| RTT p99 | 1 ms | 1 ms |
| jitter (mean abs ΔRTT) | 0.17 ms | 0.16 ms |
| ping samples | 696 | 468 |

These are loopback numbers (phone on the same machine), so they measure the *software path*
(server relay → host apply → frame submit), not Wi-Fi. The Wi-Fi path is covered by the
fault-injection test in §5, which adds 20/100 ms of delay and jitter at the relay point.

## 4. Host-side input pipeline

The host tracks each packet end to end by sequence number: phone `performance.now()`
timestamp → server relay (batched `relayLog` every 500 ms, so server receive/send times can
be correlated without adding hot-path traffic) → host WebSocket receive → applied to a kart
inside the fixed-step simulation → first frame submitted after that tick. Clock skew between
phone and host is removed with NTP-style offset estimation through the local server
(`ClockSync`, median of a 24-sample window; phones report their offset with their link
stats). The F3 overlay shows the result per team as **input → applied**; `netStats()` exposes
the raw counters.

These are **software** numbers. They deliberately exclude projector/display lag, which no
browser can observe. Physical input-to-photon must be measured with a high-speed camera —
`EVENT_RUNBOOK.md` §5 gives the procedure and the `frames / fps * 1000` calculation.

## 5. Stress and failure drills

See `docs/measurements/stress-c-d-f.txt` for the raw summaries:

- **Test C — 40 simultaneous WebSocket connections (30 s).** 6 clients hold slots and stream
  input; 34 connect as spectators. Lobby stayed responsive (`GET /diagnostics` answered in
  2–3 ms at the end of the run), RTT p95 = 2 ms, jitter 0.08 ms, no dropped connections.
- **Test D — synthetic bad Wi-Fi.** The server can delay, jitter or stall the relay per team
  from `/diagnostics` or `scripts/stress.cjs --fault …`. Measured with 20 ms/5 ms jitter,
  100 ms/20 ms jitter, and a 3 s pause applied to a single team: RTT rises as injected while
  the other teams are unaffected; the paused team's kart goes neutral and its HUD shows
  RECONNECTING. Because the host keeps only the newest packet per team, delayed packets never
  queue — stale packets are counted and dropped (visible in the F3 overlay).
- **Test F — disconnect/reconnect.** `--disconnect-at 4` closes two controllers mid-race and
  reconnects them 0.5 s later; both reclaim a slot with a new `sessionId` while the race
  continues. The Playwright suite covers the same path with a real phone context, including
  reclaiming the *same team* via the stored token.
- **Test E — CPU/GPU stress.** Six viewports, six karts, items, effects and all six HUDs are
  on during every measurement in §2; the physics column is the cost of that full load.

## 6. Optimisations actually implemented

Each of these was added because the measurement or the profile pointed at it:

1. **One shared scene, six scissored viewports** instead of six worlds — geometry, textures
   and materials are built once; only the camera and viewport change per player.
2. **Shadow maps updated once per displayed frame** (`shadowMap.autoUpdate = false`,
   `needsUpdate = true` per frame) instead of once per `render()` call — a 6× reduction in
   shadow work that three.js would otherwise repeat for every viewport.
3. **Post-processing skipped in split mode.** The solo path keeps `EffectComposer` + bloom;
   the six-camera path renders directly with tone mapping. Six bloom passes are not worth
   their cost, and split-screen readability comes from HUD contrast, not glow.
4. **Fixed 60 Hz physics with an accumulator** (max 4 catch-up steps, debt dropped after a
   stall) — frame rate can never change physics correctness, and a debugger break or tab
   switch cannot explode the simulation.
5. **Latest-state input semantics** — one packet per team, older sequence numbers rejected,
   edge flags latched until consumed. A 100 ms-delayed phone cannot build a backlog.
6. **24-byte binary input frames** with `TCP_NODELAY` and `perMessageDeflate: false`, so
   realtime traffic is neither batched by the compressor nor delayed by Nagle.
7. **Batched relay log (500 ms)** instead of per-packet server annotations: full pipeline
   tracing without adding hot-path messages.
8. **Adaptive render scale.** `SplitScreen.observeFrame()` watches p95 frame time and steps
   the renderer pixel ratio down (2 → 1.5 → 1.25 → 1 → 0.85 → 0.7) when frames run long, and
   back up when there is headroom. The physics tick rate is never reduced.
9. **DOM diffing in the lobby** — lobby and session states are compared by signature, and
   only changed numbers (ping, battery) are patched in place, so the projector screen does
   not rebuild itself every second (and buttons do not detach under a mouse).
10. **1 Hz authoritative lobby heartbeat** so the host page converges on server truth even if
    a broadcast is missed — this is what makes the reconnect indicator reliable.
11. **Pong keepalive** every 5 s from the server so a phone that vanishes is detected in
    seconds rather than lingering as a "connected" ghost.

## 7. Re-measuring on the event laptop

```bash
npm start
node scripts/measure-host.cjs --clients 6 --duration 60 --tag event-laptop
```

It writes `docs/measurements/event-laptop.json` with frame/physics/render percentiles plus
the network summary. Acceptance for the venue: p95 frame ≤ 20 ms at 1920×1080 with six
viewports, physics p95 ≤ 4 ms, RTT p95 ≤ 30 ms. If frame time is short of that, the two
levers that matter are Camera = BROADCAST (≈5× cheaper, measured above) and a lower host
resolution (render scale adapts on its own).

## 8. Known limitations

- **No GPU numbers yet.** Every frame-time figure here comes from software rasterisation.
  Re-run §7 on the venue machine; do not quote the 1280×720 split figures as a GPU result.
- **Loopback network numbers.** RTT p50/p95 of 0–1 ms measures the software path only. Real
  Wi-Fi RTT must be read from the F3 overlay or `/diagnostics` with the phones on the room's
  access point.
- **Software latency ≠ physical latency.** Projector and display lag are outside anything a
  browser can measure; use the high-speed-camera procedure.
- **Input is digital on phones.** Steering is −1/0/+1 rather than an analogue stick, so
  keyboard steering ramps are not reproduced; holding a direction gives full lock.
- **No controller battery level on every browser.** `navigator.getBattery` is Chromium-only;
  other browsers show `--` and the rest of the slot UI is unaffected.
- **Input rate is fixed at 30 Hz per phone.** Higher rates (60 Hz) are supported by the
  protocol but not enabled; at typical Wi-Fi latency the extra packets do not change what
  the 60 Hz simulation can consume.
- **Adaptive quality only changes render resolution.** It does not yet drop shadows or
  particle density; those are the next levers if a venue machine needs them.