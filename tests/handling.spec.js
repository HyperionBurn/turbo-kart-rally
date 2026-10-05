// Driving feel for phone-driven karts: rocket-start timing, smart steering and analog steer.
// Synthetic phones are WebSocket clients in the host's room streaming real 24-byte packets.
const { test, expect } = require('@playwright/test');
const WebSocket = require('ws');

const HOST = 'http://127.0.0.1:8081';
const WS = 'ws://127.0.0.1:8081/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function packet(p, { steer = 0, throttle = 0, brake = 0, flags = 0 }) {
  const b = new Uint8Array(24); const v = new DataView(b.buffer);
  b[0] = 0x54; b[1] = 0x01;
  v.setUint16(2, p.teamId, true); v.setUint32(4, p.sessionId, true); v.setUint32(8, p.seq++, true);
  v.setFloat64(12, Date.now(), true);
  v.setInt8(20, Math.round(Math.max(-1, Math.min(1, steer)) * 127));
  b[21] = Math.round(throttle * 255); b[22] = Math.round(brake * 255); b[23] = flags;
  return b;
}
async function joinPhone(room, name, idx) {
  const ws = new WebSocket(WS);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  const p = { ws, seq: 0, teamId: 0, sessionId: 0, input: {}, countdown: [] };
  ws.on('message', (d, bin) => {
    if (bin) return;
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    if (m.type === 'countdown') p.countdown.push(m.n);
    if (p.onCountdown && m.type === 'countdown') p.onCountdown(m.n);
  });
  ws.send(JSON.stringify({ type: 'join', room, name }));
  await new Promise((res) => ws.on('message', (d, bin) => {
    if (bin) return;
    const m = JSON.parse(d.toString());
    if (m.type === 'joined') { p.teamId = m.teamId; p.sessionId = m.sessionId; res(); }
  }));
  ws.send(JSON.stringify({ type: 'select', characterIdx: idx }));
  ws.send(JSON.stringify({ type: 'ready', ready: true }));
  p.timer = setInterval(() => { try { ws.send(packet(p, p.input)); } catch {} }, 16);
  return p;
}
async function hostWithPhones(browser, n) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(HOST + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 60000 });
  await page.click('#btn-event', { force: true });
  await page.waitForFunction(() => !!window.__game.eventRoom);
  const room = await page.evaluate(() => window.__game.eventRoom);
  await page.evaluate(() => window.__game.send({ type: 'hostSettings', settings: { aiFill: 0, items: false, laps: 3, cameraMode: 'broadcast' } }));
  const phones = [];
  for (let i = 0; i < n; i++) phones.push(await joinPhone(room, `H${i + 1}`, i));
  await page.waitForFunction((k) => document.querySelectorAll('.slot.ready').length >= k, n, { timeout: 15000 });
  return { page, phones, room };
}
function closeAll(phones) { for (const p of phones) { clearInterval(p.timer); try { p.ws.terminate(); } catch {} } }
async function startRace(page) {
  await page.click('#ev-start', { force: true });
  await page.waitForTimeout(300);
  await page.click('#ev-go', { force: true });
  await page.waitForFunction(() => ['countdown', 'racing'].includes(window.__game.eventDebug().state), null, { timeout: 60000 });
}

test('phone karts get Mario Kart rocket starts: press at "1" boosts, holding from "3" stalls', async ({ browser }) => {
  test.setTimeout(180000);
  const { page, phones } = await hostWithPhones(browser, 3);
  try {
    // P1 presses GAS when the "1" arrives, P2 holds GAS from the "3", P3 waits for GO
    phones[0].onCountdown = (n) => { if (n === 1) phones[0].input = { throttle: 1 }; };
    phones[1].onCountdown = (n) => { if (n === 3) phones[1].input = { throttle: 1 }; };
    await page.evaluate(() => {
      window.__starts = {};
      const bus = window.__game.bus;
      bus.on('kart:boost', (d) => { if (d.source === 'start') window.__starts[d.kart.teamId] = 'boost'; });
      bus.on('kart:stall', (d) => { window.__starts[d.kart.teamId] = 'stall'; });
    });
    await startRace(page);
    await page.waitForFunction(() => window.__game.eventDebug().state === 'racing', null, { timeout: 60000 });
    await page.waitForTimeout(300);
    const starts = await page.evaluate(() => window.__starts);
    expect(phones[0].countdown).toEqual(expect.arrayContaining([3, 2, 1]));
    expect(starts[phones[0].teamId]).toBe('boost');
    expect(starts[phones[1].teamId]).toBe('stall');
    expect(starts[phones[2].teamId]).toBeUndefined();
    expect(page.errors).toEqual([]);
  } finally {
    closeAll(phones);
    await page.close();
  }
});

