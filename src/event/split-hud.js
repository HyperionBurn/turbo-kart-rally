// Compact per-viewport HUD for split screen races.
import { bus } from '../events.js';

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];
const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);

export class SplitHUD {
  constructor(root) {
    this.root = root;
    this.panels = [];
    this.el = document.createElement('div');
    this.el.className = 'split-hud';
    root.appendChild(this.el);
  }

  attach(karts, teams) {
    this.el.innerHTML = '';
    this.panels = karts.map((kart, i) => {
      const p = document.createElement('div');
      p.className = 'sp-panel';
      p.innerHTML = `
        <div class="sp-top"><span class="sp-chip"></span><span class="sp-name"></span><span class="sp-warn"></span></div>
        <div class="sp-pos"></div>
        <div class="sp-lap"></div>
        <div class="sp-item"></div>
        <div class="sp-speed"><i></i></div>`;
      this.el.appendChild(p);
      return p;
    });
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
  }

  update(dt, { karts, race, itemSystem }) {
    if (!karts) return;
    for (let i = 0; i < karts.length && i < this.panels.length; i++) {
      const k = karts[i], p = this.panels[i], t = this.teams && this.teams[k.teamId - 1];
      const chip = p.querySelector('.sp-chip'), name = p.querySelector('.sp-name');
      if (!p._init) {
        p._init = true;
        chip.style.background = t ? t.color : hex(k.character ? k.character.color : 0x888888);
        name.textContent = t ? t.name : (k.character ? k.character.name : 'RACER');
      }
      p.querySelector('.sp-pos').textContent = ORDINALS[(k.place || 1) - 1] || '--';
      p.classList.toggle('first', (k.place || 99) === 1);
      p.querySelector('.sp-lap').textContent = k.finished ? 'FIN' : `LAP ${Math.min(k.lap || 1, race ? race.laps : 3)}/${race ? race.laps : 3}`;
      p.querySelector('.sp-speed i').style.width = `${Math.min(100, Math.abs(k.speed || 0) / 60 * 100)}%`;
      const it = k.item ? itemShort(k.item) : '';
      p.querySelector('.sp-item').textContent = it;
      const warn = p.querySelector('.sp-warn');
      const lobbyTeam = t;
      if (lobbyTeam && !lobbyTeam.connected && !lobbyTeam.ai) { warn.textContent = '⚠ RECONNECTING'; p.classList.add('warn'); }
      else if (lobbyTeam && lobbyTeam.ai && !lobbyTeam.connected) { warn.textContent = '🤖 AI'; p.classList.remove('warn'); }
      else { warn.textContent = ''; p.classList.remove('warn'); }
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
    } else {
      if (this.board) this.board.innerHTML = '';
      this.panels.forEach((p) => p.classList.remove('bc-hidden'));
      this.layout();
    }
  }
  dispose() { this.el.remove(); }
}
function itemShort(id) {
  return ({ mushroom: '🍄', triple_mushroom: '🍄×3', banana: '🍌', green_shell: '🟢', red_shell: '🔴', star: '⭐', lightning: '⚡', blue_shell: '🔵' })[id] || '';
}
function ord(n) { return ['1st', '2nd', '3rd', '4th', '5th', '6th'][n - 1] || `${n}th`; }
