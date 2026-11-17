'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVICE_MAIN = path.join(__dirname, '..', 'service', 'main.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

function request(port, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: options.path || '/',
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function startService(port, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVICE_MAIN], {
      env: {
        ...process.env,
        OPENCHAMBER_SERVICE_PORT: String(port),
        OPENCHAMBER_SERVICE_TOKEN: 'test-token',
        INSTABOX_MATRIX_DATA_DIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`service did not start in time: ${stderr}`));
    }, 15000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes('listening on')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`service exited early (${code}): ${stderr}`));
    });
  });
}

function stopService(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

test('service exposes a public, CORS-enabled instabox bus health endpoint', async () => {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibx-service-bus-'));
  const child = await startService(port, dataDir);
  try {
    const health = await request(port, { path: '/health' });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });

    const bus = await request(port, { path: '/api/v1/instabox/bus-health' });
    assert.equal(bus.status, 200);
    const body = JSON.parse(bus.body);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'instabox-matrix');
    assert.equal(body.runningMachines, 0);
    assert.equal(body.activeLeases, 0);
    assert.equal(body.tunnelledMachines, 0);
    assert.equal(bus.headers['access-control-allow-origin'], '*');

    const preflight = await request(port, {
      path: '/api/v1/instabox/bus-health',
      method: 'OPTIONS',
      headers: {
        origin: 'http://127.0.0.1:19882',
        'access-control-request-headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'http://127.0.0.1:19882');
    assert.match(preflight.headers['access-control-allow-methods'], /GET/);
  } finally {
    await stopService(child);
  }
});
