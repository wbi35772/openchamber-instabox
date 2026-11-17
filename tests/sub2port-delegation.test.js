'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const {
  resolveMode,
  egressBusRequest,
  createEgressDelegator,
  DEFAULT_EGRESS_BUS_URL,
  DEFAULT_EGRESS_CLIENT_ID,
} = require('../lib/sub2port');
const { planSlots } = require('../scripts/singbox-up');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

function jsonServer(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({
        method: req.method,
        url: req.url,
        body: body ? JSON.parse(body) : null,
      });
      handler(req, res, calls.length);
    });
  });
  return { server, calls };
}

test('delegated is the default mode and standalone is opt-in', () => {
  assert.equal(resolveMode({}), 'delegated');
  assert.equal(resolveMode({ standaloneFallback: false }), 'delegated');
  assert.equal(resolveMode({ standaloneFallback: true }), 'standalone');
  assert.equal(DEFAULT_EGRESS_BUS_URL, 'http://127.0.0.1:19880');
  assert.equal(DEFAULT_EGRESS_CLIENT_ID, 'instabox-sub2port');
});

test('the delegator plans one contract slot per node', () => {
  const delegator = createEgressDelegator({ clientId: 'test-delegator' });
  const plan = delegator.plan([
    { tag: 'node-a' },
    { tag: 'node-b' },
  ], { startIndex: 10 });
  assert.equal(plan.mode, 'delegated');
  assert.equal(plan.clientId, 'test-delegator');
  assert.deepEqual(
    plan.slots.map((slot) => [slot.matrixSlotId, slot.egressPort, slot.nodeTag]),
    [['slot-010', 24010, 'node-a'], ['slot-011', 24011, 'node-b']],
  );
});

test('the delegator refuses to plan past slot-250', () => {
  const delegator = createEgressDelegator({ clientId: 'test-delegator' });
  const nodes = Array.from({ length: 251 }, (unused, index) => ({ tag: `n${index}` }));
  assert.throws(() => delegator.plan(nodes), (error) => error.code === 'matrix_slot_exhausted');
});

test('egressBusRequest speaks JSON to the bus', async () => {
  const { server, calls } = jsonServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, slots: [{ matrixSlotId: 'slot-001' }] }));
  });
  const port = await listen(server);
  try {
    const data = await egressBusRequest(
      `http://127.0.0.1:${port}`,
      'POST',
      '/api/v1/egress/lease/bind',
      { matrixSlotId: 'slot-001' },
      4000,
    );
    assert.equal(data.ok, true);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/api/v1/egress/lease/bind');
    assert.deepEqual(calls[0].body, { matrixSlotId: 'slot-001' });
  } finally {
    await close(server);
  }
});

test('egressBusRequest surfaces bus errors with status, code and body', async () => {
  const { server } = jsonServer((req, res) => {
    res.writeHead(409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'slot busy', code: 'slot_conflict' }));
  });
  const port = await listen(server);
  try {
    await assert.rejects(
      () => egressBusRequest(`http://127.0.0.1:${port}`, 'POST', '/api/v1/egress/lease/bind', {}, 4000),
      (error) => error.status === 409
        && error.code === 'slot_conflict'
        && error.body
        && error.body.error === 'slot busy',
    );
  } finally {
    await close(server);
  }
});

test('egressBusRequest fails closed when the bus is down', async () => {
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  await assert.rejects(
    () => egressBusRequest(`http://127.0.0.1:${port}`, 'GET', '/api/v1/egress/slots', undefined, 1500),
    (error) => error.code === 'egress_unavailable',
  );
});

test('egressBusRequest times out on a silent bus', async () => {
  const server = http.createServer((req) => {
    req.on('data', () => {});
  });
  const port = await listen(server);
  try {
    await assert.rejects(
      () => egressBusRequest(`http://127.0.0.1:${port}`, 'GET', '/api/v1/egress/slots', undefined, 40),
      (error) => error.code === 'egress_timeout',
    );
  } finally {
    await close(server);
  }
});

test('listSlots and bind talk to the real bus contract', async () => {
  const { server, calls } = jsonServer((req, res, count) => {
    if (count === 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ slots: [{ matrixSlotId: 'slot-005', healthState: 'ACTIVE', egressPort: 24005 }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, slot: { matrixSlotId: 'slot-005', healthState: 'ACTIVE' } }));
  });
  const port = await listen(server);
  try {
    const delegator = createEgressDelegator({ busUrl: `http://127.0.0.1:${port}`, clientId: 'test-delegator' });
    const slots = await delegator.listSlots();
    assert.equal(slots.length, 1);
    assert.equal(slots[0].matrixSlotId, 'slot-005');
    const bound = await delegator.bind('slot-005', { leaseId: 'lease-5' });
    assert.equal(bound.ok, true);
    assert.equal(calls[1].url, '/api/v1/egress/lease/bind');
    assert.deepEqual(calls[1].body, { matrixSlotId: 'slot-005', leaseId: 'lease-5' });
    await assert.rejects(
      () => delegator.bind('bogus', { leaseId: 'x' }),
      (error) => error.code === 'invalid_slot',
    );
  } finally {
    await close(server);
  }
});

test('planSlots maps explicit slots, matrix ports and sorted aliases without drift', () => {
  const plan = planSlots(['alpha', 'beta', 'delta'], {
    slots: { delta: 'slot-200' },
    ports: { beta: 24100 },
  });
  assert.deepEqual(
    plan.map((entry) => [entry.alias, entry.matrixSlotId, entry.egressPort, entry.source]),
    [
      ['alpha', 'slot-001', 24001, 'auto'],
      ['beta', 'slot-100', 24100, 'ports'],
      ['delta', 'slot-200', 24200, 'slots'],
    ],
  );
});

test('planSlots rejects duplicate slots, invalid ids and legacy ports', () => {
  assert.throws(
    () => planSlots(['alpha', 'beta'], { slots: { alpha: 'slot-007', beta: 'slot-007' } }),
    /重复/,
  );
  assert.throws(
    () => planSlots(['alpha'], { slots: { alpha: 'slot-999' } }),
    /非法/,
  );
  assert.throws(
    () => planSlots(['alpha'], { ports: { alpha: 25001 } }),
    /矩阵范围/,
  );
});

test('planSlots refuses to invent slot-251', () => {
  const aliases = Array.from({ length: 251 }, (unused, index) => `acct-${String(index + 1).padStart(3, '0')}`);
  assert.throws(() => planSlots(aliases, {}), (error) => error.code === 'matrix_slot_exhausted');
});
