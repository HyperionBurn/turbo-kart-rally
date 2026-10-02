const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const host = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  const watch = (p, tag) => {
    p.on('pageerror', e => errs.push(tag + ' PAGEERROR: ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push(tag + ': ' + m.text()); });
  };
  watch(host, 'host');
  await host.goto('http://127.0.0.1:8080/', { waitUntil: 'load' });
  await host.waitForTimeout(2500);
  await host.click('#btn-event');
  await host.waitForTimeout(1000);

  const controllers = [];
  for (let i = 0; i < 6; i++) {
    const ctx = await b.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
    const p = await ctx.newPage();
    watch(p, 'c' + (i + 1));
    await p.goto('http://127.0.0.1:8080/controller', { waitUntil: 'load' });
    await p.fill('#name-input', 'Team ' + (i + 1));
    await p.click('#join-btn');
    await p.waitForTimeout(500);
    controllers.push(p);
  }
  await host.waitForTimeout(1000);
  const connectedSlots = await host.evaluate(() => document.querySelectorAll('.slot.on').length);
  console.log('host sees connected slots:', connectedSlots);

  for (let i = 0; i < 6; i++) {
    await controllers[i].click(`.char[data-i="${i}"]`);
    await controllers[i].click('#ready-btn');
  }
  await host.waitForTimeout(800);
  const readySlots = await host.evaluate(() => document.querySelectorAll('.slot.ready').length);
  console.log('host ready slots:', readySlots);

  await host.click('#ev-start');
  await host.waitForTimeout(600);
  await host.click('#ev-go');
  await host.waitForTimeout(4000);
  console.log('state after start:', await host.evaluate(() => document.body.dataset.state));
  await host.screenshot({ path: 'C:\\Users\\Wasif\\AppData\\Local\\Temp\\opencode\\event-race.png' });

  await controllers[0].dispatchEvent('#ctl-gas', 'pointerdown');
  await host.waitForTimeout(2000);
  await controllers[0].dispatchEvent('#ctl-gas', 'pointerup');
  const kart0 = await host.evaluate(() => {
    const w = window.__game.world;
    return w && w.mode === 'event'
      ? { karts: w.karts.length, lap: w.karts[0].lap, speed: w.karts[0].speed.toFixed(1), trackT: w.karts[0].trackT.toFixed(3) }
      : 'no-world';
  });
  console.log('kart0:', JSON.stringify(kart0));
  console.log('errors:', errs.slice(0, 12));
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
