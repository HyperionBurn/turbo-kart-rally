# Turbo Kart Rally â€” Architecture Contract

A kart racer in the spirit of Mario Kart, built with **Three.js r170** as native ES modules (no build step).
`index.html` loads `src/main.js` through an import map (`three`, `three/addons/â€¦`, `qrcode-generator`).
The whole thing is served by the local event server:

```bash
npm install
npm start     # -> http://localhost:8081  (host), /controller (phones), /diagnostics
```

**Original IP only**: no Nintendo names, characters, logos, or assets. Everything is procedural
(geometry, textures via CanvasTexture, audio via WebAudio). No external asset files.

## Conventions (everyone must follow)

- 1 unit = 1 meter. **Y is up.** Track lies in the XZ plane (with gentle elevation allowed).
- Kart heading `h` (radians) is `object3D.rotation.y`. **Forward vector = (sin h, 0, cos h)**. Models face **+Z**.
- Driver's right vector = forward Ã— up = **(âˆ’cos h, 0, sin h)** (at h = 0 the kart faces +Z and its right side is âˆ’X).
  Turning right therefore means *decreasing* heading.
- `input.steer`: **+1 = turn toward driver's right**, âˆ’1 = left.
- Shared tuning lives in `src/config.js` (`PHYSICS`, `RACE`, `CHARACTERS`, `ITEMS`, `DIFFICULTY`, `KEYS`). Import; don't duplicate.
- Cross-system notifications go through `bus` from `src/events.js` (`bus.on(name, fn)`, `bus.emit(name, data)`).
- Only import `three` and `three/addons/...`. No other dependencies.
- Every module must be robust: no throwing in the frame loop; guard against missing optional fields.
- Dispose of anything you create when `dispose()` is called (race restart creates a fresh world).

## Module ownership

| File(s) | Owner | Exports |
|---|---|---|
| `src/track.js`, `src/environment.js` | Agent 1 â€” World | `createTrack(scene, renderer)` |
| `src/kart.js`, `src/ai.js`, `src/input.js` | Agent 2 â€” Driving | `Kart`, `resolveKartCollisions`, `AIDriver`, `InputController` |
| `src/items.js`, `src/effects.js` | Agent 3 â€” Items & FX | `ItemSystem`, `Effects` |
| `src/models.js`, `src/camera.js` | Agent 4 â€” Art & Camera | `createKartModel`, `createItemModel`, `ChaseCamera` |
| `src/main.js`, `src/race.js`, `src/hud.js`, `src/menu.js`, `src/audio.js`, `src/styles.css` | Agent 5 â€” Game & UI | game loop, `RaceManager`, `HUD`, `Menu`, `AudioEngine` |
| `src/multiplayer/*`, `controller/*`, `server/*`, `src/event/*` | Event mode | see Â§6 |

Do **not** edit files you don't own. If you need something from another module, code against this contract.

---

## 1. World â€” `src/track.js`

```js
export function createTrack(scene, renderer) // -> Track (adds everything to scene: road, walls, scenery, sky, lights, fog)
```
`Track` object:
| member | type | meaning |
|---|---|---|
| `name` | string | display name, e.g. "Sunset Bay Circuit" |
| `curve` | `THREE.CatmullRomCurve3` (closed) | road centerline (y = road height) |
| `length` | number | curve length (~1600â€“2200 units; lap â‰ˆ 45â€“60 s) |
| `roadWidth` | number | full paved width (~24) |
| `startPositions` | `Array<{position: Vector3, heading: number}>` length â‰¥ 8 | grid slots behind the start line; index 0 = pole |
| `itemBoxPositions` | `Vector3[]` | centre of each item box (rows of 4â€“6 across the road, 4+ rows) |
| `minimap` | `{ points: Array<{x,z}>, bounds: {minX,maxX,minZ,maxZ} }` | â‰¥ 200 centerline samples for HUD minimap |
| `getSurfaceInfo(pos: Vector3, hintT?: number)` | â†’ `{ height, normal: Vector3, surface, t, lateral, onRoad }` | `height` = ground Y under pos; `surface` âˆˆ `'road'|'offroad'|'boost'|'jump'`; `t` âˆˆ [0,1) progress along centerline (0 = start/finish line, increasing in race direction); `lateral` = signed distance from centerline (+ = right of race direction); `hintT` = previous t for fast local search |
| `resolveWall(pos: Vector3, radius: number)` | â†’ `null` or `{ normal: Vector3, depth: number }` | outer barrier collision; caller pushes pos by `normal*depth` and reflects velocity |
| `getPointAt(t)` / `getTangentAt(t)` | Vector3 | centerline point / unit forward direction at t |
| `getRacingLine(t)` | Vector3 | a good AI line point (cuts apexes); defaults to centerline |
| `update(dt, time)` | | animate water, flags, crowds, etc. |
| `dispose()` | | |

