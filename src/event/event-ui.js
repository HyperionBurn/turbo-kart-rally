// Event Mode host UI: lobby/select, settings, prerace, results, leaderboard overlays.
import { CHARACTERS } from '../config.js';
import qrcode from 'qrcode-generator';
import { TRACKS, ROTATION, getTrackDef, rotatingTrackId } from '../tracks.js';

const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);

export class EventUI {
  constructor(root, handlers) {
    this.root = root;
    this.h = handlers; // {startRace, backToTitle, nextRace, resetTournament, lobbyAction, setSettings, flow}
    this.el = document.createElement('div');
    this.el.className = 'event-ui';
    root.appendChild(this.el);
    this.ticker = document.createElement('div');
    this.ticker.className = 'ev-ticker';
    this.ticker.setAttribute('aria-hidden', 'true');
    this.ticker.hidden = true;
    root.appendChild(this.ticker);
    this.screen = null;
    this.lobby = null;   // last lobby state
    this.session = null; // last session state
    this.roomCode = null; // event room code (via setSession state.roomCode or setRoomCode)
    this.portraits = null;
    window.addEventListener('resize', () => this._fit());
  }

  /**
   * Fit the current screen inside the window. The lobby and settings were laid out for a
   * 1080p projector; on a laptop (e.g. 1440x810 after Windows scaling) their top and bottom
   * buttons fell off-screen. CSS zoom (not transform) so layout and click targets scale too.
   */
  _fit() {
    const box = this.el.firstElementChild;
    if (!box || !this.screen) return;
    box.style.zoom = '';
    const margin = 24;
    const w = box.offsetWidth, h = box.offsetHeight;
    if (!w || !h) return;
    const s = Math.min(1, (window.innerWidth - margin * 2) / w, (window.innerHeight - margin * 2) / h);
    if (s < 0.995) box.style.zoom = String(Math.max(0.45, +s.toFixed(3)));
  }

  setPortraitProvider(fn) { this.portraitFn = fn; }

  /** Room code setter: shows the code in the lobby even before the first session arrives. */
  setRoomCode(code) {
    const next = code || null;
    this.roomCode = next;
    // always repaint the lobby (even when unchanged): a same-signature setSession may
    // have adopted the code without re-rendering, leaving the display stale
    if (this.screen === 'lobby') this.render();
  }

  show(screen) {
    this.screen = screen;
    this.el.dataset.screen = screen || '';
    this.render();
    this._updateTicker();
  }
  hide() { this.screen = null; this.el.dataset.screen = ''; this.el.innerHTML = ''; this._updateTicker(); }

  setLobby(state) {
    const sig = JSON.stringify(state.teams && state.teams.map((t) => [t.id, t.name, t.connected, t.ready, t.ai, t.characterIdx]));
    if (this.screen === 'prerace') {
      // live prerace status: patch connection state in place, never full re-render
      this._lobbySig = sig;
      this.lobby = state;
      if (this.el.querySelector('.ev-grid')) this._patchPrerace(state);
      else this.render();
      this._updateTicker();
      return;
    }
    if (this._lobbySig === sig && this.screen === 'lobby') {
      // ping/jitter changed — patch numbers in place without rebuilding DOM
      state.teams.forEach((t, i) => {
        const slot = this.el.querySelectorAll('.slot')[i];
        if (!slot) return;
        const meta = slot.querySelector('.slot-meta');
        if (!meta) return;
        if (t.connected) {
          meta.className = `slot-meta ${pingClass(t.ping)}`;
          meta.innerHTML = metaInner(t);
        }
      });
      this.lobby = state;
      this._updateTicker();
      return;
    }
    this._lobbySig = sig;
    this.lobby = state;
    if (this.screen === 'lobby') this.render();
    this._updateTicker();
  }
  setSession(state) {
    const sig = JSON.stringify([state.flow, state.raceIndex, state.settings, (state.scores || []).map((s) => [s.teamId, s.total, s.wins]), state.lastResults && state.lastResults.length, state.controllerUrl, state.roomCode || null]);
    const changed = this._sessionSig !== sig;
    this._sessionSig = sig;
    const keepLocal = this.session;
    this.session = state;
    if (state && state.roomCode) this.roomCode = state.roomCode;
    if (!changed) {
      if (keepLocal && keepLocal.lastResults && !state.lastResults) state.lastResults = keepLocal.lastResults;
      this._updateTicker();
      return;
    }
    if (this.screen) this.render();
    this._updateTicker();
  }

