# Turbo Kart Rally â€” Event Runbook

A 10-minute checklist for running a six-team party race in a room full of students,
plus the emergency moves for when something goes wrong on stage.

## 0. Before you leave home (5 minutes)

```bash
npm install
npm test          # 5 browser tests, ~2 minutes â€” proves your machine is healthy
```

## 1. Room setup (10 minutes before the event)

1. **Laptop â†’ projector.** Plug in HDMI/USB-C, set the display to *extend* (not mirror),
   and set the projector/TV input to the laptop's resolution (1920Ã—1080 recommended).
2. **Laptop â†’ dedicated router/AP.** Use a phone hotspot or a spare router, *not* the
   university Wi-Fi. 5 GHz if available. Put the router on the same desk, antenna up.
3. **Kill the noise.** Close Slack, IDEs, video calls, and Windows Defender real-time
   scanning if the machine is slow. Set the laptop to *Best performance* power mode.
4. **Full-screen the browser** (F11) once the game is running.

## 2. Start (1 minute)

```bash
npm start
```

The terminal prints:

```
HOST:        http://localhost:8081
LAN:         http://192.168.x.x:8080
Controllers: http://<LAN-IP>:8080/controller
Diagnostics: http://localhost:8081/diagnostics
```

- Open **HOST** on the laptop and press **F11** (full screen).
- Open **Diagnostics** on the laptop in a second tab (keep it minimised; you need it
  for the health check).
- If `LAN:` is missing, the laptop has no second network interface â€” plug in a USB
  Ethernet adapter or use a phone hotspot, then restart `npm start`.

## 3. Health check (60 seconds â€” do this every time)

1. Host page â†’ **EVENT MODE**. The lobby shows a QR code and 6 team slots.
2. Scan the QR with **one** phone. Confirm:
   - the phone lands on the lobby screen (no app install),
   - that team slot turns green/connected on the projector,
   - the phone shows a ping number (`--` becomes a number within 2 s).
3. On **Diagnostics**: `RTT p50 â‰¤ 15 ms`, `p95 â‰¤ 30 ms`, jitter `â‰¤ 10 ms` for that team.
   If not, move the router or reduce distance before continuing.
4. Start a race with the one phone, hold GAS for 3 seconds: the kart must move on the
   projector. Timing here is the whole product â€” if it feels laggy, stop and fix it.
5. Kill the phone's Wi-Fi for 5 seconds: the slot shows **âš  RECONNECTING**, the kart
   coasts, then the slot returns to the same team when Wi-Fi comes back.

If any of these fail, run `node scripts/stress.cjs --clients 6 --duration 15 --as-host`
and read the summary â€” it prints RTT p50/p95/p99 and jitter for the whole room.

## 4. Run the event

1. Title screen â†’ **EVENT MODE**.
2. Six phones scan the QR code (they are already in a browser camera; scanning is instant).
3. Each phone types a team name, taps a racer, taps **READY**.
   - Duplicate racers are refused: a taken character goes grey on every other phone.
4. **CONTINUE â†’ SETTINGS** on the host: laps (default 3), difficulty, items, AI fill,
   race speed, camera mode (3Ã—2 split is the default; broadcast = one cinematic camera),
   duplicate racers.
5. **START RACE** â†’ prerace flyover â†’ 3-2-1-GO.
6. After the race: results â†’ points â†’ leaderboard â†’ **NEXT RACE**.
   Points default to 10/8/6/4/2/1 and accumulate for the whole session.
7. **RESET TOURNAMENT** on the leaderboard only when you want a clean slate.

## 5. Manual latency check (optional, 5 minutes, needs a high-speed camera)

This is the only way to measure *physical* input-to-photon latency; software cannot see
the projector's lag.

1. Host page â†’ press **F3** for the diagnostics overlay.
2. On each phone the press of any button changes a large area of the screen instantly.
3. The moment the host applies that input, that team's viewport border flashes and its
   sequence number appears in the F3 overlay.
4. Record phone + projector with a camera at â‰¥120 fps (240 fps preferred), then count the
   frames between the finger press and the projected flash:

```
latency_ms = frame_difference / camera_fps * 1000

example: 8 frames at 240 fps  ->  8 / 240 * 1000  =  33.3 ms
```

A healthy local Wi-Fi setup should land around 30â€“70 ms end to end (this includes the
projector's own internal lag, typically 20â€“40 ms on consumer projectors).

## Emergency fallbacks

| Situation | What to do |
| --- | --- |
| **University Wi-Fi is bad** | Stop. Use a phone hotspot or a dedicated router. Repeat the health check. Wi-Fi with client isolation blocks phone â†’ laptop traffic completely. |
| **A player disconnects** | Nothing. Their kart coasts, the slot shows âš  RECONNECTING, and after 15 s the host switches it to AI. If they come back, the same phone reclaims the same team automatically. |
| **A phone will not join** | Have them scan the QR again. If the browser cached an old lobby, have them open `http://<LAN-IP>:8080/controller` directly. Check the host screen: 6 slots exist â€” if a slot is stuck "connected" but the phone is dead, press **REMOVE** on that slot. |
| **Fewer than six teams** | Just press START RACE. Empty slots are filled by AI (or set AI Fill = 2 for eight racers). |
| **More than six teams** | The 7th+ phones join as spectators and see the standings on their own screen. Split two teams for a second round, or run a second race. |
| **Projector performance is bad** | Press **F3** and read the frame time. Set Camera = **BROADCAST** (single cinematic camera) and re-run the race â€” it is ~5Ã— cheaper. Split screen also auto-drops render resolution under load. |
| **Server restarted** | Everything is lost except the session file, which only keeps lobby/settings/leaderboard. Restart `npm start`, reopen the host page, phones re-join by scanning again. |
| **Host browser refreshed** | The host page reconnects to the server automatically and the lobby/leaderboard is restored from the server. |
| **Laptop is on battery / thermal throttling** | Plug in power and set the OS to best-performance mode. |

## Operating tips

- Announce the rules once, loudly: *hold GAS, tap DRIFT in corners, tap ITEM when you
  have something.* Six teams learn by racing, not by reading.
- Keep races to **3 laps**. Six karts on one track finishes in about 4 minutes, which is
  the right rhythm for a room of students.
- After the leaderboard, let the crowd cheer before the next race â€” the count-up
  animation on the totals is the moment people remember.