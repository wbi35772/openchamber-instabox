'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const contract = require('../core/contract');

const REFERENCE = path.resolve(
  __dirname, '..', '..', '..',
  'egress matrix', 'openchamber-egress-matrix', 'core', 'contract.js',
);

test('slot ids and egress ports form one 250-slot matrix', () => {
  assert.equal(contract.SLOT_COUNT, 250);
  assert.equal(contract.SLOT_MIN_INDEX, 1);
  assert.equal(contract.SLOT_MAX_INDEX, 250);
  assert.equal(contract.EGRESS_PORT_MIN, 24001);
  assert.equal(contract.EGRESS_PORT_MAX, 24250);
  assert.equal(contract.slotIdForIndex(1), 'slot-001');
  assert.equal(contract.slotIdForIndex(250), 'slot-250');
  assert.equal(contract.egressPortForIndex(1), 24001);
  assert.equal(contract.egressPortForIndex(250), 24250);
  assert.equal(contract.indexForSlotId('slot-007'), 7);
  assert.equal(contract.indexForSlotId('slot-000'), 0);
  assert.equal(contract.indexForSlotId('slot-251'), 0);
  assert.equal(contract.indexForSlotId('nope'), 0);
  assert.equal(contract.egressPortForSlotId('slot-051'), 24051);
  assert.equal(contract.matrixSlotIdForPort(24123), 'slot-123');
  assert.equal(contract.matrixSlotIdForPort(24000), '');
  assert.equal(contract.matrixSlotIdForPort(24251), '');
  assert.equal(contract.isMatrixPort(24001), true);
  assert.equal(contract.isMatrixPort(25001), false);
  assert.throws(() => contract.slotIdForIndex(0), (error) => error.code === 'invalid_slot_index');
  assert.throws(() => contract.slotIdForIndex(251), (error) => error.code === 'invalid_slot_index');
});

test('blocked health states are the three fail-closed states', () => {
  assert.deepEqual(contract.BLOCKED_HEALTH_STATES, ['QUARANTINED', 'WARP_OVERFLOW', 'ROTATING']);
  for (const state of contract.BLOCKED_HEALTH_STATES) {
    assert.equal(contract.HEALTH_STATES.includes(state), true);
    assert.equal(contract.isBlockedHealthState(state), true);
    assert.equal(contract.isBlockedHealthState(state.toLowerCase()), true);
  }
  assert.equal(contract.isBlockedHealthState('ACTIVE'), false);
  assert.equal(contract.isBlockedHealthState('COOLDOWN'), false);
  assert.equal(contract.isBlockedHealthState('anything'), false);
});

test('planes and health states normalize to the contract vocabulary', () => {
  assert.deepEqual(contract.ROUTING_PLANES, ['STRICT_CONTROL', 'ELASTIC_DATA']);
  assert.equal(contract.normalizeRoutingPlane('strict_control'), 'STRICT_CONTROL');
  assert.equal(contract.normalizeRoutingPlane('elastic_data'), 'ELASTIC_DATA');
  assert.equal(contract.normalizeRoutingPlane('bogus'), 'ELASTIC_DATA');
  assert.equal(contract.normalizeRoutingPlane('bogus', 'STRICT_CONTROL'), 'STRICT_CONTROL');
  assert.equal(contract.normalizeHealthState('active'), 'ACTIVE');
  assert.equal(contract.normalizeHealthState('warp_overflow'), 'WARP_OVERFLOW');
  assert.equal(contract.normalizeHealthState('bogus'), 'ACTIVE');
  assert.equal(contract.normalizeHealthState('bogus', 'COOLDOWN'), 'COOLDOWN');
});

