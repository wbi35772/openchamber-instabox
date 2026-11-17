'use strict';

/*
 * Per-account transport: one proxy port owns both the HTTP `fetch` client and
 * the WebSocket tunnel agent. Nothing here knows about the platform client;
 * callers pass the alias, the port and optional proxy credentials.
 *
 * Fail-closed: constructing a transport without a proxy port throws
 * ERR_PROXY_REQUIRED_FAIL_CLOSED. There is no direct fallback in this module.
 *
 * A transport created with a `matrixSlotId` stamps every request and every
 * CONNECT with the STRICT_CONTROL dual-plane markers required by the egress
 * matrix. `suspend()` drops the whole connection pool for a rotation freeze
 * without poisoning the quarantine state.
 */

const { createProxyFetch, createTunnelAgent } = require('./proxy-fetch');
const { connect: wsConnect } = require('./ws');

class ProxyRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProxyRequiredError';
    this.code = 'ERR_PROXY_REQUIRED_FAIL_CLOSED';
    this.status = 503;
  }
}

/*
 * Dual-plane routing headers. Every Instabox control-plane request carries a
 * plane marker and a slot-scoped Proxy-Authorization value; the egress matrix
 * uses the pair to route STRICT_CONTROL traffic to the static upstream only.
 */
function planeHeaders(matrixSlotId, routingPlane = 'STRICT_CONTROL') {
  const slot = String(matrixSlotId || '');
  if (!slot) return {};
  const plane = String(routingPlane || 'STRICT_CONTROL').toUpperCase();
  const credentials = Buffer.from(`${slot}:${plane}`, 'utf8').toString('base64');
  return {
    'X-OC-Routing-Plane': plane,
    'Proxy-Authorization': `Basic ${credentials}`,
  };
}

function tunnelProxy(port, options = {}) {
  const plane = options.planeHeaders || {};
  return {
    host: options.proxyHost || '127.0.0.1',
    port: Number(port),
    auth: plane['Proxy-Authorization'] || options.proxyAuth || '',
    rejectUnauthorized: options.rejectUnauthorized !== false,
    ca: options.ca,
    checkServerIdentity: options.checkServerIdentity,
    alpn: options.alpn,
    connectTimeoutMs: options.connectTimeoutMs,
  };
}

function createTransport(options = {}) {
  const alias = options.alias || '';
  const port = Number(options.port);
  if (!port) {
    throw new ProxyRequiredError(`账号 ${alias || '(未命名)'} 没有代理端口，已拒绝直连`);
  }

  const proxy = tunnelProxy(port, options);
  const plane = options.planeHeaders || planeHeaders(options.matrixSlotId, options.routingPlane);
  const fetchFactory = options.fetchFactory || createProxyFetch;
  const client = fetchFactory(port, {
    resumeBarrierMs: options.resumeBarrierMs === undefined ? 1500 : options.resumeBarrierMs,
    ...(options.fetchOptions || {}),
    planeHeaders: plane,
  });
  const wsSockets = new Set();
  const wsAgents = { secure: null, plain: null };

  function agentFor(protocol) {
    const secure = protocol !== 'ws:' && protocol !== 'http:';
    const key = secure ? 'secure' : 'plain';
    if (!wsAgents[key]) {
      wsAgents[key] = createTunnelAgent(proxy, wsSockets, {
        secure,
        maxSockets: options.maxWebSockets || 4,
      });
    }
    return wsAgents[key];
  }

  function dropWebSocketPool() {
    for (const agent of Object.values(wsAgents)) {
      if (!agent) continue;
      try { agent.destroy(); } catch { /* ignore */ }
    }
    wsAgents.secure = null;
    wsAgents.plain = null;
    for (const socket of wsSockets) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    wsSockets.clear();
  }

  function connectWebSocket(url, wsOptions = {}) {
    const parsed = new URL(String(url));
    return wsConnect(url, {
      ...wsOptions,
      agent: wsOptions.agent || agentFor(parsed.protocol),
    });
  }

  function destroy() {
    try { client.close(); } catch { /* ignore */ }
    dropWebSocketPool();
  }

  function suspend() {
    if (typeof client.suspend === 'function') {
      try { client.suspend(); } catch { /* ignore */ }
    } else {
      try { client.close(); } catch { /* ignore */ }
    }
    dropWebSocketPool();
  }

  function resume() {
    if (typeof client.resume === 'function') {
      try { client.resume(); } catch { /* ignore */ }
    }
  }

  return {
    alias,
    port,
    matrixSlotId: options.matrixSlotId || '',
    planeHeaders: plane,
    fetch(input, init) {
      return client.fetch(input, init);
    },
    connectWebSocket,
    destroy,
    suspend,
    resume,
    quarantine(reason) {
      if (typeof client.quarantine === 'function') client.quarantine(reason);
    },
    release() {
      if (typeof client.release === 'function') client.release();
    },
    get state() {
      return client.state || {
        quarantined: false,
        reason: null,
        quarantinedAt: null,
        suspended: false,
      };
    },
  };
}

module.exports = {
  ProxyRequiredError,
  createTransport,
  planeHeaders,
};
