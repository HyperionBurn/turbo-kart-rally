// Floating team name tags above karts in event mode, so every player can tell which kart is
// whose on the big screen. Each kart's tag lives on its own render layer; a split-screen
// camera shows every tag except the one above its own kart (that one would sit in the middle
// of your own view), as in Mario Kart's split screen. Broadcast mode shows all of them.
import * as THREE from 'three';

export const TAG_LAYER_BASE = 10;   // kart i's tag is on layer TAG_LAYER_BASE + i (three.js has 32)
export const MAX_TAGS = 16;

function readableText(hex) {
  const c = new THREE.Color(hex);
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; // linear-ish is fine for a 2-way pick
  return lum > 0.45 ? '#111111' : '#ffffff';
}

/** A camera-facing label: the team name on a pill in the team colour. */
export function createNameTag(text, color = '#888888') {
  const label = String(text || '').toUpperCase().slice(0, 16) || 'RACER';
  const W = 512, H = 128;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.font = '900 64px system-ui, "Segoe UI", Roboto, Arial, sans-serif';
  const tw = Math.min(W - 40, g.measureText(label).width + 56);
  const x0 = (W - tw) / 2, y0 = 18, h = H - 36, r = h / 2;
  g.beginPath();
  g.moveTo(x0 + r, y0); g.lineTo(x0 + tw - r, y0); g.arc(x0 + tw - r, y0 + r, r, -Math.PI / 2, Math.PI / 2);
  g.lineTo(x0 + r, y0 + h); g.arc(x0 + r, y0 + r, r, Math.PI / 2, Math.PI * 1.5); g.closePath();
  g.fillStyle = color; g.fill();
  g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.stroke();
  g.fillStyle = readableText(color);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(label, W / 2, H / 2 + 3, tw - 40);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, toneMapped: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(4.4, 1.1, 1);
  sprite.position.set(0, 3.1, 0);
  sprite.renderOrder = 50;
  sprite.name = 'nametag';
  return sprite;
}

export function disposeNameTag(tag) {
  if (!tag) return;
  try { tag.parent && tag.parent.remove(tag); } catch {}
  try { tag.material.map && tag.material.map.dispose(); tag.material.dispose(); } catch {}
}

/** Camera i follows kart i: show every tag layer except its own kart's. */
export function setTagLayers(camera, ownIndex) {
  camera.layers.enable(0);
  for (let j = 0; j < MAX_TAGS; j++) {
    if (j === ownIndex) camera.layers.disable(TAG_LAYER_BASE + j);
    else camera.layers.enable(TAG_LAYER_BASE + j);
  }
}
