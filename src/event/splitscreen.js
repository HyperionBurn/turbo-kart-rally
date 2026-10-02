// Six-camera split screen: one shared scene, six PerspectiveCameras, scissor viewports,
// adaptive quality tiers driven by measured frame times.
import * as THREE from 'three';
import { bus } from '../events.js';

// Layouts: arrays of [x, y, w, h] in normalized (0..1 of screen), y measured from bottom for GL but we present TL.
const LAYOUTS = {
  1: [[0, 0, 1, 1]],
  2: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]],
  3: [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]],
  4: [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]],
  5: [[0, 0, 1 / 3, 0.5], [1 / 3, 0, 1 / 3, 0.5], [2 / 3, 0, 1 / 3, 0.5], [0.25, 0.5, 1 / 3, 0.5], [0.25 + 1 / 3, 0.5, 1 / 3, 0.5]],
  6: [[0, 0, 1 / 3, 0.5], [1 / 3, 0, 1 / 3, 0.5], [2 / 3, 0, 1 / 3, 0.5], [0, 0.5, 1 / 3, 0.5], [1 / 3, 0.5, 1 / 3, 0.5], [2 / 3, 0.5, 1 / 3, 0.5]],
};

// Render-scale tiers. We deliberately do NOT touch renderer.setPixelRatio: the canvas is
// always sized by CSS to the window, and only the drawing buffer shrinks, so the browser
// scales the image back up. That keeps viewport maths exact and avoids the classic
// "canvas CSS size vs drawing buffer size" mismatch that produces partial frames.
export const SCALE_TIERS = [1, 0.85, 0.75, 0.65, 0.55, 0.45];
const _size = new THREE.Vector2();

export class SplitScreen {
  constructor(renderer, ChaseCameraClass) {
    this.renderer = renderer;
    this.ChaseCameraClass = ChaseCameraClass;
    this.cams = [];       // {camera, chase, kart}
    this.tierIndex = 2;   // start at 1.25 dpr
    this.frameTimes = [];
    this.quality = 'high';
    this.broadcastIndex = 0; // for broadcast mode
  }

  get layout() { return LAYOUTS[this.cams.length] || LAYOUTS[6]; }

  attach(karts) {
    this.dispose();
    for (const kart of karts) {
      const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 3000);
      const chase = this.ChaseCameraClass ? new this.ChaseCameraClass(camera) : null;
      this.cams.push({ camera, chase, kart });
      if (chase) { try { chase.snap(kart); } catch {} }
    }
  }

  update(dt, modeForKart) {
    for (const c of this.cams) {
      if (c.chase && c.kart) {
        const mode = modeForKart ? modeForKart(c.kart) : 'race';
        try { c.chase.update(dt, c.kart, { mode, lookBack: !!c.kart.input?.lookBack }); } catch {}
      }
    }
  }

  /**
   * Render every viewport. scene: shared THREE.Scene.
   *
   * Layout is defined in CSS pixels relative to the *canvas element's* box and then mapped
   * into drawing-buffer pixels. Deriving the viewports from the buffer alone silently skews
   * the grid whenever the buffer aspect and the CSS box disagree (fullscreen browser chrome,
   * device pixel ratio, render-scale tiers) — and then the 3D view no longer lines up with
   * the DOM HUD panels drawn on top of it.
   */
  render(scene, broadcast) {
    const r = this.renderer;
    const el = r.domElement;
    const rect = el.getBoundingClientRect();
    const cssW = Math.max(1, rect.width || el.clientWidth || window.innerWidth);
    const cssH = Math.max(1, rect.height || el.clientHeight || window.innerHeight);
    r.getDrawingBufferSize(_size);
    const bw = Math.max(1, Math.floor(_size.x)), bh = Math.max(1, Math.floor(_size.y));
    const sx = bw / cssW, sy = bh / cssH;         // CSS px -> buffer px
    this.lastMapping = { cssW, cssH, bw, bh, sx, sy };

    r.setScissorTest(true);
    r.setClearColor(0x0b0e1a, 1);
    if (broadcast) {
      const c = this.cams[this.broadcastIndex];
      r.setViewport(0, 0, bw, bh); r.setScissor(0, 0, bw, bh);
      if (c) {
        c.camera.aspect = bw / bh; c.camera.updateProjectionMatrix();
        r.clear(); r.render(scene, c.camera);
      } else r.clear();
      r.setScissorTest(false);
      this.lastViewports = [{ x: 0, y: 0, w: bw, h: bh }];
      return;
    }
    const layout = this.layout;
    this.lastViewports = [];
    for (let i = 0; i < this.cams.length; i++) {
      const [nx, ny, nw, nh] = layout[i]; // ny measured from the top
      const vx = Math.round(nx * cssW * sx);
      const vw = Math.max(1, Math.round(nw * cssW * sx));
      const vyTop = Math.round(ny * cssH * sy);
      const vh = Math.max(1, Math.round(nh * cssH * sy));
      const vy = Math.round(bh - (vyTop + vh)); // GL origin is bottom-left
      const c = this.cams[i];
      c.camera.aspect = vw / vh; c.camera.updateProjectionMatrix();
      r.setViewport(vx, vy, vw, vh);
      r.setScissor(vx, vy, vw, vh);
      if (i === 0) r.clear();
      r.render(scene, c.camera);
      this.lastViewports.push({ x: vx, y: vyTop, w: vw, h: vh, css: { x: nx * cssW, y: ny * cssH, w: nw * cssW, h: nh * cssH } });
    }
    r.setScissorTest(false);
  }

  /** Call once per displayed frame with its ms; auto-adjust tiers. */
  observeFrame(ms) {
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    if (this.frameTimes.length < 60) return;
    const sorted = this.frameTimes.slice().sort((a, b) => a - b);
    const p95 = sorted[(p95Idx(sorted.length))];
    if (p95 > 21 && this.tierIndex < SCALE_TIERS.length - 1) {
      this.tierIndex++;
      this._applyTier();
    } else if (p95 < 13 && this.tierIndex > 0 && !this._locked) {
      this.tierIndex--;
      this._applyTier();
    }
  }
  _applyTier() {
    const scale = SCALE_TIERS[this.tierIndex];
    // size the buffer from the canvas' own CSS box, not from window.innerWidth/Height:
    // those can disagree (fullscreen chrome, scrollbars), which would skew the grid
    const el = this.renderer.domElement;
    const w = Math.max(320, Math.round((el.clientWidth || window.innerWidth) * scale));
    const h = Math.max(180, Math.round((el.clientHeight || window.innerHeight) * scale));
    this.renderer.setSize(w, h, false);   // updateStyle=false: CSS keeps the canvas full-window
    bus.emit('split:quality', { tier: this.tierIndex, scale });
  }
  /** Broadcast mode is a single full-screen view: give it the top tier, no downscaling. */
  setBroadcastMode(on) {
    if (this.broadcastMode === on) return;
    this.broadcastMode = on;
    this.tierIndex = 0;
    this.frameTimes.length = 0;
    this._applyTier();
  }
  dispose() {
    for (const c of this.cams) { try { c.chase && c.chase.dispose && c.chase.dispose(); } catch {} }
    this.cams = [];
  }
}
function p95Idx(n) { return Math.min(n - 1, Math.floor(0.95 * n)); }
