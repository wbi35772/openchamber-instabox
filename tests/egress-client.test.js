'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createEgressClient } = require('../lib/egress-client');

function fakeBus(routes) {
  const calls = [];
  function request(options) {
    const { method, pathname, body } = options;
    calls.push({ method, pathname, body });
    const key = `${method} ${pathname}`;
    const handler = routes[key];
    if (handler === undefined) {
      return Promise.reject(Object.assign(new Error(`unexpected ${key}`), { status: 404, code: 'not_found' }));
    }
    return Promise.resolve(typeof handler === 'function' ? handler(body) : handler);
  }
  return { calls, request };
}

function fakeSocket() {
  const listeners = new Map();
  const socket = {
    isOpen: true,
    sent: [],
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return socket;
    },
    emit(event, payload) {
      for (const handler of listeners.get(event) || []) handler(payload);
    },
    send(raw) {
      socket.sent.push(raw);
    },
    close() {
      socket.isOpen = false;
      socket.emit('close', {});
    },
  };
  return socket;
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function until(predicate, label) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`condition not met: ${label}`);
}

function activeSlot(matrixSlotId, port, extra = {}) {
  return {
    matrixSlotId,
    egressPort: port,
    routingPlane: 'STRICT_CONTROL',
    healthState: 'ACTIVE',
    leaseId: `lease-${port}`,
    egressFingerprint: { exitIp: '203.0.113.9' },
    ...extra,
  };
}

test('slots() normalizes matrix rows and caches them', async () => {
  const bus = fakeBus({
    'GET /api/v1/egress/slots': {
      slots: [{
        matrixSlotId: 'slot-007',
        healthState: 'active',
        egressPort: '24007',
        routingPlane: 'strict_control',
        leaseId: 'lease-7',
        egressFingerprint: {
          exitIp: '203.0.113.9',
          ipv6Prefix64: '2001:db8:aa:bb::1',
          asn: 64500,
        },
      }],
    },
  });
  const client = createEgressClient({ request: bus.request, clientId: 'test-client', log: () => {} });
  const slots = await client.slots();
  assert.equal(slots.length, 1);
  const row = slots[0];
  assert.equal(row.matrixSlotId, 'slot-007');
  assert.equal(row.egressPort, 24007);
  assert.equal(row.routingPlane, 'STRICT_CONTROL');
  assert.equal(row.healthState, 'ACTIVE');
  assert.equal(row.leaseId, 'lease-7');
  assert.equal(row.egressFingerprint.exitIp, '203.0.113.9');
  assert.equal(row.egressFingerprint.ipv6Prefix64, '2001:db8:aa:bb::/64');
  assert.equal(client.cachedSlot('slot-007').leaseId, 'lease-7');
  client.close();
});

test('assertSlotUsable refetches the lease and fails closed on any non-ACTIVE state', async () => {
  let healthState = 'ACTIVE';
  const bus = fakeBus({
    'GET /api/v1/egress/lease/slot-007': () => ({ slot: activeSlot('slot-007', 24007, { healthState }) }),
  });
  const client = createEgressClient({ request: bus.request, log: () => {} });

  const row = await client.assertSlotUsable('slot-007');
  assert.equal(row.healthState, 'ACTIVE');

  healthState = 'WARP_OVERFLOW';
  await assert.rejects(
    () => client.assertSlotUsable('slot-007'),
    (error) => error.code === 'ERR_EGRESS_SLOT_BLOCKED'
      && error.matrixSlotId === 'slot-007'
      && error.healthState === 'WARP_OVERFLOW'
      && error.status === 503,
  );

  healthState = 'QUARANTINED';
  await assert.rejects(() => client.assertSlotUsable('slot-007'), (error) => error.healthState === 'QUARANTINED');
  client.close();
});

test('assertSlotUsable treats a missing or invalid slot as UNKNOWN', async () => {
  const bus = fakeBus({});
  const client = createEgressClient({ request: bus.request, log: () => {} });
  await assert.rejects(
    () => client.assertSlotUsable('slot-009'),
    (error) => error.code === 'ERR_EGRESS_SLOT_BLOCKED' && error.healthState === 'UNKNOWN',
  );
  await assert.rejects(
    () => client.assertSlotUsable('slot-999'),
    (error) => error.code === 'ERR_EGRESS_SLOT_BLOCKED' && error.healthState === 'UNKNOWN',
  );
  client.close();
});

test('bindLease posts the lease identity and remembers the returned slot', async () => {
  const bus = fakeBus({
    'POST /api/v1/egress/lease/bind': (body) => ({
      ok: true,
      slot: activeSlot(body.matrixSlotId, 24012, { leaseId: body.leaseId }),
    }),
  });
  const client = createEgressClient({ request: bus.request, log: () => {} });
  const payload = await client.bindLease({ matrixSlotId: 'slot-012', leaseId: 'lease-12' });
  assert.equal(payload.slot.matrixSlotId, 'slot-012');
  assert.deepEqual(bus.calls[0].body, { matrixSlotId: 'slot-012', leaseId: 'lease-12' });
  assert.equal(client.cachedSlot('slot-012').leaseId, 'lease-12');
  await assert.rejects(() => client.bindLease({ matrixSlotId: 'slot-012' }), /leaseId/);
  await assert.rejects(
    () => client.bindLease({ matrixSlotId: 'bogus', leaseId: 'x' }),
    (error) => error.code === 'ERR_EGRESS_SLOT_BLOCKED',
  );
  client.close();
});

