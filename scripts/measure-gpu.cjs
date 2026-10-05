// Real-GPU performance capture for the six-player event race.
//
// Unlike measure-host.cjs (headless SwiftShader, no GPU), this drives Chromium on a real
// GPU through ANGLE/Direct3D, joins N synthetic phones INTO THE HOST'S ROOM (so every kart
// is human-driven), races for --duration seconds and prints frame/physics/render percentiles.
//
//   npm start                                   # in another terminal
//   node scripts/measure-gpu.cjs                 # integrated GPU (what Chrome uses by default)
//   node scripts/measure-gpu.cjs --gpu dgpu      # force the discrete GPU (NVIDIA/AMD)
//   node scripts/measure-gpu.cjs --mode broadcast --width 1280 --height 720
//   node scripts/measure-gpu.cjs --uncapped      # no vsync: shows real headroom above 60 fps
//
// Writes docs/measurements/gpu-<tag>.json. Run it on the event laptop, plugged in.
const { chromium } = require('playwright');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i].replace(/^--/, '');
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[a] = true; else { args[a] = next; i++; }
}
const HOST = (args.host && args.host !== true ? args.host : 'http://127.0.0.1:8081').replace(/\/$/, '');
const GPU = args.gpu || 'igpu';                 // igpu | dgpu | software
const MODE = args.mode || 'split';              // split | broadcast
const PLAYERS = Math.max(1, Math.min(6, +(args.players || 6)));
const DURATION = +(args.duration || 30);
const WIDTH = +(args.width || 1920), HEIGHT = +(args.height || 1080);
const UNCAPPED = !!args.uncapped;
const TAG = args.tag && args.tag !== true ? args.tag : `${GPU}-${MODE}-${WIDTH}x${HEIGHT}${UNCAPPED ? '-uncapped' : ''}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wsUrl = HOST.replace(/^http/, 'ws') + '/ws';

function chromeArgs() {
  const a = ['--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
  if (GPU === 'software') a.push('--use-angle=swiftshader');
  else a.push('--use-angle=d3d11');
  if (GPU === 'dgpu') a.push('--force_high_performance_gpu');
  if (UNCAPPED) a.push('--disable-gpu-vsync', '--disable-frame-rate-limit');
  return a;
}

/** A synthetic phone: joins the room, picks a racer, readies, then streams 30 Hz input. */
function phone(room, i) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const p = { ws, teamId: 0, sessionId: 0, seq: 0, timer: null };
    const to = setTimeout(() => reject(new Error(`phone ${i + 1} never joined`)), 10000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room, name: `GPU ${i + 1}` })));
    ws.on('message', (d, bin) => {
      if (bin) return;
      let m; try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.type === 'joined') {
        clearTimeout(to);
        p.teamId = m.teamId; p.sessionId = m.sessionId;
        ws.send(JSON.stringify({ type: 'select', characterIdx: i }));
        ws.send(JSON.stringify({ type: 'ready', ready: true }));
        resolve(p);
      } else if (m.type === 'spectating') { clearTimeout(to); reject(new Error('room full')); }
    });
    ws.on('error', reject);
  });
}
function drive(p, i) {
  const t0 = Date.now();
  p.timer = setInterval(() => {
    const t = (Date.now() - t0) / 1000;
    const b = new Uint8Array(24); const v = new DataView(b.buffer);
    b[0] = 0x54; b[1] = 0x01;
    v.setUint16(2, p.teamId, true); v.setUint32(4, p.sessionId, true); v.setUint32(8, p.seq++, true);
    v.setFloat64(12, Date.now(), true);
    v.setInt8(20, Math.round(Math.sin(t * 0.7 + i) * 0.6 * 127));
    b[21] = 255; b[22] = 0;
    b[23] = (Math.sin(t * 0.5 + i) > 0.6 ? 1 : 0) | (p.seq % 90 === 0 ? 4 : 0); // drift sometimes, item every 3 s
    try { p.ws.send(b); } catch {}
  }, 33);
}

(async () => {
  const browser = await chromium.launch({ channel: 'chromium', args: chromeArgs() });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(HOST + '/', { waitUntil: 'load' });
  const gpuName = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2', { powerPreference: 'high-performance' });
    const e = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  await page.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 60000 });
  await page.click('#btn-event', { force: true });
  await page.waitForFunction(() => !!window.__game.eventRoom, null, { timeout: 10000 });
  const room = await page.evaluate(() => window.__game.eventRoom);
  await page.evaluate(() => window.__game.send({ type: 'hostResetSession' }));

  const phones = [];
  for (let i = 0; i < PLAYERS; i++) phones.push(await phone(room, i));
  await page.waitForFunction((n) => document.querySelectorAll('.slot.ready').length >= n, PLAYERS, { timeout: 15000 });

  await page.click('#ev-start', { force: true });
  await page.evaluate((mode) => window.__game.send({ type: 'hostSettings', settings: { cameraMode: mode, laps: 5, items: true, aiFill: 0 } }), MODE);
  await sleep(400);
  await page.click('#ev-go', { force: true });
  await page.waitForFunction(() => ['countdown', 'racing'].includes(window.__game.eventDebug().state), null, { timeout: 60000 });
  phones.forEach(drive);
  await page.waitForFunction(() => window.__game.eventDebug().state === 'racing', null, { timeout: 30000 });
  await sleep(3000); // warm-up: shader compiles, adaptive tier settles
  let cdp = null;
  if (args.profile) {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
  }
  await page.evaluate(() => window.__game.enableProbe());
  await sleep(DURATION * 1000);
  let hot = null;
  if (cdp) {
    // --profile: aggregate self time per function so the hot spots are visible without DevTools
    const { profile } = await cdp.send('Profiler.stop');
    const dt = new Map(); // nodeId -> self ms
    for (let i = 0; i < profile.samples.length; i++) {
      const id = profile.samples[i];
      dt.set(id, (dt.get(id) || 0) + (profile.timeDeltas[i] || 0) / 1000);
    }
    const self = new Map();
    let total = 0;
    for (const n of profile.nodes) {
      const ms = dt.get(n.id) || 0;
      total += ms;
      const f = n.callFrame;
      const key = `${f.functionName || '(anonymous)'}  ${(f.url || '').replace(/^.*\/(node_modules\/three\/build\/|src\/)/, '$1')}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) || 0) + ms);
    }
    hot = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
      .map(([k, ms]) => `${(100 * ms / total).toFixed(1).padStart(5)}%  ${k}`);
  }

  const probe = await page.evaluate(() => window.__game.probeData());
  const dbg = await page.evaluate(() => window.__game.eventDebug());
  const info = await page.evaluate(() => {
    const r = window.__game.renderer;
    const w = window.__game.world;
    let meshes = 0, shadowCasters = 0;
    w.scene.traverse((o) => { if (o.isMesh) { meshes++; if (o.castShadow) shadowCasters++; } });
    return {
      drawCallsLastFrame: r.info.render.calls, trianglesLastFrame: r.info.render.triangles,
      geometries: r.info.memory.geometries, textures: r.info.memory.textures, programs: r.info.programs && r.info.programs.length,
      meshes, shadowCasters, pixelRatio: r.getPixelRatio(),
      jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      karts: w.karts.map((k) => ({ team: k.teamId, ai: !!k._ai, lap: k.lap, speed: +k.speed.toFixed(1) })),
    };
  });
  const net = await page.evaluate(() => window.__game.netStats());
  for (const p of phones) { clearInterval(p.timer); try { p.ws.close(); } catch {} }

  const fps = probe.frameMs.p50 ? +(1000 / probe.frameMs.p50).toFixed(1) : 0;
  const report = {
    tag: TAG, gpu: gpuName, mode: MODE, players: PLAYERS, viewport: `${WIDTH}x${HEIGHT}`, uncapped: UNCAPPED,
    durationSeconds: DURATION, frames: probe.frames, fpsAtP50: fps,
    frameMs: probe.frameMs, physicsMs: probe.physicsMs, renderSubmitMs: probe.renderMs,
    adaptiveTier: dbg.tier, longFramesOver33ms: dbg.longFrames, scene: info,
    net: net && net.stats, errors, hotFunctions: hot,
  };
  const out = path.join(__dirname, '..', 'docs', 'measurements');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `gpu-${TAG}.json`), JSON.stringify(report, null, 2));
  const r1 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +(+v).toFixed(2)]));
  console.log(JSON.stringify({ tag: TAG, gpu: gpuName, fpsAtP50: fps, frames: probe.frames, frameMs: r1(probe.frameMs), physicsMs: r1(probe.physicsMs), renderSubmitMs: r1(probe.renderMs), tier: dbg.tier, longFrames: dbg.longFrames, drawCalls: info.drawCallsLastFrame, triangles: info.trianglesLastFrame, humanKarts: info.karts.filter((k) => !k.ai && k.team > 0).length, errors: errors.slice(0, 5) }, null, 1));
  if (hot) console.log('\nCPU self time (main thread, sampled):\n' + hot.join('\n'));
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
