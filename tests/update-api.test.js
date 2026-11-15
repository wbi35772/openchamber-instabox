'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOKEN = 'test-service-token';
const PORT = 45000 + Math.floor(Math.random() * 8000);

function request(method, urlPath, payload, withAuth = true) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload));
    const headers = body ? { 'content-type': 'application/json', 'content-length': body.length } : {};
    if (withAuth) headers.authorization = `Bearer ${TOKEN}`;
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: urlPath,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* plain text */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error('timed out');
}

test('update API stores settings and reports status', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ibx-update-api-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'service', 'main.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      OPENCHAMBER_SERVICE_PORT: String(PORT),
      OPENCHAMBER_SERVICE_TOKEN: TOKEN,
      USERPROFILE: home,
      HOME: home,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(() => {
    child.kill();
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  await waitFor(async () => {
    const health = await request('GET', '/health');
    return health.status === 200;
  }, 15000);

  const denied = await request('GET', '/api/update/status', undefined, false);
  assert.equal(denied.status, 401);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));

  const boot = await request('GET', '/api/bootstrap');
  assert.equal(boot.status, 200, output);
  assert.equal(boot.json.version, pkg.version);
  assert.equal(boot.json.settings.update.channel, 'system');
  assert.equal(boot.json.settings.update.ref, 'main');

  const status = await request('GET', '/api/update/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.currentVersion, pkg.version);
  assert.equal(status.json.update.channel, 'system');

  const saved = await request('PUT', '/api/settings', {
    update: { channel: 'custom', proxyUrl: 'http://127.0.0.1:10809' },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.settings.update.channel, 'custom');
  assert.equal(saved.json.settings.update.proxyUrl, 'http://127.0.0.1:10809');
  assert.equal(saved.json.settings.update.repo, boot.json.settings.update.repo);

  const reloaded = await request('GET', '/api/bootstrap');
  assert.equal(reloaded.json.settings.update.channel, 'custom');

  const direct = await request('PUT', '/api/settings', { update: { channel: 'direct' } });
  assert.equal(direct.status, 200);
  assert.equal(direct.json.settings.update.channel, 'direct');
  assert.equal(direct.json.settings.update.proxyUrl, 'http://127.0.0.1:10809', 'proxy is kept for later reuse');

  const bad = await request('PUT', '/api/settings', { update: { channel: 'custom', proxyUrl: 'ftp://nope' } });
  assert.equal(bad.status, 502);
  assert.match(bad.json.error.message, /更新代理地址/);

  const still = await request('GET', '/api/bootstrap');
  assert.equal(still.json.settings.update.channel, 'direct', 'failed save does not mutate settings');
});