  render() {
    switch (this.screen) {
      case 'lobby': this._renderLobby(); break;
      case 'settings': this._renderSettings(); break;
      case 'prerace': this._renderPrerace(); break;
      case 'results': this._renderResults(); break;
      case 'leaderboard': this._renderLeaderboard(); break;
    }
    this._fit();
  }

  _updateTicker() {
    if (!this.ticker) return;
    const s = this.session;
    const flow = s && s.flow;
    if (!s || (flow !== 'prerace' && flow !== 'countdown' && flow !== 'racing')) {
      this.ticker.hidden = true;
      this.ticker.textContent = '';
      return;
    }
    const total = (s.settings && s.settings.raceCount) || s.raceCount || 3;
    const idx = (s.raceIndex || 0) + 1;
    const laps = (s.settings && s.settings.laps) ?? s.laps ?? 3;
    const scores = Array.isArray(s.scores) ? s.scores.slice().sort((a, b) => (b.total || 0) - (a.total || 0)) : [];
    const leader = scores.length ? scores[0] : null;
    let text = `RACE ${idx} OF ${total} · ${laps} LAPS`;
    if (leader && leader.name != null && isFinite(+leader.total)) {
      text += ` · 🏆 LEADER: ${leader.name} (${leader.total} PTS)`;
    }
    this.ticker.textContent = text;
    this.ticker.hidden = false;
  }

