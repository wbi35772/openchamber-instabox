'use strict';

/*
 * Control-plane bridge to the local Cloudflare tunnel provisioner
 * (`openchamber-cloudflare`, 127.0.0.1:19882, zero ingress):
 *
 *   POST /api/v1/cf/tunnel/provision  -> allocate a named tunnel for an instance
 *   POST /api/v1/cf/tunnel/teardown   -> release it
 *   GET  /api/v1/cf/status            -> provisioner health and counters
 *
 * The tunnel token never lands in state, logs or API responses: it is read from
 * the provision response and immediately handed to `cloudflared` inside the
 * instance through one non-history exec call.
 */

const http = require('node:http');
const https = require('node:https');
const contract = require('../core/contract');

const DEFAULT_BASE_URL = 'http://127.0.0.1:19882';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_CLOUDFLARED = 'cloudflared';
const DEFAULT_LOG_FILE = '/tmp/cloudflared.log';
const TOKEN_ENV = 'OPENCHAMBER_CF_TOKEN';
const DOMAIN_ZONE_ENV = 'OPENCHAMBER_CF_DOMAIN_ZONE';

class CfBridgeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'CfBridgeError';
    this.code = options.code || 'ERR_CF_BRIDGE';
    this.status = options.status || 502;
    if (options.body) this.body = options.body;
  }
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/*
 * One-line background launch command. `--no-autoupdate` keeps the instance
 * image deterministic and `--protocol http2` avoids QUIC being blocked on
 * hosts where only TCP/443 egress exists.
 */
function cloudflaredCommand(token, options = {}) {
  const text = String(token || '');
  if (!text) throw new CfBridgeError('cloudflared token 不能为空', { status: 400, code: 'missing_tunnel_token' });
  const binary = options.binary || DEFAULT_CLOUDFLARED;
  const logFile = options.logFile || DEFAULT_LOG_FILE;
  const args = [
    'tunnel run',
    `--token ${shellQuote(text)}`,
    '--no-autoupdate',
    `--protocol ${options.protocol || 'http2'}`,
    `--edge-ip-version ${options.edgeIpVersion || 'auto'}`,
    `--loglevel ${options.logLevel || 'warn'}`,
  ].join(' ');
  return `nohup ${binary} ${args} >${shellQuote(logFile)} 2>&1 &`;
}

