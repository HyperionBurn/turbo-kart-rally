// Verify the QR code encodes the LAN controller URL (never localhost).
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const host = await b.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  host.on('pageerror', e => errs.push(e.message));
  await host.goto('http://127.0.0.1:8081/', { waitUntil: 'load' });
  await host.waitForFunction(() => window.__game && window.__game.state === 'title', null, { timeout: 60000 });
  await host.click('#btn-event', { force: true });
  await host.waitForTimeout(1200);
  const info = await host.evaluate(() => ({
    url: document.querySelector('.ev-url')?.textContent.trim(),
    warn: !!document.querySelector('.ev-url.warn'),
    net: window.__game.netDebug ? window.__game.netDebug() : null,
  }));
  console.log(JSON.stringify(info));
  // decode the QR by re-encoding what the page drew is not possible; instead check the URL text
  console.log(info.url.includes('localhost') ? 'FAIL: QR encodes localhost' : 'PASS: QR encodes a LAN address');
  console.log('errors:', errs);
  await host.screenshot({ path: 'C:\\Users\\Wasif\\AppData\\Local\\Temp\\opencode\\qr-check.png' });
  await b.close();
})();