  _renderLobby() {
    const s = this.session || { settings: {}, flow: 'lobby' };
    const teams = (this.lobby && this.lobby.teams) || [];
    const ready = teams.filter((t) => t.connected && t.ready).length;
    const connected = teams.filter((t) => t.connected).length;
    const canStart = connected > 0;
    const roomCode = safeRoomCode(this.roomCode || s.roomCode);
    // the QR must encode the room join URL — never double-append if a future
    // server already put ?room= in controllerUrl
    const joinUrl = withRoom(s.controllerUrl || '', roomCode);
    this.el.innerHTML = `
      <div class="ev-lobby">
        <div class="ev-left">
          <div class="ev-kicker">SCAN TO PLAY</div>
          ${roomCode ? `<div class="ev-room" style="font-size:64px;font-weight:900;letter-spacing:10px;line-height:1;margin:6px 0 2px">ROOM ${roomCode}</div>` : ''}
          <canvas id="ev-qr" width="300" height="300"></canvas>
          <div class="ev-url">${joinUrl}</div>
          ${s.lanWarning ? '<div class="ev-url warn">NO LAN IP FOUND — plug in Ethernet/hotspot, or type this URL on the phones</div>' : ''}
          ${s.altUrls && s.altUrls.length ? `<div class="ev-url alt">other interfaces: ${s.altUrls.join('  ')}</div>` : ''}
          <div class="ev-sub">${connected}/6 CONNECTED · ${ready} READY</div>
          <div class="ev-progress" aria-hidden="true"><i style="width:${Math.round(ready / 6 * 100)}%"></i></div>
          <div class="ev-guide" aria-label="Host steps"><span>1 · TEAMS SCAN THE QR</span><span>2 · PICK RACER + READY (${ready}/6)</span><span>3 · PRESS CONTINUE</span></div>
          <button id="ev-start" class="btn primary big" ${canStart ? '' : 'disabled'}>${canStart ? 'CONTINUE → SETTINGS' : 'WAITING FOR TEAMS…'}</button>
          ${canStart ? '' : '<div class="ev-hint">Teams: scan the QR, pick a racer, tap READY on your phone.</div>'}
          <button id="ev-newroom" class="btn ghost">NEW CODE</button>
          <button id="ev-solo" class="btn ghost">← SOLO MODE</button>
        </div>
        <div class="ev-slots">
          ${teams.map((t) => slotHtml(t)).join('')}
        </div>
      </div>`;
    drawQr(this.el.querySelector('#ev-qr'), joinUrl);
    if (canStart) this.el.querySelector('#ev-start').onclick = () => this.h.goSettings();
    const nr = this.el.querySelector('#ev-newroom');
    if (nr) nr.onclick = () => { if (this.h.newRoom) this.h.newRoom(); };
    this.el.querySelector('#ev-solo').onclick = () => this.h.backToTitle();
    this.el.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => this.h.lobbyAction(b.dataset.act, +b.dataset.team));
  }

  _renderSettings() {
    const s = (this.session && this.session.settings) || {};
    const pts = (this.session && this.session.pointsTable) || [10, 8, 6, 4, 2, 1];
    const ccLabel = { easy: '50cc · EASY', normal: '100cc · NORMAL', hard: '150cc · HARD' };
    const ords = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
    this.el.innerHTML = `
      <div class="ev-settings">
        <h2>RACE SETTINGS</h2>
        <div class="opt-row"><span>Track</span><div>${[...TRACKS.map((t) => [t.id, t.name.toUpperCase()]), ['rotate', 'ROTATE ↻']].map(([id, label]) => `<button data-k="track" data-v="${id}" class="${(s.track || 'rotate') === id ? 'on' : ''}">${label}</button>`).join('')}</div></div>
        <div class="opt-desc">${(s.track || 'rotate') === 'rotate' ? 'A different circuit every race: ' + ROTATION.map((id) => getTrackDef(id).name).join(' → ') + '.' : getTrackDef(s.track).blurb}</div>
        <div class="opt-row"><span>Laps</span><div>${[1, 3, 5].map((n) => `<button data-k="laps" data-v="${n}" class="${s.laps === n ? 'on' : ''}">${n}</button>`).join('')}</div></div>
        <div class="opt-desc">How many laps each race lasts.</div>
        <div class="opt-row"><span>Difficulty</span><div>${['easy', 'normal', 'hard'].map((n) => `<button data-k="difficulty" data-v="${n}" class="${s.difficulty === n ? 'on' : ''}">${ccLabel[n]}</button>`).join('')}</div></div>
        <div class="opt-desc">Speed class: sets top speed + AI pace — 50cc relaxed, 100cc brisk, 150cc flat-out.</div>
        <div class="opt-row"><span>Items</span><div>${[true, false].map((n) => `<button data-k="items" data-v="${n}" class="${!!s.items === n ? 'on' : ''}">${n ? 'ON' : 'OFF'}</button>`).join('')}</div></div>
        <div class="opt-desc">Pickups like shells and boosts appear on the track when ON.</div>
        <div class="opt-row"><span>AI Fill</span><div>${[0, 2].map((n) => `<button data-k="aiFill" data-v="${n}" class="${s.aiFill === n ? 'on' : ''}">${n}</button>`).join('')}</div></div>
        <div class="opt-desc">Adds computer teams so the grid feels full.</div>
        <div class="opt-row"><span>Race speed</span><div>${['slow', 'normal', 'fast'].map((n) => `<button data-k="raceSpeed" data-v="${n}" class="${(s.raceSpeed || 'normal') === n ? 'on' : ''}">${n.toUpperCase()}</button>`).join('')}</div></div>
        <div class="opt-desc">Changes top speed for everyone.</div>
        <div class="opt-row"><span>Camera</span><div>${['split', 'broadcast'].map((n) => `<button data-k="cameraMode" data-v="${n}" class="${s.cameraMode === n ? 'on' : ''}">${n.toUpperCase()}</button>`).join('')}</div></div>
        <div class="opt-desc">Split shows every team; broadcast follows the leader.</div>
        <div class="opt-row"><span>Duplicate racers</span><div>${[false, true].map((n) => `<button data-k="allowDupes" data-v="${n}" class="${!!s.allowDupes === n ? 'on' : ''}">${n ? 'ALLOW' : 'BLOCK'}</button>`).join('')}</div></div>
        <div class="opt-desc">BLOCK keeps every racer unique; ALLOW lets teams pick the same one.</div>
        <div class="opt-row"><span>Races</span><div>${[1, 2, 3, 4, 5].map((n) => `<button data-k="raceCount" data-v="${n}" class="${(s.raceCount ?? 3) === n ? 'on' : ''}">${n}</button>`).join('')}</div></div>
        <div class="opt-desc">How many races make up the championship.</div>
        <div class="opt-desc">POINTS ${pts.map((p, i) => `${ords[i] || ((i + 1) + 'th')} ${p}`).join(' · ')}</div>
        <button id="ev-go" class="btn primary big">START RACE</button>
        <button id="ev-back" class="btn ghost">← LOBBY</button>
      </div>`;
    this.el.querySelectorAll('[data-k]').forEach((b) => b.onclick = () => {
      const k = b.dataset.k; let v = b.dataset.v;
      if (v === 'true') v = true; else if (v === 'false') v = false; else if (!isNaN(+v)) v = +v;
      this.h.setSettings({ [k]: v });
    });
    this.el.querySelector('#ev-go').onclick = () => this.h.startRace();
    this.el.querySelector('#ev-back').onclick = () => this.h.goLobby();
  }

  _renderPrerace() {
    const teams = (this.lobby && this.lobby.teams) || [];
    const sess = this.session || {};
    const total = (sess.settings && sess.settings.raceCount) || sess.raceCount || 3;
    const idx = (sess.raceIndex || 0) + 1;
    const racers = teams.filter((t) => t.connected || t.ai);
    this.el.innerHTML = `
      <div class="ev-prerace">
        <div class="ev-kicker">${preraceTrackName(sess).toUpperCase()}</div>
        <h1>RACE ${idx} OF ${total}</h1>
        <div class="ev-grid">
          ${racers.map((t) => `<div class="ev-racer" data-team="${t.id}" style="--tc:${t.color}"><b><i class="ev-dot" style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${t.color};margin-right:8px;vertical-align:baseline"></i>${t.name}</b><span>${CHARACTERS[t.characterIdx] ? CHARACTERS[t.characterIdx].name : ''}</span><span class="ev-wait" style="display:none;font-size:12px;margin-left:6px">• waiting…</span></div>`).join('')}
        </div>
        <div class="ev-sub" id="ev-prerace-status" style="font-size:13px;letter-spacing:1px">${preraceStatusText(racers)}</div>
        <div class="ev-sub">GET READY…</div>
        <div class="ev-controls">Hold GAS · DRIFT in corners · ITEM when lit</div>
      </div>`;
  }

  _patchPrerace(state) {
    const grid = this.el.querySelector('.ev-grid');
    if (!grid) { this.render(); return; }
    const teams = (state && state.teams) || [];
    const byId = new Map(teams.map((t) => [t.id, t]));
    grid.querySelectorAll('.ev-racer').forEach((el) => {
      const t = byId.get(+el.dataset.team);
      if (!t) return;
      const gone = !t.connected && !t.ai;
      el.style.opacity = gone ? '0.45' : '';
      let w = el.querySelector('.ev-wait');
      if (gone && !w) {
        w = document.createElement('span');
        w.className = 'ev-wait';
        w.style.cssText = 'font-size:12px;margin-left:6px';
        w.textContent = '• waiting…';
        el.appendChild(w);
      }
      if (w) w.style.display = gone ? '' : 'none';
    });
    // a racer that (re)connects mid-prerace with no element yet: append without rebuilding
    const present = new Set([...grid.querySelectorAll('.ev-racer')].map((el) => +el.dataset.team));
    for (const t of teams) {
      if ((t.connected || t.ai) && !present.has(t.id)) {
        const div = document.createElement('div');
        div.className = 'ev-racer';
        div.dataset.team = t.id;
        div.style.cssText = `--tc:${t.color}`;
        div.innerHTML = `<b><i class="ev-dot" style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${t.color};margin-right:8px;vertical-align:baseline"></i>${t.name}</b><span>${CHARACTERS[t.characterIdx] ? CHARACTERS[t.characterIdx].name : ''}</span><span class="ev-wait" style="display:none;font-size:12px;margin-left:6px">• waiting…</span>`;
        grid.appendChild(div);
      }
    }
    const status = this.el.querySelector('#ev-prerace-status');
    if (status) {
      const racers = [...grid.querySelectorAll('.ev-racer')].map((el) => byId.get(+el.dataset.team)).filter(Boolean);
      status.textContent = preraceStatusText(racers);
    }
  }

  _renderResults() {
    const s = this.session;
    const gained = (s && s.lastGained) || {};
    const results = (s && s.lastResults) || [];
    const medal = (p) => p === 1 ? '🥇 ' : p === 2 ? '🥈 ' : p === 3 ? '🥉 ' : '';
    const winner = results.find((r) => r.place === 1) || results[0] || null;
    const winnerT = winner ? parseRaceTime(winner.time) : null;
    this.el.innerHTML = `
      <div class="ev-results">
        <h2>RACE RESULTS</h2>
        ${results.map((r) => {
          let timeText = '';
          let gapCls = '';
          if (r.place === 1) {
            timeText = r.time || '';
          } else {
            const t = parseRaceTime(r.time);
            if (t != null && winnerT != null && isFinite(t - winnerT) && (t - winnerT) >= 0) {
              timeText = `+${(t - winnerT).toFixed(2)}s`;
              gapCls = ' res-gap';
            } else {
              timeText = '';
            }
          }
          return `
          <div class="res-row" style="--tc:${r.color || '#888'}${r.place === 1 ? ';border-left:4px solid #ffd835;padding-left:8px' : ''}">
            <span class="res-place">${medal(r.place)}${ord(r.place)}</span>
            <span class="res-name">${r.name}</span>
            <span class="res-char">${r.characterName || ''}</span>
            <span class="res-time${gapCls}">${timeText}</span>
            <span class="res-pts">+${gained[r.teamId] ?? 0}</span>
          </div>`;
        }).join('')}
        <button id="ev-next" class="btn primary big">LEADERBOARD</button>
      </div>`;
    this.el.querySelector('#ev-next').onclick = () => this.h.showLeaderboard();
    // staggered row reveal (~250ms apart, JS timeouts); LEADERBOARD stays visible throughout
    try {
      const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduced) {
        const rows = this.el.querySelectorAll('.res-row');
        // visibility (not display) keeps the full card in the layout, so the fit-to-window
        // scale is measured on the final size rather than on an empty card
        rows.forEach((row, i) => {
          row.style.visibility = 'hidden';
          setTimeout(() => { row.style.visibility = ''; }, 250 * (i + 1));
        });
      }
    } catch {}
  }

  _renderLeaderboard() {
    const s = this.session || {};
    const scores = (s.scores || []).slice().sort((a, b) => b.total - a.total);
    const races = s.raceCount || (s.settings && s.settings.raceCount) || 3;
    const done = (s.raceIndex || 0) >= races;
    const champ = done && scores[0] ? scores[0] : null;
    // largest mover since last race: max (total - previous); ties → first in display order
    let climbIdx = 0, climbBest = -Infinity;
    scores.forEach((r, i) => {
      const g = (r.total || 0) - (r.previous || 0);
      if (g > climbBest) { climbBest = g; climbIdx = i; }
    });
    // most wins: max wins; ties → first in display order
    let mostWins = scores.length ? scores[0] : null;
    for (const r of scores) {
      if ((r.wins || 0) > (mostWins.wins || 0)) mostWins = r;
    }
    this.el.innerHTML = `
      <div class="ev-board ${done ? 'final' : ''}">
        ${champ ? `<div class="champ-banner"><div class="champ-kicker">EVENT CHAMPION</div>
          <div class="champ-name" style="--tc:${hex(0xffd835)}">${champ.name}</div>
          <div class="champ-sub">${CHARACTERS[champ.characterId] ? CHARACTERS[champ.characterId].name : ''} · ${champ.total} PTS · ${champ.wins} WINS</div></div>` : ''}
        <h2>${done ? 'FINAL STANDINGS' : `SESSION LEADERBOARD · RACE ${s.raceIndex || 0} OF ${races}`}</h2>
        <table>
          <thead><tr><th>#</th><th>TEAM</th><th>RACER</th><th>LAST</th><th>+PTS</th><th>TOTAL</th><th>WINS</th></tr></thead>
          <tbody>
            ${scores.map((r, i) => `<tr><td>${i + 1}</td><td>${r.name}${i === climbIdx ? '<span style="color:#ffd835;font-size:11px"> ▲ BIGGEST CLIMB</span>' : ''}</td><td>${CHARACTERS[r.characterId] ? CHARACTERS[r.characterId].name : ''}</td><td>${r.previous}</td><td>+${(r.total - r.previous)}</td><td class="tot" data-total="${r.total}">0</td><td>${r.wins}</td></tr>`).join('')}
          </tbody>
        </table>
        ${mostWins ? `<div class="ev-most-wins">MOST WINS: ${mostWins.name} (${mostWins.wins || 0}) 🏁</div>` : ''}
        <button id="ev-again" class="btn primary big">NEXT RACE</button>
        <button id="ev-reset" class="btn ghost">RESET TOURNAMENT</button>
        <button id="ev-quit" class="btn ghost">END EVENT</button>
      </div>`;
    this.el.querySelector('#ev-again').onclick = () => this.h.nextRace();
    this.el.querySelector('#ev-reset').onclick = () => this.h.resetTournament();
    this.el.querySelector('#ev-quit').onclick = () => this.h.endEvent();
    // count-up animation
    this.el.querySelectorAll('.tot').forEach((td) => countUp(td, +td.dataset.total));
    if (champ) this.h.champion && this.h.champion(champ);
  }
}

