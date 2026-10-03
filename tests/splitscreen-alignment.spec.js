// Guards the split-screen alignment invariant by reading the REAL GL viewport back out of
// three.js (renderer.getViewport returns CSS pixels) and comparing it with the DOM HUD panel
// drawn on top of it — at any window size, pixel ratio and render-scale tier.
const { test, expect } = require('@playwright/test');
const HOST = 'http://127.0.0.1:8081';

// Alignment needs ≥1 connected team: the lobby START guard (correctly) blocks empty
// races. A raw socket join is enough — no browser, no rendering, no input needed.
const WebSocket = require('ws');
async function ensureTeam(name = 'ALIGN') {
  const ws = new WebSocket('ws://127.0.0.1:8081/ws');
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  ws.send(JSON.stringify({ type: 'join', name }));
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('no join reply')), 15000);
    ws.on('message', (d, b) => {
      if (b) return;
      try { const m = JSON.parse(d.toString()); if (m.type === 'joined') { clearTimeout(t); res(m); } } catch {}
    });
  });
  return ws;
}

const openSlots = [];
test.afterAll(async () => { for (const ws of openSlots.splice(0)) { try { ws.close(); } catch {} } });

async function startRace(page) {
  const slot = await ensureTeam();
  openSlots.push(slot);
  // free the slot when the test's page closes so later tests start clean
  page.on('close', () => { try { slot.close(); } catch {} });
    await page.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 60000 });
    await page.click('#btn-event', { force: true });
    await page.waitForTimeout(500);
    // guard must be satisfied before continuing (proves the guard works, too)
    await expect(page.locator('#ev-start')).toBeEnabled({ timeout: 20000 });
    await page.click('#ev-start', { force: true });
    await page.waitForTimeout(300);
    await page.click('#ev-go', { force: true });
  for (let i = 0; i < 240; i++) {
    const s = await page.evaluate(() => {
      const d = window.__game.eventDebug();
      if (d.state === 'prerace' || d.state === 'countdown') window.__game.skipEventCountdown();
      return d.state;
    });
    if (s === 'racing') break;
    await page.waitForTimeout(500);
  }
  await page.waitForFunction(() => window.__game.eventDebug().state === 'racing', null, { timeout: 60000 });
  await page.waitForTimeout(1200);
}

/** Viewports the last REAL frame applied — read back out of three.js inside render(). */
async function realViewports(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#game-canvas');
    const canvas = el.getBoundingClientRect();
    const panels = [...document.querySelectorAll('.sp-panel')];
    const dbg = window.__game.viewportDebug();
    return {
      canvas: { w: Math.round(canvas.width), h: Math.round(canvas.height) },
      mapping: dbg ? dbg.mapping : null,
      gl: (dbg && dbg.viewports) || [],
      panels: panels.map((p) => {
        const b = p.getBoundingClientRect();
        return {
          x: Math.round(b.left - canvas.left), y: Math.round(b.top - canvas.top),
          w: Math.round(b.width), h: Math.round(b.height),
        };
      }),
    };
  });
}

function expectAligned(r) {
  expect(r.gl.length).toBe(6);
  expect(r.panels.length).toBe(6);
  for (let i = 0; i < 6; i++) {
    expect(Math.abs(r.gl[i].x - r.panels[i].x)).toBeLessThanOrEqual(2);
    expect(Math.abs(r.gl[i].y - r.panels[i].y)).toBeLessThanOrEqual(2);
    expect(Math.abs(r.gl[i].w - r.panels[i].w)).toBeLessThanOrEqual(2);
    expect(Math.abs(r.gl[i].h - r.panels[i].h)).toBeLessThanOrEqual(2);
  }
}

test('GL viewports line up with the HUD panels at 16:9', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(HOST + '/', { waitUntil: 'load' });
  await startRace(page);
  expectAligned(await realViewports(page));
  await page.close();
});

// NOTE: viewport sizes are kept modest on purpose. 16:9 is already covered by 1280x720,
// and the software rasterizer (SwiftShader) OOM-crashes Chromium on 1920x1080+ with six
// viewports (Target crashed / worker exit 3221226091). Aspect coverage is preserved with
// smaller buffers: 1600x900 is still 16:9, 1680x720 is still ~21:9 ultrawide.
for (const [w, h, dpr] of [[1024, 768, 1], [1440, 900, 1], [1600, 900, 1], [1680, 720, 1], [900, 1600, 1], [1440, 900, 2]]) {
  test(`GL viewports line up at ${w}x${h} dpr${dpr}`, async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
    await page.goto(HOST + '/', { waitUntil: 'load' });
    await startRace(page);
    expectAligned(await realViewports(page));
    await page.close();
  });
}

test('GL viewports stay aligned at every render-scale tier', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(HOST + '/', { waitUntil: 'load' });
  await startRace(page);
  for (let tier = 0; tier < 6; tier++) {
    await page.evaluate((t) => window.__game.setSplitTier(t), tier);
    await page.waitForTimeout(900);
    const r = await realViewports(page);
    expectAligned(r);
    // and the grid must always be an exact 3x2 split of the canvas
    const rowH = r.gl[0].h, colW = r.gl[0].w;
    for (let i = 1; i < 3; i++) expect(r.gl[i].h).toBeCloseTo(rowH, 0);
    for (let i = 3; i < 6; i++) expect(r.gl[i].h).toBeCloseTo(rowH, 0);
    for (let i = 0; i < 6; i++) expect(r.gl[i].w).toBeCloseTo(colW, 0);
    expect(Math.abs(r.gl[0].h * 2 - r.canvas.h)).toBeLessThanOrEqual(2);
  }
  await page.close();
});