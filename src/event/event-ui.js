// Event Mode host UI: lobby/select, settings, prerace, results, leaderboard overlays.
import { CHARACTERS } from '../config.js';
import qrcode from 'qrcode-generator';

const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);

export class EventUI {
  constructor(root, handlers) {
    this.root = root;
    this.h = handlers; // {startRace, backToTitle, nextRace, resetTournament, lobbyAction, setSettings, flow}
    this.el = document.createElement('div');
    this.el.className = 'event-ui';
    root.appendChild(this.el);
    this.screen = null;
    this.lobby = null;   // last lobby state
    this.session = null; // last session state
    this.portraits = null;
  }

  setPortraitProvider(fn) { this.portraitFn = fn; }

  show(screen) {
    this.screen = screen;
    this.el.dataset.screen = screen || '';
    this.render();
  }
  hide() { this.screen = null; this.el.dataset.screen = ''; this.el.innerHTML = ''; }

  setLobby(state) {
    const sig = JSON.stringify(state.teams && state.teams.map((t) => [t.id, t.name, t.connected, t.ready, t.ai, t.characterIdx]));
    if (this._lobbySig === sig && this.screen === 'lobby') {
      // ping/jitter changed — patch numbers in place without rebuilding DOM
      state.teams.forEach((t, i) => {
        const slot = this.el.querySelectorAll('.slot')[i];
        if (slot) slot.querySelector('.slot-meta').innerHTML = t.connected ? `${t.ping || 0}ms · batt ${t.battery != null ? t.battery + '%' : '--'}` : '&nbsp;';
      });
      this.lobby = state;
      return;
    }
    this._lobbySig = sig;
    this.lobby = state;
    if (this.screen === 'lobby') this.render();
  }
  setSession(state) {
    const sig = JSON.stringify([state.flow, state.raceIndex, state.settings, (state.scores || []).map((s) => [s.teamId, s.total, s.wins]), state.lastResults && state.lastResults.length, state.controllerUrl]);
    const changed = this._sessionSig !== sig;
    this._sessionSig = sig;
    const keepLocal = this.session;
    this.session = state;
    if (!changed) {
      if (keepLocal && keepLocal.lastResults && !state.lastResults) state.lastResults = keepLocal.lastResults;
      return;
    }
    if (this.screen) this.render();
  }

  render() {
    switch (this.screen) {
      case 'lobby': return this._renderLobby();
      case 'settings': return this._renderSettings();
      case 'prerace': return this._renderPrerace();
      case 'results': return this._renderResults();
      case 'leaderboard': return this._renderLeaderboard();
    }
  }

