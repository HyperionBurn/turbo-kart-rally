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
const _vp = new THREE.Vector4();

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
   * Viewports are handed to three.js in CSS pixels, which is exactly what setViewport and
   * setScissor expect: three multiplies by the renderer pixel ratio internally. Converting
   * to drawing-buffer pixels by hand double-counts the pixel ratio, which skewed the grid
   * (the top row of a 3x2 split was cut off) whenever devicePixelRatio was not 1.
   */
  render(scene, broadcast) {
    const r = this.renderer;
    const el = r.domElement;
    const rect = el.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width || el.clientWidth || window.innerWidth));
    const cssH = Math.max(1, Math.round(rect.height || el.clientHeight || window.innerHeight));
    r.getDrawingBufferSize(_size);
    this.lastMapping = { cssW, cssH, bw: Math.floor(_size.x), bh: Math.floor(_size.y), pixelRatio: r.getPixelRatio() };

    r.setScissorTest(true);
    r.setClearColor(0x0b0e1a, 1);
    if (broadcast) {
      const c = this.cams[this.broadcastIndex];
      r.setViewport(0, 0, cssW, cssH); r.setScissor(0, 0, cssW, cssH);
      if (c) {
        c.camera.aspect = cssW / cssH; c.camera.updateProjectionMatrix();
        r.clear(); r.render(scene, c.camera);
      } else r.clear();
      r.setScissorTest(false);
      this.lastViewports = [{ x: 0, y: 0, w: cssW, h: cssH }];
      return;
    }
    const layout = this.layout;
    this.lastViewports = [];
    for (let i = 0; i < this.cams.length; i++) {
      const [nx, ny, nw, nh] = layout[i]; // ny measured from the top of the canvas
      const vx = Math.round(nx * cssW);
      const vw = Math.max(1, Math.round(nw * cssW));
      const vyTop = Math.round(ny * cssH);
      const vh = Math.max(1, Math.round(nh * cssH));
      const vy = cssH - (vyTop + vh);        // GL viewport origin is bottom-left
      const c = this.cams[i];
      c.camera.aspect = vw / vh; c.camera.updateProjectionMatrix();
      r.setViewport(vx, vy, vw, vh);
      r.setScissor(vx, vy, vw, vh);
      if (i === 0) r.clear();
      r.render(scene, c.camera);
      // read the viewport back out of three.js so diagnostics/tests see the real GL state,
      // not the numbers we intended
      r.getViewport(_vp);
      this.lastViewports.push({
        x: Math.round(_vp.x), w: Math.round(_vp.z),
        y: Math.round(cssH - (_vp.y + _vp.w)), h: Math.round(_vp.w),
      });
    }
    r.setScissorTest(false);
  }

  /** Render only the given camera index (diagnostics read-back), leaving its viewport set. */
  renderOne(index, scene) {
    const c = this.cams[index];
    if (!c) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width || window.innerWidth));
    const cssH = Math.max(1, Math.round(rect.height || window.innerHeight));
    const [nx, ny, nw, nh] = this.layout[index];
    const vx = Math.round(nx * cssW);
    const vw = Math.max(1, Math.round(nw * cssW));
    const vyTop = Math.round(ny * cssH);
    const vh = Math.max(1, Math.round(nh * cssH));
    this.renderer.setScissorTest(true);
    this.renderer.setViewport(vx, cssH - (vyTop + vh), vw, vh);
    this.renderer.setScissor(vx, cssH - (vyTop + vh), vw, vh);
    this.renderer.render(scene, c.camera);
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
    const el = this.renderer.domElement;
    const cssW = Math.max(320, Math.round(el.clientWidth || window.innerWidth));
    const cssH = Math.max(180, Math.round(el.clientHeight || window.innerHeight));
    // Quality is expressed as the pixel ratio only: CSS keeps the canvas full-window, and
    // three.js turns these CSS dimensions into buffer pixels. Keeping a single source of
    // truth here is what guarantees setViewport() lines up with the DOM HUD.
    const dpr = Math.max(0.5, Math.min(window.devicePixelRatio || 1, 3) * scale);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(cssW, cssH, false);
    bus.emit('split:quality', { tier: this.tierIndex, dpr });
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
