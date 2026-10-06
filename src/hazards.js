// Track hazards: the signature set-pieces of the themed circuits (tracks.js `hazards`).
//   crusher  a stone block that hovers, slams down on a timer and flattens a kart under it
//   ball     a chrome pinball: drops in from a launch ring, bounces, rolls downhill against
//            the race gathering speed, ricochets off walls and karts, then drains and respawns
//   bumper   a pop bumper (or cloud puff) that bounces karts off with a flash
// Positions are fractions of a lap (`t`) plus a lateral offset, so they follow any layout.
// Everything is deterministic on the race clock; kart effects use the existing hit API.
import * as THREE from 'three';
import { bus } from './events.js';

const UP = new THREE.Vector3(0, 1, 0);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrap01 = (t) => ((t % 1) + 1) % 1;
// tiny seeded RNG so every ball's chaos is repeatable run to run
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const GRAV = 34;

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
  // neon band so the ball's spin reads at speed
  const band = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.002, radius * 0.07, 6, 32),
    new THREE.MeshStandardMaterial({ color: 0x00e5ff, emissive: 0x00e5ff, emissiveIntensity: 1.4 }));
  mesh.add(band);
  return mesh;
}

// glowing launch ring in the sky that the balls drop out of
function chuteMesh(radius) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xff3df2, emissive: 0xff3df2, emissiveIntensity: 1.2 });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius * 1.6, 0.35, 8, 36), mat);
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  return { group: g, mat };
}

