'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createAccountProxy, resolveMatrixSlot, ProxyRequiredError } = require('../lib/account-proxy');
const { planeHeaders } = require('../lib/account-transport');
const { createProxyFetch } = require('../lib/proxy-fetch');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function stateWithPort(port, enabled = true) {
  return {
    accounts: [{ alias: 'alice', enabled: true }],
    settings: { proxy: { enabled, ports: { alice: port } } },
  };
}

function fakeFetchFactory() {
  const client = {
    calls: [],
    suspended: 0,
    resumed: 0,
    closed: 0,
    fetch(input, init) {
      client.calls.push({ input: String(input), init });
      return Promise.resolve({ ok: true });
    },
    close() { client.closed += 1; },
    suspend() { client.suspended += 1; },
    resume() { client.resumed += 1; },
    state: { quarantined: false, suspended: false },
  };
  const factory = (port, options) => {
    client.port = port;
    client.options = options;
    return client;
  };
  return { factory, client };
}

test('planeHeaders marks the slot and routing plane exactly as the bus expects', () => {
  assert.deepEqual(planeHeaders('slot-007'), {
    'X-OC-Routing-Plane': 'STRICT_CONTROL',
    'Proxy-Authorization': `Basic ${Buffer.from('slot-007:STRICT_CONTROL').toString('base64')}`,
  });
  assert.deepEqual(planeHeaders('slot-007', 'elastic_data'), {
    'X-OC-Routing-Plane': 'ELASTIC_DATA',
    'Proxy-Authorization': `Basic ${Buffer.from('slot-007:ELASTIC_DATA').toString('base64')}`,
  });
  assert.deepEqual(planeHeaders(''), {});
  assert.deepEqual(planeHeaders(null), {});
});

test('plain http requests carry the plane headers through the proxy', async () => {
  const seen = [];
  const proxy = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('routed');
  });
  const port = await listen(proxy);
  const client = createProxyFetch(port, { planeHeaders: planeHeaders('slot-007') });
  try {
    const response = await client.fetch('http://api.instabox.sh/v1/machines');
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'routed');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].headers['x-oc-routing-plane'], 'STRICT_CONTROL');
    assert.equal(
      seen[0].headers['proxy-authorization'],
      `Basic ${Buffer.from('slot-007:STRICT_CONTROL').toString('base64')}`,
    );
  } finally {
    await client.close();
    await close(proxy);
  }
});

test('account fetches verify the live slot before opening a proxy connection', async () => {
  const proxy = fakeFetchFactory();
  const checked = [];
  const proxies = createAccountProxy({
    getState: () => stateWithPort(24007),
    fetchFactory: proxy.factory,
    egress: {
      assertSlotUsable: async (slotId) => {
        checked.push(slotId);
        return { matrixSlotId: slotId, healthState: 'ACTIVE' };
      },
    },
  });
  const fetch = proxies.requireFetchFor('alice');
  await fetch('http://api.instabox.sh/v1/machines');
  assert.deepEqual(checked, ['slot-007']);
  assert.equal(proxy.client.port, 24007);
  assert.deepEqual(proxy.client.options.planeHeaders, planeHeaders('slot-007'));
  assert.equal(proxy.client.calls.length, 1);
});

test('a blocked slot stops the request before the proxy is touched', async () => {
  const proxy = fakeFetchFactory();
  const proxies = createAccountProxy({
    getState: () => stateWithPort(24009),
    fetchFactory: proxy.factory,
    egress: {
      assertSlotUsable: async () => {
        throw Object.assign(new Error('slot quarantined'), {
          name: 'EgressSlotBlockedError',
          code: 'ERR_EGRESS_SLOT_BLOCKED',
          status: 503,
          healthState: 'QUARANTINED',
          matrixSlotId: 'slot-009',
        });
      },
    },
  });
  await assert.rejects(
    () => proxies.fetchFor('alice')('http://api.instabox.sh/v1/machines'),
    (error) => error.code === 'ERR_EGRESS_SLOT_BLOCKED' && error.healthState === 'QUARANTINED',
  );
  assert.equal(proxy.client.calls.length, 0);
});