test('PRE_ROTATION_FREEZE freezes the slot, ACKs, and POST_ROTATION_RESUME unfreezes it', async () => {
  const bus = fakeBus({
    'GET /api/v1/egress/lease/slot-007': { slot: activeSlot('slot-007', 24007) },
    'POST /api/v1/egress/ack-freeze': { ok: true },
  });
  const socket = fakeSocket();
  const client = createEgressClient({
    request: bus.request,
    clientId: 'client-1',
    wsConnect: () => socket,
    log: () => {},
  });
  const frozenRecords = [];
  const resumed = [];
  const subscription = client.subscribe({
    freeze: (record) => { frozenRecords.push(record); },
    resume: (payload) => { resumed.push(payload); },
  });
  await tick();
  await tick();
  assert.equal(socket.isOpen, true);
  assert.equal(client.status().connected, true);

  socket.emit('message', {
    data: JSON.stringify({
      type: 'PRE_ROTATION_FREEZE',
      eventId: 'evt-1',
      matrixSlotId: 'slot-007',
      reason: 'scheduled',
      deadlineMs: 800,
    }),
  });
  await until(() => client.isFrozen('slot-007'), 'freeze applied');
  assert.equal(frozenRecords.length, 1);
  assert.equal(frozenRecords[0].reason, 'scheduled');
  await until(() => bus.calls.some((call) => call.pathname === '/api/v1/egress/ack-freeze'), 'freeze ack');
  const ack = bus.calls.find((call) => call.pathname === '/api/v1/egress/ack-freeze');
  assert.deepEqual(ack.body, { clientId: 'client-1', eventId: 'evt-1', ok: true });

  await assert.rejects(
    () => client.assertSlotUsable('slot-007'),
    (error) => error.healthState === 'ROTATING' && error.frozen === true,
  );

  const waiting = client.waitForResume('slot-007', { timeoutMs: 2000 });
  socket.emit('message', {
    data: JSON.stringify({
      type: 'POST_ROTATION_RESUME',
      matrixSlotId: 'slot-007',
      leaseId: 'lease-8',
      egressFingerprint: { exitIp: '203.0.113.10', ipv6Prefix64: '2001:db8:aa:bb::2' },
    }),
  });
  const outcome = await waiting;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.slot.matrixSlotId, 'slot-007');
  await until(() => !client.isFrozen('slot-007'), 'resume applied');
  assert.equal(client.cachedSlot('slot-007').leaseId, 'lease-8');
  assert.equal(client.cachedSlot('slot-007').healthState, 'ACTIVE');
  assert.equal(resumed.length, 1);
  subscription.close();
  client.close();
});

test('waitForResume times out and ROTATION_FAILED settles the waiter', async () => {
  const bus = fakeBus({
    'POST /api/v1/egress/ack-freeze': { ok: true },
  });
  const socket = fakeSocket();
  const failed = [];
  const client = createEgressClient({ request: bus.request, wsConnect: () => socket, log: () => {} });
  client.subscribe({ failed: (payload) => failed.push(payload) });
  await tick();
  await tick();
  socket.emit('message', {
    data: JSON.stringify({ type: 'PRE_ROTATION_FREEZE', eventId: 'f1', matrixSlotId: 'slot-011' }),
  });
  await until(() => client.isFrozen('slot-011'), 'freeze');

  const timeout = await client.waitForResume('slot-011', { timeoutMs: 20 });
  assert.deepEqual(timeout, { ok: false, timeout: true });

  const second = client.waitForResume('slot-011', { timeoutMs: 2000 });
  socket.emit('message', {
    data: JSON.stringify({ type: 'ROTATION_FAILED', matrixSlotId: 'slot-011', reason: 'upstream dead' }),
  });
  const outcome = await second;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.payload.reason, 'upstream dead');
  await until(() => failed.length === 1, 'failed handler');
  assert.equal(failed[0].reason, 'upstream dead');
  client.close();
});

test('SLOT_STATE_UPDATED remembers the row and an ACTIVE update clears the freeze', async () => {
  const bus = fakeBus({
    'POST /api/v1/egress/ack-freeze': { ok: true },
  });
  const socket = fakeSocket();
  const client = createEgressClient({ request: bus.request, wsConnect: () => socket, log: () => {} });
  client.subscribe({});
  await tick();
  await tick();
  socket.emit('message', {
    data: JSON.stringify({ type: 'PRE_ROTATION_FREEZE', eventId: 'f2', matrixSlotId: 'slot-012' }),
  });
  await until(() => client.isFrozen('slot-012'), 'freeze');
  socket.emit('message', {
    data: JSON.stringify({
      type: 'SLOT_STATE_UPDATED',
      matrixSlotId: 'slot-012',
      healthState: 'ACTIVE',
      egressPort: 24012,
      leaseId: 'lease-12',
      egressFingerprint: { exitIp: '198.51.100.4' },
    }),
  });
  await until(() => !client.isFrozen('slot-012'), 'ACTIVE unfreezes');
  const cached = client.cachedSlot('slot-012');
  assert.ok(cached, 'slot row remembered');
  assert.equal(cached.healthState, 'ACTIVE');
  assert.equal(cached.leaseId, 'lease-12');
  assert.equal(cached.egressFingerprint.exitIp, '198.51.100.4');
  client.close();
});

test('close() resolves pending rotation waiters as closed', async () => {
  const bus = fakeBus({ 'POST /api/v1/egress/ack-freeze': { ok: true } });
  const socket = fakeSocket();
  const client = createEgressClient({ request: bus.request, wsConnect: () => socket, log: () => {} });
  client.subscribe({});
  await tick();
  await tick();
  socket.emit('message', {
    data: JSON.stringify({ type: 'PRE_ROTATION_FREEZE', eventId: 'f3', matrixSlotId: 'slot-013' }),
  });
  await until(() => client.isFrozen('slot-013'), 'freeze');
  const waiting = client.waitForResume('slot-013', { timeoutMs: 2000 });
  client.close();
  assert.deepEqual(await waiting, { ok: false, closed: true });
});
