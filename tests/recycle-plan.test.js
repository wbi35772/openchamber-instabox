'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { leadMsFor, planRecycle, nextRecycleAt } = require('../lib/recycle');

const base = { id: 'm_1', state: 'running', runStartedAt: '2026-11-13T00:00:00Z', maxRunMinutes: 480 };
const config = { enabled: true, leadMinutes: null, minUptimeMinutes: 60, verifyCommand: 'true' };
const now = Date.parse('2026-11-13T07:35:00Z');

test('lead clamps to 10-30 minutes', () => {
  assert.equal(leadMsFor(480, null), 30 * 60000);
  assert.equal(leadMsFor(120, null), 12 * 60000);
  assert.equal(leadMsFor(60, null), 10 * 60000);
  assert.equal(leadMsFor(480, 45), 45 * 60000);
});

test('nextRecycleAt subtracts the lead from max run', () => {
  assert.equal(nextRecycleAt({ runStartedAt: base.runStartedAt, maxRunMinutes: 480, leadMinutes: null }), Date.parse('2026-11-13T07:30:00Z'));
  assert.equal(nextRecycleAt({ runStartedAt: null, maxRunMinutes: 480, leadMinutes: null }), null);
  assert.equal(nextRecycleAt({ runStartedAt: base.runStartedAt, maxRunMinutes: 0, leadMinutes: null }), null);
});

test('due only inside the lead window and never in cooldown', () => {
  assert.equal(planRecycle({ machine: base, config, status: {}, now }).due, true);
  const early = { ...base, runStartedAt: '2026-11-13T05:30:00Z' };
  assert.equal(planRecycle({ machine: early, config, status: {}, now }).reason, 'not_due');
  const cooling = { ...base, cooldownUntil: '2026-11-13T08:00:00Z' };
  assert.equal(planRecycle({ machine: cooling, config, status: {}, now }).reason, 'cooldown');
  const done = { ...base, runStartedAt: '2026-11-12T00:00:00Z' };
  assert.equal(planRecycle({ machine: done, config, status: { lastRunStartedAt: done.runStartedAt }, now }).reason, 'already_recycled');
  assert.equal(planRecycle({ machine: { ...base, runStartedAt: null }, config, status: {}, now }).reason, 'invalid_run_start');
  assert.equal(planRecycle({ machine: base, config: { ...config, verifyCommand: '' }, status: {}, now }).reason, 'not_configured');
  assert.equal(planRecycle({ machine: base, config, status: { status: 'degraded' }, now }).reason, 'degraded');
  assert.equal(planRecycle({ machine: base, config: { ...config, enabled: false }, status: {}, now }).reason, 'disabled');
  assert.equal(planRecycle({ machine: base, config: { ...config, machineEnabled: false }, status: {}, now }).reason, 'machine_disabled');
  assert.equal(planRecycle({ machine: { ...base, maxRunMinutes: 0 }, config, status: {}, now }).reason, 'invalid_max_run');
  assert.equal(planRecycle({ machine: { ...base, state: 'suspended' }, config, status: {}, now }).reason, 'not_running');
  assert.equal(planRecycle({ machine: { ...base, runStartedAt: '2026-11-13T07:10:00Z' }, config, status: {}, now }).reason, 'uptime_low');
});

test('a recycled run becomes due again at its own next cadence', () => {
  const status = { lastRunStartedAt: base.runStartedAt, lastRecycleAt: '2026-11-13T00:05:00Z' };
  assert.equal(planRecycle({ machine: base, config, status, now }).due, true);
  const fresh = { lastRunStartedAt: base.runStartedAt, lastRecycleAt: '2026-11-13T07:00:00Z' };
  assert.equal(planRecycle({ machine: base, config, status: fresh, now }).reason, 'already_recycled');
});
