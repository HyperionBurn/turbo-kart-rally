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

const PIXEL_TIERS = [2, 1.5, 1.25, 1, 0.85, 0.7];

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

  /** Render every viewport. scene: shared THREE.Scene. */
  render(scene, broadcast) {
    const r = this.renderer;
    const w = r.domElement.width, h = r.domElement.height;
    r.setScissorTest(true);
    r.setClearColor(0x0b0e1a, 1);
    if (broadcast) {
      const c = this.cams[this.broadcastIndex];
      if (c) {
        c.camera.aspect = w / h; c.camera.updateProjectionMatrix();
        r.setViewport(0, 0, w, h); r.setScissor(0, 0, w, h);
        r.clear(); r.render(scene, c.camera);
      }
      r.setScissorTest(false);
      return;
    }
    const layout = this.layout;
    for (let i = 0; i < this.cams.length; i++) {
      const [nx, ny, nw, nh] = layout[i]; // ny from top
      const vx = Math.floor(nx * w), vw = Math.ceil(nw * w);
      const vy = Math.floor((1 - ny - nh) * h), vh = Math.ceil(nh * h);
      const c = this.cams[i];
      c.camera.aspect = vw / vh; c.camera.updateProjectionMatrix();
      r.setViewport(vx, vy, vw, vh);
      r.setScissor(vx, vy, vw, vh);
      if (i === 0) r.clear();
      r.render(scene, c.camera);
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
    if (p95 > 21 && this.tierIndex < PIXEL_TIERS.length - 1) {
      this.tierIndex++;
      this._applyTier();
    } else if (p95 < 13 && this.tierIndex > 0 && !this._locked) {
      this.tierIndex--;
      this._applyTier();
    }
  }
  _applyTier() {
    const dpr = Math.min(window.devicePixelRatio || 1, PIXEL_TIERS[this.tierIndex]);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    bus.emit('split:quality', { tier: this.tierIndex, dpr });
  }
  dispose() {
    for (const c of this.cams) { try { c.chase && c.chase.dispose && c.chase.dispose(); } catch {} }
    this.cams = [];
  }
}
function p95Idx(n) { return Math.min(n - 1, Math.floor(0.95 * n)); }
