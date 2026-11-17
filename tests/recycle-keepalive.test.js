'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.INSTABOX_MATRIX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ibx-recycle-keepalive-'));

const test = require('node:test');
const assert = require('node:assert');
const store = require('../lib/store');
const { createKeepalive, shouldCheckTunnel } = require('../lib/keepalive');

test('busy machines are skipped by the keepalive tick', async () => {
  let fetches = 0;
  const keepalive = createKeepalive({
    isBusy: (account, machineId) => machineId === 'm_busy',
    clientFor: () => ({
      async listMachines() { fetches += 1; return []; },
      async putLease() { fetches += 1; },
      async deleteLease() {},
    }),
  });
  store.save({
    ...store.load(),
    keepalive: [
      { account: 'wbi', machineId: 'm_busy', enabled: true, mode: 'lease', ttlSeconds: 900, leaseId: 'oc-1', expiresAt: null },
      { account: 'wbi', machineId: 'm_free', enabled: true, mode: 'lease', ttlSeconds: 900, leaseId: '', expiresAt: null },
    ],
  });
  await keepalive.tick(Date.now() + 1);
  assert.equal(fetches, 1);
});

test('keepalive release routes through the injected proxy-aware client', async () => {
  store.save({
    ...store.load(),
    accounts: [{ alias: 'wbi', apiKey: 'ibk_test', enabled: true }],
    keepalive: [{ account: 'wbi', machineId: 'm_rel', enabled: true, leaseId: 'oc-9' }],
  });
  let deleted = null;
  const keepalive = createKeepalive({
    clientFor: (alias) => ({
      async deleteLease(machineId, leaseId) { deleted = `${alias}/${machineId}/${leaseId}`; },
    }),
  });
  assert.equal(await keepalive.release('wbi', 'm_rel'), true);
  assert.equal(deleted, 'wbi/m_rel/oc-9');
});

test('shouldCheckTunnel throttles by the configured interval', () => {
  assert.equal(shouldCheckTunnel(undefined, 1000, 60000), true);
  assert.equal(shouldCheckTunnel(null, 1000, 60000), true);
  assert.equal(shouldCheckTunnel(1000, 60999, 60000), false);
  assert.equal(shouldCheckTunnel(1000, 61000, 60000), true);
  assert.equal(shouldCheckTunnel(1000, 2000, 0), true);
});

test('keepalive checks the tunnel on the interval and restarts a dead cloudflared', async () => {
  store.save({
    ...store.load(),
    accounts: [{ alias: 'wbi', apiKey: 'ibk_test', enabled: true }],
    keepalive: [{
      account: 'wbi',
      machineId: 'm_tunnel',
      enabled: true,
      mode: 'lease',
      ttlSeconds: 900,
      leaseId: 'oc-t',
      expiresAt: null,
    }],
  });
  const checks = [];
  const restarts = [];
  const keepalive = createKeepalive({
    clientFor: () => ({
      async listMachines() { return []; },
      async putLease() { return { expiresAt: new Date(Date.now() + 900000).toISOString() }; },
      async deleteLease() {},
    }),
    tunnelCheckMs: 60000,
    tunnel: {
      async check(entry) {
        checks.push(entry.machineId);
        return { ok: false, running: false };
      },
      async restart(entry) {
        restarts.push(entry.machineId);
        return { ok: true, restarted: true };
      },
    },
  });
  try {
    const t0 = Date.now();
    await keepalive.tick(t0);
    assert.deepEqual(checks, ['m_tunnel']);
    assert.deepEqual(restarts, ['m_tunnel']);

    await keepalive.tick(t0 + 1000);
    assert.deepEqual(checks, ['m_tunnel']);

    await keepalive.tick(t0 + 60001);
    assert.deepEqual(checks, ['m_tunnel', 'm_tunnel']);
    assert.deepEqual(restarts, ['m_tunnel', 'm_tunnel']);
  } finally {
    keepalive.stop();
  }
});

test('keepalive leaves a healthy cloudflared alone', async () => {
  store.save({
    ...store.load(),
    accounts: [{ alias: 'wbi', apiKey: 'ibk_test', enabled: true }],
    keepalive: [{
      account: 'wbi',
      machineId: 'm_tunnel_ok',
      enabled: true,
      mode: 'lease',
      ttlSeconds: 900,
      leaseId: 'oc-ok',
      expiresAt: null,
    }],
  });
  const restarts = [];
  const keepalive = createKeepalive({
    clientFor: () => ({
      async listMachines() { return []; },
      async putLease() { return { expiresAt: new Date(Date.now() + 900000).toISOString() }; },
      async deleteLease() {},
    }),
    tunnelCheckMs: 0,
    tunnel: {
      async check() { return { ok: true, running: true }; },
      async restart(entry) { restarts.push(entry.machineId); return { ok: true }; },
    },
  });
  try {
    await keepalive.tick(Date.now() + 1);
    assert.deepEqual(restarts, []);
  } finally {
    keepalive.stop();
  }
});
