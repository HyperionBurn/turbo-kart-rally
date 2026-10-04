# Playing over the internet (every household)

The same codebase runs both ways with zero code changes:

- **Same Wi-Fi (party mode):** `npm start` on the laptop, phones scan the QR.
  Lowest latency, works with no internet at all.
- **Different houses:** deploy the server to Render once per household, open the
  public URL on the laptop, phones join from anywhere. The QR code automatically
  encodes the public URL — the host page just has to be opened via that URL.

## One-time deploy (about 5 minutes)

**Option A — Blueprint (easiest):**

1. Push this repo to GitHub.
2. Render Dashboard → New → **Blueprint** → select the repo.
   (`render.yaml` in the repo root describes the service: Node, `npm install`,
   `node server/server.js`, health check `/healthz`.)
3. Click Apply. Render gives you a URL like
   `https://turbo-kart-rally.onrender.com`.

**Option B — manual web service:**

1. Render Dashboard → New → Web Service → select the repo.
2. Build command: `npm install` · Start command: `node server/server.js`.
3. Health check path: `/healthz`. Leave everything else default.

No environment variables are required. The server reads Render's `PORT`
automatically and serves everything (game, controller, diagnostics) from the
one service.

## Game night (internet mode)

1. Open `https://<your-service>.onrender.com` on the laptop (projector/TV).
   The lobby QR now encodes `https://<your-service>.onrender.com/controller`.
2. Phones scan it from any network — no app, no account. Controllers use
   secure WebSockets automatically.
3. Play exactly like a local event (`EVENT_RUNBOOK.md` still applies).

## What changes on the internet (read this)

- **Latency budget moves.** On LAN the target is RTT p95 ≤ 30 ms. Over the
  internet, add the host-laptop↔Render and phone↔Render round trips: anything
  with RTT p95 ≤ 80 ms still plays great (the game applies the newest input
  per team, so jitter never queues). Pick the Render **region closest to the
  players** when creating the service, and glance at the F3 overlay /
  `/diagnostics` before the first race.
- **Free-plan sleep.** Render's free tier spins the service down after ~15 min
  idle: the first load of the night takes ~30 s, and an hours-long idle lobby
  may drop phones (they auto-reconnect). Open the host page a minute before
  guests arrive. Paid tiers don't sleep.
- **Scores reset on redeploy.** The session ledger lives in
  `server/session-state.json` on ephemeral disk — fine for a game night, gone
  on the next deploy.
- **Your URL is the room key.** There is one global room per deployment, and
  anyone with the link can join (6 play, the rest spectate). Share it like a
  party invite, not a tweet. The host can REMOVE strangers from the lobby.

## Back to LAN mode

Nothing changed: `npm start` with no internet still prints LAN URLs and the QR
encodes the laptop's LAN IP. `localhost` never ends up in a QR either way
(there's a test pinning that: `tests/public-url.spec.js`).