test('fingerprints keep the first /64 and the lease id', () => {
  assert.equal(contract.normalizePrefix64('2001:db8:1:2::5'), '2001:db8:1:2::/64');
  assert.equal(contract.normalizePrefix64('[2001:0db8:0000:0000:0000:0000:0000:0001]'), '2001:db8:0:0::/64');
  assert.equal(contract.normalizePrefix64('not-an-address'), '');
  assert.equal(contract.normalizePrefix64(''), '');
  const fingerprint = contract.normalizeFingerprint({
    exitIp: '203.0.113.9',
    ipv6Prefix64: '2001:db8:aa:bb::1',
    asn: 64500,
  }, 'lease-fallback');
  assert.equal(fingerprint.exitIp, '203.0.113.9');
  assert.equal(fingerprint.ipv6Prefix64, '2001:db8:aa:bb::/64');
  assert.equal(fingerprint.asn, '64500');
  assert.equal(fingerprint.leaseId, 'lease-fallback');
  assert.equal(typeof fingerprint.updatedAt, 'number');
  const empty = contract.emptyFingerprint('lease-1');
  assert.equal(empty.leaseId, 'lease-1');
  assert.equal(empty.exitIp, '');
});

test('validateLeaseRecord pins port, plane, health and fingerprint shape', () => {
  const valid = contract.slotRecord({
    matrixSlotId: 'slot-007',
    routingPlane: 'STRICT_CONTROL',
    healthState: 'ACTIVE',
    leaseId: 'lease-7',
    egressFingerprint: { exitIp: '203.0.113.9', ipv6Prefix64: '2001:db8:aa:bb::1' },
  });
  assert.deepEqual(contract.validateLeaseRecord(valid), []);
  assert.deepEqual(contract.validateLeaseRecord(null), ['lease record must be an object']);

  const wrongPort = { ...valid, egressPort: 25001 };
  assert.equal(contract.validateLeaseRecord(wrongPort).some((message) => /egressPort/.test(message)), true);

  const wrongPlane = { ...valid, routingPlane: 'BEST_EFFORT' };
  assert.equal(contract.validateLeaseRecord(wrongPlane).some((message) => /routingPlane/.test(message)), true);

  const wrongHealth = { ...valid, healthState: 'DRAINING' };
  assert.equal(contract.validateLeaseRecord(wrongHealth).some((message) => /healthState/.test(message)), true);

  const badFingerprint = { ...valid, egressFingerprint: { ipv6Prefix64: '2001:db8::1' } };
  assert.equal(contract.validateLeaseRecord(badFingerprint).some((message) => /ipv6Prefix64/.test(message)), true);
});

test('slotRecord fills the contract row and rejects invalid slots', () => {
  const row = contract.slotRecord({
    matrixSlotId: 'slot-250',
    routingPlane: 'STRICT_CONTROL',
    healthState: 'COOLDOWN',
    leaseId: 'lease-250',
  });
  assert.equal(row.matrixSlotId, 'slot-250');
  assert.equal(row.egressPort, 24250);
  assert.equal(row.routingPlane, 'STRICT_CONTROL');
  assert.equal(row.healthState, 'COOLDOWN');
  assert.equal(row.leaseId, 'lease-250');
  assert.equal(row.intentId, '');
  assert.equal(row.key, '');
  assert.equal(row.lastError, null);
  assert.deepEqual(row.stats, {});
  assert.throws(() => contract.slotRecord({ matrixSlotId: 'slot-999' }), (error) => error.code === 'invalid_slot');
});

test('the extension contract matches the egress matrix reference', { skip: !fs.existsSync(REFERENCE) }, () => {
  const reference = require(REFERENCE);
  for (const key of [
    'SLOT_MIN_INDEX', 'SLOT_MAX_INDEX', 'SLOT_COUNT',
    'EGRESS_PORT_BASE', 'EGRESS_PORT_MIN', 'EGRESS_PORT_MAX',
    'ROUTING_PLANES', 'HEALTH_STATES',
  ]) {
    assert.deepEqual(contract[key], reference[key], key);
  }
  if (reference.BLOCKED_HEALTH_STATES) {
    assert.deepEqual(contract.BLOCKED_HEALTH_STATES, reference.BLOCKED_HEALTH_STATES);
  }
  for (const index of [1, 7, 100, 250]) {
    assert.equal(contract.slotIdForIndex(index), reference.slotIdForIndex(index), `slot ${index}`);
    assert.equal(contract.egressPortForIndex(index), reference.egressPortForIndex(index), `port ${index}`);
  }
  assert.equal(
    contract.normalizePrefix64('2001:db8:1:2::5'),
    reference.normalizePrefix64('2001:db8:1:2::5'),
  );
  assert.equal(
    contract.matrixSlotIdForPort(24051),
    reference.matrixSlotIdForPort(24051),
  );
});
