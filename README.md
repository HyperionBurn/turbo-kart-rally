# Turbo Kart Rally

**An arcade kart racer in the spirit of Mario Kart, built entirely with Three.js. Every mesh, texture, sound effect and music track is generated in code at load time. There are no asset files and no build step.**

**Now also a six-player party racer.** Run one command, project it on a wall, and six teams
scan a QR code with their phones and race each other on a true 3×2 split screen — no app,
no install, no accounts. See [`EVENT_RUNBOOK.md`](EVENT_RUNBOOK.md) for the event-day checklist.

```bash
npm install
npm start
```

```
HOST:        http://localhost:8080
LAN:         http://192.168.x.x:8080      <- phones scan the QR code on screen
Diagnostics: http://localhost:8080/diagnostics
```

<p align="center">
  <a href="https://bridge-mind.github.io/turbo-kart-rally/"><img src="docs/screenshots/title.jpg" alt="Turbo Kart Rally title screen" width="800"></a>
</p>

<p align="center">
  <a href="https://bridge-mind.github.io/turbo-kart-rally/"><strong>▶ Play the solo game in your browser</strong></a>
</p>

## Two modes

**Solo mode** (original game, unchanged): pick a racer, class and lap count, race seven AI
drivers. Keyboard or gamepad.

**Event mode** (six players on one laptop):

```text
title → EVENT MODE → lobby with QR + room code → six phones join, pick racers, READY
      → race settings → prerace flyover → 3-2-1-GO → 3×2 split-screen race
      → results → event points → session leaderboard → next race / rematch
```

- Six human-controlled teams, each with its own name, colour, racer and ready state.
- Phones are controllers only. Physics, collisions, items, laps and results are simulated
  authoritatively on the host machine; phones send 24-byte input packets at 30 Hz.
- Disconnects degrade gracefully: the kart coasts, the slot shows RECONNECTING, the host can
  hand the slot to AI after 15 s, and the same phone reclaims its team automatically when it
  comes back — mid-race, without restarting.
- Points accumulate across races for the whole session; the leaderboard animates the totals.

## Controls

Solo: keyboard or gamepad as before (see the table further down).
Phones: landscape pad — left/right steer, GAS, BRAKE, DRIFT, ITEM, LOOK.

## Play (solo, online)

Open **https://bridge-mind.github.io/turbo-kart-rally/** in a desktop browser with WebGL2.
Click or press Enter, choose one of eight racers, pick a class and lap count, hit RACE!.

Race seven AI drivers around Palm Cove Circuit. Drift through corners and release for a mini-turbo. Grab item boxes and fire shells, drop bananas, pop mushrooms, or call down lightning on the field.

## The prompt that built this

This is the complete, verbatim prompt given to Claude Code. Nothing else was specified.

> I need you to launch five opus 5.5 sub-agents and help me build a triple A quality game that is a clone of Mario Kart. What I want you to do is I want you to launch these sub-agents, build the game without asking me any questions at all, and use 3JS to build the game. And once you're done, report back to me.

## How it was built

The orchestrating agent wrote an architecture contract first ([ARCHITECTURE.md](ARCHITECTURE.md)), plus the shared config and event bus, then launched five sub-agents that each owned one slice of the codebase. No sub-agent edited another's files. Each one tested its slice in a real browser against stubs, and the game and UI agent then integrated and play-tested the whole thing.

| Agent | Owns | Delivers |
| --- | --- | --- |
| 1 · World | `track.js`, `environment.js`, `track-textures.js` | Procedural circuit, barriers, boost pads, jump ramps, water, sky, scenery, grandstands, lighting |
| 2 · Driving | `kart.js`, `ai.js`, `input.js` | Arcade kart physics, drift and mini-turbo, AI drivers, keyboard and gamepad input |
| 3 · Items and FX | `items.js`, `effects.js` | Item boxes, roulette and eight items, pooled particle effects |
| 4 · Art and camera | `models.js`, `camera.js` | Karts, drivers, item models, portraits, chase camera |
| 5 · Game and UI | `main.js`, `race.js`, `hud.js`, `menu.js`, `audio.js`, `styles.css` | Game loop, race manager, HUD, menus, results, procedural audio and music |

`src/config.js` (roster, physics tuning, items, difficulty, key bindings) and `src/events.js` (the event bus) were written before the sub-agents started.

## Features

- **Eight racers**, each with their own hat, look and stats for speed, acceleration, handling and weight: Blaze, Zippy, Bella, Toadly, Rex, Grumbo, Koopz and Dotty.
- **Palm Cove Circuit**, about 2.1 km, with a long start straight, sweepers, an S-bend, a bridge over a lagoon, a hairpin, 8 boost pads, 2 jump ramps and 30 item boxes.
- **Arcade handling** with hop, drift, three-stage mini-turbo, a rocket start, trick boosts off ramps, off-road slowdown, wall bumps and kart-to-kart collisions resolved by weight.
- **Eight items**: mushroom, triple mushroom, banana, green shell, homing red shell, star, lightning and blue shell. Item odds are weighted by race position.
- **AI drivers** that follow a racing line, drift on corners, dodge hazards, use items tactically and rubber-band toward the player.
- **Fully synthesised audio**: engine, drift and item sounds, and a sequenced chiptune soundtrack with separate menu and race music that speeds up on the final lap.
- **Effects**: pooled drift sparks, boost flames, dust, star sparkles, explosions, confetti and speed lines, with bloom.
- **Presentation**: live demo race behind the title screen, intro flyover, 3-2-1-GO with start lights, position and lap HUD, item roulette, minimap, speedometer, final-lap and wrong-way banners, results screen.

