// Host-side measurement harness: real game page + N synthetic controllers, samples
// frame time / physics / render / network and writes a JSON report.
//   node scripts/measure-host.cjs --clients 6 --duration 30 --tag six-normal
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i].replace(/^--/, '');
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[a] = true; else { args[a] = next; i++; }
}
const CLIENTS = +(args.clients || 6);
const DURATION = +(args.duration || 20);
const TAG = args.tag && args.tag !== true ? args.tag : 'run';
const HOST = args.host || 'http://127.0.0.1:8081';
const WIDTH = +(args.width || 1280), HEIGHT = +(args.height || 720);
const OUT = path.join(__dirname, '..', 'docs', 'measurements');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(HOST + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 60000 });
  await page.click('#btn-event');
  await page.waitForTimeout(600);
  await page.click('#ev-start');
  await page.waitForTimeout(400);
  if (args.broadcast) await page.evaluate(() => window.__game.send({ type: 'hostSettings', settings: { cameraMode: 'broadcast' } }));
  if (args.items === 'off') await page.evaluate(() => window.__game.send({ type: 'hostSettings', settings: { items: false } }));
  await page.waitForTimeout(400);
  await page.click('#ev-go');
  await page.waitForTimeout(1200);
  // headless software rendering is far too slow for the 3.5 s countdown to be meaningful
  await page.evaluate(() => window.__game.skipEventCountdown());
  await page.waitForFunction(() => window.__game.eventDebug().state === 'racing', null, { timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.__game.enableProbe());

  const stress = path.join(__dirname, 'stress.cjs');
  const stressArgs = [stress, '--clients', String(CLIENTS), '--duration', String(DURATION), '--client-only'];
  if (args.fault && args.fault !== true) stressArgs.push('--fault', String(args.fault));
  if (args.frantic) stressArgs.push('--frantic');
  const child = require('child_process').spawn('node', stressArgs, { encoding: 'utf8' });
  let stressOut = '';
  child.stdout.on('data', d => { stressOut += d; });
  child.stderr.on('data', d => { stressOut += d; });

  await new Promise(r => setTimeout(r, DURATION * 1000));
  child.kill();

  const probe = await page.evaluate(() => window.__game.probeData());
  const dbg = await page.evaluate(() => window.__game.eventDebug());
  const net = await page.evaluate(() => window.__game.netStats());
  const report = {
    tag: TAG, clients: CLIENTS, durationSeconds: DURATION, viewport: `${WIDTH}x${HEIGHT}`,
    fault: args.fault || null, frantic: !!args.frantic,
    frameMs: probe.frameMs, physicsMs: probe.physicsMs, renderMs: probe.renderMs,
    finalDebug: dbg, net, stress: stressOut, errors,
  };
  fs.writeFileSync(path.join(OUT, `${TAG}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ tag: TAG, frameMs: probe.frameMs, physicsMs: probe.physicsMs, renderMs: probe.renderMs, errors: errors.slice(0, 5) }, null, 1));
  console.log(stressOut);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });