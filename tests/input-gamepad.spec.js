// Xbox / PlayStation Bluetooth controller support: identity, mapping, multi-pad
// selection, rumble, hot-plug. Real Gamepad API hardware can't exist headless,
// so stub navigator.getGamepads in-page and drive the real InputController.
const { test, expect } = require('@playwright/test');
const HOST = 'http://127.0.0.1:8081';

function stubPad(o = {}) {
  const btns = [];
  for (let i = 0; i < 17; i++) btns.push({ pressed: false, value: 0 });
  for (const [i, v] of Object.entries(o.buttons || {})) {
    btns[+i] = typeof v === 'object' ? v : { pressed: !!v, value: v ? 1 : 0 };
  }
  return {
    id: o.id || 'Xbox 360 Controller (XInput STANDARD GAMEPAD Vendor: 045e Product: 02e0)',
    mapping: o.mapping === undefined ? 'standard' : o.mapping,
    connected: o.connected === undefined ? true : o.connected,
    axes: o.axes || [0, 0, 0, 0],
    buttons: btns,
    vibrationActuator: o.rumble === false ? undefined : { playEffect: () => Promise.resolve(true) },
    _rumbled: [],
  };
}

async function boot(page) {
  await page.goto(HOST + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 60000 });
  await page.evaluate(() => {
    window.__pads = [];
    Object.defineProperty(window.navigator, 'getGamepads', {
      value: () => window.__pads, configurable: true,
    });
  });
  return page.evaluate(async () => {
    const m = await import('/src/input.js');
    window.__input = { ...m, ctl: new m.InputController({ target: null }) };
    return !!window.__input.ctl;
  });
}
async function setPads(page, pads) {
  await page.evaluate((ps) => {
    window.__pads.length = 0;
    for (const p of ps) window.__pads.push(p);
  }, pads);
}
// Playwright structured-clones page objects; rebuild stubs from plain descriptors instead.
async function setPadDescs(page, descs) {
  await page.evaluate((ds) => {
    window.__pads.length = 0;
    for (const d of ds) {
      const btns = [];
      for (let i = 0; i < 17; i++) btns.push({ pressed: false, value: 0 });
      for (const k of Object.keys(d.buttons || {})) {
        const v = d.buttons[k];
        btns[+k] = typeof v === 'object' ? v : { pressed: !!v, value: v ? 1 : 0 };
      }
      const calls = [];
      window.__pads.push({
        id: d.id, mapping: d.mapping === undefined ? 'standard' : d.mapping,
        connected: d.connected === undefined ? true : d.connected,
        axes: d.axes || [0, 0, 0, 0], buttons: btns,
        vibrationActuator: d.rumble === false ? undefined : {
          playEffect: (type, opts) => { calls.push({ type, opts }); window.__rumbleCalls.push({ type, opts }); return Promise.resolve(true); },
        },
      });
    }
  }, descs);
  await page.evaluate(() => { window.__rumbleCalls = window.__rumbleCalls || []; });
}

const XBOX_ID = 'Xbox 360 Controller (XInput STANDARD GAMEPAD Vendor: 045e Product: 02e0)';
const DS_ID = 'DualSense wireless controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';
const DS4_ID = 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 05c4)';

test('identifies Xbox, DualSense, DualShock 4 and generic pads', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await boot(page);
  const out = await page.evaluate((ids) => {
    const m = window.__input;
    return ids.map((id) => m.identifyGamepad(id));
  }, [XBOX_ID, DS_ID, DS4_ID, 'Some USB Gamepad']);
  expect(out[0].type).toBe('xbox');
  expect(out[1].type).toBe('playstation');
  expect(out[1].label).toMatch(/DualSense/);
  expect(out[2].type).toBe('playstation');
  expect(out[3].type).toBe('generic');
  expect(await page.evaluate(() => window.__input.padHint('playstation'))).toMatch(/✕/);
  expect(await page.evaluate(() => window.__input.padHint('xbox'))).toMatch(/A gas/);
  await page.close();
});

test('Xbox stick + triggers drive kart input with deadzone', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await boot(page);
  await setPadDescs(page, [{ id: XBOX_ID, axes: [0.5, 0, 0, 0], buttons: { 7: { pressed: true, value: 0.8 } } }]);
  await page.waitForTimeout(60);
  const inp = await page.evaluate(() => window.__input.ctl.getInput());
  expect(inp.throttle).toBeGreaterThan(0.7);
  expect(inp.steer).toBeGreaterThan(0.2);
  expect(await page.evaluate(() => window.__input.ctl.gamepadConnected)).toBe(true);
  // tiny stick deflection inside the deadzone steers nothing
  await setPadDescs(page, [{ id: XBOX_ID, axes: [0.05, 0, 0, 0] }]);
  await page.waitForTimeout(60);
  const inp2 = await page.evaluate(() => window.__input.ctl.getInput());
  expect(Math.abs(inp2.steer)).toBeLessThan(0.01);
  await page.close();
});