test('freezeSlot suspends the transport and resumeSlot reopens it', async () => {
  const proxy = fakeFetchFactory();
  const proxies = createAccountProxy({
    getState: () => stateWithPort(24007),
    fetchFactory: proxy.factory,
    egress: { assertSlotUsable: async (slotId) => ({ matrixSlotId: slotId, healthState: 'ACTIVE' }) },
  });
  const fetch = proxies.requireFetchFor('alice');
  await fetch('http://api.instabox.sh/v1/machines');

  assert.deepEqual(proxies.freezeSlot('slot-007', { reason: 'rotate' }), ['alice']);
  assert.equal(proxy.client.suspended, 1);
  assert.equal(proxies.isPaused('alice'), true);
  assert.deepEqual(proxies.pausedSlots(), ['slot-007']);
  await assert.rejects(
    () => fetch('http://api.instabox.sh/v1/machines'),
    (error) => error.code === 'ERR_EGRESS_SLOT_BLOCKED' && error.frozen === true,
  );
  assert.equal(proxy.client.calls.length, 1);

  assert.deepEqual(proxies.resumeSlot('slot-007', { exitIp: '203.0.113.9' }), ['alice']);
  assert.equal(proxy.client.resumed, 1);
  assert.equal(proxies.isPaused('alice'), false);
  assert.deepEqual(proxies.pausedSlots(), []);
  await fetch('http://api.instabox.sh/v1/machines');
  assert.equal(proxy.client.calls.length, 2);
});

test('waitForResume delegates to the egress client and is a no-op without one', async () => {
  const calls = [];
  const proxies = createAccountProxy({
    getState: () => stateWithPort(24007),
    fetchFactory: fakeFetchFactory().factory,
    egress: {
      assertSlotUsable: async () => ({}),
      waitForResume: (slotId, options) => {
        calls.push({ slotId, options });
        return Promise.resolve({ ok: true, slot: { matrixSlotId: slotId } });
      },
    },
  });
  const outcome = await proxies.waitForResume('alice', { timeoutMs: 25 });
  assert.equal(outcome.ok, true);
  assert.deepEqual(calls, [{ slotId: 'slot-007', options: { timeoutMs: 25 } }]);

  const plain = createAccountProxy({
    getState: () => stateWithPort(24007),
    fetchFactory: fakeFetchFactory().factory,
  });
  assert.deepEqual(await plain.waitForResume('alice'), { ok: true, already: true });
});

test('legacy ports outside the matrix send no plane headers and skip the slot check', async () => {
  const proxy = fakeFetchFactory();
  const checked = [];
  const proxies = createAccountProxy({
    getState: () => stateWithPort(25001),
    fetchFactory: proxy.factory,
    egress: { assertSlotUsable: async (slotId) => { checked.push(slotId); return {}; } },
  });
  const target = resolveMatrixSlot(stateWithPort(25001), 'alice');
  assert.equal(target.legacyPort, true);
  assert.equal(target.matrixSlotId, '');
  await proxies.requireFetchFor('alice')('http://api.instabox.sh/v1/machines');
  assert.deepEqual(proxy.client.options.planeHeaders, {});
  assert.deepEqual(checked, []);
});

test('proxy disabled fails closed instead of falling back to a direct connection', () => {
  const proxies = createAccountProxy({
    getState: () => stateWithPort(24007, false),
    fetchFactory: fakeFetchFactory().factory,
  });
  assert.throws(
    () => proxies.requireFetchFor('alice'),
    (error) => error instanceof ProxyRequiredError && error.code === 'ERR_PROXY_REQUIRED_FAIL_CLOSED',
  );
});
