// Track hazards: the signature set-pieces of the themed circuits (tracks.js `hazards`).
//   crusher  a stone block that hovers, slams down on a timer and flattens a kart under it
//   ball     a chrome ball rolling down a stretch of track against the race direction
//   bumper   a pop bumper (or cloud puff) that bounces karts off with a flash
// Positions are fractions of a lap (`t`) plus a lateral offset, so they follow any layout.
// Everything is deterministic on the race clock; kart effects use the existing hit API.
import * as THREE from 'three';
import { bus } from './events.js';

const UP = new THREE.Vector3(0, 1, 0);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap01 = (t) => ((t % 1) + 1) % 1;

function placeOnTrack(track, t, lat, out) {
  const p = track.getPointAt(wrap01(t));
  const tan = track.getTangentAt(wrap01(t));
  const right = new THREE.Vector3(-tan.z, 0, tan.x).normalize();
  out.set(p.x + right.x * lat, p.y, p.z + right.z * lat);
  return { tan, right, ground: p.y };
}

function crusherMesh() {
  const g = new THREE.Group();
  const stone = new THREE.MeshStandardMaterial({ color: 0x7d8796, roughness: 0.85, metalness: 0.05 });
  const block = new THREE.Mesh(new THREE.BoxGeometry(5.2, 3.2, 5.2), stone);
  block.castShadow = true;
  g.add(block);
  const spikeMat = new THREE.MeshStandardMaterial({ color: 0x9aa4b3, roughness: 0.6 });
  for (const [x, z, ry] of [[2.9, 0, 0], [-2.9, 0, Math.PI], [0, 2.9, -Math.PI / 2], [0, -2.9, Math.PI / 2]]) {
    const sp = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.2, 6), spikeMat);
    sp.rotation.set(0, ry, -Math.PI / 2); sp.position.set(x, 0, z);
    g.add(sp);
  }
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff2a00, emissiveIntensity: 2.2 });
  for (const s of [-1, 1]) for (const face of [[0, 0, 2.62], [0, 0, -2.62]]) {
    const e = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.5, 0.12), eyeMat);
    e.position.set(s * 1.1, 0.5, face[2]); g.add(e);
  }
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(3.4, 24), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.0, depthWrite: false }));
  shadow.rotation.x = -Math.PI / 2;
  return { group: g, shadow };
}

function ballMesh(radius) {
  const m = new THREE.MeshStandardMaterial({ color: 0xdfe6f2, metalness: 1, roughness: 0.12 });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 28, 18), m);
  mesh.castShadow = true;
  return mesh;
}

function bumperMesh(style, radius, color) {
  const g = new THREE.Group();
  if (style === 'cloud') {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, emissive: 0xbfd8ff, emissiveIntensity: 0.15 });
    for (const [x, y, z, r] of [[0, 1.1, 0, 1.0], [0.9, 0.9, 0.2, 0.75], [-0.85, 0.85, -0.1, 0.8], [0.1, 1.7, 0.3, 0.7], [0.2, 0.7, -0.9, 0.7]]) {
      const puff = new THREE.Mesh(new THREE.IcosahedronGeometry(r * radius * 0.85, 1), mat);
      puff.position.set(x * radius * 0.7, y * radius * 0.7, z * radius * 0.7);
      g.add(puff);
    }
    return { group: g, flashMat: mat };
  }
  const base = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.05, 1.4, 28), new THREE.MeshStandardMaterial({ color: 0x1a1030, roughness: 0.4, metalness: 0.4 }));
  base.position.y = 0.7; base.castShadow = true;
  const capMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.3 });
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.92, radius * 0.92, 0.5, 28), capMat);
  cap.position.y = 1.65;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.02, 0.18, 8, 32), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.6 }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 1.4;
  g.add(base, cap, ring);
  return { group: g, flashMat: capMat };
}