function dropShadow(radius) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(radius * 1.1, 24),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  return m;
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
  const rollAxis = new THREE.Vector3();
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
        const chutes = (d.chutes || [d.t1]).map((t) => {
          const pos = new THREE.Vector3();
          const { ground } = placeOnTrack(track, t, d.lat || 0, pos);
          const c = chuteMesh(radius);
          c.group.position.set(pos.x, ground + 22, pos.z);
          root.add(c.group);
          const item = { type: 'chute', group: c.group, mat: c.mat, glow: 0 };
          items.push(item);
          return { t, item };
        });
        for (let k = 0; k < count; k++) {
          const mesh = ballMesh(radius);
          const shadow = dropShadow(radius);
          mesh.visible = false;
          root.add(mesh, shadow);
          items.push({
            type: 'ball', d, mesh, shadow, radius, chutes, rand: rng(9173 * (k + 1) + Math.round((d.t0 || 0) * 1e4)),
            phase: 'wait', wait: 0.6 + k * (d.stagger || 2.4), s: 0, lat: 0, vLat: 0, y: 0, vy: 0, v: 0, kick: 0, size: 1,
            prev: new THREE.Vector3(), hasPrev: false,
          });
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

  // lateral room on the road at fraction t (keep the ball inside the walls)
  function roomAt(t, r) {
    const N = track.N;
    if (!N || !track.wallL || !track.wallR) return 9 - r;
    const i = Math.floor(wrap01(t) * N) % N;
    return Math.max(1, Math.min(Math.abs(track.wallL[i]), Math.abs(track.wallR[i])) - r - 0.6);
  }

  function spawnBall(it) {
    const R = it.rand, d = it.d;
    const chute = it.chutes[Math.floor(R() * it.chutes.length) % it.chutes.length];
    it.s = chute.t;
    it.lat = (d.lat || 0) + (R() - 0.5) * 3;
    it.vLat = (R() - 0.5) * 14;
    it.vy = 0;
    it.v = 4 + R() * 4;
    it.vmax = (d.vmax || 26) * (0.8 + R() * 0.35);
    it.kick = 0.8 + R() * 1.6;
    it.size = 1;
    it.landed = false;
    placeOnTrack(track, it.s, it.lat, tmp);
    it.y = tmp.y + 22;
    it.phase = 'drop';
    it.hasPrev = false;
    it.mesh.position.set(tmp.x, it.y, tmp.z);
    it.mesh.visible = true;
    it.mesh.scale.setScalar(1);
    chute.item.glow = 1;
  }

  function updateBall(it, dt, karts) {
    const d = it.d, r = it.radius, R = it.rand;
    if (it.phase === 'wait') {
      it.wait -= dt;
      it.shadow.material.opacity = 0;
      if (it.wait > 0) return;
      spawnBall(it); // then fall through, so it is placed before the first frame it is seen
    }
    const span = wrap01(d.t1 - d.t0) || 0.1;
    const len = track.length || 2000;
    // along the track (downhill = against the race), accelerating like a ball on a tilted table
    if (it.landed) it.v = Math.min(it.vmax, it.v + 7 * dt);
    if (it.phase !== 'drain') it.s -= (it.v * dt) / len;
    // random flipper-style kicks keep it unpredictable
    it.kick -= dt;
    if (it.kick <= 0 && it.phase === 'roll') {
      it.vLat += (R() - 0.5) * 22;
      if (R() < 0.45) it.vy = 5 + R() * 5;
      it.kick = 0.9 + R() * 1.8;
    }
    it.vLat *= Math.exp(-0.25 * dt);
    it.lat += it.vLat * dt;
    const room = roomAt(it.s, r);
    if (Math.abs(it.lat) > room) {
      it.lat = Math.sign(it.lat) * room;
      it.vLat = -it.vLat * 0.85;
      if (Math.abs(it.vLat) > 3 && it.phase === 'roll') {
        it.vy = Math.max(it.vy, 3.5);
        bus.emit('hazard:ball', { position: it.mesh.position, heavy: false });
      }
    }
    const { ground } = placeOnTrack(track, it.s, it.lat, tmp);
    const floor = ground + r * it.size;
    // vertical: gravity with damped bounces
    if (it.phase !== 'drain') {
      it.vy -= GRAV * dt;
      it.y += it.vy * dt;
      if (it.y < floor) {
        it.y = floor;
        if (it.vy < -5) {
          bus.emit('hazard:ball', { position: it.mesh.position, heavy: !it.landed });
          it.vy = -it.vy * (it.landed ? 0.35 : 0.5);
        } else it.vy = 0;
        if (!it.landed) { it.landed = true; it.phase = 'roll'; }
      }
    }
    // drain at the bottom of the table: sink into the floor, then wait for the next launch
    const travelled = wrap01(d.t1 - it.s);
    if (it.phase === 'roll' && travelled > span && travelled < 0.9) it.phase = 'drain';
    if (it.phase === 'drain') {
      it.size = Math.max(0, it.size - dt * 1.8);
      it.y = ground + r * it.size - (1 - it.size) * r;
      it.mesh.scale.setScalar(Math.max(0.01, it.size));
      if (it.size <= 0) {
        it.mesh.visible = false;
        it.phase = 'wait';
        it.wait = 0.5 + R() * 2.5;
      }
    }
    it.mesh.position.set(tmp.x, it.y, tmp.z);
    // warning shadow: darker and tighter as a falling ball nears the road
    it.shadow.position.set(tmp.x, ground + 0.07, tmp.z);
    const above = Math.max(0, it.y - floor);
    it.shadow.material.opacity = it.phase === 'drain' ? 0 : clamp(0.55 - above / 40, 0.15, 0.55);
    it.shadow.scale.setScalar(clamp(1.3 - above / 30, 0.5, 1.3));
    // roll about the axis perpendicular to how it actually moved
    if (it.hasPrev) {
      const mx = it.mesh.position.x - it.prev.x, mz = it.mesh.position.z - it.prev.z;
      const dist = Math.hypot(mx, mz);
      if (dist > 1e-4 && dist < 20) {
        rollAxis.set(mz / dist, 0, -mx / dist);
        it.mesh.rotateOnWorldAxis(rollAxis, dist / r);
      }
    }
    it.prev.copy(it.mesh.position); it.hasPrev = true;
    if (!it.landed) return; // still in the air above the karts
    // hit karts: spin them out, shove them, and get deflected ourselves
    for (const k of karts) {
      if (!k || k.respawnTimer > 0) continue;
      const dx = k.position.x - it.mesh.position.x, dz = k.position.z - it.mesh.position.z;
      const rr = r * it.size + (k.radius || 1.3);
      if (dx * dx + dz * dz < rr * rr && Math.abs(k.position.y + 0.6 - it.y) < r + 1.4) {
        if (k.applyHit('spin')) {
          const n = Math.hypot(dx, dz) || 1;
          k.velocity.x += (dx / n) * 10; k.velocity.z += (dz / n) * 10;
          it.vLat += (R() - 0.5) * 18;
          it.vy = Math.max(it.vy, 6);
          bus.emit('hazard:ball', { position: it.mesh.position, heavy: false });
        }
      }
    }
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
      } else if (it.type === 'chute') {
        it.glow = Math.max(0, it.glow - dt * 2.5);
        it.mat.emissiveIntensity = 1.2 + it.glow * 4;
        it.group.rotation.y += dt * 1.5;
      } else if (it.type === 'ball') {
        updateBall(it, dt, karts);
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
