// Playwright test suite for the event-mode flow.
// Run with: npm test
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 180000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8081',
    headless: true,
    viewport: { width: 1280, height: 720 },
  },
  webServer: {
    command: 'node server/server.js',
    url: 'http://127.0.0.1:8081/diagnostics',
    reuseExistingServer: true,
    timeout: 30000,
  },
});