Surfaces: `boost` pads (dash panels, glowing chevrons) and `jump` ramps (kart gets upward launch) placed on the road.
Offroad (grass/sand) runs a few meters outside the road before the barrier.
The race direction at t=0 must match `startPositions[i].heading`.

## 2. Driving â€” `src/kart.js`, `src/ai.js`, `src/input.js`

```js
export class Kart {
  constructor({ scene, track, character /* CHARACTERS entry */, isPlayer, index /* 0..7 */, model /* from createKartModel */ })
  // state (read by others):
  object3D          // THREE.Group added to scene; contains model.root
  position          // Vector3 (== object3D.position)
  velocity          // Vector3
  heading           // radians
  speed             // signed forward speed (units/s)
  radius            // PHYSICS.kartRadius (Ã— 0.6 while shrunk)
  input             // { throttle 0..1, brake 0..1, steer -1..1, drift bool (held), item bool (pressed this frame), lookBack bool }
  isPlayer, character, index
  trackT            // last t from track.getSurfaceInfo
  surface           // current surface string
  airborne          // bool
  drifting, driftDir (-1|1), driftLevel (0..3), boostTimer, starTimer, shrinkTimer, spinTimer, invulnTimer
  item              // null | item id held (set by ItemSystem)
  itemCount         // for triple items
  controlsLocked    // bool â€” RaceManager sets true during countdown / after finish (AI keeps driving after finish)
  // race fields maintained by RaceManager: lap, place, finished, finishTime, raceProgress
  update(dt)
  applyHit(kind)     // 'spin' (banana), 'tumble' (shell/blue shell), 'shrink' (lightning); ignored while starTimer>0 or invulnTimer>0
  applyBoost(seconds, strength = 1)
  startStar(seconds)
  get forward()      // Vector3 unit
  reset(position, heading)
  dispose()
}
export function resolveKartCollisions(karts) // pairwise sphere push, weight-based; star kart spins non-star karts
```
Arcade feel requirements: snappy acceleration, drift by holding drift while steering (small hop on press),
3-level mini-turbo (blueâ†’orangeâ†’purple sparks) released as boost, boost pads, jump ramps with airtime,
offroad slowdown (ignored while boosting/star), wall bounce, slope following via `getSurfaceInfo().normal`,
start-line rocket boost (press throttle during last part of countdown â€” RaceManager emits `race:countdown`).
Kart calls `model.animate(...)` each frame (see Â§4).

Events the Kart must emit (on `bus`):
`kart:driftStart {kart}`, `kart:driftLevel {kart, level}`, `kart:driftEnd {kart}`, `kart:miniTurbo {kart, level}`,
`kart:boost {kart, source}`, `kart:hit {kart, kind}`, `kart:wallBump {kart, intensity}`, `kart:jump {kart}`, `kart:land {kart}`,
`kart:bump {a, b, intensity}`.