test('smart steering keeps a hands-off kart on the road; without it the kart leaves', async ({ browser }) => {
  test.setTimeout(180000);
  const { page, phones } = await hostWithPhones(browser, 4);
  try {
    // full throttle, thumbs off the steering: two karts with the assist, two without
    phones.forEach((p, i) => { p.input = { throttle: 1, steer: 0, flags: i < 2 ? 32 : 0 }; });
    await startRace(page);
    await page.evaluate(() => window.__game.skipEventCountdown());
    await page.waitForFunction(() => window.__game.eventDebug().state === 'racing', null, { timeout: 60000 });
    await page.waitForTimeout(500); // latest packets (with flags) are in
    const res = await page.evaluate(() => {
      const w = window.__game.world;
      for (const k of w.karts) {
        k._off = 0;
        const upd = k.update.bind(k);
        k.update = (dt) => { upd(dt); if (k.surface === 'offroad') k._off += dt; };
      }
      window.__game.simulateFor(20);
      return w.karts.filter((k) => k.teamId > 0).map((k) => ({ team: k.teamId, ai: !!k._ai, assist: !!(k.input && k.input.assist), offroadSeconds: +k._off.toFixed(1), progress: +(k.raceProgress || 0).toFixed(3) }));
    }, null);
    // only the four phone-driven karts (the two empty slots are AI-driven)
    const phoneTeams = new Set(phones.map((p) => p.teamId));
    const all = res;
    res.splice(0, res.length, ...all.filter((r) => phoneTeams.has(r.team)));
    expect(all.filter((r) => !phoneTeams.has(r.team)).every((r) => r.ai)).toBe(true);
    const withAssist = res.filter((r) => r.assist);
    const without = res.filter((r) => !r.assist);
    expect(withAssist).toHaveLength(2);
    expect(without).toHaveLength(2);
    const avg = (a, f) => a.reduce((s, r) => s + r[f], 0) / a.length;
    console.log('smart steering, 20 s hands-off:', JSON.stringify(res));
    expect(avg(withAssist, 'offroadSeconds')).toBeLessThan(avg(without, 'offroadSeconds') * 0.5);
    expect(avg(withAssist, 'progress')).toBeGreaterThan(avg(without, 'progress'));
  } finally {
    closeAll(phones);
    await page.close();
  }
});

test('the phone steering bar is analog: a partial slide reaches the kart as a partial steer', async ({ browser }) => {
  test.setTimeout(180000);
  const { page, phones, room } = await hostWithPhones(browser, 0);
  const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  const ph = await ctx.newPage();
  try {
    await ph.goto(`${HOST}/controller?room=${room}`, { waitUntil: 'load' });
    await ph.fill('#name-input', 'ANALOG');
    await ph.click('#join-btn');
    await expect(ph.locator('#view-lobby')).toHaveClass(/active/, { timeout: 15000 });
    await ph.click('#ready-btn');
    await page.waitForFunction(() => document.querySelectorAll('.slot.ready').length >= 1, null, { timeout: 15000 });
    // the mapping itself: centre = straight, inner part of a button = partial, its middle and beyond = full lock
    const map = await ph.evaluate(() => {
      document.querySelector('#view-race').classList.add('active');
      const r = document.querySelector('.pad-row').getBoundingClientRect();
      const at = (u) => window.__tkr.steerFromEvent({ clientX: r.left + r.width / 2 + u * r.width / 2, clientY: r.top + r.height / 2 }, 0);
      return { centre: at(0), quarterRight: at(0.25), buttonMiddleRight: at(0.52), edgeLeft: at(-0.98) };
    });
    expect(map.centre).toBe(0);
    expect(map.quarterRight).toBeGreaterThan(0.2);
    expect(map.quarterRight).toBeLessThan(0.6);
    expect(map.buttonMiddleRight).toBe(1);
    expect(map.edgeLeft).toBe(-1);

    await startRace(page);
    await page.evaluate(() => window.__game.skipEventCountdown());
    await page.waitForFunction(() => window.__game.eventDebug().state === 'racing', null, { timeout: 60000 });
    await expect(ph.locator('#view-race')).toHaveClass(/active/, { timeout: 15000 });
    // a real (trusted) pointer: press on the right button, then slide back toward the centre
    const box = await ph.locator('.pad-row').boundingBox();
    const cy = box.y + box.height / 2;
    await ph.mouse.move(box.x + box.width * 0.8, cy);
    await ph.mouse.down();
    await ph.mouse.move(box.x + box.width * 0.62, cy, { steps: 4 });
    // the host applies input on its next physics step (headless software rendering is slow)
    await page.waitForFunction(() => {
      const k = window.__game.world.karts.find((x) => x.teamId > 0);
      return k && k.input && Math.abs(k.input.steer) > 0.05;
    }, null, { timeout: 20000 });
    const steer = await page.evaluate(() => window.__game.world.karts.find((x) => x.teamId > 0).input.steer);
    await ph.mouse.up();
    expect(steer).toBeGreaterThan(0.2);
    expect(steer).toBeLessThan(0.75);
    await page.waitForFunction(() => Math.abs(window.__game.world.karts.find((x) => x.teamId > 0).input.steer) < 0.02, null, { timeout: 20000 });
  } finally {
    closeAll(phones);
    await ctx.close();
    await page.close();
  }
});
