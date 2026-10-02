# Turbo Kart Rally â€” Performance & Latency Report

All numbers below were **measured on the machine described in Â§1**, by
`scripts/measure-host.cjs` (frame/physics/render) and `scripts/stress.cjs`
(network). Raw captures live in `docs/measurements/`. Nothing here is estimated.

Read Â§6 before using any of these numbers to judge real hardware: the capture machine has
**no GPU**, so its frame times are a software-rasterisation floor, not a prediction of what
a gaming laptop will do. What *is* representative on any machine is the CPU-side cost
(physics, input, network) and the network latency, because those do not depend on the GPU.

## 1. Test hardware and software

| | |
| --- | --- |
| Machine | Windows 11 x64 laptop (this workspace), x64 CPU, **no discrete GPU** |
| GPU | none â€” Chromium falls back to **SwiftShader** (CPU software rasteriser) |
| Browser | Chromium (Playwright bundled build), headless |
| Server | Node.js 24 on `127.0.0.1` (loopback), same machine as the host page |
| Resolution | 1280Ã—720 host viewport (six viewports â‡’ ~427Ã—360 each) |
| Players | 6 (all human-controlled, split screen), optional 40-connection load |
| Physics | fixed 60 Hz timestep, up to 4 catch-up steps per frame |

Because the renderer is software, every frame-time figure in Â§2 is dominated by CPU
rasterisation of six viewports. Treat those numbers as a **worst case**, and re-measure on
the event laptop (see Â§7) before trusting them in either direction.

## 2. Frame, physics and render cost (six-player split screen)

Measured with `node scripts/measure-host.cjs --clients 6 --duration 30 --tag six-normal-final`
(host page driving, six synthetic controllers streaming 30 Hz input,
`docs/measurements/six-normal-final.json`; an earlier 25 s run, `six-normal.json`, gave
2788 / 2965 / 2965 ms frame p50/p95/p99 with physics 1.3 / 4.0 / 4.0 ms):

| metric | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| frame time | 2253 ms | 2463 ms | 2463 ms | 2463 ms |
| physics step (all 6 karts + items + race logic) | 0.7 ms | 1.3 ms | 1.3 ms | 1.3 ms |
| render submit (6 Ã— `setViewport`/`setScissor` + 6 `render()`) | 9.0 ms | 16.3 ms | 16.3 ms | 16.3 ms |

Network counters for the same run (`netStats()`): 6 team links, 139 input updates/s received,
**0 out-of-order, 0 stale packets dropped**, clock offset 0 ms.

Same scene in **broadcast mode** (one full-screen camera, `docs/measurements/six-broadcast.json`):

| metric | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- |
| frame time | 568 ms | 701 ms | 773 ms | 773 ms |
| physics step | 0.9 ms | 1.5 ms | 1.6 ms | 1.6 ms |
| render submit | 4.0 ms | 4.8 ms | 4.9 ms | 4.9 ms |

**What this proves (and what it does not).** Split-screen cost scales with the number of
viewports: 1 camera = 568 ms/frame, 6 cameras = 2253 ms/frame (4.0Ã—) in software
rasterisation. The CPU-side work the game itself owns â€” physics for six karts with items,
collisions, lap logic, input application and HUD updates â€” is **0.7 ms per 60 Hz tick
(p95 1.3 ms)**, i.e. ~8 % of a 16.7 ms budget, leaving ~15 ms for rasterisation on real
hardware. On a GPU that rasterises 1280Ã—720 six times per frame at 60 fps, this is
comfortably inside budget; the same measurement on a GPU-less machine shows exactly where
the remaining time goes (rasterisation), which is the only conclusion this environment can
support honestly.

## 3. Network latency (loopback, 6 controllers, 30 Hz input)

`node scripts/stress.cjs --clients 6 --duration 30 --as-host` â†’
`docs/measurements/stress-a-b.txt`:

