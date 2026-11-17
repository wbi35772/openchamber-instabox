'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  cloudflaredCommand,
  extractToken,
  normalizeProvisionBody,
  createCfBridge,
  CfBridgeError,
} = require('../lib/cf-bridge');

function fakeBridge(routes) {
  const calls = [];
  function request(method, pathname, body) {
    calls.push({ method, pathname, body });
    const key = `${method} ${pathname}`;
    const handler = routes[key];
    if (handler === undefined) {
      return Promise.reject(new CfBridgeError(`missing route ${key}`, { status: 404, code: 'not_found' }));
    }
    return Promise.resolve(typeof handler === 'function' ? handler(body) : handler);
  }
  return { calls, request };
}

test('cloudflaredCommand launches cloudflared detached with the token', () => {
  const command = cloudflaredCommand("tok'en");
  assert.match(command, /^nohup cloudflared tunnel run --token /);
  assert.match(command, /--no-autoupdate/);
  assert.match(command, /--protocol http2/);
  assert.ok(command.includes("'tok'\\''en'"), command);
  assert.ok(command.trim().endsWith('&'), command);
  assert.throws(() => cloudflaredCommand(''), (error) => error.code === 'missing_tunnel_token');
});

test('extractToken accepts every documented response shape', () => {
  assert.equal(extractToken({ tunnelToken: 'a' }), 'a');
  assert.equal(extractToken({ token: 'b' }), 'b');
  assert.equal(extractToken({ tunnel: { token: 'c' } }), 'c');
  assert.equal(extractToken({ tunnel: { tunnelToken: 'd' } }), 'd');
  assert.equal(extractToken({}), '');
  assert.equal(extractToken(null), '');
});

test('normalizeProvisionBody derives the egress port and defaults the routing plane', () => {
  const body = normalizeProvisionBody({
    matrixSlotId: 'slot-012',
    machineId: 'm-1',
    hostname: 'demo.example.com',
  });
  assert.deepEqual(body, {
    machineId: 'm-1',
    matrixSlotId: 'slot-012',
    egressPort: 24012,
    hostname: 'demo.example.com',
    routingPlane: 'STRICT_CONTROL',
  });
  assert.throws(
    () => normalizeProvisionBody({ machineId: 'm-1', hostname: 'x.example.com' }),
    (error) => error.code === 'missing_matrix_slot',
  );
  assert.throws(
    () => normalizeProvisionBody({ matrixSlotId: 'slot-012', hostname: 'x.example.com' }),
    (error) => error.code === 'missing_machine_id',
  );
  assert.throws(
    () => normalizeProvisionBody({ matrixSlotId: 'slot-012', machineId: 'm-1' }),
    (error) => error.code === 'missing_hostname',
  );
});

test('provisionMachine starts cloudflared without leaking the tunnel token', async () => {
  const bridge = fakeBridge({
    'POST /api/v1/cf/tunnel/provision': { tunnelId: 'tun-1', tunnelToken: 'SECRET-TOKEN' },
  });
  const cf = createCfBridge({ request: bridge.request, log: () => {} });
  const execs = [];
  const client = {
    exec: async (id, cmd, options) => {
      execs.push({ id, cmd, options });
      return { exitCode: 0, stdout: 'started', stderr: '' };
    },
  };
  const outcome = await cf.provisionMachine(client, 'm-1', {
    matrixSlotId: 'slot-012',
    hostname: 'demo.example.com',
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.cloudflared, 'started');
  assert.equal(outcome.tunnelId, 'tun-1');
  assert.equal(execs.length, 1);
  assert.equal(execs[0].id, 'm-1');
  assert.equal(execs[0].options.noHistory, true);
  assert.ok(execs[0].cmd.includes("--token 'SECRET-TOKEN'"), execs[0].cmd);
  assert.equal(JSON.stringify(outcome).includes('SECRET-TOKEN'), false);
  assert.deepEqual(bridge.calls[0].body, {
    machineId: 'm-1',
    matrixSlotId: 'slot-012',
    egressPort: 24012,
    hostname: 'demo.example.com',
    routingPlane: 'STRICT_CONTROL',
  });
});

test('provisionMachine reports a failed cloudflared start without throwing', async () => {
  const bridge = fakeBridge({ 'POST /api/v1/cf/tunnel/provision': { token: 'T2' } });
  const cf = createCfBridge({ request: bridge.request, log: () => {} });
  const outcome = await cf.provisionMachine(
    { exec: async () => { throw new Error('exec denied'); } },
    'm-2',
    { matrixSlotId: 'slot-002', hostname: 'demo2.example.com' },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.cloudflared, 'failed');
  assert.match(outcome.exec.error, /exec denied/);
});

test('a provision response without a token leaves cloudflared unstarted', async () => {
  const bridge = fakeBridge({ 'POST /api/v1/cf/tunnel/provision': { tunnelId: 'tun-3' } });
  const cf = createCfBridge({ request: bridge.request, log: () => {} });
  const execs = [];
  const outcome = await cf.provisionMachine(
    { exec: async (...args) => { execs.push(args); return {}; } },
    'm-3',
    { matrixSlotId: 'slot-003', hostname: 'demo3.example.com' },
  );
  assert.equal(outcome.ok, false);
  assert.equal(outcome.cloudflared, 'token_missing');
  assert.equal(execs.length, 0);
});

test('teardown treats a missing tunnel as already released', async () => {
  const bridge = fakeBridge({});
  const cf = createCfBridge({ request: bridge.request, log: () => {} });
  const result = await cf.teardown({ machineId: 'm-1' });
  assert.deepEqual(result, { ok: true, skipped: true, machineId: 'm-1' });
});

test('teardownMachine kills cloudflared and releases the tunnel', async () => {
  const bridge = fakeBridge({ 'POST /api/v1/cf/tunnel/teardown': { ok: true } });
  const cf = createCfBridge({ request: bridge.request, log: () => {} });
  const execs = [];
  const outcome = await cf.teardownMachine(
    {
      exec: async (id, cmd, options) => {
        execs.push({ id, cmd, options });
        return { exitCode: 0 };
      },
    },
    'm-4',
    { matrixSlotId: 'slot-004' },
  );
  assert.equal(outcome.ok, true);
  assert.equal(execs.length, 1);
  assert.match(execs[0].cmd, /pkill -f "cloudflared tunnel run"/);
  assert.equal(execs[0].options.noHistory, true);
  assert.deepEqual(bridge.calls[0].body, { machineId: 'm-4', matrixSlotId: 'slot-004' });
});

test('status falls back to /health when the bridge has no status route', async () => {
  const bridge = fakeBridge({ 'GET /health': { ok: true } });
  const cf = createCfBridge({ request: bridge.request, log: () => {} });
  const status = await cf.status();
  assert.equal(status.reachable, true);
  assert.equal(status.degraded, true);
  assert.deepEqual(bridge.calls.map((call) => call.pathname), ['/api/v1/cf/status', '/health']);
});

test('status reports an unreachable bridge instead of throwing', async () => {
  const cf = createCfBridge({ request: () => Promise.reject(new Error('ECONNREFUSED')), log: () => {} });
  const status = await cf.status();
  assert.equal(status.reachable, false);
  assert.equal(status.ok, false);
  assert.match(status.error, /ECONNREFUSED/);
});
