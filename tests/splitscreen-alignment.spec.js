// Guards the split-screen alignment invariant: every GL viewport must line up with the DOM
// HUD panel drawn on top of it, at any window size / pixel ratio / render-scale tier.
const { test, expect } = require('@playwright/test');
const HOST = 'http://127.0.0.1:8081';

async function startRace(page) {
  await page.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 60000 });
  await page.click('#btn-event', { force: true });
  await page.waitForTimeout(500);
  await page.click('#ev-start', { force: true });
  await page.waitForTimeout(300);
  await page.click('#ev-go', { force: true });
  // software rendering needs a while to build the world and step the countdown: keep asking
  for (let i = 0; i < 240; i++) {
    const d = await page.evaluate(() => {
      const s = window.__game.eventDebug();
      if (s.state === 'prerace' || s.state === 'countdown') window.__game.skipEventCountdown();
      return s.state;
    });
    if (d === 'racing') break;
    await page.waitForTimeout(500);
  }
  await page.waitForFunction(() => window.__game.eventDebug().state === 'racing', null, { timeout: 60000 });
  await page.waitForTimeout(1200);
}

async function compare(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#game-canvas');
    const canvas = el.getBoundingClientRect();
    const panels = [...document.querySelectorAll('.sp-panel')];
    const dbg = window.__game.viewportDebug();
    if (!dbg) return { error: 'no viewport data' };
    const rows = panels.map((p, i) => {
      const b = p.getBoundingClientRect();
      const v = dbg.viewports[i];
      if (!v) return { i, missing: true };
      return {
        i,
        dLeft: Math.round(Math.abs(v.css.x - (b.left - canvas.left))),
        dTop: Math.round(Math.abs(v.css.y - (b.top - canvas.top))),
        dW: Math.round(Math.abs(v.css.w - b.width)),
        dH: Math.round(Math.abs(v.css.h - b.height)),
      };
    });
    return { canvas: { w: Math.round(canvas.width), h: Math.round(canvas.height) }, mapping: dbg.mapping, rows };
  });
}

test('six viewports line up with the six HUD panels at 16:9', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(HOST + '/', { waitUntil: 'load' });
  await startRace(page);
  const r = await compare(page);
  expect(r.error).toBeUndefined();
  expect(r.rows.length).toBe(6);
  for (const row of r.rows) {
    expect(row.dLeft).toBeLessThanOrEqual(2);
    expect(row.dTop).toBeLessThanOrEqual(2);
    expect(row.dW).toBeLessThanOrEqual(2);
    expect(row.dH).toBeLessThanOrEqual(2);
  }
  // each viewport must be a third of the width and half the height (3x2 grid)
  for (const row of r.rows) expect(row.dH).toBeLessThanOrEqual(2);
  await page.close();
});

for (const [w, h] of [[1024, 768], [1440, 900], [1920, 1080], [2560, 1080], [900, 1600]]) {
  test(`viewports line up at ${w}x${h}`, async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto(HOST + '/', { waitUntil: 'load' });
    await startRace(page);
    const r = await compare(page);
    expect(r.error).toBeUndefined();
    for (const row of r.rows) {
      expect(row.dLeft).toBeLessThanOrEqual(2);
      expect(row.dTop).toBeLessThanOrEqual(2);
      expect(row.dW).toBeLessThanOrEqual(2);
      expect(row.dH).toBeLessThanOrEqual(2);
    }
    await page.close();
  });
}

test('viewports stay aligned while the render-scale tier changes', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(HOST + '/', { waitUntil: 'load' });
  await startRace(page);
  // force the lowest tier (worst case for buffer/CSS mismatch)
  for (let tier = 0; tier < 5; tier++) await page.evaluate(() => { window.__game.renderer.setPixelRatio(1); });
  await page.evaluate(() => window.__game.setSplitTier && window.__game.setSplitTier(5));
  await page.waitForTimeout(1500);
  const r = await compare(page);
  expect(r.error).toBeUndefined();
  for (const row of r.rows) {
    expect(row.dLeft).toBeLessThanOrEqual(2);
    expect(row.dTop).toBeLessThanOrEqual(2);
    expect(row.dW).toBeLessThanOrEqual(2);
    expect(row.dH).toBeLessThanOrEqual(2);
  }
  await page.close();
});