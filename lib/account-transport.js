'use strict';

/*
 * Per-account transport: one proxy port owns both the HTTP `fetch` client and
 * the WebSocket tunnel agent. Nothing here knows about the platform client;
 * callers pass the alias, the port and optional proxy credentials.
 *
 * Fail-closed: constructing a transport without a proxy port throws
 * ERR_PROXY_REQUIRED_FAIL_CLOSED. There is no direct fallback in this module.
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

function tunnelProxy(port, options = {}) {
  return {
    host: options.proxyHost || '127.0.0.1',
    port: Number(port),
    auth: options.proxyAuth || '',
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
  const fetchFactory = options.fetchFactory || createProxyFetch;
  const client = fetchFactory(port, options.fetchOptions || {});
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

  function connectWebSocket(url, wsOptions = {}) {
    const parsed = new URL(String(url));
    return wsConnect(url, {
      ...wsOptions,
      agent: wsOptions.agent || agentFor(parsed.protocol),
    });
  }

  function destroy() {
    try { client.close(); } catch { /* ignore */ }
    for (const agent of Object.values(wsAgents)) {
      if (!agent) continue;
      try { agent.destroy(); } catch { /* ignore */ }
    }
    for (const socket of wsSockets) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    wsSockets.clear();
  }

  return {
    alias,
    port,
    fetch(input, init) {
      return client.fetch(input, init);
    },
    connectWebSocket,
    destroy,
    quarantine(reason) {
      if (typeof client.quarantine === 'function') client.quarantine(reason);
    },
    release() {
      if (typeof client.release === 'function') client.release();
    },
    get state() {
      return client.state || { quarantined: false, reason: null, quarantinedAt: null };
    },
  };
}

module.exports = {
  ProxyRequiredError,
  createTransport,
};