export function createHazards(scene, track, defs) {
  const root = new THREE.Group();
  root.name = 'hazards';
  scene.add(root);
  const items = [];
  const tmp = new THREE.Vector3();
  for (const d of defs || []) {
    try {
      if (d.type === 'crusher') {
        const pos = new THREE.Vector3();
        const { ground } = placeOnTrack(track, d.t, d.lat || 0, pos);
        const { group, shadow } = crusherMesh();
        group.position.set(pos.x, ground + 10, pos.z);
        shadow.position.set(pos.x, ground + 0.06, pos.z);
        root.add(group, shadow);
        items.push({ type: 'crusher', d, group, shadow, pos, ground, period: d.period || 3.4, phase: d.phase || 0, h: 10, wasDown: false });
      } else if (d.type === 'ball') {
        const radius = d.radius || 2.4;
        const count = d.count || 2;
        for (let k = 0; k < count; k++) {
          const mesh = ballMesh(radius);
          root.add(mesh);
          items.push({ type: 'ball', d, mesh, radius, offset: k / count });
        }
      } else if (d.type === 'bumper') {
        const radius = d.radius || 1.8;
        const pos = new THREE.Vector3();
        const { ground } = placeOnTrack(track, d.t, d.lat || 0, pos);
        const { group, flashMat } = bumperMesh(d.style, radius, d.color ?? 0xff3df2);
        group.position.set(pos.x, ground, pos.z);
        root.add(group);
        items.push({ type: 'bumper', d, group, flashMat, pos, ground, radius, flash: 0, baseGlow: flashMat.emissiveIntensity });
      }
    } catch (e) { console.warn('[hazards] skipped', d, e); }
  }

  function update(dt, time, karts) {
    for (const it of items) {
      if (it.type === 'crusher') {
        // cycle: hover (55%) -> slam (6%) -> rest on the road (17%) -> rise (22%)
        const u = wrap01(time / it.period + it.phase);
        let h;
        if (u < 0.55) h = 10;
        else if (u < 0.61) h = 10 - 9.6 * ((u - 0.55) / 0.06) ** 2;
        else if (u < 0.78) h = 0.4;
        else h = 0.4 + 9.6 * ((u - 0.78) / 0.22);
        it.h = h;
        it.group.position.y = it.ground + h + 1.6;
        // warning shadow darkens as the block is about to drop
        it.shadow.material.opacity = u > 0.4 && u < 0.78 ? clamp((u - 0.4) / 0.15, 0, 1) * 0.55 : 0.12;
        const down = h < 2.4;
        if (down && !it.wasDown) bus.emit('hazard:slam', { position: it.group.position });
        it.wasDown = down;
        if (down) {
          for (const k of karts) {
            if (!k || k.respawnTimer > 0) continue;
            const dx = k.position.x - it.pos.x, dz = k.position.z - it.pos.z;
            if (Math.abs(dx) < 3.2 && Math.abs(dz) < 3.2 && k.position.y < it.ground + h + 2.5) k.applyHit('squash');
          }
        }
      } else if (it.type === 'ball') {
        const d = it.d;
        const span = wrap01(d.t1 - d.t0) || 0.1;
        const speed = d.speed || 0.035; // laps fraction per second (against the race direction)
        const u = wrap01(it.offset + time * speed / span);
        const t = d.t1 - span * u;
        const { tan, ground } = placeOnTrack(track, t, d.lat || 0, tmp);
        it.mesh.position.set(tmp.x, ground + it.radius, tmp.z);
        // roll: rotate about the axis perpendicular to travel
        const axis = new THREE.Vector3().crossVectors(UP, tan).normalize();
        it.mesh.rotateOnWorldAxis(axis, -(dt * speed * (track.length || 2000)) / it.radius);
        for (const k of karts) {
          if (!k || k.respawnTimer > 0) continue;
          const dx = k.position.x - it.mesh.position.x, dz = k.position.z - it.mesh.position.z;
          const r = it.radius + (k.radius || 1.3);
          if (dx * dx + dz * dz < r * r && Math.abs(k.position.y - ground) < it.radius * 2) {
            if (k.applyHit('spin')) {
              const n = Math.hypot(dx, dz) || 1;
              k.velocity.x += (dx / n) * 10; k.velocity.z += (dz / n) * 10;
            }
          }
        }
      } else if (it.type === 'bumper') {
        if (it.flash > 0) it.flash = Math.max(0, it.flash - dt * 3);
        it.flashMat.emissiveIntensity = it.baseGlow + it.flash * 3;
        for (const k of karts) {
          if (!k || k.respawnTimer > 0) continue;
          const dx = k.position.x - it.pos.x, dz = k.position.z - it.pos.z;
          const r = it.radius + (k.radius || 1.3);
          const d2 = dx * dx + dz * dz;
          if (d2 >= r * r || Math.abs(k.position.y - it.ground) > 3) continue;
          const dist = Math.sqrt(d2) || 0.001, nx = dx / dist, nz = dz / dist;
          k.position.x += nx * (r - dist); k.position.z += nz * (r - dist);
          const vn = k.velocity.x * nx + k.velocity.z * nz;
          // pinball kick: reflect and add a fixed pop so even a slow touch bounces
          const kick = Math.max(0, -vn) * 1.25 + 9;
          k.velocity.x += nx * kick; k.velocity.z += nz * kick;
          if (it.flash < 0.5) bus.emit('hazard:bumper', { kart: k, position: it.group.position });
          it.flash = 1;
        }
      }
    }
  }

  function dispose() {
    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    scene.remove(root);
  }

  return { update, dispose, root, count: items.length };
}