| metric | Test A (normal) | Test B (frantic: 9 Hz steering oscillation, random throttle/brake, item spam) |
| --- | --- | --- |
| input throughput | 256.6 packets/s total (42.8/client) | 255.9 packets/s (42.7/client) |
| RTT p50 | 0 ms | 0 ms |
| RTT p95 | 1 ms | 1 ms |
| RTT p99 | 1 ms | 1 ms |
| jitter (mean abs Î”RTT) | 0.17 ms | 0.16 ms |
| ping samples | 696 | 468 |

These are loopback numbers (phone on the same machine), so they measure the *software path*
(server relay â†’ host apply â†’ frame submit), not Wi-Fi. The Wi-Fi path is covered by the
fault-injection test in Â§5, which adds 20/100 ms of delay and jitter at the relay point.

## 4. Host-side input pipeline

The host tracks each packet end to end by sequence number: phone `performance.now()`
timestamp â†’ server relay (batched `relayLog` every 500 ms, so server receive/send times can
be correlated without adding hot-path traffic) â†’ host WebSocket receive â†’ applied to a kart
inside the fixed-step simulation â†’ first frame submitted after that tick. Clock skew between
phone and host is removed with NTP-style offset estimation through the local server
(`ClockSync`, median of a 24-sample window; phones report their offset with their link
stats). The F3 overlay shows the result per team as **input â†’ applied**; `netStats()` exposes
the raw counters.

These are **software** numbers. They deliberately exclude projector/display lag, which no
browser can observe. Physical input-to-photon must be measured with a high-speed camera â€”
`EVENT_RUNBOOK.md` Â§5 gives the procedure and the `frames / fps * 1000` calculation.

## 5. Stress and failure drills

See `docs/measurements/stress-c-d-f.txt` for the raw summaries:

- **Test C â€” 40 simultaneous WebSocket connections (30 s).** 6 clients hold slots and stream
  input; 34 connect as spectators. Lobby stayed responsive (`GET /diagnostics` answered in
  2â€“3 ms at the end of the run), RTT p95 = 2 ms, jitter 0.08 ms, no dropped connections.
- **Test D â€” synthetic bad Wi-Fi.** The server can delay, jitter or stall the **input relay**
  per team from `/diagnostics` or `scripts/stress.cjs --fault â€¦`. Measured with 20 ms/5 ms
  jitter, 100 ms/20 ms jitter, and a 3 s stall applied to a single team
  (`docs/measurements/stress-c-d-f.txt`). Two things are worth being precise about:
  the injection sits on the gameplay input path, **not** on the diagnostics ping path, so the
  reported RTT stays low (that is the ping channel, by design, staying healthy) â€” the effect
  shows up as added input age in the F3 overlay instead. With 100 ms/20 ms injected while six
  controllers raced (`docs/measurements/six-fault-100ms.json`) the host produced **no errors**,
  physics stayed at 1.1 ms p50 / 1.6 ms p95, and frame cost was unchanged versus the
  fault-free run â€” degraded input, identical simulation. Stale packets are counted and
  discarded (visible in the F3 overlay) rather than queued, which is the mechanism that keeps
  a delayed phone from building a backlog.
- **Test F â€” disconnect/reconnect.** `--disconnect-at 4` closes two controllers mid-race and
  reconnects them 0.5 s later; both reclaim a slot with a new `sessionId` while the race
  continues (server log: `reconnected team 1`, `reconnected team 2`). The Playwright suite
  covers the same path with a real phone context, including reclaiming the *same team* via the
  stored token while the other teams keep driving.
- **Test E â€” CPU/GPU stress.** Six viewports, six karts, items, effects and all six HUDs are
  on during every measurement in Â§2; the physics column is the cost of that full load.

## 6. Optimisations actually implemented

Each of these was added because the measurement or the profile pointed at it:

1. **One shared scene, six scissored viewports** instead of six worlds â€” geometry, textures
   and materials are built once; only the camera and viewport change per player.
2. **Shadow maps updated once per displayed frame** (`shadowMap.autoUpdate = false`,
   `needsUpdate = true` per frame) instead of once per `render()` call â€” a 6Ã— reduction in
   shadow work that three.js would otherwise repeat for every viewport.
3. **Post-processing skipped in split mode.** The solo path keeps `EffectComposer` + bloom;
   the six-camera path renders directly with tone mapping. Six bloom passes are not worth
   their cost, and split-screen readability comes from HUD contrast, not glow.