function slotHtml(t) {
  const ch = CHARACTERS[t.characterIdx];
  const hint = t.connected && !t.ready ? '<div class="slot-hint">👉 TAP READY ON PHONE</div>' : '';
  const isAI = !!t.ai;
  const isEmpty = !t.connected && !t.ai;
  const cls = ['slot', t.connected ? 'on' : '', t.ready ? 'ready' : '', isAI ? 'slot-ai' : '', isEmpty ? 'slot-empty' : ''].filter(Boolean).join(' ');
  // No CSS access from this file: visible AI/empty treatments are inline styles.
  const extra = isAI ? 'outline:2px solid #9fb0e8;outline-offset:2px;' : (isEmpty ? 'opacity:.6;border-style:dashed;' : '');
  const state = t.connected ? (t.ready ? 'READY' : 'IN LOBBY') : (isAI ? '🤖 AI' : 'EMPTY');
  const meta = t.connected
    ? `<div class="slot-meta ${pingClass(t.ping)}">${metaInner(t)}</div>`
    : (isAI ? '<div class="slot-meta">computer driver</div>' : '<div class="slot-meta waiting">waiting for phone… (or press AI)</div>');
  return `
    <div class="${cls}" style="--tc:${t.color};${extra}" data-team="${t.id}">
      <div class="slot-head"><span class="dot" style="background:${t.color}"></span><b>${t.name}</b><span class="slot-state">${state}</span></div>
      <div class="slot-char">${ch ? ch.name : '—'}</div>
      ${hint}
      ${meta}
      <div class="slot-acts">
        <button data-act="ready" data-team="${t.id}">FORCE READY</button>
        <button data-act="ai" data-team="${t.id}">AI</button>
        <button data-act="remove" data-team="${t.id}">REMOVE</button>
      </div>
    </div>`;
}