## Controls

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Accelerate | W or Up | A or right trigger |
| Brake / reverse | S or Down | B or left trigger |
| Steer | A and D, or Left and Right | Left stick |
| Hop / drift | Space | RB or X |
| Use item | E, X or Left Shift | LB or Y |
| Look back | C | Click either stick |
| Pause | Esc or P | Start |
| Mute | M | |

Hold drift through a corner. Sparks turn blue, then orange, then purple. Release for a bigger boost the longer you held it. Hold accelerate as the countdown reaches GO for a rocket start.

## Run it locally

```bash
git clone https://github.com/bridge-mind/turbo-kart-rally.git
cd turbo-kart-rally
npm install       # three.js (vendored locally), ws, playwright for tests
npm start         # host + controllers + diagnostics on one port
```

Then open **http://localhost:8080**. Three.js r170 is served from `node_modules` through an
import map, so no internet connection is needed at the venue. The terminal prints the
localhost URL, every LAN URL it can find, and the diagnostics URL.

Any other static server also works for solo play (`python3 -m http.server 8080`); the
phone-controller features need `npm start`.

## Tests and diagnostics

```bash
npm test                              # Playwright: full event flow, reconnect, host controls, solo regression
node scripts/stress.cjs --clients 40 --duration 30 --as-host   # 40 WebSocket clients vs the lobby
node scripts/measure-host.cjs --clients 6 --duration 30 --tag six-normal   # frame/physics/render/latency capture
```

Press **F3** on the host page for the live latency overlay (FPS, frame time, physics,
render, per-team RTT/p95/jitter, stale inputs). `http://localhost:8080/diagnostics` shows the
room-wide link table and fault-injection controls. Measured numbers live in
[`PERFORMANCE.md`](PERFORMANCE.md).

## Project layout

```
turbo-kart-rally/
├── index.html            entry page and import map
├── ARCHITECTURE.md       module contract + event-mode design (section 6)
├── EVENT_RUNBOOK.md      event-day setup checklist and emergency fallbacks
├── PERFORMANCE.md        measured frame/render/latency numbers and limits
├── server/
│   └── server.js         static host + controller/host WebSockets, rooms, sessions, diagnostics
├── controller/
│   ├── index.html        phone controller (join, racer select, ready, race pad)
│   ├── controller.js     pointer-event input, 30 Hz packets, reconnect token
│   └── controller.css    landscape layout
├── diagnostics/
│   └── index.html        room-wide link table + fault injection
├── src/
│   ├── main.js           renderer, post-processing, state machine, fixed-step loop, event mode
│   ├── config.js         roster, physics tuning, items, difficulty, key bindings
│   ├── events.js         shared event bus
│   ├── track.js          circuit, surfaces, walls, racing line
│   ├── environment.js    sky, lights, water, terrain, scenery
│   ├── kart.js           kart physics
│   ├── ai.js             AI drivers
│   ├── input.js          keyboard and gamepad
│   ├── items.js          item boxes, roulette, items
│   ├── effects.js        particles and bursts
│   ├── models.js         karts, drivers, item models, portraits
│   ├── camera.js         chase camera
│   ├── race.js           laps, positions, countdown, finish
│   ├── hud.js            in-race HUD and results
│   ├── menu.js           title, character select, pause
│   ├── audio.js          Web Audio sound and music
│   ├── styles.css        UI styling
│   ├── multiplayer/
│   │   ├── protocol.js       24-byte binary input frame
│   │   ├── latency.js        clock sync, RTT/jitter statistics
│   │   └── network-client.js host socket, latest-state semantics
│   └── event/
│       ├── splitscreen.js    six scissored viewports, adaptive quality
│       ├── split-hud.js      compact per-viewport HUD
│       └── event-ui.js       lobby / settings / prerace / results / leaderboard
├── scripts/              stress, measurement and manual end-to-end harnesses
├── tests/                Playwright suite (event flow, reconnect, solo regression)
├── docs/measurements/    raw JSON captured by scripts/measure-host.cjs
├── dev/                  per-module test harnesses from the original build
└── docs/screenshots/     images used in this README
```

Open `window.__game` in the browser console for debug hooks such as `startRace()`,
`toFinalLap()`, `finishPlayer()` and `debug.autopilot = true`. In event mode you also get
`eventDebug()`, `netStats()`, `probeData()`, `simulateFor(seconds)`, `skipEventCountdown()`
and `send(msg)` for the local server.

## Screenshots

| | |
| --- | --- |
| ![Character select](docs/screenshots/character-select.jpg) | ![Racing](docs/screenshots/race.jpg) |
| ![Items and grandstands](docs/screenshots/items.jpg) | ![Results](docs/screenshots/results.jpg) |

## Disclaimer

Turbo Kart Rally is an original, fan-made homage to the kart-racing genre. It is not affiliated with, endorsed by, or associated with Nintendo. All characters, circuits, names, art, music and code in this repository are original.

## License

[MIT](LICENSE) © 2026 BridgeMind
