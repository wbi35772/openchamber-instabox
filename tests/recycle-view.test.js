'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.INSTABOX_MATRIX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ibx-recycle-view-'));
const store = require('../lib/store');
const { buildRecycleView } = require('../lib/recycle');

test('buildRecycleView merges config, status and plan', () => {
  const state = store.load();
  store.setRecycleConfig(state, {
    account: 'wbi',
    machineId: 'm_1',
    enabled: true,
    verifyCommand: 'true',
    bootstrapCommand: 'up',
    proxyExitExpect: '1.2.3.4',
  });
  store.upsertRecycleStatus(state, {
    account: 'wbi',
    machineId: 'm_1',
    status: 'idle',
    nextAt: '2026-11-13T07:40:00Z',
    lastRunStartedAt: '2026-11-13T00:00:00Z',
  });
  const view = buildRecycleView(state, Date.parse('2026-11-13T07:00:00Z'));
  assert.equal(view.enabled, false);
  assert.equal(view.machines.length, 1);
  assert.equal(view.machines[0].account, 'wbi');
  assert.equal(view.machines[0].verifyCommand, 'true');
  assert.equal(view.machines[0].bootstrapCommand, 'up');
  assert.equal(view.machines[0].proxyExitExpect, '1.2.3.4');
  assert.equal(view.machines[0].status.status, 'idle');
  assert.equal(view.machines[0].status.nextAt, '2026-11-13T07:40:00Z');
});

test('buildRecycleView without config returns empty machines', () => {
  const view = buildRecycleView(store.load(), Date.now());
  assert.equal(view.machines.length, 0);
  assert.equal(view.enabled, false);
});