```js
export class AIDriver { constructor(kart, track, { difficulty /* key of DIFFICULTY */ }); update(dt, raceContext) }
// raceContext = { karts, player, itemSystem, time }. Sets kart.input each frame: follows track.getRacingLine with look-ahead,
// drifts on long corners, avoids item/banana hazards via itemSystem.getHazards(), uses items tactically
// (by setting input.item = true), rubber-bands relative to player's raceProgress, varied personalities.

export class InputController { constructor(); getInput() /* same shape as kart.input */; isPressed(action); consumePressed(action); dispose() }
// keyboard (KEYS in config) + Gamepad API. `item` is edge-triggered. Also exposes `pausePressed` via consumePressed('pause').
```

## 3. Items & FX â€” `src/items.js`, `src/effects.js`

```js
export class ItemSystem {
  constructor({ scene, track, karts })
  update(dt, time)          // item boxes (spin/bob, respawn after 2 s), projectiles, hazards, collisions with karts
  getHazards()              // Array<{ position: Vector3, radius, type }> for AI avoidance
  // Each frame, for every kart with kart.input.item === true and kart.item set -> use it.
  // Roulette: on box pickup, emit item:roulette and assign kart.item after ~1.5 s (player) / instantly-ish for AI,
  // weighted by kart.place (leaders get bananas/green shells; back gets stars/lightning/triple mushrooms; blue shell rare, never to 1st).
  // Holding a banana/shell behind the kart (drag) while input.item held is a nice-to-have.
  rouletteState(kart)       // { spinning: bool, displayItem } for HUD
  dispose()
}
```
Items: mushroom (boost), triple_mushroom, banana (spin hazard; can be thrown forward if steer/throttle up else dropped behind),
green_shell (straight, bounces off walls ~5 times, 8 s life), red_shell (homes on kart ahead following the track),
star (invincible, faster, rainbow), lightning (shrinks all opponents, spins them), blue_shell (seeks 1st place, big explosion).
Use `createItemModel(type)` from models.js for visuals. Emit `item:pickup {kart}`, `item:roulette {kart}`, `item:got {kart, item}`,
`item:use {kart, item}`, `item:hit {kart, item, by}`, `item:explode {position}`, `item:lightning {by}`.

```js
export class Effects {
  constructor(scene, camera)
  update(dt, karts)         // continuous: drift sparks per level colour, boost flames at exhaust, offroad dust, star sparkle, tire smoke
  burst(kind, position, opts) // 'explosion', 'confetti', 'itemBox', 'hitStars', 'splash', 'landingDust'
  dispose()
}
```
Effects subscribe to bus events themselves (kart:*, item:*). Pooled particles (InstancedMesh or Points), no per-frame allocations.
Exhaust / wheel positions come from `kart.object3D` + `model.anchors` (Â§4).

## 4. Art & Camera â€” `src/models.js`, `src/camera.js`

```js
export function createKartModel(character) // -> KartModel
KartModel = {
  root: THREE.Group,                      // faces +Z, origin at ground contact centre, ~2.4 long, ~1.6 wide
  anchors: { exhaustL, exhaustR, wheelRL, wheelRR, wheelFL, wheelFR, itemHold /* behind kart */ } // THREE.Object3D children of root
  animate({ dt, speed, steer, drifting, driftDir, boosting, airborne, spin /* 0..1 spin-out phase */, star /* bool */, time }),
  setShrunk(scale),                       // visual scale
  dispose()
}
export function createItemModel(type) // -> THREE.Object3D for 'item_box', 'banana', 'green_shell', 'red_shell', 'blue_shell', 'mushroom', 'star', 'lightning'
export function createCharacterPortrait(character) // -> dataURL string (canvas 128x128) for menus/HUD
```
Stylized, chunky, colourful, readable at speed: chassis, bumpers, spoiler, 4 wheels with rims & treads, steering wheel,
driver with head/eyes/hat per `character.hat`, animated body lean, wheel spin, suspension bob, steer angle.
MeshStandardMaterial / MeshToonMaterial, cast shadows.

