'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.INSTABOX_MATRIX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ibx-recycle-keepalive-'));

const test = require('node:test');
const assert = require('node:assert');
const store = require('../lib/store');
const { createKeepalive } = require('../lib/keepalive');

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
