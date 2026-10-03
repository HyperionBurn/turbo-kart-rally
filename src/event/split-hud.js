// Compact per-viewport HUD for split screen races.
import { bus } from '../events.js';

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);

// Panel-width breakpoints (px) for the per-panel type scale. Measured once at
// attach/layout time, never per frame. Thresholds are fixed pixels so a 1080p
// six-way split (~640px panels) lands on lg for projector legibility, while
// 1-2 player layouts hit the same capped lg sizes instead of ballooning.
const SCALE_SM_MAX = 320;
const SCALE_MD_MAX = 560;
const SLOT_FRAC = {
  full: 1, halfL: 0.5, halfR: 0.5,
  t3L: 1 / 3, t3M: 1 / 3, t3R: 1 / 3,
  q1: 1 / 3, q2: 1 / 3, q3: 1 / 3, q4: 1 / 3, q5: 1 / 3, q6: 1 / 3,
  w4: 1 / 3, w5: 1 / 3,
};

export class SplitHUD {
  constructor(root) {
    this.root = root;
    this.panels = [];
    this.refs = [];
    this.cache = [];
    this._lastPlaces = [];
    this._flashTimers = [];
    this.el = document.createElement('div');
    this.el.className = 'split-hud';
    root.appendChild(this.el);
  }

  attach(karts, teams) {
    this._clearFlashTimers();
    this.el.innerHTML = '';
    this.panels = karts.map((kart, i) => {
      const p = document.createElement('div');
      p.className = 'sp-panel';
      p.innerHTML = `
        <div class="sp-top"><span class="sp-chip"></span><span class="sp-name"></span><span class="sp-final"></span><span class="sp-warn"></span></div>
        <div class="sp-pos"></div>
        <div class="sp-lap"></div>
        <div class="sp-item"></div>
        <div class="sp-speed"><i></i></div>`;
      this.el.appendChild(p);
      return p;
    });
    // Cache element refs once so update() never queries the DOM per frame.
    this.refs = this.panels.map((p) => ({
      chip: p.querySelector('.sp-chip'),
      name: p.querySelector('.sp-name'),
      warn: p.querySelector('.sp-warn'),
      pos: p.querySelector('.sp-pos'),
      lap: p.querySelector('.sp-lap'),
      item: p.querySelector('.sp-item'),
      speed: p.querySelector('.sp-speed i'),
      final: p.querySelector('.sp-final'),
    }));
    this.cache = this.panels.map(() => ({
      posTxt: null, lapTxt: null, itemTxt: null, warnTxt: null,
      finalTxt: null, speedW: null, first: null, warnCls: null,
    }));
    this._lastPlaces = new Array(this.panels.length).fill(undefined);
    this._flashTimers = new Array(this.panels.length).fill(0);
    this.teams = teams;
    this.karts = karts;
    this.layout();
  }

  layout() {
    const n = this.panels.length;
    const L = {
      1: ['full'], 2: ['halfL', 'halfR'], 3: ['t3L', 't3M', 't3R'],
      4: ['q1', 'q2', 'q3', 'q4'], 5: ['q1', 'q2', 'q3', 'w4', 'w5'], 6: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'],
    }[n] || ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'];
    this.panels.forEach((p, i) => { p.dataset.slot = L[i] || 'q1'; });
    this._applyScale();
  }

  // Derive one sm/md/lg type-scale class per panel from its width. Runs only
  // at attach/layout time (panels are display:none until shown, so fall back
  // to the estimated slot fraction of the root width when clientWidth is 0).
  _applyScale() {
    const rootW = this.root.clientWidth || window.innerWidth || 1280;
    this.panels.forEach((p) => {
      let w = p.clientWidth;
      if (!w) w = rootW * (SLOT_FRAC[p.dataset.slot] || 1 / 3);
      const cls = w < SCALE_SM_MAX ? 'sp-sm' : w < SCALE_MD_MAX ? 'sp-md' : 'sp-lg';
      if (!p.classList.contains(cls)) {
        p.classList.remove('sp-sm', 'sp-md', 'sp-lg');
        p.classList.add(cls);
      }
    });
  }

  _clearFlashTimers() {
    if (this._flashTimers) this._flashTimers.forEach((t) => { if (t) clearTimeout(t); });
    this._flashTimers = [];
  }