```js
export class ChaseCamera {
  constructor(camera /* PerspectiveCamera */)
  update(dt, kart, { lookBack, mode /* 'race'|'countdown'|'finish'|'intro' */ })
  // Smooth spring follow, FOV widens with speed/boost, slight shake on hits/boost, drift offset,
  // intro flyover around the start grid during 'intro', orbiting shot on 'finish'.
  snap(kart)                // hard reset behind kart
}
```

## 5. Game & UI â€” `src/main.js`, `src/race.js`, `src/hud.js`, `src/menu.js`, `src/audio.js`, `src/styles.css`

Game flow: **Title â†’ Character select (8 racers, stats bars) â†’ Difficulty/laps â†’ Intro flyover â†’ Countdown 3-2-1-GO â†’ Race (3 laps) â†’ Results â†’ Restart/Menu**. Pause menu (Esc).

`main.js` owns renderer (antialias, ACES tone mapping, sRGB, PCF soft shadows), `PerspectiveCamera`,
post-processing (EffectComposer + UnrealBloomPass, subtle), resize handling, and the loop:

```
dt = min(clock.getDelta(), 1/30)
playerKart.input = controlsLocked ? neutral : inputController.getInput()
ai.update(dt, ctx) for each AI
kart.update(dt) for each kart
resolveKartCollisions(karts)
itemSystem.update(dt, time)
race.update(dt)
effects.update(dt, karts)
track.update(dt, time)
chaseCamera.update(dt, player, {...})
hud.update(dt, state)
audio.update(dt, { player, karts, camera })
composer.render()
```

`RaceManager`: grid placement from `track.startPositions` (player starts mid-pack), countdown (emits `race:countdown {n}` for 3,2,1 and `race:go`),
lap counting from `kart.trackT` wraps (must pass tâ‰ˆ0.5 checkpoint before a lap counts â€” no reverse cheating), `raceProgress = lap + t`,
places sorted by progress, `race:lap {kart, lap}`, `race:finalLap`, `race:finish {kart, place}`, `race:end` (when player finishes;
AI remaining get estimated times). Wrong-way detection for the player (`race:wrongWay {active}`).

`HUD` (DOM overlay in `#ui-root`): position (big "1st"â€¦"8th" with colour), lap counter, race timer + lap splits, item slot with
roulette animation, minimap (canvas) with all racers as coloured dots, speedometer, drift/boost indicators, countdown overlay,
"FINAL LAP!", "WRONG WAY", finish banner, results table.

`AudioEngine` (WebAudio, fully procedural): player engine (pitch/filter by speed), drift screech, mini-turbo, boost whoosh, item box,
roulette ticks, item use/hit/explosion, countdown beeps, lap/final-lap jingle, finish fanfare, catchy upbeat chiptune/synth background
music loop (and faster tempo on final lap). Unlock on first user gesture. Master volume + mute toggle (M key).

## Event catalogue (bus)
race:countdown {n} Â· race:go Â· race:lap {kart, lap} Â· race:finalLap Â· race:leader {kart, prev, teamId} Â· race:finish {kart, place} Â· race:end Â· race:wrongWay {active}
kart:driftStart Â· kart:driftLevel Â· kart:driftEnd Â· kart:miniTurbo Â· kart:boost Â· kart:hit Â· kart:wallBump Â· kart:jump Â· kart:land Â· kart:bump
item:pickup Â· item:roulette Â· item:got Â· item:use Â· item:hit Â· item:explode Â· item:lightning
game:state {state}  ('title'|'select'|'intro'|'countdown'|'racing'|'finished'|'paused')
gamepad:connected {index, id, type, label, mapping} · gamepad:disconnected {index, id}

---

# 6. Event mode (six-player party racer)

Event mode is additive: nothing in sections 1-5 changed behaviour for solo play. It adds a
phone-controller client, a local-network server, a second rendering path (one shared scene,
six scissored viewports) and a fixed-timestep simulation loop.

## 6.1 Topology

```
PHONE 1..6 â”€â”€Wi-Fi/LANâ”€â”€> LOCAL SERVER (server/server.js, port 8080) â”€â”€localhost WSâ”€â”€> HOST BROWSER
   /controller (browser)         rooms Â· relays Â· session authority        6 cameras Â· authoritative physics
                                diagnostics Â· fault injection
```

