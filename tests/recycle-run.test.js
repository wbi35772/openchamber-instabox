'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runRecycle, reconcileMachine } = require('../lib/recycle');

function harness(machineStates, results = {}) {
  const calls = [];
  let index = 0;
  const direct = {
    async listMachines() {
      calls.push('list');
      return [machineStates[Math.min(index++, machineStates.length - 1)]];
    },
    async power(id, action) {
      calls.push(action);
      if (results.powerError) throw new Error(results.powerError);
    },
    async snapshot() { calls.push('snapshot'); },
  };
  const proxy = {
    async exec(id, cmd) {
      calls.push(`exec:${cmd}`);
      return results.exec ? results.exec(cmd, calls) : { exitCode: 0, stdout: 'ok', stderr: '' };
    },
  };
  return { calls, direct, proxy };
}

test('suspend then resume then verify resets the run', async () => {
  const h = harness([
    { id: 'm_1', state: 'running', runStartedAt: '2026-11-13T00:00:00Z', maxRunMinutes: 480 },
    { id: 'm_1', state: 'suspended', runStartedAt: '2026-11-13T00:00:00Z' },
    { id: 'm_1', state: 'running', runStartedAt: '2026-11-13T07:40:00Z', maxRunMinutes: 480 },
  ]);
  const out = await runRecycle({
    machine: { id: 'm_1', state: 'running', runStartedAt: '2026-11-13T00:00:00Z', maxRunMinutes: 480 },
    config: { verifyCommand: 'docker ps --filter name=proxygate --format "{{.State}}" | grep -q running' },
    status: {},
    direct: h.direct,
    proxy: h.proxy,
    now: () => Date.parse('2026-11-13T07:40:00Z'),
    log() {},
  });
  assert.equal(out.status, 'idle');
  assert.ok(h.calls.includes('suspend'));
  assert.ok(h.calls.includes('resume'));
  assert.equal(out.machine.runStartedAt, '2026-11-13T07:40:00Z');
});

test('cooldown appearing after suspend stops before resume', async () => {
  const h = harness([
    { id: 'm_1', state: 'running', runStartedAt: '2026-11-13T00:00:00Z', maxRunMinutes: 480 },
    { id: 'm_1', state: 'suspended', cooldownUntil: '2026-11-13T09:00:00Z' },
  ]);
  const out = await runRecycle({
    machine: { id: 'm_1', state: 'running', runStartedAt: '2026-11-13T00:00:00Z', maxRunMinutes: 480 },
    config: { verifyCommand: 'true' },
    status: {},
    direct: h.direct,
    proxy: h.proxy,
    now: () => Date.parse('2026-11-13T07:40:00Z'),
    log() {},
  });
  assert.equal(out.status, 'race_cooldown');
  assert.equal(h.calls.includes('resume'), false);
});

test('failed verification runs bootstrap once and degrades after second failure', async () => {
  let n = 0;
  const h = harness([
    { id: 'm_1', state: 'running', runStartedAt: '2026-11-13T00:00:00Z', maxRunMinutes: 480 },
    { id: 'm_1', state: 'suspended' },
    { id: 'm_1', state: 'running', runStartedAt: '2026-11-13T07:40:00Z' },
  ], {
    exec: () => (++n === 1 ? { exitCode: 1, stdout: '', stderr: 'down' } : { exitCode: 0, stdout: 'ok', stderr: '' }),
  });
  const out = await runRecycle({
    machine: { id: 'm_1', state: 'running', runStartedAt: '2026-11-13T00:00:00Z', maxRunMinutes: 480 },
    config: { verifyCommand: 'healthcheck', bootstrapCommand: 'compose up -d' },
    status: {},
    direct: h.direct,
    proxy: h.proxy,
    now: () => Date.parse('2026-11-13T07:40:00Z'),
    log() {},
  });
  assert.equal(out.status, 'degraded');
  assert.ok(h.calls.some((c) => c === 'exec:compose up -d'));
});

test('reconcile resumes a machine left suspended', async () => {
  const h = harness([
    { id: 'm_1', state: 'suspended', runStartedAt: '2026-11-13T00:00:00Z' },
    { id: 'm_1', state: 'running', runStartedAt: '2026-11-13T07:40:00Z' },
  ]);
  const out = await reconcileMachine({
    account: 'wbi',
    machineId: 'm_1',
    status: { status: 'suspended', updatedAt: '2026-11-13T07:20:00Z' },
    config: { verifyCommand: 'true' },
    direct: h.direct,
    proxy: h.proxy,
    now: () => Date.parse('2026-11-13T07:40:00Z'),
    log() {},
  });
  assert.equal(out.status, 'idle');
  assert.ok(h.calls.includes('resume'));
});