  _renderLobby() {
    const s = this.session || { settings: {}, flow: 'lobby' };
    const teams = (this.lobby && this.lobby.teams) || [];
    const ready = teams.filter((t) => t.connected && t.ready).length;
    const connected = teams.filter((t) => t.connected).length;
    this.el.innerHTML = `
      <div class="ev-lobby">
        <div class="ev-left">
          <div class="ev-kicker">SCAN TO PLAY</div>
          <canvas id="ev-qr" width="220" height="220"></canvas>
          <div class="ev-url">${s.controllerUrl || ''}</div>
          ${s.lanWarning ? '<div class="ev-url warn">NO LAN IP FOUND — plug in Ethernet/hotspot, or type this URL on the phones</div>' : ''}
          ${s.altUrls && s.altUrls.length ? `<div class="ev-url alt">other interfaces: ${s.altUrls.join('  ')}</div>` : ''}
          <div class="ev-sub">${connected}/6 CONNECTED · ${ready} READY</div>
          <button id="ev-start" class="btn primary big">CONTINUE → SETTINGS</button>
          <button id="ev-solo" class="btn ghost">← SOLO MODE</button>
        </div>
        <div class="ev-slots">
          ${teams.map((t) => slotHtml(t)).join('')}
        </div>
      </div>`;
    drawQr(this.el.querySelector('#ev-qr'), s.controllerUrl || '');
    this.el.querySelector('#ev-start').onclick = () => this.h.goSettings();
    this.el.querySelector('#ev-solo').onclick = () => this.h.backToTitle();
    this.el.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => this.h.lobbyAction(b.dataset.act, +b.dataset.team));
  }

  _renderSettings() {
    const s = (this.session && this.session.settings) || {};
    this.el.innerHTML = `
      <div class="ev-settings">
        <h2>RACE SETTINGS</h2>
        <div class="opt-row"><span>Laps</span><div>${[1, 3, 5].map((n) => `<button data-k="laps" data-v="${n}" class="${s.laps === n ? 'on' : ''}">${n}</button>`).join('')}</div></div>
        <div class="opt-row"><span>Difficulty</span><div>${['easy', 'normal', 'hard'].map((n) => `<button data-k="difficulty" data-v="${n}" class="${s.difficulty === n ? 'on' : ''}">${n.toUpperCase()}</button>`).join('')}</div></div>
        <div class="opt-row"><span>Items</span><div>${[true, false].map((n) => `<button data-k="items" data-v="${n}" class="${!!s.items === n ? 'on' : ''}">${n ? 'ON' : 'OFF'}</button>`).join('')}</div></div>
        <div class="opt-row"><span>AI Fill</span><div>${[0, 2].map((n) => `<button data-k="aiFill" data-v="${n}" class="${s.aiFill === n ? 'on' : ''}">${n}</button>`).join('')}</div></div>
        <div class="opt-row"><span>Race speed</span><div>${['slow', 'normal', 'fast'].map((n) => `<button data-k="raceSpeed" data-v="${n}" class="${(s.raceSpeed || 'normal') === n ? 'on' : ''}">${n.toUpperCase()}</button>`).join('')}</div></div>
        <div class="opt-row"><span>Camera</span><div>${['split', 'broadcast'].map((n) => `<button data-k="cameraMode" data-v="${n}" class="${s.cameraMode === n ? 'on' : ''}">${n.toUpperCase()}</button>`).join('')}</div></div>
        <div class="opt-row"><span>Duplicate racers</span><div>${[false, true].map((n) => `<button data-k="allowDupes" data-v="${n}" class="${!!s.allowDupes === n ? 'on' : ''}">${n ? 'ALLOW' : 'BLOCK'}</button>`).join('')}</div></div>
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
    this.el.innerHTML = `
      <div class="ev-prerace">
        <div class="ev-kicker">PALM COVE CIRCUIT</div>
        <h1>RACE ${(this.session ? this.session.raceIndex : 0) + 1}</h1>
        <div class="ev-grid">
          ${teams.filter((t) => t.connected || t.ai).map((t) => `<div class="ev-racer" style="--tc:${t.color}"><b>${t.name}</b><span>${CHARACTERS[t.characterIdx] ? CHARACTERS[t.characterIdx].name : ''}</span></div>`).join('')}
        </div>
        <div class="ev-sub">GET READY…</div>
      </div>`;
  }

  _renderResults() {
    const s = this.session;
    const gained = (s && s.lastGained) || {};
    const results = (s && s.lastResults) || [];
    this.el.innerHTML = `
      <div class="ev-results">
        <h2>RACE RESULTS</h2>
        ${results.map((r) => `
          <div class="res-row" style="--tc:${r.color || '#888'}">
            <span class="res-place">${ord(r.place)}</span>
            <span class="res-name">${r.name}</span>
            <span class="res-char">${r.characterName || ''}</span>
            <span class="res-time">${r.time || ''}</span>
            <span class="res-pts">+${gained[r.teamId] ?? 0}</span>
          </div>`).join('')}
        <button id="ev-next" class="btn primary big">LEADERBOARD</button>
      </div>`;
    this.el.querySelector('#ev-next').onclick = () => this.h.showLeaderboard();
  }

  _renderLeaderboard() {
    const s = this.session || {};
    const scores = (s.scores || []).slice().sort((a, b) => b.total - a.total);
    const races = s.raceCount || 3;
    const done = (s.raceIndex || 0) >= races;
    const champ = done && scores[0] ? scores[0] : null;
    this.el.innerHTML = `
      <div class="ev-board ${done ? 'final' : ''}">
        ${champ ? `<div class="champ-banner"><div class="champ-kicker">EVENT CHAMPION</div>
          <div class="champ-name" style="--tc:${hex(0xffd835)}">${champ.name}</div>
          <div class="champ-sub">${CHARACTERS[champ.characterId] ? CHARACTERS[champ.characterId].name : ''} · ${champ.total} PTS · ${champ.wins} WINS</div></div>` : ''}
        <h2>${done ? 'FINAL STANDINGS' : `SESSION LEADERBOARD · RACE ${s.raceIndex || 0} OF ${races}`}</h2>
        <table>
          <thead><tr><th>#</th><th>TEAM</th><th>RACER</th><th>LAST</th><th>+PTS</th><th>TOTAL</th><th>WINS</th></tr></thead>
          <tbody>
            ${scores.map((r, i) => `<tr><td>${i + 1}</td><td>${r.name}</td><td>${CHARACTERS[r.characterId] ? CHARACTERS[r.characterId].name : ''}</td><td>${r.previous}</td><td>+${(r.total - r.previous)}</td><td class="tot" data-total="${r.total}">0</td><td>${r.wins}</td></tr>`).join('')}
          </tbody>
        </table>
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
  return `
    <div class="slot ${t.connected ? 'on' : ''} ${t.ready ? 'ready' : ''}" style="--tc:${t.color}" data-team="${t.id}">
      <div class="slot-head"><span class="dot" style="background:${t.color}"></span><b>${t.name}</b><span class="slot-state">${t.connected ? (t.ready ? 'READY' : 'IN LOBBY') : (t.ai ? 'AI' : 'EMPTY')}</span></div>
      <div class="slot-char">${ch ? ch.name : '—'}</div>
      <div class="slot-meta">${t.connected ? `${t.ping || 0}ms · batt ${t.battery != null ? t.battery + '%' : '--'}` : '&nbsp;'}</div>
      <div class="slot-acts">
        <button data-act="ready" data-team="${t.id}">FORCE READY</button>
        <button data-act="ai" data-team="${t.id}">AI</button>
        <button data-act="remove" data-team="${t.id}">REMOVE</button>
      </div>
    </div>`;
}

function ord(n) { return ['1st', '2nd', '3rd', '4th', '5th', '6th'][n - 1] || `${n}th`; }
function countUp(td, target) {
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 900);
    td.textContent = Math.round(target * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function drawQr(canvas, text) {
  if (!canvas || !text) return;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    const pad = 8;
    const cell = Math.floor((size - pad * 2) / n);
    ctx.fillStyle = '#0b0e1a';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#ffffff';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(pad + c * cell, pad + r * cell, cell, cell);
    }
  } catch {}
}
