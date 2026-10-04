// Public-origin support: the lobby URL must encode the origin the host page
// actually arrived on - LAN IP at home, public https URL on Render. Ws-level only.
const { test, expect } = require('@playwright/test');
const WebSocket = require('ws');
const http = require('http');

const WS = 'ws://127.0.0.1:8081/ws';
function connect(headers) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WS, headers ? { headers } : undefined);
    ws.on('open', () => res(ws));
    ws.on('error', rej);
  });
}
function nextMsg(ws, pred, timeout = 15000) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => { ws.off('message', on); rej(new Error('timeout')); }, timeout);
    function on(data, isBinary) {
      if (isBinary) return;
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (pred(m)) { clearTimeout(t); ws.off('message', on); res(m); }
    }
    ws.on('message', on);
  });
}
function get(path) {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:8081' + path, (r) => {
      let s = '';
      r.on('data', (d) => { s += d; });
      r.on('end', () => res({ status: r.statusCode, body: s }));
    }).on('error', rej);
  });
}

test('/healthz answers for orchestrators', async () => {
  const r = await get('/healthz');
  expect(r.status).toBe(200);
  expect(JSON.parse(r.body).ok).toBe(true);
});

test('public Host header yields a public controller URL', async () => {
  const host = await connect({ Host: 'turbo-kart-rally.onrender.com' });
  try {
    host.send(JSON.stringify({ type: 'hostHello' }));
    const m = await nextMsg(host, (x) => x.type === 'session' && !!x.net);
    expect(m.net.public).toBe(true);
    expect(m.net.controllerUrl).toBe('https://turbo-kart-rally.onrender.com/controller');
  } finally { host.close(); }
});

test('LAN Host header keeps the LAN controller URL', async () => {
  const host = await connect({ Host: '192.168.0.184:8081' });
  try {
    host.send(JSON.stringify({ type: 'hostHello' }));
    const m = await nextMsg(host, (x) => x.type === 'session' && !!x.net);
    expect(m.net.public).toBe(false);
    expect(m.net.controllerUrl).toMatch(/^http:\/\/192\.168\.\d+\.\d+:\d+\/controller$/);
  } finally { host.close(); }
});

test('localhost Host header never leaks into the URL', async () => {
  const host = await connect({ Host: 'localhost:8081' });
  try {
    host.send(JSON.stringify({ type: 'hostHello' }));
    const m = await nextMsg(host, (x) => x.type === 'session' && !!x.net);
    expect(m.net.controllerUrl).not.toContain('localhost');
  } finally { host.close(); }
});