- **Phones send input, never positions.** Physics, collisions, items, laps, placement and
  results are computed only on the host machine.
- The server owns: room/slot assignment, reconnect tokens, race settings, points, and the
  session ledger. It never simulates a kart.
- The server is authoritative for lobby state; the host page mirrors it and sends control
  messages (`hostFlow`, `hostSettings`, `hostRemove`, `hostForceReady`, `hostReplaceAI`,
  `hostApplyResults`, `hostResetSession`).
- **Internet households:** the same server runs unchanged on Render (see `render.yaml` +
  `DEPLOY_RENDER.md`). The lobby's controller URL is derived per-connection from the
  `Host` header the host page arrived on — a public origin yields
  `https://<host>/controller` (wss is automatic on https), a LAN origin yields the LAN
  URL, and `localhost` never leaks into a QR. Each household deploys its own service,
  so one global room per deployment is all that's needed.

## 6.2 Modules

| File | Responsibility |
|---|---|
| `server/server.js` | HTTP static host + `/controller` + `/diagnostics` + `/debug/slots`; one WebSocket endpoint (`/ws`) that multiplexes roles (host / controller / spectator / diagnostics); six team slots; reconnect tokens; 1 Hz authoritative lobby heartbeat; batched relay log every 500 ms; per-team fault injection (delay / jitter / pause, optional auto-expiry); `hostResetSlots` for a fresh event without dropping connected phones; spectator counting; name-collision suffixing. Lobby state carries rules phones need (`pointsTable`, `raceIndex`, `laps`, `totalRaces`); host heartbeats additionally carry per-team `lastInputAgeMs`. Settings/points changes rebroadcast the lobby so phones never go stale. |
| `src/multiplayer/protocol.js` | 24-byte binary input frame (magic, type, teamId, sessionId, seq, f64 client timestamp, steer/throttle/brake bytes, flags). Encode/decode with zero allocation. |
| `src/multiplayer/latency.js` | `ClockSync` (NTP-style offset vs the server), `LinkStats` (RTT p50/p95/p99, jitter, rate, out-of-order, drops, reconnects), `qualityOf` thresholds. |
| `src/multiplayer/network-client.js` | Host-side socket. Applies **latest-state semantics**: one packet per team, older sequences rejected, edge flags latched until consumed. Queue-and-replay on reconnect. |
| `controller/index.html/.css/.js` | Landscape phone controller: Pointer Events only, multi-touch per control, haptics via `navigator.vibrate`, battery reporting, token persistence for auto-reclaim, 30 Hz input + immediate button edges. A persistent connection bar (idle/connecting/connected/reconnecting/offline) is visible on every screen; link quality is shown as EXCELLENT/OK/LAGGY words, not just milliseconds. Character select shows stat bars + a detail strip with flavor tags. The controller holds a screen wake lock while racing, flashes its own countdown/GO overlay with haptics, shows held-item state on the ITEM button, and shows the player's own place, points and a top-6 board on the results screen. Left/right-handed pad mirror and haptics/sound toggles persist in localStorage. |
| `src/event/splitscreen.js` | Six `PerspectiveCamera`s + `ChaseCamera`s over one scene; layouts for 1-6 players; `setViewport`/`setScissor`/`setScissorTest` rendering; adaptive pixel-ratio tiers driven by measured p95 frame time. |
| `src/event/split-hud.js` | Compact per-viewport HUD: team chip, place (gold for P1, flash on change), lap + FINAL badge, item pill, speed bar, reconnect/AI/wrong-way warnings. Viewport-scaled type, cached refs with change-detection (no per-frame DOM queries). |
| `src/event/event-ui.js` | Host overlays: lobby (300px QR + URL + 3-step host guide + slots + host controls, START disabled until ≥1 team connects, ready progress + per-slot phone hints), settings (speed classes, points preview, race count), prerace (live per-team status, grid + controls reminder), results with points (medals, staggered reveal, gaps to winner), session leaderboard with count-up (biggest-climb + most-wins callouts, champion banner). Diffs lobby/session signatures so DOM is not rebuilt on every heartbeat. A slim session ticker (race x of y, laps, tournament leader) persists across racing flows. |
| `src/main.js` | Fixed 60 Hz simulation accumulator, event-mode state machine, AI takeover on disconnect, F3 latency overlay, diagnostics probe. |

