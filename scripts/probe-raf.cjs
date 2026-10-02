const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 640, height: 360 } });
  await p.goto('http://127.0.0.1:8080/', { waitUntil: 'load' });
  await p.waitForTimeout(2500);
  const raf = await p.evaluate(() => new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else res({ frames: n, ms: performance.now() - t0 }); };
    requestAnimationFrame(tick);
  }));
  console.log('solo rAF:', JSON.stringify(raf), 'fps', (raf.frames / (raf.ms / 1000)).toFixed(1));
  await b.close();
})();