'use strict';

/*
 * Zero-platform generic proxy `fetch` shim (solution B: no vendored undici).
 *
 * - HTTPS targets: CONNECT through the local HTTP/mixed proxy, then a TLS
 *   upgrade with an EXPLICIT `servername` (SNI) and ALPN http/1.1.
 * - HTTP targets: absolute-form request through the proxy.
 * - fail-closed: on transport failure the account is quarantined and every
 *   later call is rejected until `release()`.
 * - close(): aborts in-flight work and destroys every tunnel socket.
 *
 * This file must not import the platform client. Callers pass the proxy port and
 * target URLs; nothing is hardcoded.
 */

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

function tlsUpgradeOptions(hostname, options = {}) {
  return {
    socket: options.socket,
    servername: hostname,
    ALPNProtocols: options.alpn && options.alpn.length ? options.alpn : ['http/1.1'],
    rejectUnauthorized: options.rejectUnauthorized !== false,
    ...(options.ca ? { ca: options.ca } : {}),
    ...(options.checkServerIdentity ? { checkServerIdentity: options.checkServerIdentity } : {}),
  };
}

function normalizeHeaders(input) {
  const headers = {};
  if (!input) return headers;
  if (typeof input.forEach === 'function' && typeof input.get === 'function') {
    input.forEach((value, key) => { headers[key] = value; });
    return headers;
  }
  if (Array.isArray(input)) {
    for (const [key, value] of input) headers[key] = value;
    return headers;
  }
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) headers[key] = String(value);
  }
  return headers;
}

function headersBag(raw) {
  const store = new Map();
  for (const [key, value] of Object.entries(raw || {})) {
    store.set(String(key).toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
  }
  return {
    get(name) {
      return store.has(String(name).toLowerCase()) ? store.get(String(name).toLowerCase()) : null;
    },
    has(name) {
      return store.has(String(name).toLowerCase());
    },
    forEach(fn) {
      for (const [key, value] of store) fn(value, key);
    },
    entries() {
      return store.entries();
    },
    keys() {
      return store.keys();
    },
    values() {
      return store.values();
    },
    [Symbol.iterator]() {
      return store.entries();
    },
  };
}

function makeError(message, code, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function createTunnelSocketFactory(proxy, sockets, factoryOptions = {}) {
  const secure = factoryOptions.secure !== false;
  return function createConnection(options, callback) {
    const host = options.host;
    const port = Number(options.port) || 443;
    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: {
        Host: `${host}:${port}`,
        ...(proxy.auth ? { 'Proxy-Authorization': proxy.auth } : {}),
      },
    });

    const fail = (error) => {
      connectReq.destroy();
      callback(error);
    };

    connectReq.setTimeout(proxy.connectTimeoutMs || 15000, () => {
      fail(makeError(`CONNECT timeout: ${host}:${port}`, 'PROXY_CONNECT_TIMEOUT'));
    });
    connectReq.on('error', (error) => {
      callback(makeError(`CONNECT failed: ${error.message}`, 'PROXY_CONNECT_FAILED', error));
    });
    connectReq.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        callback(makeError(`CONNECT rejected: HTTP ${response.statusCode}`, 'PROXY_CONNECT_REJECTED'));
        return;
      }
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      if (!secure) {
        callback(null, socket);
        return;
      }
      const upgrade = tls.connect(tlsUpgradeOptions(host, {
        socket,
        rejectUnauthorized: proxy.rejectUnauthorized,
        ca: proxy.ca,
        checkServerIdentity: proxy.checkServerIdentity,
        alpn: proxy.alpn,
      }));
      sockets.add(upgrade);
      upgrade.once('close', () => sockets.delete(upgrade));
      upgrade.once('secureConnect', () => {
        if (proxy.onTlsUpgrade) proxy.onTlsUpgrade(host, upgrade);
        callback(null, upgrade);
      });
      upgrade.once('error', (error) => {
        callback(makeError(`TLS upgrade failed: ${error.message}`, 'TLS_UPGRADE_FAILED', error));
      });
    });
    connectReq.end();
    return undefined;
  };
}