function preraceTrackName(sess) {
  const st = (sess && sess.settings) || {};
  const id = !st.track || st.track === 'rotate' ? rotatingTrackId(sess.raceIndex || 0) : st.track;
  return getTrackDef(id).name;
}
function ord(n) { return ['1st', '2nd', '3rd', '4th', '5th', '6th'][n - 1] || `${n}th`; }
function safeRoomCode(v) {
  if (v == null) return null;
  const s = String(v).replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
  return /^[A-HJ-KM-NP-Z2-9]{4}$/.test(s) ? s : null;
}
/** Append ?room=CODE (or &room=) unless the URL already carries it. Never double-appends. */
function withRoom(base, code) {
  if (!base || !code) return base;
  if (base.includes('room=')) return base;
  return base + (base.includes('?') ? '&' : '?') + 'room=' + code;
}
function preraceStatusText(racers) {
  const waiting = (racers || []).filter((t) => !t.connected && !t.ai).map((t) => t.name);
  return waiting.length ? `WAITING ON: ${waiting.join(', ')}` : 'ALL TEAMS IN — GOOD TO GO';
}
function parseRaceTime(t) {
  if (t == null) return null;
  if (typeof t === 'number') return isFinite(t) ? t : null;
  const s = String(t).trim();
  if (!s) return null;
  if (s.includes(':')) {
    const parts = s.split(':');
    if (parts.length !== 2) return null;
    const m = parseFloat(parts[0]);
    const sec = parseFloat(parts[1]);
    if (!isFinite(m) || !isFinite(sec)) return null;
    return m * 60 + sec;
  }
  const v = parseFloat(s);
  return isFinite(v) ? v : null;
}
function pingClass(ping) {
  const p = +ping || 0;
  return p <= 30 ? 'ping-good' : (p <= 80 ? 'ping-ok' : 'ping-bad');
}
const PING_COLORS = { 'ping-good': '#69f0ae', 'ping-ok': '#fdd835', 'ping-bad': '#ff5252' };
function battState(b) {
  if (b == null || b === '' || isNaN(+b)) return { cls: 'batt-unknown', icon: '▱▱▱', label: 'battery unknown' };
  const v = Math.round(+b);
  if (v >= 60) return { cls: 'batt-full', icon: '▰▰▰', label: `battery ${v}%` };
  if (v >= 25) return { cls: 'batt-half', icon: '▰▰▱', label: `battery ${v}%` };
  return { cls: 'batt-low', icon: '▰▱▱', label: `battery ${v}% — low, plug the phone in` };
}
function metaInner(t) {
  const pc = pingClass(t.ping);
  const b = battState(t.battery);
  return `<span class="ping ${pc}" style="color:${PING_COLORS[pc]}">${t.ping || 0}ms</span> · <span class="batt ${b.cls}" title="${b.label}">🔋${b.icon}</span>`;
}
function countUp(td, target) {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { td.textContent = target; return; }
  } catch {}
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 900);
    td.textContent = Math.round(target * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
/**
 * Standard-polarity QR: dark modules on white with the 4-module quiet zone the QR spec
 * requires. The earlier light-on-dark rendering was an inverted code with a 1-module
 * margin; inverted decoding is optional in the spec and many phone cameras and scanner
 * apps silently ignore it, so a share of the room could not join at all.
 */
function drawQr(canvas, text) {
  if (!canvas || !text) return;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    const cell = Math.max(1, Math.floor(size / (n + quiet * 2))); // whole pixels: no blurred module edges
    const off = Math.floor((size - cell * n) / 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(off + c * cell, off + r * cell, cell, cell);
    }
    canvas.dataset.qr = text; // what the code encodes, for the decode test and field diagnosis
  } catch {}
}