  update(dt, { karts, race, itemSystem }) {
    if (!karts) return;
    const totalLaps = race ? race.laps : 3;
    for (let i = 0; i < karts.length && i < this.panels.length; i++) {
      const k = karts[i], p = this.panels[i], r = this.refs[i], c = this.cache[i];
      const t = this.teams && this.teams[k.teamId - 1];
      if (!p._init) {
        p._init = true;
        r.chip.style.background = t ? t.color : hex(k.character ? k.character.color : 0x888888);
        r.name.textContent = t ? t.name : (k.character ? k.character.name : 'RACER');
      }
      const posTxt = ORDINALS[(k.place || 1) - 1] || '--';
      if (c.posTxt !== posTxt) { r.pos.textContent = posTxt; c.posTxt = posTxt; }
      const isFirst = (k.place || 99) === 1;
      if (c.first !== isFirst) { p.classList.toggle('first', isFirst); c.first = isFirst; }
      // Position-change flash: tint only, no geometry changes so layout never moves.
      const place = k.place || 1;
      if (this._lastPlaces[i] === undefined) {
        this._lastPlaces[i] = place;
      } else if (this._lastPlaces[i] !== place) {
        const up = place < this._lastPlaces[i];
        this._lastPlaces[i] = place;
        r.pos.classList.remove('up', 'down');
        r.pos.classList.add(up ? 'up' : 'down');
        if (this._flashTimers[i]) clearTimeout(this._flashTimers[i]);
        const posEl = r.pos;
        this._flashTimers[i] = setTimeout(() => { posEl.classList.remove('up', 'down'); }, 1000);
      }
      const lapTxt = k.finished ? 'FIN' : `LAP ${Math.min(k.lap || 1, race ? race.laps : 3)}/${race ? race.laps : 3}`;
      if (c.lapTxt !== lapTxt) { r.lap.textContent = lapTxt; c.lapTxt = lapTxt; }
      // FINAL LAP badge on the last lap; cleared on finish (FIN shown instead).
      const finalTxt = (totalLaps > 1 && !k.finished && (k.lap || 1) === totalLaps) ? 'FINAL' : '';
      if (c.finalTxt !== finalTxt) { r.final.textContent = finalTxt; c.finalTxt = finalTxt; }
      const speedW = `${Math.min(100, Math.abs(k.speed || 0) / 60 * 100)}%`;
      if (c.speedW !== speedW) { r.speed.style.width = speedW; c.speedW = speedW; }
      const it = k.item ? itemShort(k.item) : '';
      if (c.itemTxt !== it) { r.item.textContent = it; c.itemTxt = it; }
      const lobbyTeam = t;
      let warnTxt, warnCls;
      if (lobbyTeam && !lobbyTeam.connected && !lobbyTeam.ai) { warnTxt = '⚠ RECONNECTING'; warnCls = true; }
      else if (lobbyTeam && lobbyTeam.ai && !lobbyTeam.connected) { warnTxt = '🤖 AI'; warnCls = false; }
      else if (k._wrongWay && !k.finished) { warnTxt = '↩ WRONG WAY'; warnCls = true; }
      else { warnTxt = ''; warnCls = false; }
      if (c.warnTxt !== warnTxt) { r.warn.textContent = warnTxt; c.warnTxt = warnTxt; }
      if (c.warnCls !== warnCls) { p.classList.toggle('warn', warnCls); c.warnCls = warnCls; }
    }
  }

  show() { this.el.classList.add('on'); }
  hide() { this.el.classList.remove('on'); }

  /** Broadcast camera mode: one cinematic view + a full standings strip instead of six panels. */
  setBroadcast(on, karts, race) {
    this.broadcast = !!on;
    this.el.classList.toggle('broadcast', this.broadcast);
    if (this.broadcast) {
      if (!this.board) {
        this.board = document.createElement('div');
        this.board.className = 'bc-board';
        this.el.appendChild(this.board);
      }
      this.panels.forEach((p, i) => p.classList.toggle('bc-hidden', i !== 0));
      this.panels[0].dataset.slot = 'full';
      const rows = (karts || []).map((k) => {
        const t = this.teams && this.teams[k.teamId - 1];
        const color = t ? t.color : '#888';
        return `<div class="bc-row" style="--tc:${color}"><b>${ord(k.place || 1)}</b><span>${t ? t.name : ''}</span><i>L${Math.min(k.lap || 1, race ? race.laps : 3)}</i></div>`;
      }).join('');
      this.board.innerHTML = `<div class="bc-title">STANDINGS</div>${rows}`;
      this._applyScale();
    } else {
      if (this.board) this.board.innerHTML = '';
      this.panels.forEach((p) => p.classList.remove('bc-hidden'));
      this.layout();
    }
  }
  dispose() { this._clearFlashTimers(); this.el.remove(); }
}
function itemShort(id) {
  return ({ mushroom: '🍄', triple_mushroom: '🍄×3', banana: '🍌', green_shell: '🟢', red_shell: '🔴', star: '⭐', lightning: '⚡', blue_shell: '🔵' })[id] || '';
}
function ord(n) { return ['1st', '2nd', '3rd', '4th', '5th', '6th'][n - 1] || `${n}th`; }