class TunnelAgent extends https.Agent {
  constructor(proxy, sockets) {
    super({ keepAlive: true, maxSockets: 32 });
    this.proxy = proxy;
    this.sockets = sockets;
    this.createConnection = createTunnelSocketFactory(proxy, sockets);
  }

  destroy() {
    super.destroy();
    for (const socket of this.sockets) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this.sockets.clear();
  }
}

function createProxyFetch(port, options = {}) {
  const plane = options.planeHeaders && typeof options.planeHeaders === 'object'
    ? options.planeHeaders
    : {};
  const planeAuth = plane['Proxy-Authorization'] || '';
  const proxy = {
    host: options.proxyHost || '127.0.0.1',
    port: Number(port),
    auth: planeAuth || options.proxyAuth || '',
    rejectUnauthorized: options.rejectUnauthorized !== false,
    ca: options.ca,
    checkServerIdentity: options.checkServerIdentity,
    alpn: options.alpn,
    connectTimeoutMs: options.connectTimeoutMs,
    onTlsUpgrade: options.onTlsUpgrade,
  };
  if (!proxy.port) throw new Error('createProxyFetch requires a proxy port');

  const sockets = new Set();
  const agent = new TunnelAgent(proxy, sockets);
  const now = options.now || Date.now;
  const cooldownMs = options.cooldownMs === undefined ? 15000 : Math.max(0, Number(options.cooldownMs) || 0);
  const resumeBarrierMs = options.resumeBarrierMs === undefined
    ? 1500
    : Math.max(0, Number(options.resumeBarrierMs) || 0);
  let resumeWaiters = [];
  const state = {
    quarantined: false,
    reason: null,
    quarantinedAt: null,
    quarantinedAtMs: 0,
    probing: false,
    suspended: false,
  };

  function applyPlaneHeaders(headers) {
    for (const [name, value] of Object.entries(plane)) {
      if (value === undefined || value === null) continue;
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
      }
      headers[name] = String(value);
    }
    return headers;
  }

  function quarantine(reason) {
    state.quarantined = true;
    state.reason = String(reason || 'proxy failure');
    state.quarantinedAtMs = now();
    state.quarantinedAt = new Date(state.quarantinedAtMs).toISOString();
    state.probing = false;
    if (options.onQuarantine) options.onQuarantine(state.reason);
  }

  function release() {
    state.quarantined = false;
    state.reason = null;
    state.quarantinedAt = null;
    state.quarantinedAtMs = 0;
    state.probing = false;
  }

  /*
   * Rotation barrier: a request that lands inside a PRE_ROTATION_FREEZE parks
   * here for at most `resumeBarrierMs` (1500ms by default) instead of failing
   * immediately. `resume()` releases every waiter after the connection pool is
   * rebuilt, so keepalive/jobs survive the slot swap without an error burst.
   */
  function flushResumeWaiters(result) {
    const waiters = resumeWaiters;
    resumeWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      try { waiter.resolve(result); } catch { /* ignore */ }
    }
    return waiters.length;
  }

  function waitForResume(waitMs) {
    if (!state.suspended) return Promise.resolve({ ok: true, already: true });
    const limit = waitMs === undefined
      ? resumeBarrierMs
      : Math.max(0, Number(waitMs) || 0);
    if (limit <= 0) return Promise.resolve({ ok: false, timeout: true });
    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        resumeWaiters = resumeWaiters.filter((entry) => entry !== waiter);
        resolve({ ok: false, timeout: true });
      }, limit);
      if (waiter.timer.unref) waiter.timer.unref();
      resumeWaiters.push(waiter);
    });
  }

  async function fetchImpl(input, init = {}) {
    if (state.suspended) {
      const barrier = await waitForResume();
      if (state.suspended || !barrier || barrier.ok !== true) {
        throw makeError('proxy suspended (rotation freeze)', 'PROXY_SUSPENDED');
      }
    }
    if (state.quarantined) {
      const cooledDown = cooldownMs > 0 && now() - state.quarantinedAtMs >= cooldownMs;
      if (!cooledDown) {
        throw makeError(`proxy quarantined: ${state.reason}`, 'PROXY_QUARANTINED');
      }
      if (state.probing) {
        throw makeError(`proxy quarantined (half-open probe in flight): ${state.reason}`, 'PROXY_QUARANTINED');
      }
      state.probing = true;
    }
    const url = new URL(String(input));
    const target = url.hostname;
    const targetPort = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const headers = normalizeHeaders(init.headers);
    applyPlaneHeaders(headers);
    if (!headers.Host && !headers.host) headers.Host = url.host;
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body === undefined || init.body === null ? null : init.body;
    const timeoutMs = Number(init.timeoutMs || options.timeoutMs) || 30000;

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };

      let request;
      if (url.protocol === 'https:') {
        request = https.request(
          {
            host: target,
            port: targetPort,
            path: `${url.pathname}${url.search}`,
            method,
            headers,
            agent,
            servername: target,
          },
          onResponse,
        );
      } else {
        request = http.request(
          {
            host: proxy.host,
            port: proxy.port,
            path: url.toString(),
            method,
            headers,
            agent: false,
          },
          onResponse,
        );
      }

      const signal = init.signal;
      const onAbort = () => {
        const error = makeError('aborted', 'ABORT_ERR');
        error.name = 'AbortError';
        try { request.destroy(error); } catch { /* ignore */ }
        finish(reject, error);
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      function cleanup() {
        state.probing = false;
        if (signal) signal.removeEventListener('abort', onAbort);
      }

      request.setTimeout(timeoutMs, () => {
        const error = makeError(`request timeout: ${url.toString()}`, 'ETIMEDOUT');
        try { request.destroy(error); } catch { /* ignore */ }
        fail(error);
      });

      request.on('error', fail);
      request.on('socket', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });

      if (body !== null) request.write(body);
      request.end();

      function fail(error) {
        if (settled) return;
        state.probing = false;
        if (options.failClosed !== false && !state.suspended) {
          quarantine(error.message);
        }
        finish(reject, makeError(`proxy request failed: ${error.message}`, 'PROXY_REQUEST_FAILED', error));
      }

      function onResponse(response) {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', fail);
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          if (state.quarantined) release();
          finish(resolve, {
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            statusText: response.statusMessage || '',
            url: url.toString(),
            redirected: false,
            headers: headersBag(response.headers),
            text: async () => buffer.toString('utf8'),
            json: async () => JSON.parse(buffer.toString('utf8')),
            arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
            buffer: async () => buffer,
          });
        });
      }
    });
  }

  async function close() {
    flushResumeWaiters({ ok: false, closed: true });
    agent.destroy();
    for (const socket of sockets) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    sockets.clear();
  }

  function suspend() {
    state.suspended = true;
    state.probing = false;
    agent.destroy();
    for (const socket of sockets) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    sockets.clear();
  }

  function resume() {
    state.suspended = false;
    flushResumeWaiters({ ok: true, resumed: true });
  }

  return {
    fetch: fetchImpl,
    close,
    suspend,
    resume,
    waitForResume,
    quarantine,
    release,
    get state() {
      return { ...state };
    },
    isQuarantined() {
      return state.quarantined;
    },
    isSuspended() {
      return state.suspended;
    },
  };
}

function createTunnelAgent(proxy, sockets, options = {}) {
  const secure = options.secure !== false;
  const BaseAgent = secure ? https.Agent : http.Agent;
  const createConnection = createTunnelSocketFactory(proxy, sockets, { secure });

  class TunnelOnlyAgent extends BaseAgent {
    constructor() {
      super({ keepAlive: true, maxSockets: options.maxSockets || 8 });
      this.createConnection = createConnection;
    }

    destroy() {
      super.destroy();
      for (const socket of sockets) {
        try { socket.destroy(); } catch { /* ignore */ }
      }
      sockets.clear();
    }
  }

  return new TunnelOnlyAgent();
}

module.exports = {
  createProxyFetch,
  createTunnelAgent,
  createTunnelSocketFactory,
  tlsUpgradeOptions,
  normalizeHeaders,
  headersBag,
};