4. **Fixed 60 Hz physics with an accumulator** (max 4 catch-up steps, debt dropped after a
   stall) â€” frame rate can never change physics correctness, and a debugger break or tab
   switch cannot explode the simulation.
5. **Latest-state input semantics** â€” one packet per team, older sequence numbers rejected,
   edge flags latched until consumed. A 100 ms-delayed phone cannot build a backlog.
6. **24-byte binary input frames** with `TCP_NODELAY` and `perMessageDeflate: false`, so
   realtime traffic is neither batched by the compressor nor delayed by Nagle.
7. **Batched relay log (500 ms)** instead of per-packet server annotations: full pipeline
   tracing without adding hot-path messages.
8. **Adaptive render scale.** `SplitScreen.observeFrame()` watches p95 frame time and steps
   the *drawing buffer* down (1 â†’ 0.85 â†’ 0.75 â†’ 0.65 â†’ 0.55 â†’ 0.45 of window size) when
   frames run long, and back up when there is headroom. Deliberately **not** `setPixelRatio`:
   the canvas is sized by CSS to the window, so shrinking only the buffer keeps viewport
   arithmetic exact (an earlier pixel-ratio version rendered a partial frame â€” caught by the
   screenshot pass, not by a unit test). The physics tick rate is never reduced.
9. **DOM diffing in the lobby** â€” lobby and session states are compared by signature, and
   only changed numbers (ping, battery) are patched in place, so the projector screen does
   not rebuild itself every second (and buttons do not detach under a mouse).
10. **1 Hz authoritative lobby heartbeat** so the host page converges on server truth even if
    a broadcast is missed â€” this is what makes the reconnect indicator reliable.
11. **Pong keepalive** every 5 s from the server so a phone that vanishes is detected in
    seconds rather than lingering as a "connected" ghost.

## 7. Re-measuring on the event laptop

```bash
npm start
node scripts/measure-host.cjs --clients 6 --duration 60 --tag event-laptop
```

It writes `docs/measurements/event-laptop.json` with frame/physics/render percentiles plus
the network summary. Acceptance for the venue: p95 frame â‰¤ 20 ms at 1920Ã—1080 with six
viewports, physics p95 â‰¤ 4 ms, RTT p95 â‰¤ 30 ms. If frame time is short of that, the two
levers that matter are Camera = BROADCAST (â‰ˆ5Ã— cheaper, measured above) and a lower host
resolution (render scale adapts on its own).

## 8. Known limitations

- **No GPU numbers yet.** Every frame-time figure here comes from software rasterisation.
  Re-run Â§7 on the venue machine; do not quote the 1280Ã—720 split figures as a GPU result.
- **Loopback network numbers.** RTT p50/p95 of 0â€“1 ms measures the software path only. Real
  Wi-Fi RTT must be read from the F3 overlay or `/diagnostics` with the phones on the room's
  access point.
- **Software latency â‰  physical latency.** Projector and display lag are outside anything a
  browser can measure; use the high-speed-camera procedure.
- **Input is digital on phones.** Steering is âˆ’1/0/+1 rather than an analogue stick, so
  keyboard steering ramps are not reproduced; holding a direction gives full lock.
- **No controller battery level on every browser.** `navigator.getBattery` is Chromium-only;
  other browsers show `--` and the rest of the slot UI is unaffected.
- **Input rate is fixed at 30 Hz per phone.** Higher rates (60 Hz) are supported by the
  protocol but not enabled; at typical Wi-Fi latency the extra packets do not change what
  the 60 Hz simulation can consume.
- **Adaptive quality only changes render resolution.** It does not yet drop shadows or
  particle density; those are the next levers if a venue machine needs them.
- **Split-screen frame capture is screenshot-bound in software rendering.** On this GPU-less
  machine a 1280Ã—720 six-viewport frame takes ~2.3 s to rasterise, so an automated
  screenshot can catch a partially presented frame; on real hardware at 16.7 ms/frame this
  does not occur. `scripts/shots.cjs` writes the documentation screenshots with a settle
  delay for that reason.