test('DualSense item button is edge-triggered exactly once', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await boot(page);
  await setPadDescs(page, [{ id: DS_ID }]);
  await page.waitForTimeout(60);
  // press triangle (button 3)
  await setPadDescs(page, [{ id: DS_ID, buttons: { 3: true } }]);
  await page.waitForTimeout(60);
  const a = await page.evaluate(() => window.__input.ctl.getInput().item);
  const b = await page.evaluate(() => window.__input.ctl.getInput().item);
  expect(a).toBe(true);
  expect(b).toBe(false);
  expect(await page.evaluate(() => window.__input.ctl.consumePressed('pause'))).toBe(false);
  // START (button 9) latches pause exactly once
  await setPadDescs(page, [{ id: DS_ID, buttons: { 9: true } }]);
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => window.__input.ctl.consumePressed('pause'))).toBe(true);
  expect(await page.evaluate(() => window.__input.ctl.consumePressed('pause'))).toBe(false);
  await page.close();
});

test('second pad takes over on START; disconnect falls back gracefully', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await boot(page);
  await setPadDescs(page, [{ id: XBOX_ID }, { id: DS_ID }]);
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => { window.__input.ctl.getInput(); return window.__input.ctl.padIndex; })).toBe(0);
  // START on pad 1 steals selection
  await setPadDescs(page, [{ id: XBOX_ID }, { id: DS_ID, buttons: { 9: true } }]);
  await page.waitForTimeout(60);
  await page.evaluate(() => window.__input.ctl.getInput());
  expect(await page.evaluate(() => window.__input.ctl.padIndex)).toBe(1);
  expect(await page.evaluate(() => window.__input.ctl.padInfo.type)).toBe('playstation');
  // pad 1 vanishes -> falls back to pad 0, game never stalls
  await setPadDescs(page, [{ id: XBOX_ID, connected: false }, { id: DS_ID }]);
  await page.waitForTimeout(60);
  await page.evaluate(() => window.__input.ctl.getInput());
  expect(await page.evaluate(() => window.__input.ctl.padIndex)).toBe(1);
  // all pads gone -> keyboard path, connected false
  await setPadDescs(page, []);
  await page.waitForTimeout(60);
  await page.evaluate(() => window.__input.ctl.getInput());
  expect(await page.evaluate(() => window.__input.ctl.gamepadConnected)).toBe(false);
  await page.close();
});

test('rumble fires on capable pads and never throws without an actuator', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await boot(page);
  await setPadDescs(page, [{ id: XBOX_ID }]);
  await page.waitForTimeout(60);
  await page.evaluate(() => { window.__rumbleCalls = []; window.__input.ctl.getInput(); });
  const ok = await page.evaluate(() => window.__input.ctl.rumble({ strong: 0.9, weak: 0.2, duration: 150 }));
  expect(ok).toBe(true);
  const calls = await page.evaluate(() => window.__rumbleCalls);
  expect(calls.length).toBe(1);
  expect(calls[0].type).toBe('dual-rumble');
  expect(calls[0].opts.strongMagnitude).toBeCloseTo(0.9, 2);
  // pad without actuator: silent false, no throw
  await setPadDescs(page, [{ id: XBOX_ID, rumble: false }]);
  await page.waitForTimeout(60);
  await page.evaluate(() => window.__input.ctl.getInput());
  expect(await page.evaluate(() => window.__input.ctl.rumbleSupported())).toBe(false);
  expect(await page.evaluate(() => window.__input.ctl.rumble({}))).toBe(false);
  await page.close();
});

test('non-standard mapping warns once and keeps reading', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const warns = [];
  page.on('console', (m) => { if (m.type() === 'warning') warns.push(m.text()); });
  await boot(page);
  await setPadDescs(page, [{ id: 'Old Pad', mapping: '' }]);
  await page.waitForTimeout(60);
  await page.evaluate(() => window.__input.ctl.getInput());
  expect(await page.evaluate(() => window.__input.ctl.nonStandardMapping)).toBe(true);
  expect(warns.some((w) => /non-standard/i.test(w))).toBe(true);
  await page.close();
});
