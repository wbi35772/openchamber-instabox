'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const EXTENSION_ROOT = path.resolve(__dirname, '..');
const store = require('../lib/store');
const { InstaboxClient, InstaboxError } = require('../lib/instabox');
const { createKeepalive } = require('../lib/keepalive');
const { createRecycler, buildRecycleView } = require('../lib/recycle');
const { createJobs } = require('../lib/jobs');
const { createNetProbe } = require('../lib/netprobe');
const inventory = require('../lib/inventory');
const { createTerminalManager } = require('../lib/terminal');
const { createAccountProxy } = require('../lib/account-proxy');
const { createEgressClient } = require('../lib/egress-client');
const { createEgressLeaseSync } = require('../lib/leases');
const { createCfBridge } = require('../lib/cf-bridge');
const { createRateLimiter } = require('../lib/ratelimit');
const { createScheduler } = require('../lib/scheduler');
const selfUpdate = require('../lib/self-update');
const canvas = require('../lib/canvas');
const canvasPage = require('../lib/canvas-page');

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT || 0);
const TOKEN = String(process.env.OPENCHAMBER_SERVICE_TOKEN || '');
const HOST = '127.0.0.1';
const BODY_LIMIT = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const EXTENSION_DIR = path.resolve(__dirname, '..');
const REGISTRY_FILE = path.join(os.homedir(), '.config', 'openchamber', 'extensions.json');
const EXTENSION_VERSION = require('../package.json').version;

function log(message) {
  try { process.stderr.write(`[instabox-matrix] ${message}\n`); } catch { /* ignore */ }
}

if (!PORT || !TOKEN) {
  log('missing OPENCHAMBER_SERVICE_PORT / OPENCHAMBER_SERVICE_TOKEN');
  process.exit(1);
}

const egress = createEgressClient({
  baseUrl: process.env.OPENCHAMBER_EGRESS_BUS_URL || undefined,
  log,
});
const cfBridge = createCfBridge({
  baseUrl: process.env.OPENCHAMBER_CF_BRIDGE_URL || undefined,
  log,
});
const proxies = createAccountProxy({ getState: () => store.load(), log, egress });
const leaseSync = createEgressLeaseSync({ egress, getState: () => store.load(), log });
const cfTunnels = new Map();
const cfTunnelJobs = new Map();
const rateLimiter = createRateLimiter();
const jobs = createJobs({
  gate: async (job) => {
    const alias = String((job.meta && job.meta.alias) || '');
    if (!alias) return;
    const outcome = await proxies.waitForResume(alias, { timeoutMs: 60000 });
    if (outcome && outcome.ok === false && outcome.timeout) {
      throw new InstaboxError('egress 槽位正在换血，命令已取消', {
        code: 'egress_rotation_timeout',
        status: 503,
      });
    }
  },
});
const recycler = createRecycler({
  getState: () => store.load(),
  saveStatus: (patch) => {
    const saved = store.update((state) => {
      store.upsertRecycleStatus(state, patch);
      return true;
    });
    if (patch && patch.status === 'idle' && patch.account && patch.machineId) {
      void autoProvisionTunnel(patch.account, patch.machineId).catch((error) => {
        log(`CF 自动打通失败 ${patch.account}/${patch.machineId}: ${error.message}`);
      });
    }
    return saved;
  },
  directClientFor: (alias) => controlClientFor(alias),
  proxyClientFor: (alias) => controlClientFor(alias),
  lockPath: path.join(store.DATA_DIR, 'recycle.lock'),
  log,
});
const keepalive = createKeepalive({
  log,
  rateLimiter,
  clientFor: (alias) => clientForAccount(store.findAccount(store.load(), alias), store.load()),
  isBusy: (account, machineId) => recycler.isBusy(account, machineId) || proxies.isPaused(account),
  waitForResume: (alias) => proxies.waitForResume(alias, { timeoutMs: 1500 }),
  tunnel: { check: tunnelCheckHeartbeat, restart: tunnelRestartHeartbeat },
});
const netprobe = createNetProbe();
const terminals = createTerminalManager({ log });
const portCache = new Map();
const inventoryCache = new Map();

function send(res, status, payload, extraHeaders = {}) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  }, extraHeaders));
  res.end(body);
}

function failure(res, error) {
  const isKnown = error instanceof InstaboxError;
  const hasStatus = Boolean(error && Number.isInteger(error.status) && error.status >= 400 && error.status < 600);
  const known = isKnown || hasStatus;
  const status = known ? error.status : 502;
  send(res, status, {
    ok: false,
    error: {
      code: known ? (error.code || 'error') : 'internal_error',
      message: error && error.message ? error.message : String(error),
      status: known ? error.status : 0,
      retryable: Boolean(isKnown && error.retryable),
      retryAfterSeconds: isKnown ? error.retryAfterSeconds : undefined,
    },
  });
}