function httpRequest(baseUrl, method, pathname, body, timeoutMs, extraHeaders = {}) {
  let url;
  try {
    url = new URL(`${baseUrl}${pathname}`);
  } catch (error) {
    return Promise.reject(new CfBridgeError(`CF 桥接 URL 无效: ${pathname}`, { code: 'bad_cf_url' }));
  }
  const transport = url.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search || ''}`,
      method,
      headers: {
        accept: 'application/json',
        ...extraHeaders,
        ...(payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(new CfBridgeError(`CF 桥接响应失败: ${error.message}`, { code: 'cf_unreachable' }));
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = { raw: text };
        }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(data);
          return;
        }
        reject(new CfBridgeError(
          (data && (data.error || data.message)) || `CF 桥接 HTTP ${response.statusCode}`,
          {
            status: response.statusCode,
            code: (data && data.code) || 'cf_http_error',
            body: data,
          },
        ));
      });
    });
    request.setTimeout(timeoutMs, () => {
      if (settled) return;
      settled = true;
      const error = new CfBridgeError(`CF 桥接超时: ${method} ${pathname}`, { code: 'cf_timeout' });
      request.destroy(error);
      reject(error);
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (error instanceof CfBridgeError) {
        reject(error);
        return;
      }
      reject(new CfBridgeError(`CF 桥接不可达: ${error.message}`, { code: 'cf_unreachable' }));
    });
    if (payload) request.write(payload);
    request.end();
  });
}

function extractToken(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return String(
    payload.tunnelToken
    || payload.token
    || (payload.tunnel && (payload.tunnel.token || payload.tunnel.tunnelToken))
    || '',
  );
}

function execSummary(result) {
  if (!result || typeof result !== 'object') return result || null;
  return {
    exitCode: result.exitCode === undefined ? null : result.exitCode,
    stdout: String(result.stdout || '').slice(0, 400),
    stderr: String(result.stderr || '').slice(0, 400),
  };
}

const CLOUDFLARED_PROBE = 'pgrep -f "cloudflared tunnel run" >/dev/null 2>&1 && echo running || echo down';
const COOLDOWN_CODES = new Set(['cf_cooldown', 'cf_backoff', 'cooldown', 'tunnel_cooldown']);

function isCooldownError(error) {
  if (!error) return false;
  if (COOLDOWN_CODES.has(error.code)) return true;
  if (Number(error.status) === 429) return true;
  const body = error.body || {};
  if (Number(body.retryAfterSeconds) > 0) return true;
  const retryAt = body.retryAt || body.canWakeAt;
  if (retryAt && Date.parse(retryAt) > Date.now()) return true;
  return /cooldown|backoff|冷却|退避/i.test(String(error.message || ''));
}

function isRetryableError(error) {
  if (!error) return false;
  if (isCooldownError(error)) return true;
  if (['cf_unreachable', 'cf_timeout', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code)) return true;
  return Number(error.status) >= 500;
}

function retryAfterMs(error) {
  if (!error) return null;
  const body = error.body || {};
  const seconds = Number(body.retryAfterSeconds || body.retry_after || 0);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  const at = body.retryAt || body.canWakeAt;
  const atMs = at ? Date.parse(at) : NaN;
  if (Number.isFinite(atMs) && atMs > Date.now()) return atMs - Date.now();
  return null;
}

function deriveDomainZone(hostname) {
  const parts = String(hostname || '').toLowerCase().split('.').filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join('.') : '';
}

function normalizeProvisionBody(body = {}) {
  const matrixSlotId = String(body.matrixSlotId || '');
  if (!contract.indexForSlotId(matrixSlotId)) {
    throw new CfBridgeError('provision 需要合法的 matrixSlotId', {
      status: 400,
      code: 'missing_matrix_slot',
    });
  }
  const machineId = String(body.vmInstanceId || body.machineId || body.id || '');
  if (!machineId) {
    throw new CfBridgeError('provision 需要 machineId', { status: 400, code: 'missing_machine_id' });
  }
  const hostname = String(body.publicHostname || body.hostname || '').toLowerCase();
  if (!hostname) {
    throw new CfBridgeError('provision 需要 publicHostname', {
      status: 400,
      code: 'missing_hostname',
    });
  }
  const domainZone = String(
    body.domainZone
    || body.zone
    || process.env[DOMAIN_ZONE_ENV]
    || deriveDomainZone(hostname),
  ).trim().toLowerCase();
  if (!domainZone) {
    throw new CfBridgeError('provision 需要 domainZone 或带域名的 publicHostname', {
      status: 400,
      code: 'missing_domain_zone',
    });
  }
  const internalPort = Number(body.localPort || body.internalPort || body.servicePort || body.targetPort || 0);
  if (internalPort && (!Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65535)) {
    throw new CfBridgeError(`internalPort 非法: ${body.internalPort}`, {
      status: 400,
      code: 'invalid_internal_port',
    });
  }
  return {
    vmInstanceId: machineId,
    machineId,
    matrixSlotId,
    egressPort: Number(body.egressPort || body.port) || contract.egressPortForSlotId(matrixSlotId),
    domainZone,
    localPort: internalPort || 8080,
    publicHostname: hostname,
    routingPlane: contract.normalizeRoutingPlane(body.routingPlane, 'STRICT_CONTROL'),
    ...(body.account ? { account: String(body.account) } : {}),
  };
}

function createCfBridge(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.OPENCHAMBER_CF_BRIDGE_URL);
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(options.timeoutMs);
  const log = options.log || (() => {});
  const token = String(options.token || process.env.OPENCHAMBER_CF_TOKEN || '').trim();
  const authHeaders = token ? { authorization: `Bearer ${token}` } : {};
  const request = typeof options.request === 'function'
    ? options.request
    : (method, pathname, body) => httpRequest(baseUrl, method, pathname, body, timeoutMs, authHeaders);
  const tokenCache = new Map();

  function cacheToken(machineId, token, source = {}) {
    if (!machineId || !token) return null;
    const record = {
      token: String(token),
      at: Date.now(),
      hostname: String(source.hostname || ''),
      matrixSlotId: String(source.matrixSlotId || ''),
    };
    tokenCache.set(String(machineId), record);
    return record;
  }

  async function provision(body = {}) {
    const payload = normalizeProvisionBody(body);
    const data = await request('POST', '/api/v1/cf/tunnel/provision', payload);
    return { ...data, request: payload };
  }

  async function teardown(body = {}) {
    const machineId = String(body.vmInstanceId || body.machineId || body.id || '');
    if (!machineId) {
      throw new CfBridgeError('teardown 需要 machineId', { status: 400, code: 'missing_machine_id' });
    }
    const payload = {
      vmInstanceId: machineId,
      machineId,
      ...(body.tunnelId ? { tunnelId: String(body.tunnelId) } : {}),
      ...(body.hostname ? { hostname: String(body.hostname) } : {}),
      ...(body.matrixSlotId ? { matrixSlotId: String(body.matrixSlotId) } : {}),
    };
    try {
      return await request('POST', '/api/v1/cf/tunnel/teardown', payload);
    } catch (error) {
      if (error && error.status === 404) {
        log(`CF teardown 未找到 ${machineId}，视为已释放`);
        return { ok: true, skipped: true, machineId };
      }
      throw error;
    }
  }

  async function status() {
    try {
      const data = await request('GET', '/api/v1/cf/status');
      return { reachable: true, ok: data.ok !== false, ...data, degraded: false };
    } catch (error) {
      if (error && error.status === 404) {
        try {
          const health = await request('GET', '/health');
          return {
            reachable: true,
            ok: health.ok !== false,
            degraded: true,
            health,
            error: null,
          };
        } catch (inner) {
          return { reachable: false, ok: false, degraded: true, error: inner.message };
        }
      }
      if (error && error.status) {
        return { reachable: true, ok: false, degraded: false, status: error.status, error: error.message };
      }
      return { reachable: false, ok: false, degraded: false, error: error.message };
    }
  }

  /*
   * Provision the tunnel, then start `cloudflared` inside the instance. The
   * token is never returned, logged or persisted.
   */
  async function provisionMachine(client, machineId, provisionOptions = {}) {
    if (!client || typeof client.exec !== 'function') {
      throw new CfBridgeError('provisionMachine 需要 InstaboxClient', {
        status: 400,
        code: 'missing_client',
      });
    }
    const id = String(machineId || provisionOptions.machineId || '');
    const data = await provision({ ...provisionOptions, machineId: id });
    const token = extractToken(data);
    if (token) {
      cacheToken(id, token, {
        hostname: provisionOptions.hostname || provisionOptions.publicHostname || '',
        matrixSlotId: provisionOptions.matrixSlotId || '',
      });
    }
    const command = token ? cloudflaredCommand(token, provisionOptions) : '';
    let exec = null;
    let cloudflared = 'token_missing';
    if (command) {
      try {
        const result = await client.exec(id, command, { timeoutSeconds: 20, noHistory: true });
        exec = execSummary(result);
        cloudflared = 'started';
      } catch (error) {
        cloudflared = 'failed';
        log(`cloudflared 启动失败 ${id}: ${error.message}`);
        exec = { error: error.message };
      }
    }
    return {
      ok: cloudflared === 'started',
      machineId: id,
      matrixSlotId: String(provisionOptions.matrixSlotId || ''),
      hostname: String(provisionOptions.hostname || provisionOptions.publicHostname || ''),
      tunnelId: String(data.tunnelId || data.id || (data.tunnel && data.tunnel.id) || ''),
      hostnameRecord: String(data.hostname || ''),
      cloudflared,
      exec,
    };
  }

  async function teardownMachine(client, machineId, teardownOptions = {}) {
    const id = String(machineId || teardownOptions.machineId || '');
    if (!id) {
      throw new CfBridgeError('teardownMachine 需要 machineId', {
        status: 400,
        code: 'missing_machine_id',
      });
    }
    let stopped = null;
    if (client && typeof client.exec === 'function') {
      try {
        const result = await client.exec(
          id,
          'pkill -f "cloudflared tunnel run" >/dev/null 2>&1 || true',
          { timeoutSeconds: 15, noHistory: true },
        );
        stopped = execSummary(result);
      } catch (error) {
        stopped = { error: error.message };
        log(`cloudflared 停止失败 ${id}: ${error.message}`);
      }
    }
    let released = null;
    try {
      released = await teardown({
        machineId: id,
        hostname: teardownOptions.hostname,
        matrixSlotId: teardownOptions.matrixSlotId,
        tunnelId: teardownOptions.tunnelId,
      });
    } catch (error) {
      log(`CF teardown 失败 ${id}: ${error.message}`);
      released = { ok: false, error: error.message };
    }
    tokenCache.delete(id);
    return {
      ok: Boolean(released && released.ok !== false),
      machineId: id,
      stopped,
      teardown: released,
    };
  }

  async function checkCloudflared(client, machineId) {
    if (!client || typeof client.exec !== 'function') {
      throw new CfBridgeError('checkCloudflared 需要 InstaboxClient', {
        status: 400,
        code: 'missing_client',
      });
    }
    const id = String(machineId || '');
    if (!id) {
      throw new CfBridgeError('checkCloudflared 需要 machineId', {
        status: 400,
        code: 'missing_machine_id',
      });
    }
    const result = await client.exec(id, CLOUDFLARED_PROBE, { timeoutSeconds: 15, noHistory: true });
    const text = String((result && result.stdout) || '');
    return {
      machineId: id,
      running: /(^|\n)\s*running\s*(\n|$)/.test(text),
      exitCode: result && result.exitCode !== undefined ? result.exitCode : null,
      at: new Date().toISOString(),
    };
  }

  /*
   * Keepalive fast path: reuse the in-memory tunnel token captured at provision
   * time and relaunch cloudflared without re-provisioning. Tokens never leave
   * this closure; if the process lost its cache (service restart) it falls back
   * to a fresh idempotent provision.
   */
  async function restartCloudflared(client, machineId, restartOptions = {}) {
    if (!client || typeof client.exec !== 'function') {
      throw new CfBridgeError('restartCloudflared 需要 InstaboxClient', {
        status: 400,
        code: 'missing_client',
      });
    }
    const id = String(machineId || restartOptions.machineId || '');
    if (!id) {
      throw new CfBridgeError('restartCloudflared 需要 machineId', {
        status: 400,
        code: 'missing_machine_id',
      });
    }
    const cached = tokenCache.get(id);
    if (!cached || !cached.token) {
      const outcome = await provisionMachine(client, id, restartOptions);
      return { ...outcome, restarted: false, reason: 'token_missing' };
    }
    try {
      const result = await client.exec(id, cloudflaredCommand(cached.token, restartOptions), {
        timeoutSeconds: 20,
        noHistory: true,
      });
      return {
        ok: true,
        machineId: id,
        matrixSlotId: cached.matrixSlotId || String(restartOptions.matrixSlotId || ''),
        hostname: cached.hostname || String(restartOptions.hostname || ''),
        cloudflared: 'restarted',
        restarted: true,
        exec: execSummary(result),
      };
    } catch (error) {
      return {
        ok: false,
        machineId: id,
        cloudflared: 'failed',
        restarted: false,
        error: error.message,
      };
    }
  }

  async function ensureMachine(client, machineId, ensureOptions = {}) {
    const probe = await checkCloudflared(client, machineId);
    if (probe.running) {
      return {
        ok: true,
        machineId: probe.machineId,
        cloudflared: 'running',
        restarted: false,
        checkedAt: probe.at,
      };
    }
    return restartCloudflared(client, machineId, ensureOptions);
  }

  function forgetToken(machineId) {
    tokenCache.delete(String(machineId || ''));
  }

  function hasCachedToken(machineId) {
    return tokenCache.has(String(machineId || ''));
  }

  return {
    baseUrl,
    provision,
    teardown,
    status,
    provisionMachine,
    teardownMachine,
    checkCloudflared,
    restartCloudflared,
    ensureMachine,
    forgetToken,
    hasCachedToken,
    cloudflaredCommand: (token, commandOptions) => cloudflaredCommand(token, commandOptions),
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  CLOUDFLARED_PROBE,
  CfBridgeError,
  cloudflaredCommand,
  extractToken,
  isCooldownError,
  isRetryableError,
  retryAfterMs,
  normalizeProvisionBody,
  createCfBridge,
};