## 6.3 Simulation and rendering

```
accumulator += min(frameDelta, 0.1)
while accumulator >= 1/60 and steps < 4:  simulate(1/60);  accumulator -= 1/60
if steps == 4: accumulator = 0          # never spiral after a tab stall
render once per animation frame
```

Input is sampled inside the simulation step (network state is pulled per team), so rendering
speed can never change physics correctness. Six viewports render the **same** scene with
`shadowMap.autoUpdate = false` refreshed once per displayed frame; bloom/postprocessing are
skipped in split mode.

## 6.4 Event flow

`title -> lobby(+QR) -> settings -> prerace -> countdown -> racing -> results -> leaderboard -> next race`

`eventPhase` in `src/main.js` drives the UI and the controller screens; the same value is
mirrored to phones as `lobby.state.flow` so a phone switches between the join pad, the race
pad and the results screen without polling.

Points default to `[10, 8, 6, 4, 2, 1]` and accumulate in `session.scores` for the whole
event session (`server/session-state.json` survives a server restart; only a lobby/settings/
leaderboard state is restored, never an in-flight race).

## 6.5 Resilience

- **Disconnect:** the kart keeps its last input for one tick then goes neutral; the slot
  shows RECONNECTING; after 15 s the host converts the slot to AI (`syncDrivers()`), and
  `Kart.controlsLocked` is untouched so a returning human resumes instantly.
- **Reconnect:** the phone stores its token in `localStorage`; on reload it rejoins
  automatically and reclaims the same team (new `sessionId`, so stale packets from the old
  socket are rejected).
- **One bad client:** inputs are per-team maps, so a stalled phone cannot queue or block
  other racers. The server drops packets for teams under an injected pause fault.
- **Host refresh:** the host socket reconnects automatically and the lobby/leaderboard is
  restored from the server.
- **Subsystem isolation:** every frame-loop call is wrapped by `safe()`; a failing optional
  subsystem (audio, items, effects, HUD) is logged once and skipped.

## 6.6 Diagnostics

- Host overlay: **F3** shows FPS, frame time, physics ms, render ms, long frames, update
  rate, stale inputs, per-team RTT/p95/jitter, and the software input->applied latency.
- `http://localhost:8081/diagnostics`: room-wide link table plus fault injection buttons
  (20/50/100 ms delay, jitter, 3 s pause per team or all).
- `window.__game` hooks used by the test harnesses: `eventDebug()`, `netStats()`,
  `probeData()`, `enableProbe()`, `simulateFor(seconds)`, `skipEventCountdown()`, `send(msg)`.
- Latency figures reported by the game are **software** numbers (input event -> applied ->
  frame submitted). Physical input-to-photon must be measured with a high-speed camera;
  see `EVENT_RUNBOOK.md` Â§5.

## 6.7 Tests

```bash
npm test                                                   # Playwright: full event flow, reconnect, host controls, solo regression
node scripts/stress.cjs --clients 6  --duration 30 --as-host   # Test A: six controllers
node scripts/stress.cjs --clients 6  --duration 15 --frantic --as-host  # Test B: frantic input
node scripts/stress.cjs --clients 40 --duration 30 --as-host            # Test C: 40 connections
node scripts/stress.cjs --clients 6  --duration 20 --fault delay:100,jitter:20 --as-host  # Test D: bad Wi-Fi
node scripts/stress.cjs --clients 2  --duration 10 --disconnect-at 4    # Test F: reconnect
node scripts/measure-host.cjs --clients 6 --duration 30 --tag six-normal # perf + latency capture
```