function authorized(req) {
  const header = String(req.headers.authorization || '');
  const expected = `Bearer ${TOKEN}`;
  if (header.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new InstaboxError('请求体过大', { code: 'body_too_large', status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch {
        reject(new InstaboxError('请求体不是合法 JSON', { code: 'bad_json', status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function selectedAccounts(state, requested) {
  if (requested === 'all') return state.accounts.filter((a) => a.enabled !== false);
  if (requested) {
    const account = store.findAccount(state, requested);
    if (!account) throw new InstaboxError(`账号不存在：${requested}`, { code: 'account_not_found', status: 404 });
    return [account];
  }
  const active = store.findAccount(state, '');
  return active ? [active] : [];
}

function proxyRequired(state) {
  return Boolean(state && state.settings && state.settings.proxy && state.settings.proxy.enabled === true);
}

function failClosedFetch(state, alias, options) {
  if (!proxyRequired(state)) return undefined;
  return proxies.requireFetchFor(alias, options);
}

function controlClientFor(alias) {
  const state = store.load();
  const account = store.findAccount(state, alias);
  if (!account) return null;
  try {
    return InstaboxClient.fromAccount(account, state.settings, {
      fetchImpl: failClosedFetch(state, alias),
    });
  } catch (error) {
    if (error && error.code === 'ERR_PROXY_REQUIRED_FAIL_CLOSED') {
      log(`blocked direct control-plane call for ${alias}: ${error.message}`);
      return null;
    }
    throw error;
  }
}

function clientForAccount(account, state) {
  if (!account) return InstaboxClient.fromAccount(account, state.settings, {});
  const limit = store.normalizeRateLimit(state.settings && state.settings.rateLimit);
  rateLimiter.configure(account.alias, limit);
  return InstaboxClient.fromAccount(account, state.settings, {
    fetchImpl: failClosedFetch(state, account.alias),
    rateLimiter,
    rateKey: account.alias,
  });
}

function clientFor(state, alias) {
  return clientForAccount(store.findAccount(state, alias), state);
}

function keepaliveFor(state, alias, machineId) {
  return state.keepalive.find((k) => k.account === alias && k.machineId === machineId) || null;
}

async function cachedPorts(client, alias, machineId) {
  const key = `${alias}:${machineId}`;
  const hit = portCache.get(key);
  if (hit && Date.now() - hit.at < 15000) return hit.value;
  const value = await client.listPorts(machineId).catch(() => null);
  portCache.set(key, { at: Date.now(), value });
  return value;
}

async function probeBatch(targets, force) {
  const queue = targets.slice();
  const workerCount = Math.min(2, queue.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const target = queue.shift();
      try {
        await netprobe.probe(target.client, target.account, target.machineId, { force });
      } catch (error) {
        log(`netprobe failed ${target.account}/${target.machineId}: ${error.message}`);
      }
    }
  });
  await Promise.all(workers);
}

function matrixViewFor(alias) {
  let target = null;
  try { target = proxies.slotFor(alias); } catch { target = null; }
  if (!target) return null;
  const cached = target.matrixSlotId ? egress.cachedSlot(target.matrixSlotId) : null;
  return {
    matrixSlotId: target.matrixSlotId || null,
    egressPort: target.egressPort,
    routingPlane: target.routingPlane,
    healthState: proxies.isPaused(alias) ? 'ROTATING' : (cached ? cached.healthState : 'ACTIVE'),
    egressFingerprint: cached ? cached.egressFingerprint : null,
    exitIp: cached && cached.egressFingerprint ? cached.egressFingerprint.exitIp : '',
    ipv6Prefix64: cached && cached.egressFingerprint ? cached.egressFingerprint.ipv6Prefix64 : '',
  };
}

function tunnelHostname(state, alias, machineId) {
  const tunnels = (state.settings && state.settings.proxy && state.settings.proxy.tunnels) || {};
  const explicit = tunnels[machineId];
  if (explicit && explicit.hostname) return String(explicit.hostname);
  const suffix = String(
    (state.settings && state.settings.cf && state.settings.cf.hostnameSuffix)
    || process.env.OPENCHAMBER_CF_HOSTNAME_SUFFIX
    || '',
  ).replace(/^\.+/, '').replace(/\.+$/, '');
  if (!suffix) return '';
  const label = `${alias}-${machineId}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return label ? `${label}.${suffix}` : '';
}

function tunnelInternalPort(state, machineId) {
  const tunnels = (state.settings && state.settings.proxy && state.settings.proxy.tunnels) || {};
  const explicit = tunnels[machineId];
  const port = Number(explicit && explicit.internalPort);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function tunnelDomainZone(state, hostname) {
  const configured = String(
    (state.settings && state.settings.cf && state.settings.cf.domainZone)
    || process.env.OPENCHAMBER_CF_DOMAIN_ZONE
    || '',
  ).trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '');
  if (configured) return configured;
  const parts = String(hostname || '').split('.').filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join('.').toLowerCase() : '';
}

function tunnelKey(alias, machineId) {
  return `${alias}/${machineId}`;
}

function pendingTunnelJob(alias, machineId) {
  const key = tunnelKey(alias, machineId);
  const jobId = cfTunnelJobs.get(key);
  if (!jobId) return null;
  const job = jobs.get(jobId);
  if (job && (job.status === 'pending' || job.status === 'running')) return job;
  cfTunnelJobs.delete(key);
  return null;
}

function recordCfTunnel(alias, machineId, fields) {
  const key = tunnelKey(alias, machineId);
  const previous = cfTunnels.get(key) || {};
  const record = { ...previous, machineId, at: Date.now(), ...fields };
  cfTunnels.set(key, record);
  return record;
}

function cancelTunnelRetry(alias, machineId) {
  const key = tunnelKey(alias, machineId);
  const jobId = cfTunnelJobs.get(key);
  if (!jobId) return null;
  const job = jobs.cancel(jobId);
  cfTunnelJobs.delete(key);
  return job;
}

/*
 * Cloudflare account cooldown must never fail an instance boot. The tunnel
 * injection is parked in the job queue and retried with exponential backoff;
 * the sandbox stays RUNNING and the tunnel is attached once the backoff ends.
 */
function scheduleTunnelRetry(alias, machineId, error, state) {
  const existing = pendingTunnelJob(alias, machineId);
  if (existing) return existing;
  const retry = (state && state.settings && state.settings.cf && state.settings.cf.retry) || {};
  const job = jobs.retry(async () => {
    const outcome = await autoProvisionTunnel(alias, machineId, { queue: false });
    if (!outcome || outcome.ok === false) {
      throw new InstaboxError(
        (outcome && outcome.error) || 'CF 隧道仍未就绪',
        { code: 'cf_tunnel_pending', status: 503 },
      );
    }
    cfTunnelJobs.delete(tunnelKey(alias, machineId));
    return outcome;
  }, { kind: 'cf-tunnel', alias, machineId }, {
    attempts: retry.attempts === undefined ? 6 : Number(retry.attempts),
    delayMs: retry.delayMs === undefined ? 15000 : Number(retry.delayMs),
    factor: retry.factor === undefined ? 2 : Number(retry.factor),
    maxDelayMs: retry.maxDelayMs === undefined ? 5 * 60 * 1000 : Number(retry.maxDelayMs),
  });
  cfTunnelJobs.set(tunnelKey(alias, machineId), job.id);
  recordCfTunnel(alias, machineId, {
    ok: false,
    queued: true,
    retryJobId: job.id,
    nextAt: job.nextAt,
    error: error ? error.message : '',
    code: error && error.code ? error.code : 'cf_retry',
  });
  log(`CF 隧道进入退避重试 ${alias}/${machineId}（${error ? error.message : 'unknown'}）`);
  return job;
}

async function autoProvisionTunnel(alias, machineId, provisionOptions = {}) {
  const state = store.load();
  const account = store.findAccount(state, alias);
  if (!account) return null;
  let target = null;
  try { target = proxies.slotFor(alias); } catch { target = null; }
  if (!target || !target.matrixSlotId) return null;
  const hostname = tunnelHostname(state, alias, machineId);
  if (!hostname) return null;
  const client = controlClientFor(alias);
  if (!client) return { ok: false, alias, machineId, error: 'proxy_unavailable' };
  try {
    const outcome = await cfBridge.provisionMachine(client, machineId, {
      matrixSlotId: target.matrixSlotId,
      hostname,
      internalPort: tunnelInternalPort(state, machineId),
      domainZone: tunnelDomainZone(state, hostname),
      account: alias,
      routingPlane: target.routingPlane,
    });
    recordCfTunnel(alias, machineId, {
      ok: outcome.ok !== false,
      matrixSlotId: outcome.matrixSlotId || target.matrixSlotId,
      hostname: outcome.hostname || hostname,
      tunnelId: outcome.tunnelId || '',
      cloudflared: outcome.cloudflared || 'unknown',
      queued: false,
      error: '',
    });
    if (outcome.tunnelId) {
      const configured = ((state.settings.proxy || {}).tunnels || {})[machineId] || {};
      if (configured.tunnelId !== outcome.tunnelId) {
        await store.update((draft) => {
          draft.settings.proxy = store.normalizeProxySettings(draft.settings.proxy);
          const record = draft.settings.proxy.tunnels[machineId] || { hostname };
          draft.settings.proxy.tunnels[machineId] = { ...record, tunnelId: outcome.tunnelId };
          return true;
        });
      }
    }
    return outcome;
  } catch (error) {
    if (provisionOptions.queue !== false && cfBridge.isRetryableError(error)) {
      const job = scheduleTunnelRetry(alias, machineId, error, state);
      return {
        ok: false,
        queued: true,
        alias,
        machineId,
        jobId: job.id,
        nextAt: job.nextAt,
        code: error.code || 'cf_retry',
        error: error.message,
      };
    }
    throw error;
  }
}

async function tunnelCheckHeartbeat(entry) {
  const state = store.load();
  if (!tunnelHostname(state, entry.account, entry.machineId)) return null;
  const client = controlClientFor(entry.account);
  if (!client) return { ok: false, error: 'proxy_unavailable' };
  const probe = await cfBridge.checkCloudflared(client, entry.machineId);
  if (!probe.running) {
    log(`cloudflared 掉线 ${entry.account}/${entry.machineId}，触发自愈`);
    return { ...probe, ok: false };
  }
  return { ...probe, ok: true };
}

async function tunnelRestartHeartbeat(entry) {
  const state = store.load();
  const hostname = tunnelHostname(state, entry.account, entry.machineId);
  if (!hostname) return { ok: false, error: 'tunnel_not_configured' };
  let target = null;
  try { target = proxies.slotFor(entry.account); } catch { target = null; }
  if (!target || !target.matrixSlotId) return { ok: false, error: 'matrix_slot_missing' };
  const client = controlClientFor(entry.account);
  if (!client) return { ok: false, error: 'proxy_unavailable' };
  try {
    const outcome = await cfBridge.restartCloudflared(client, entry.machineId, {
      matrixSlotId: target.matrixSlotId,
      hostname,
      internalPort: tunnelInternalPort(state, entry.machineId),
      domainZone: tunnelDomainZone(state, hostname),
      account: entry.account,
      routingPlane: target.routingPlane,
    });
    recordCfTunnel(entry.account, entry.machineId, {
      ok: outcome.ok !== false,
      matrixSlotId: outcome.matrixSlotId || target.matrixSlotId,
      hostname: outcome.hostname || hostname,
      tunnelId: outcome.tunnelId || '',
      cloudflared: outcome.cloudflared || (outcome.restarted ? 'restarted' : 'unknown'),
      queued: false,
      error: outcome.error || '',
    });
    return outcome;
  } catch (error) {
    if (cfBridge.isRetryableError(error)) {
      const job = scheduleTunnelRetry(entry.account, entry.machineId, error, state);
      return { ok: false, queued: true, jobId: job.id, error: error.message };
    }
    throw error;
  }
}

function instaboxBusHealth() {
  let state = null;
  try { state = store.load(); } catch { state = null; }
  const entries = state && Array.isArray(state.keepalive) ? state.keepalive : [];
  const runningMachines = entries.filter(
    (entry) => entry && entry.enabled !== false && entry.lastOk === true,
  ).length;
  const activeLeases = entries.filter((entry) => entry && entry.leaseId).length;
  let tunnelledMachines = 0;
  for (const tunnel of cfTunnels.values()) {
    if (tunnel && tunnel.ok !== false && !tunnel.queued) tunnelledMachines += 1;
  }
  return { ok: true, service: 'instabox-matrix', runningMachines, activeLeases, tunnelledMachines };
}

async function overview(state, requested) {
  const accounts = selectedAccounts(state, requested);
  const results = await Promise.all(accounts.map(async (account) => {
    const client = clientForAccount(account, state);
    try {
      const [machines, usage, snapshots] = await Promise.all([
        client.listMachines(),
        client.usage().catch((error) => ({ error: error.message })),
        client.listSnapshots().catch(() => []),
      ]);
      const enriched = await Promise.all(machines.map(async (machine) => {
        const ports = await cachedPorts(client, account.alias, machine.id);
        const connection = machine.state === 'running'
          ? await client.connectionInfo(machine.id).catch(() => null)
          : null;
        return Object.assign({}, machine, {
          account: account.alias,
          ports,
          connection,
          keepalive: keepaliveFor(state, account.alias, machine.id),
          network: netprobe.get(account.alias, machine.id),
          matrix: matrixViewFor(account.alias),
          cf: cfTunnels.get(`${account.alias}/${machine.id}`) || null,
        });
      }));
      return { alias: account.alias, ok: true, usage, snapshots, machines: enriched };
    } catch (error) {
      return {
        alias: account.alias,
        ok: false,
        error: { code: error.code || 'error', message: error.message, status: error.status || 0 },
        machines: [],
        snapshots: [],
        usage: null,
      };
    }
  }));
  return { ok: true, accounts: results, fetchedAt: new Date().toISOString() };
}

function identityOf(me) {
  return {
    login: me.login || '',
    name: me.name || '',
    email: me.email || '',
    org: me.org ? { id: me.org.id, name: me.org.name, tier: me.org.tier } : null,
    allowedSpecs: me.allowedSpecs || [],
    workspaces: me.workspaces || [],
  };
}

async function testCredentials(apiKey, gatewayUrl, alias) {
  const state = store.load();
  const client = new InstaboxClient({
    apiKey,
    baseUrl: gatewayUrl || state.settings.gatewayUrl || undefined,
    fetchImpl: failClosedFetch(state, String(alias || '').trim(), { candidate: true }),
  });
  const me = await client.me();
  return identityOf(me);
}

function mergeAccountMeta(state, alias, identity) {
  const account = store.setAccountMeta(state, alias, {
    identity,
    lastCheckedAt: new Date().toISOString(),
    lastError: null,
  });
  return account;
}

async function route(req, res, url) {
  const method = req.method || 'GET';
  const path = url.pathname;
  const query = Object.fromEntries(url.searchParams.entries());
  const parts = path.split('/').filter(Boolean);

  if (method === 'GET' && path === '/health') {
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && path === '/api/bootstrap') {
    const state = store.load();
    return send(res, 200, {
      ok: true,
      version: EXTENSION_VERSION,
      settings: state.settings,
      accounts: state.accounts.map(store.publicAccount),
      keepalive: state.keepalive,
    });
  }

  if (parts[0] === 'api' && parts[1] === 'terminal' && parts[2]) {
    const sessionId = decodeURIComponent(parts[2]);
    if (method === 'GET' && parts.length === 3) {
      const session = terminals.get(sessionId);
      return send(res, 200, { ok: true, terminal: session.poll(query.cursor) });
    }
    if (method === 'POST' && parts[3] === 'input' && parts.length === 4) {
      const body = await readBody(req);
      const session = terminals.get(sessionId);
      const bytes = body.dataB64
        ? Buffer.from(String(body.dataB64), 'base64')
        : Buffer.from(String(body.data === undefined ? '' : body.data), 'utf8');
      session.send(bytes);
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && parts[3] === 'resize' && parts.length === 4) {
      const body = await readBody(req);
      const session = terminals.get(sessionId);
      session.resize(body.cols, body.rows);
      return send(res, 200, { ok: true });
    }
    if (method === 'DELETE' && parts.length === 3) {
      const session = terminals.get(sessionId);
      session.close('client');
      return send(res, 200, { ok: true });
    }
    throw new InstaboxError('接口不存在', { code: 'not_found', status: 404 });
  }

  if (method === 'GET' && path === '/api/settings') {
    return send(res, 200, { ok: true, settings: store.load().settings });
  }

  if (method === 'PUT' && path === '/api/settings') {
    const body = await readBody(req);
    const state = store.load();
    if (body.gatewayUrl !== undefined) state.settings.gatewayUrl = store.normalizeBaseUrl(body.gatewayUrl);
    if (body.defaultTtlSeconds !== undefined) {
      state.settings.defaultTtlSeconds = Math.max(60, Math.min(3600, Number(body.defaultTtlSeconds) || 900));
    }
    if (body.defaultKeepaliveSeconds !== undefined) {
      state.settings.defaultKeepaliveSeconds = Math.max(30, Math.min(3600, Number(body.defaultKeepaliveSeconds) || 240));
    }
    if (body.proxy !== undefined) {
      state.settings.proxy = store.normalizeProxySettings(body.proxy);
    }
    if (body.update !== undefined) {
      state.settings.update = store.normalizeUpdateSettings({
        ...state.settings.update,
        ...(body.update && typeof body.update === 'object' ? body.update : {}),
      });
    }
    store.save(state);
    proxies.closeAll();
    return send(res, 200, { ok: true, settings: state.settings });
  }

  if (method === 'GET' && path === '/api/update/status') {
    const state = store.load();
    return send(res, 200, {
      ok: true,
      currentVersion: selfUpdate.currentVersion(EXTENSION_DIR),
      update: state.settings.update,
    });
  }

  if (method === 'POST' && path === '/api/update/check') {
    const state = store.load();
    try {
      const result = await selfUpdate.check({
        update: state.settings.update,
        installDir: EXTENSION_DIR,
        timeoutMs: 180000,
        log,
      });
      await store.update((draft) => {
        draft.settings.update = store.normalizeUpdateSettings({
          ...draft.settings.update,
          lastCheck: {
            at: result.checkedAt,
            currentVersion: result.currentVersion,
            latestVersion: result.latestVersion,
            available: result.available,
            commit: result.commit,
            error: '',
          },
        });
      });
      return send(res, 200, { ok: true, ...result, update: store.load().settings.update });
    } catch (error) {
      await store.update((draft) => {
        draft.settings.update = store.normalizeUpdateSettings({
          ...draft.settings.update,
          lastCheck: {
            at: new Date().toISOString(),
            currentVersion: selfUpdate.currentVersion(EXTENSION_DIR),
            latestVersion: '',
            available: false,
            commit: '',
            error: String(error && error.message ? error.message : error),
          },
        });
      });
      throw error;
    }
  }

  if (method === 'POST' && path === '/api/update/apply') {
    const state = store.load();
    const result = await selfUpdate.apply({
      update: state.settings.update,
      installDir: EXTENSION_DIR,
      registry: REGISTRY_FILE,
      timeoutMs: 300000,
      log,
    });
    return send(res, 200, { ok: true, ...result });
  }

  if (method === 'GET' && path === '/api/proxy/status') {
    return send(res, 200, { ok: true, proxy: proxies.status(), settings: store.load().settings.proxy });
  }

  if (method === 'POST' && path === '/api/proxy/release') {
    const body = await readBody(req);
    proxies.release(body.alias ? String(body.alias) : '');
    return send(res, 200, { ok: true, proxy: proxies.status() });
  }

  if (method === 'POST' && path === '/api/proxy/probe') {
    const body = await readBody(req);
    const state = store.load();
    const accounts = selectedAccounts(state, body.account || '');
    if (!accounts.length) throw new InstaboxError('没有可用账号', { code: 'no_account', status: 400 });
    const results = await Promise.all(accounts.map((account) => proxies.probe(account.alias)));
    return send(res, 200, { ok: results.every((item) => item.ok), results });
  }

  if (method === 'POST' && path === '/api/test') {
    const body = await readBody(req);
    const apiKey = String(body.apiKey || '').trim();
    if (!apiKey) throw new InstaboxError('缺少 API Key', { code: 'missing_key', status: 400 });
    const identity = await testCredentials(
      apiKey,
      body.gatewayUrl ? store.normalizeBaseUrl(body.gatewayUrl) : '',
      body.alias ? String(body.alias) : '',
    );
    return send(res, 200, { ok: true, identity });
  }

  if (path === '/api/accounts') {
    const state = store.load();
    if (method === 'GET') {
      return send(res, 200, { ok: true, accounts: state.accounts.map(store.publicAccount) });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const alias = store.normalizeAlias(body.alias);
      const apiKey = String(body.apiKey || '').trim();
      if (!apiKey) throw new InstaboxError('缺少 API Key', { code: 'missing_key', status: 400 });
      if (state.accounts.some((a) => a.alias === alias)) {
        throw new InstaboxError(`账号别名已存在：${alias}`, { code: 'alias_exists', status: 409 });
      }
      const gatewayUrl = body.gatewayUrl ? store.normalizeBaseUrl(body.gatewayUrl) : '';
      let identity = null;
      if (!body.skipTest) {
        try {
          identity = await testCredentials(apiKey, gatewayUrl, alias);
        } catch (error) {
          if (error && error.code === 'ERR_PROXY_REQUIRED_FAIL_CLOSED') throw error;
          throw new InstaboxError(`API Key 验证失败：${error.message}`, {
            code: 'test_failed',
            status: 400,
            body: { cause: error.code },
          });
        }
      }
      const account = {
        alias,
        apiKey,
        gatewayUrl,
        enabled: true,
        createdAt: new Date().toISOString(),
        lastCheckedAt: identity ? new Date().toISOString() : null,
        identity,
        lastError: null,
      };
      state.accounts.push(account);
      store.save(state);
      return send(res, 201, { ok: true, account: store.publicAccount(account) });
    }
    throw new InstaboxError('方法不允许', { code: 'method_not_allowed', status: 405 });
  }

  if (parts[0] === 'api' && parts[1] === 'accounts' && parts[2]) {
    const alias = decodeURIComponent(parts[2]);
    const state = store.load();
    const account = store.findAccount(state, alias);
    if (!account) throw new InstaboxError(`账号不存在：${alias}`, { code: 'account_not_found', status: 404 });
    if (method === 'PATCH') {
      const body = await readBody(req);
      if (body.apiKey !== undefined) {
        const apiKey = String(body.apiKey).trim();
        if (!apiKey) throw new InstaboxError('API Key 不能为空', { code: 'missing_key', status: 400 });
        account.apiKey = apiKey;
        account.identity = null;
        account.lastCheckedAt = null;
      }
      if (body.gatewayUrl !== undefined) account.gatewayUrl = store.normalizeBaseUrl(body.gatewayUrl);
      if (body.enabled !== undefined) account.enabled = Boolean(body.enabled);
      if (body.retest) {
        try {
          account.identity = await testCredentials(account.apiKey, account.gatewayUrl, account.alias);
          account.lastCheckedAt = new Date().toISOString();
          account.lastError = null;
        } catch (error) {
          account.lastError = error.message;
          if (error && error.code === 'ERR_PROXY_REQUIRED_FAIL_CLOSED') throw error;
          throw new InstaboxError(`验证失败：${error.message}`, { code: 'test_failed', status: 400 });
        }
      }
      store.save(state);
      return send(res, 200, { ok: true, account: store.publicAccount(account) });
    }
    if (method === 'DELETE') {
      store.removeAccount(state, alias);
      store.save(state);
      portCache.clear();
      return send(res, 200, { ok: true });
    }
    throw new InstaboxError('方法不允许', { code: 'method_not_allowed', status: 405 });
  }

  if (method === 'GET' && path === '/api/matrix') {
    const state = store.load();
    return send(res, 200, { ok: true, meta: state.machineMeta || [] });
  }

  if (method === 'PUT' && path === '/api/matrix/meta') {
    const body = await readBody(req);
    const account = String(body.account || '').trim();
    const machineId = String(body.machineId || '').trim();
    if (!account || !machineId) {
      throw new InstaboxError('缺少 account 或 machineId', { code: 'bad_request', status: 400 });
    }
    const state = store.load();
    const patch = { account, machineId };
    if (body.projectGroup !== undefined) patch.projectGroup = body.projectGroup;
    if (body.role !== undefined) patch.role = body.role;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (body.tags !== undefined) {
      patch.tags = Array.isArray(body.tags) ? body.tags : String(body.tags).split(',');
    }
    const meta = store.setMachineMeta(state, patch);
    store.save(state);
    return send(res, 200, { ok: true, meta });
  }

  if (method === 'GET' && path === '/api/keepalive') {
    return send(res, 200, { ok: true, keepalive: store.load().keepalive });
  }

  if (method === 'GET' && path === '/api/netprobe') {
    return send(res, 200, {
      ok: true,
      network: netprobe.snapshot(query.account || 'all'),
      fetchedAt: new Date().toISOString(),
    });
  }

  if (method === 'POST' && path === '/api/netprobe') {
    const body = await readBody(req);
    const state = store.load();
    const accounts = selectedAccounts(state, body.account || 'all');
    const wanted = Array.isArray(body.machineIds) && body.machineIds.length
      ? new Set(body.machineIds.map(String))
      : null;
    const targets = [];
    for (const account of accounts) {
      const client = clientForAccount(account, state);
      let machines;
      try {
        machines = await client.listMachines();
      } catch (error) {
        log(`netprobe list failed ${account.alias}: ${error.message}`);
        continue;
      }
      for (const machine of machines) {
        if (machine.state !== 'running') continue;
        if (machine.runtime && machine.runtime.ready === false) continue;
        if (wanted && !wanted.has(machine.id)) continue;
        targets.push({ account: account.alias, machineId: machine.id, client });
      }
    }
    if (targets.length) void probeBatch(targets, Boolean(body.force));
    return send(res, 202, { ok: true, accepted: targets.length, running: targets.length > 0 });
  }

  if (method === 'POST' && path === '/api/keepalive/tick') {
    let scope = null;
    try {
      const body = await readBody(req);
      if (body && Array.isArray(body.accounts) && body.accounts.length) scope = body.accounts.map(String);
    } catch (error) {
      scope = null;
    }
    const patches = await keepalive.tick(Date.now(), scope);
    return send(res, 200, { ok: true, patches, scope: scope || 'all' });
  }

  if (method === 'GET' && path === '/api/recycle') {
    return send(res, 200, { ok: true, recycle: buildRecycleView(store.load(), Date.now()) });
  }

  if (method === 'PUT' && path === '/api/recycle') {
    const body = await readBody(req);
    const machineInput = body.machine && typeof body.machine === 'object' ? body.machine : null;
    if (machineInput && (!machineInput.account || !machineInput.machineId)) {
      throw new InstaboxError('缺少 machine.account 或 machine.machineId', { code: 'bad_request', status: 400 });
    }
    await store.update((state) => {
      const current = (state.settings && state.settings.recycle) || {};
      state.settings.recycle = store.normalizeRecycleSettings({
        ...current,
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.leadMinutes !== undefined ? { leadMinutes: body.leadMinutes } : {}),
        ...(body.minUptimeMinutes !== undefined ? { minUptimeMinutes: body.minUptimeMinutes } : {}),
        ...(body.pollMinutes !== undefined ? { pollMinutes: body.pollMinutes } : {}),
        ...(body.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: body.verifyTimeoutMs } : {}),
        ...(body.bootstrapTimeoutSeconds !== undefined
          ? { bootstrapTimeoutSeconds: body.bootstrapTimeoutSeconds }
          : {}),
      });
      if (machineInput) {
        store.setRecycleConfig(state, {
          account: machineInput.account,
          machineId: machineInput.machineId,
          ...(machineInput.enabled !== undefined ? { enabled: machineInput.enabled } : {}),
          ...(machineInput.verifyCommand !== undefined ? { verifyCommand: machineInput.verifyCommand } : {}),
          ...(machineInput.bootstrapCommand !== undefined ? { bootstrapCommand: machineInput.bootstrapCommand } : {}),
          ...(machineInput.snapshotBeforeFirst !== undefined
            ? { snapshotBeforeFirst: machineInput.snapshotBeforeFirst }
            : {}),
          ...(machineInput.proxyExitExpect !== undefined ? { proxyExitExpect: machineInput.proxyExitExpect } : {}),
        });
      }
      return true;
    });
    return send(res, 200, { ok: true, recycle: buildRecycleView(store.load(), Date.now()) });
  }

  if (method === 'POST' && path === '/api/recycle/run') {
    const body = await readBody(req);
    const account = String(body.account || '').trim();
    const machineId = String(body.machineId || '').trim();
    if (!account || !machineId) {
      throw new InstaboxError('缺少 account 或 machineId', { code: 'bad_request', status: 400 });
    }
    const config = store.findRecycleConfig(store.load(), account, machineId);
    if (!config) {
      throw new InstaboxError('该机器未配置自动回收', { code: 'recycle_not_configured', status: 400 });
    }
    if (recycler.isBusy(account, machineId)) {
      throw new InstaboxError('自动回收正在进行', { code: 'recycle_busy', status: 409 });
    }
    const outcome = await recycler.runNow(account, machineId, { force: body.force === true });
    return send(res, 200, { ok: outcome.status === 'idle', result: outcome });
  }

  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'jobs' && parts[2]) {
    const job = jobs.get(decodeURIComponent(parts[2]));
    if (!job) throw new InstaboxError('任务不存在或已过期', { code: 'job_not_found', status: 404 });
    return send(res, 200, {
      ok: true,
      status: job.status,
      result: job.result,
      error: job.error,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
    });
  }

  if (method === 'GET' && path === '/api/overview') {
    return send(res, 200, await overview(store.load(), query.account || ''));
  }

  if (method === 'GET' && path === '/api/matrix/status') {
    return send(res, 200, {
      ok: true,
      proxy: proxies.status(),
      egress: egress.status(),
      leases: leaseSync.status(),
      tunnels: [...cfTunnels.entries()].map(([key, value]) => ({ key, ...value })),
      cf: { baseUrl: cfBridge.baseUrl },
    });
  }

  if (method === 'GET' && path === '/api/matrix/slots') {
    const [slotsResult, leasesResult] = await Promise.allSettled([egress.slots(), egress.leases()]);
    const reachable = slotsResult.status === 'fulfilled';
    return send(res, 200, {
      ok: true,
      reachable,
      error: reachable ? undefined : String(slotsResult.reason && slotsResult.reason.message),
      slots: reachable ? slotsResult.value : [],
      leases: leasesResult.status === 'fulfilled' ? leasesResult.value : [],
      accounts: proxies.status(),
    });
  }

  if (method === 'POST' && path === '/api/matrix/sync') {
    return send(res, 200, { ok: true, ...(await leaseSync.sync()) });
  }

  if (method === 'POST' && path === '/api/matrix/bind') {
    const body = await readBody(req);
    const alias = String(body.alias || body.account || '');
    if (!alias) throw new InstaboxError('缺少 alias', { code: 'missing_alias', status: 400 });
    return send(res, 200, { ok: true, result: await leaseSync.bind(alias, body) });
  }

  if (method === 'POST' && path === '/api/matrix/rotate') {
    const body = await readBody(req);
    const alias = String(body.alias || body.account || '');
    let target = null;
    try { target = proxies.slotFor(alias); } catch { target = null; }
    if (!target || !target.matrixSlotId) {
      throw new InstaboxError(`账号 ${alias || '(空)'} 没有矩阵槽位`, {
        code: 'matrix_slot_missing',
        status: 409,
      });
    }
    const result = await egress.rotateSlot(
      target.matrixSlotId,
      body.reason ? { reason: String(body.reason) } : {},
    );
    return send(res, 202, { ok: true, matrixSlotId: target.matrixSlotId, result });
  }

  if (method === 'GET' && path === '/api/cf/status') {
    return send(res, 200, { ok: true, ...(await cfBridge.status()) });
  }

  if (method === 'POST' && path === '/api/cf/tunnel/provision') {
    const body = await readBody(req);
    const alias = String(body.alias || body.account || query.account || '');
    const machineId = String(body.machineId || '');
    if (!machineId) throw new InstaboxError('缺少 machineId', { code: 'missing_machine_id', status: 400 });
    if (body.hostname) {
      await store.update((state) => {
        state.settings.proxy = store.normalizeProxySettings(state.settings.proxy);
        state.settings.proxy.tunnels[machineId] = { hostname: String(body.hostname) };
        return true;
      });
    }
    const outcome = await autoProvisionTunnel(alias, machineId);
    if (!outcome) {
      throw new InstaboxError('CF 桥接未配置（缺少 hostnameSuffix 或矩阵槽位）', {
        code: 'cf_unavailable',
        status: 409,
      });
    }
    return send(res, 202, { ok: true, tunnel: outcome });
  }

  if (method === 'POST' && path === '/api/cf/tunnel/teardown') {
    const body = await readBody(req);
    const alias = String(body.alias || body.account || query.account || '');
    const machineId = String(body.machineId || '');
    if (!machineId) throw new InstaboxError('缺少 machineId', { code: 'missing_machine_id', status: 400 });
    const client = controlClientFor(alias);
    if (!client) throw new InstaboxError('该账号没有可用代理，已拒绝直连', { code: 'proxy_unavailable', status: 503 });
    let target = null;
    try { target = proxies.slotFor(alias); } catch { target = null; }
    cancelTunnelRetry(alias, machineId);
    const tunnelRecord = cfTunnels.get(tunnelKey(alias, machineId)) || {};
    const persisted = ((store.load().settings.proxy || {}).tunnels || {})[machineId] || {};
    const outcome = await cfBridge.teardownMachine(client, machineId, {
      hostname: String(body.hostname || ''),
      matrixSlotId: target && target.matrixSlotId ? target.matrixSlotId : String(body.matrixSlotId || ''),
      tunnelId: String(body.tunnelId || tunnelRecord.tunnelId || persisted.tunnelId || ''),
    });
    cfBridge.forgetToken(machineId);
    cfTunnels.delete(`${alias}/${machineId}`);
    return send(res, 200, { ok: true, tunnel: outcome });
  }

  if (method === 'GET' && path === '/api/usage') {
    const state = store.load();
    const accounts = selectedAccounts(state, query.account || '');
    const data = await Promise.all(accounts.map(async (account) => {
      try {
        return { alias: account.alias, ok: true, usage: await clientForAccount(account, state).usage() };
      } catch (error) {
        return { alias: account.alias, ok: false, error: { code: error.code, message: error.message } };
      }
    }));
    return send(res, 200, { ok: true, accounts: data });
  }

  if (method === 'GET' && path === '/api/snapshots') {
    const state = store.load();
    const accounts = selectedAccounts(state, query.account || '');
    const data = await Promise.all(accounts.map(async (account) => {
      try {
        return { alias: account.alias, ok: true, snapshots: await clientForAccount(account, state).listSnapshots() };
      } catch (error) {
        return { alias: account.alias, ok: false, error: { code: error.code, message: error.message } };
      }
    }));
    return send(res, 200, { ok: true, accounts: data });
  }

  if (method === 'GET' && path === '/api/templates') {
    const state = store.load();
    const accounts = selectedAccounts(state, query.account || '');
    const data = await Promise.all(accounts.map(async (account) => {
      try {
        return {
          alias: account.alias,
          ok: true,
          templates: await clientForAccount(account, state).templates(),
        };
      } catch (error) {
        return { alias: account.alias, ok: false, templates: [], error: { code: error.code, message: error.message } };
      }
    }));
    return send(res, 200, { ok: true, accounts: data });
  }

  if (method === 'POST' && path === '/api/machines') {
    const body = await readBody(req);
    const state = store.load();
    const account = store.findAccount(state, String(body.account || ''));
    if (!account) throw new InstaboxError('请先添加一个 Instabox 账号', { code: 'account_not_found', status: 404 });
    const payload = {};
    const keys = [
      'name', 'templateId', 'templateVersion', 'snapshotId', 'vcpus', 'memMiB',
      'rootDiskGiB', 'persistentDiskGiB', 'desiredState', 'autoSuspendAfterSeconds',
      'maxRunMinutes',
    ];
    for (const key of keys) {
      if (body[key] !== undefined && body[key] !== null && body[key] !== '') payload[key] = body[key];
    }
    const operation = await clientForAccount(account, state).createMachine(payload);
    return send(res, 202, { ok: true, operationId: operation.id, operation });
  }

  if (method === 'GET' && parts[0] === 'api' && parts[1] === 'operations' && parts[2] && parts[3]) {
    const state = store.load();
    const alias = decodeURIComponent(parts[2]);
    const operationId = decodeURIComponent(parts[3]);
    const operation = await clientFor(state, alias).operation(operationId);
    return send(res, 200, { ok: true, operation });
  }

  if (parts[0] === 'api' && parts[1] === 'snapshots' && parts[2] && parts[3] && method === 'DELETE') {
    const state = store.load();
    const alias = decodeURIComponent(parts[2]);
    const snapshotId = decodeURIComponent(parts[3]);
    const client = clientFor(state, alias);
    await client.deleteSnapshot(snapshotId, snapshotId);
    return send(res, 200, { ok: true });
  }

  if (parts[0] === 'api' && parts[1] === 'machines' && parts[2] && parts[3] && parts[4] === 'terminal' && parts.length === 5 && method === 'POST') {
    const state = store.load();
    const alias = decodeURIComponent(parts[2]);
    const machineId = decodeURIComponent(parts[3]);
    const client = clientFor(state, alias);
    const session = await terminals.create({
      baseUrl: client.baseUrl,
      apiKey: client.apiKey,
      machineId,
      connect: proxyRequired(state)
        ? (wsUrl, wsOptions) => proxies.connectWebSocket(alias, wsUrl, wsOptions)
        : undefined,
    });
    return send(res, 201, {
      ok: true,
      sessionId: session.id,
      session: session.serverSession,
      persistent: session.persistent,
    });
  }

  if (parts[0] === 'api' && parts[1] === 'machines' && parts[2] && parts[3]) {
    const state = store.load();
    const alias = decodeURIComponent(parts[2]);
    const machineId = decodeURIComponent(parts[3]);
    const rest = parts.slice(4).map(decodeURIComponent);
    const client = clientFor(state, alias);

    if (rest.length === 0 && method === 'GET') {
      const [machine, usage] = await Promise.all([
        client.getMachine(machineId),
        client.machineUsage(machineId).catch(() => null),
      ]);
      return send(res, 200, { ok: true, machine, usage, keepalive: keepaliveFor(state, alias, machineId) });
    }

    if (rest[0] === 'connection' && method === 'GET') {
      return send(res, 200, { ok: true, connection: await client.connectionInfo(machineId) });
    }

    if (rest[0] === 'usage' && method === 'GET') {
      return send(res, 200, { ok: true, usage: await client.machineUsage(machineId) });
    }

    if (rest[0] === 'metrics' && method === 'GET') {
      return send(res, 200, { ok: true, data: await client.metrics(machineId, { since: query.since || undefined }) });
    }

    if (rest[0] === 'logs' && method === 'GET') {
      const tail = Math.max(1, Math.min(5000, Number(query.tail) || 200));
      const after = query.after === undefined || query.after === '' ? undefined : Number(query.after);
      return send(res, 200, { ok: true, data: await client.logs(machineId, { tail, after }) });
    }

    if (rest[0] === 'history' && method === 'GET') {
      if (rest.length === 2) {
        return send(res, 200, { ok: true, data: await client.historyEntry(machineId, rest[1]) });
      }
      const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
      return send(res, 200, {
        ok: true,
        data: await client.history(machineId, { limit, cursor: query.cursor || undefined }),
      });
    }

    if (rest[0] === 'processes' && method === 'GET') {
      return send(res, 200, {
        ok: true,
        data: await client.processes(machineId, { all: query.all === 'true' || query.all === '1' }),
      });
    }

    if (rest[0] === 'inventory' && rest.length === 1) {
      const key = `${alias}:${machineId}`;
      const cached = inventoryCache.get(key) || null;
      if (method === 'GET') {
        return send(res, 200, { ok: true, inventory: cached, ttlMs: inventory.INVENTORY_TTL_MS });
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const age = cached ? Date.now() - Date.parse(cached.scannedAt || 0) : Infinity;
        if (!body.force && cached && age >= 0 && age < inventory.INVENTORY_TTL_MS) {
          return send(res, 200, {
            ok: true,
            inventory: cached,
            cached: true,
            ttlMs: inventory.INVENTORY_TTL_MS,
          });
        }
        const machine = await client.getMachine(machineId).catch(() => null);
        if (machine && machine.state && machine.state !== 'running') {
          throw new InstaboxError('机器未运行，启动后才能扫描服务清单', { code: 'machine_not_running', status: 409 });
        }
        const scanned = await inventory.scanInventory(client, machineId, {
          timeoutSeconds: Math.max(15, Math.min(180, Number(body.timeoutSeconds) || 90)),
        });
        inventoryCache.set(key, scanned);
        return send(res, 200, {
          ok: true,
          inventory: scanned,
          cached: false,
          ttlMs: inventory.INVENTORY_TTL_MS,
        });
      }
    }

    if (rest[0] === 'canvas' && rest.length === 1 && method === 'POST') {
      const body = await readBody(req);
      const [machine, connection, rawPorts] = await Promise.all([
        client.getMachine(machineId),
        client.connectionInfo(machineId).catch(() => null),
        cachedPorts(client, alias, machineId),
      ]);
      const running = machine && machine.state === 'running';
      let inventoryData = inventoryCache.get(`${alias}:${machineId}`) || null;
      const warnings = [];
      const wantScan = body.refresh === true || body.scan === true;
      if (running && (wantScan || !inventoryData)) {
        try {
          inventoryData = await inventory.scanInventory(client, machineId, {
            timeoutSeconds: Math.max(15, Math.min(180, Number(body.timeoutSeconds) || 90)),
          });
          inventoryCache.set(`${alias}:${machineId}`, inventoryData);
        } catch (error) {
          warnings.push('扫描服务清单失败：' + error.message);
        }
      } else if (!inventoryData) {
        warnings.push('机器未运行，未扫描服务清单。');
      }
      const recycleView = buildRecycleView(state, Date.now());
      const recycle = (recycleView.machines || []).find(
        (entry) => entry.account === alias && entry.machineId === machineId,
      ) || null;
      const html = canvasPage.buildMachineCanvasHtml({
        machine: Object.assign({}, machine, { account: alias }),
        account: alias,
        connection: running ? connection : null,
        ports: Array.isArray(rawPorts) ? rawPorts : (rawPorts && Array.isArray(rawPorts.ports) ? rawPorts.ports : []),
        inventory: inventoryData,
        keepalive: keepaliveFor(state, alias, machineId),
        recycle,
        warnings,
      });
      const published = await canvas.publishArtifact({
        title: '机器画布 · ' + (machine.name || machineId),
        html,
        dedupeKey: 'instabox-matrix:machine-canvas:' + alias + ':' + machineId,
        directory: process.env.CANVAS_DIRECTORY || EXTENSION_ROOT,
        tags: ['instabox', 'machine'],
      });
      const viewer = await canvas.ensureViewer({
        storeRoot: canvas.defaultStoreRoot(),
        canvasDir: canvas.defaultCanvasDir(),
      });
      if (published.contentChanged) {
        await canvas.notifyViewerChanged(viewer, {
          id: published.id,
          version: published.version,
        }).catch(() => {});
      }
      const minted = await canvas.mintViewUrl(viewer, {
        id: published.id,
        version: published.version,
      });
      return send(res, 200, {
        ok: true,
        url: minted.url,
        expiresAt: minted.expiresAt,
        artifactId: published.id,
        version: published.version,
        contentChanged: published.contentChanged,
        warnings,
      });
    }

    if (rest[0] === 'exec' && method === 'POST') {
      const body = await readBody(req);
      const cmd = String(body.cmd || '').trim();
      if (!cmd) throw new InstaboxError('缺少要执行的命令', { code: 'missing_cmd', status: 400 });
      const timeoutSeconds = Math.max(1, Math.min(600, Number(body.timeoutSeconds) || 60));
      const job = jobs.start(
        () => client.exec(machineId, cmd, { timeoutSeconds, noHistory: Boolean(body.noHistory) }),
        { alias, machineId, cmd, timeoutSeconds },
      );
      return send(res, 202, { ok: true, jobId: job.id, status: job.status, startedAt: job.startedAt });
    }

    if (rest[0] === 'ports' && rest.length === 1) {
      if (method === 'GET') return send(res, 200, { ok: true, ports: await client.listPorts(machineId) });
      if (method === 'POST') {
        const body = await readBody(req);
        const port = Number(body.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) {
          throw new InstaboxError('端口必须在 1024-65535 之间', { code: 'bad_port', status: 400 });
        }
        const payload = { port };
        if (body.name) payload.name = String(body.name).slice(0, 100);
        if (body.access) payload.access = body.access === 'private' ? 'private' : 'public';
        if (body.protocol) payload.protocol = body.protocol === 'tcp' ? 'tcp' : 'http';
        portCache.delete(`${alias}:${machineId}`);
        return send(res, 200, { ok: true, port: await client.publishPort(machineId, payload) });
      }
    }

    if (rest[0] === 'ports' && rest.length === 2 && method === 'DELETE') {
      portCache.delete(`${alias}:${machineId}`);
      await client.unpublishPort(machineId, rest[1]);
      return send(res, 200, { ok: true });
    }

    if (rest[0] === 'snapshots' && method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
        throw new InstaboxError('快照名需为 1-63 位小写字母、数字或短横线，并以字母或数字开头', { code: 'bad_snapshot_name', status: 400 });
      }
      const payload = { name };
      if (body.description) payload.description = String(body.description).slice(0, 500);
      if (body.rootOnly) payload.rootOnly = true;
      return send(res, 200, { ok: true, snapshot: await client.snapshot(machineId, payload) });
    }

    if (rest[0] === 'keepalive' && method === 'PUT') {
      const body = await readBody(req);
      const enabled = Boolean(body.enabled);
      if (!enabled) {
        await keepalive.release(alias, machineId).catch((error) => log(`lease release failed: ${error.message}`));
      }
      const entry = store.upsertKeepalive(state, {
        account: alias,
        machineId,
        machineName: body.machineName || '',
        mode: body.mode,
        ttlSeconds: body.ttlSeconds,
        knockUrl: body.knockUrl,
        autoWake: body.autoWake,
        enabled,
      });
      store.save(state);
      return send(res, 200, { ok: true, keepalive: entry });
    }

    if (rest.length === 1 && rest[0] === 'fork' && method === 'POST') {
      const body = await readBody(req);
      const payload = {};
      if (body.name !== undefined) payload.name = String(body.name).trim();
      if (body.vcpus !== undefined && body.vcpus !== '') payload.vcpus = body.vcpus;
      if (body.memMiB !== undefined && body.memMiB !== '') payload.memMiB = body.memMiB;
      const operation = await client.forkMachine(machineId, payload);
      return send(res, 202, { ok: true, operationId: operation.id, operation });
    }

    if (rest.length === 1 && rest[0] === 'restore' && method === 'POST') {
      const body = await readBody(req);
      const payload = {};
      if (body.snapshotId) payload.snapshotId = String(body.snapshotId);
      if (body.desiredState) payload.desiredState = body.desiredState === 'stopped' ? 'stopped' : 'running';
      return send(res, 200, { ok: true, operation: await client.power(machineId, 'restore', { body: payload }) });
    }

    if (rest[0] === 'files' && rest.length === 1 && method === 'GET') {
      const files = await client.listFiles(machineId, query.path || '/');
      return send(res, 200, { ok: true, files });
    }

    if (rest[0] === 'files' && rest.length === 2 && rest[1] === 'download' && method === 'GET') {
      const data = await client.downloadFile(machineId, query.path || '');
      return send(res, 200, {
        ok: true,
        file: {
          path: data.path,
          mode: data.mode,
          size: data.size,
          base64: data.buffer.toString('base64'),
        },
      });
    }

    if (rest[0] === 'files' && rest.length === 2 && rest[1] === 'write' && method === 'POST') {
      const body = await readBody(req, 8 * 1024 * 1024);
      const base64 = String(body.base64 || '');
      if (!base64) throw new InstaboxError('缺少 base64 内容', { code: 'missing_content', status: 400 });
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length > MAX_UPLOAD_BYTES) {
        throw new InstaboxError('上传文件不能超过 4 MiB', { code: 'file_too_large', status: 413 });
      }
      const written = await client.writeFile(machineId, body.path, buffer, {
        mode: body.mode,
        parents: Boolean(body.parents),
      });
      return send(res, 200, { ok: true, written });
    }

    if (rest[0] === 'files' && rest.length === 2 && rest[1] === 'upload-url' && method === 'POST') {
      const body = await readBody(req);
      const upload = await client.createUploadURL(machineId, {
        path: body.path,
        expiresInSeconds: body.expiresInSeconds,
        mode: body.mode,
        parents: Boolean(body.parents),
      });
      return send(res, 200, {
        ok: true,
        upload,
        curl: `curl -T LOCAL_FILE '${upload.url}'`,
      });
    }

    if (rest[0] === 'ssh-tokens' && rest.length === 1 && method === 'GET') {
      const tokens = await client.listSSHTokens(machineId);
      return send(res, 200, { ok: true, tokens });
    }

    if (rest[0] === 'ssh-tokens' && rest.length === 1 && method === 'POST') {
      const body = await readBody(req);
      const token = await client.createSSHToken(machineId, {
        name: body.name,
        ttlSeconds: body.ttlSeconds,
        noExpiry: body.noExpiry === true,
      });
      return send(res, 201, { ok: true, token });
    }

    if (rest[0] === 'ssh-tokens' && rest.length === 1 && method === 'DELETE') {
      const result = await client.revokeAllSSHTokens(machineId);
      return send(res, 200, { ok: true, revoked: result && result.revoked });
    }

    if (rest[0] === 'ssh-tokens' && rest.length === 2 && method === 'DELETE') {
      await client.revokeSSHToken(machineId, rest[1]);
      return send(res, 200, { ok: true });
    }

    if (rest[0] === 'desktop' && rest.length === 1 && method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, {
        ok: true,
        desktop: await client.desktop(machineId, { action: body.action }),
      });
    }

    if (rest[0] === 'desktop' && rest.length === 2 && rest[1] === 'stream' && method === 'POST') {
      const body = await readBody(req);
      const stream = await client.desktopStream(machineId, {
        ttlSeconds: body.ttlSeconds,
        viewOnly: body.viewOnly !== false,
      });
      return send(res, 200, { ok: true, stream });
    }

    if (rest[0] === 'desktop' && rest.length === 2 && rest[1] === 'stream' && method === 'DELETE') {
      await client.deleteDesktopStream(machineId);
      return send(res, 200, { ok: true });
    }

    if (rest[0] === 'desktop' && rest.length === 2 && rest[1] === 'state' && method === 'GET') {
      const state = await client.desktopStreamState(machineId, { token: query.token });
      return send(res, 200, { ok: true, state });
    }

    if (rest.length === 1 && method === 'POST') {
      const action = rest[0];
      const body = await readBody(req);
      if (action === 'delete') {
        const confirm = String(body.confirm || '');
        if (!confirm) throw new InstaboxError('删除需要 confirm（机器 ID 或名称）', { code: 'confirm_required', status: 400 });
        try {
          let target = null;
          try { target = proxies.slotFor(alias); } catch { target = null; }
          cancelTunnelRetry(alias, machineId);
          const tunnelRecord = cfTunnels.get(tunnelKey(alias, machineId)) || {};
          const persisted = ((store.load().settings.proxy || {}).tunnels || {})[machineId] || {};
          await cfBridge.teardownMachine(client, machineId, {
            matrixSlotId: target && target.matrixSlotId ? target.matrixSlotId : '',
            tunnelId: tunnelRecord.tunnelId || persisted.tunnelId || '',
          });
          cfBridge.forgetToken(machineId);
        } catch (error) {
          log(`CF 隧道清理失败 ${alias}/${machineId}: ${error.message}`);
        }
        cfTunnels.delete(`${alias}/${machineId}`);
        const operation = await client.power(machineId, 'delete', { confirm });
        return send(res, 200, { ok: true, operation });
      }
      if (['start', 'stop', 'suspend', 'resume', 'wake'].includes(action)) {
        const operation = await client.power(machineId, action);
        return send(res, 200, { ok: true, operation });
      }
      throw new InstaboxError(`未知操作：${action}`, { code: 'bad_action', status: 400 });
    }

    throw new InstaboxError('接口不存在', { code: 'not_found', status: 404 });
  }

  throw new InstaboxError('接口不存在', { code: 'not_found', status: 404 });
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || '');
  res.setHeader('access-control-allow-origin', origin || '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader(
    'access-control-allow-headers',
    String(req.headers['access-control-request-headers'] || 'authorization,content-type,x-oc-routing-plane'),
  );
  res.setHeader('access-control-max-age', '600');
  res.setHeader('vary', 'origin');
}

const server = http.createServer(async (req, res) => {
  try {
    applyCors(req, res);
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'cache-control': 'no-store' });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/instabox/bus-health') {
      return send(res, 200, instaboxBusHealth());
    }
    if (!authorized(req)) {
      return send(res, 401, { ok: false, error: { code: 'unauthorized', message: 'Missing or invalid service token' } });
    }
    await route(req, res, url);
  } catch (error) {
    if (!res.headersSent) failure(res, error);
    else res.end();
  }
});

/*
 * Rotation choreography: the egress matrix announces a freeze before it swaps
 * an upstream. Every account bound to that slot stops issuing control-plane
 * requests and its connection pools are torn down; ACK is sent by the client
 * after these handlers resolve. Resume refreshes the fingerprint and reopens.
 */
function startEgressSubscription() {
  egress.subscribe({
    freeze: (record) => {
      const paused = proxies.freezeSlot(record.matrixSlotId, record);
      log(`egress 冻结 ${record.matrixSlotId}（${record.reason}），暂停 ${paused.length} 个账号`);
    },
    resume: ({ slot }) => {
      const resumed = proxies.resumeSlot(slot.matrixSlotId, slot.egressFingerprint);
      const exitIp = slot.egressFingerprint && slot.egressFingerprint.exitIp;
      log(`egress 恢复 ${slot.matrixSlotId}${exitIp ? ` exit=${exitIp}` : ''}，恢复 ${resumed.length} 个账号`);
    },
    failed: (payload) => {
      log(`egress 轮换失败 ${payload.matrixSlotId}: ${payload.reason || payload.error || 'unknown'}`);
    },
    slot: ({ slot }) => {
      log(`egress 槽位更新 ${slot.matrixSlotId} -> ${slot.healthState}`);
    },
  });
}

server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT}`);
  startEgressSubscription();
  keepalive.start();
  void keepalive.tick();
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  keepalive.stop();
  terminals.closeAll();
  egress.close();
  proxies.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
