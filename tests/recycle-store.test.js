'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.INSTABOX_MATRIX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ibx-recycle-store-'));
const store = require('../lib/store');

test('recycle defaults are opt-in and clamp config', () => {
  const state = store.load();
  assert.equal(state.settings.recycle.enabled, false);
  assert.deepEqual(state.settings.recycle.machines, {});
  const normalized = store.normalizeRecycleSettings({
    enabled: true,
    leadMinutes: 1,
    minUptimeMinutes: 99999,
    verifyTimeoutMs: 1,
    bootstrapTimeoutSeconds: 1,
    machines: {
      'wbi/m_1': { account: 'wbi', machineId: 'm_1', verifyCommand: 'x'.repeat(5000), bootstrapCommand: 42 },
      bad: { account: 'wbi' },
    },
  });
  assert.equal(normalized.enabled, true);
  assert.equal(normalized.leadMinutes, 5);
  assert.equal(normalized.minUptimeMinutes, 1440);
  assert.equal(normalized.verifyTimeoutMs, 30000);
  assert.equal(normalized.bootstrapTimeoutSeconds, 30);
  assert.equal(normalized.machines['wbi/m_1'].verifyCommand.length, 4000);
  assert.equal(normalized.machines.bad, undefined);
});

test('setRecycleConfig keeps disabled command and removeAccount cascades', () => {
  const state = store.load();
  store.setRecycleConfig(state, { account: 'wbi', machineId: 'm_1', enabled: false, verifyCommand: 'true' });
  assert.equal(store.findRecycleConfig(state, 'wbi', 'm_1').verifyCommand, 'true');
  store.upsertRecycleStatus(state, { account: 'wbi', machineId: 'm_1', status: 'idle', lastRunStartedAt: '2026-11-13T00:00:00Z' });
  store.removeAccount(state, 'wbi');
  assert.equal(store.findRecycleConfig(state, 'wbi', 'm_1'), null);
  assert.equal(store.findRecycleStatus(state, 'wbi', 'm_1'), null);
});
