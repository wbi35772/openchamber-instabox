'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const {
  cloudflaredCommand,
  extractToken,
  normalizeProvisionBody,
  createCfBridge,
  CfBridgeError,
  CLOUDFLARED_PROBE,
  isCooldownError,
  isRetryableError,
  retryAfterMs,
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
    vmInstanceId: 'm-1',
    machineId: 'm-1',
    matrixSlotId: 'slot-012',
    egressPort: 24012,
    domainZone: 'example.com',
    localPort: 8080,
    publicHostname: 'demo.example.com',
    routingPlane: 'STRICT_CONTROL',
  });
  assert.equal(
    normalizeProvisionBody({
      matrixSlotId: 'slot-012',
      machineId: 'm-1',
      publicHostname: 'a.b.example.co.uk',
      domainZone: 'example.co.uk',
    }).domainZone,
    'example.co.uk',
  );
  assert.throws(
    () => normalizeProvisionBody({ matrixSlotId: 'slot-012', machineId: 'm-1', hostname: 'localhost' }),
    (error) => error.code === 'missing_domain_zone',
  );
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

test('normalizeProvisionBody forwards a validated internal service port', () => {
  const body = normalizeProvisionBody({
    matrixSlotId: 'slot-020',
    vmInstanceId: 'm-20',
    publicHostname: 'demo20.example.com',
    internalPort: 3000,
  });
  assert.equal(body.localPort, 3000);
  assert.equal(body.vmInstanceId, 'm-20');
  assert.equal(body.egressPort, 24020);
  assert.equal(
    normalizeProvisionBody({ matrixSlotId: 'slot-020', machineId: 'm-20', hostname: 'h.example.com', servicePort: '8080' }).localPort,
    8080,
  );
  assert.throws(
    () => normalizeProvisionBody({ matrixSlotId: 'slot-020', machineId: 'm-20', hostname: 'h.example.com', internalPort: 70000 }),
    (error) => error.code === 'invalid_internal_port',
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
    vmInstanceId: 'm-1',
    machineId: 'm-1',
    matrixSlotId: 'slot-012',
    egressPort: 24012,
    domainZone: 'example.com',
    localPort: 8080,
    publicHostname: 'demo.example.com',
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
    { matrixSlotId: 'slot-004', tunnelId: 'tun-4' },
  );
  assert.equal(outcome.ok, true);
  assert.equal(execs.length, 1);
  assert.match(execs[0].cmd, /pkill -f "cloudflared tunnel run"/);
  assert.equal(execs[0].options.noHistory, true);
  assert.deepEqual(bridge.calls[0].body, {
    vmInstanceId: 'm-4',
    machineId: 'm-4',
    matrixSlotId: 'slot-004',
    tunnelId: 'tun-4',
  });
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

test('isCooldownError recognises codes, 429 and retry hints', () => {
  assert.equal(isCooldownError(Object.assign(new Error('x'), { code: 'cf_cooldown' })), true);
  assert.equal(isCooldownError(Object.assign(new Error('x'), { status: 429 })), true);
  assert.equal(isCooldownError(Object.assign(new Error('x'), { body: { retryAfterSeconds: 30 } })), true);
  assert.equal(
    isCooldownError(Object.assign(new Error('x'), { body: { retryAt: new Date(Date.now() + 60000).toISOString() } })),
    true,
  );
  assert.equal(isCooldownError(new Error('隧道冷却中，请稍后')), true);
  assert.equal(isCooldownError(Object.assign(new Error('bad request'), { status: 400, code: 'bad_request' })), false);
  assert.equal(isCooldownError(null), false);
});

test('isRetryableError keeps 5xx and transport failures, drops 4xx', () => {
  assert.equal(isRetryableError(Object.assign(new Error('down'), { code: 'cf_unreachable' })), true);
  assert.equal(isRetryableError(Object.assign(new Error('slow'), { status: 504 })), true);
  assert.equal(isRetryableError(Object.assign(new Error('nope'), { status: 400 })), false);
  assert.equal(isRetryableError(Object.assign(new Error('cooldown'), { status: 429 })), true);
  assert.equal(isRetryableError(null), false);
});

test('retryAfterMs converts retryAfterSeconds and retryAt', () => {
  assert.equal(retryAfterMs(Object.assign(new Error('x'), { body: { retryAfterSeconds: 12 } })), 12000);
  const at = new Date(Date.now() + 30000).toISOString();
  const wait = retryAfterMs(Object.assign(new Error('x'), { body: { retryAt: at } }));
  assert.ok(wait > 20000 && wait <= 30000, String(wait));
  assert.equal(retryAfterMs(new Error('plain')), null);
  assert.equal(retryAfterMs(null), null);
});

test('checkCloudflared reads the pgrep probe result', async () => {
  const seen = [];
  const cf = createCfBridge({ request: () => Promise.reject(new Error('unused')), log: () => {} });
  const client = {
    exec: async (id, cmd, options) => {
      seen.push({ id, cmd, options });
      return { exitCode: 0, stdout: 'running\n', stderr: '' };
    },
  };
  const running = await cf.checkCloudflared(client, 'm-9');
  assert.equal(running.running, true);
  assert.equal(running.machineId, 'm-9');
  assert.equal(seen[0].cmd, CLOUDFLARED_PROBE);
  assert.equal(seen[0].options.noHistory, true);

  const down = await cf.checkCloudflared(
    { exec: async () => ({ exitCode: 0, stdout: 'down\n' }) },
    'm-9',
  );
  assert.equal(down.running, false);
});

test('restartCloudflared reuses the cached token without provisioning again', async () => {
  const bridge = fakeBridge({
    'POST /api/v1/cf/tunnel/provision': { tunnelId: 'tun-7', tunnelToken: 'CACHED-TOKEN' },
  });
  const cf = createCfBridge({ request: bridge.request, log: () => {} });
  const execs = [];
  const client = {
    exec: async (id, cmd) => {
      execs.push(cmd);
      return { exitCode: 0, stdout: 'ok' };
    },
  };
  await cf.provisionMachine(client, 'm-7', {
    matrixSlotId: 'slot-007',
    hostname: 'demo7.example.com',
  });
  assert.equal(cf.hasCachedToken('m-7'), true);
  execs.length = 0;

  const outcome = await cf.restartCloudflared(client, 'm-7');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.restarted, true);
  assert.equal(outcome.cloudflared, 'restarted');
  assert.equal(outcome.matrixSlotId, 'slot-007');
  assert.equal(outcome.hostname, 'demo7.example.com');
  assert.equal(bridge.calls.length, 1, 'no second provision');
  assert.equal(execs.length, 1);
  assert.ok(execs[0].includes("--token 'CACHED-TOKEN'"), execs[0]);
  assert.equal(JSON.stringify(outcome).includes('CACHED-TOKEN'), false);

  cf.forgetToken('m-7');
  assert.equal(cf.hasCachedToken('m-7'), false);
});

test('ensureMachine skips the restart when cloudflared is already running', async () => {
  const bridge = fakeBridge({});
  const cf = createCfBridge({ request: bridge.request, log: () => {} });
  const execs = [];
  const outcome = await cf.ensureMachine(
    { exec: async (id, cmd) => { execs.push(cmd); return { stdout: 'running' }; } },
    'm-8',
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.cloudflared, 'running');
  assert.equal(outcome.restarted, false);
  assert.equal(execs.length, 1);
  assert.equal(bridge.calls.length, 0);
});

test('restartCloudflared falls back to provision when the token cache is cold', async () => {
  const bridge = fakeBridge({
    'POST /api/v1/cf/tunnel/provision': { tunnelToken: 'FRESH-TOKEN' },
  });
  const cf = createCfBridge({ request: bridge.request, log: () => {} });
  const execs = [];
  const outcome = await cf.restartCloudflared(
    { exec: async (id, cmd) => { execs.push(cmd); return { exitCode: 0 }; } },
    'm-10',
    { matrixSlotId: 'slot-010', hostname: 'demo10.example.com' },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.restarted, false);
  assert.equal(outcome.reason, 'token_missing');
  assert.equal(bridge.calls.length, 1);
  assert.equal(execs.length, 1);
  assert.ok(execs[0].includes("--token 'FRESH-TOKEN'"), execs[0]);
});

test('the bridge sends the configured CF bearer token', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization || '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'cf-matrix-channel' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const cf = createCfBridge({
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'CF-TOKEN',
      log: () => {},
    });
    const status = await cf.status();
    assert.equal(status.reachable, true);
    assert.equal(status.ok, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/api/v1/cf/status');
    assert.equal(seen[0].authorization, 'Bearer CF-TOKEN');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
