'use strict';

/*
 * Client for the local OpenChamber egress matrix bus (`127.0.0.1:19880`).
 *
 * The bus is the only source of truth for matrix slots, leases and the
 * rotation freeze choreography. This module is generic: it only knows the
 * `core/contract` field names, never the Instabox platform.
 *
 * Fail-closed rules implemented here:
 *   - a slot that is not ACTIVE blocks control-plane traffic
 *   - a slot inside PRE_ROTATION_FREEZE blocks until POST_ROTATION_RESUME
 *   - an unreachable bus blocks instead of silently passing through
 */

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const contract = require('../core/contract');
const { connect: wsConnect } = require('./ws');

const DEFAULT_BASE_URL = 'http://127.0.0.1:19880';
const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;

class EgressUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'EgressUnavailableError';
    this.code = 'ERR_EGRESS_UNAVAILABLE';
    this.status = 503;
    if (cause) this.cause = cause;
  }
}

class EgressSlotBlockedError extends Error {
  constructor(matrixSlotId, healthState, message, frozen) {
    super(message || `egress 槽位 ${matrixSlotId} 当前不可用 (${healthState})`);
    this.name = 'EgressSlotBlockedError';
    this.code = 'ERR_EGRESS_SLOT_BLOCKED';
    this.status = 503;
    this.matrixSlotId = matrixSlotId;
    this.healthState = healthState || 'UNKNOWN';
    this.frozen = Boolean(frozen);
  }
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function createEgressClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.OPENCHAMBER_EGRESS_BUS_URL);
  const clientId = String(options.clientId || `instabox-${crypto.randomUUID()}`);
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(options.timeoutMs);
  const log = options.log || (() => {});
  const now = options.now || Date.now;
  const wsFactory = options.wsConnect || wsConnect;

  const slotCache = new Map();
  const frozen = new Map();
  const waiters = new Map();
  const handlers = {
    freeze: [],
    resume: [],
    failed: [],
    slot: [],
    open: [],
  };

  let socket = null;
  let connecting = false;
  let closed = false;
  let reconnectTimer = null;
  let reconnectDelay = options.reconnectMs === undefined ? DEFAULT_RECONNECT_MS : Number(options.reconnectMs);
  let lastSyncAt = 0;
  let lastState = null;
  let lastError = null;

  function emit(kind, payload) {
    const results = [];
    for (const handler of handlers[kind]) {
      try {
        results.push(handler(payload));
      } catch (error) {
        log(`egress ${kind} handler failed: ${error.message}`);
        results.push(Promise.reject(error));
      }
    }
    return Promise.allSettled(results);
  }

  function on(kind, handler) {
    if (!handlers[kind]) throw new Error(`unknown egress event kind: ${kind}`);
    if (typeof handler === 'function') handlers[kind].push(handler);
    return () => {
      const list = handlers[kind];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  }

  function call(method, pathname, requestOptions = {}) {
    if (typeof options.request === 'function') {
      return Promise.resolve(options.request({ method, pathname, body: requestOptions.body, timeoutMs }));
    }
    let url;
    try {
      url = new URL(`${baseUrl}${pathname}`);
    } catch (error) {
      return Promise.reject(new EgressUnavailableError(`egress bus URL 无效: ${pathname}`, error));
    }
    const body = requestOptions.body === undefined ? null : Buffer.from(JSON.stringify(requestOptions.body));
    const transport = url.protocol === 'https:' ? https : http;
    const perCallTimeout = requestOptions.timeoutMs === undefined ? timeoutMs : Number(requestOptions.timeoutMs);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      const request = transport.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search || ''}`,
        method,
        headers: {
          accept: 'application/json',
          ...(body
            ? {
              'content-type': 'application/json',
              'content-length': body.length,
            }
            : {}),
          ...(requestOptions.headers || {}),
        },
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', (error) => finish(reject, new EgressUnavailableError(`egress bus 响应失败: ${error.message}`, error)));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const payload = parseJson(text);
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const error = new Error(
              (payload && payload.error) || `egress bus HTTP ${response.statusCode}`,
            );
            error.status = response.statusCode;
            error.code = (payload && payload.code) || 'egress_http_error';
            error.body = payload;
            finish(reject, error);
            return;
          }
          finish(resolve, payload === null ? {} : payload);
        });
      });
      request.setTimeout(perCallTimeout, () => {
        const error = new EgressUnavailableError(`egress bus 超时: ${method} ${pathname}`);
        request.destroy(error);
        finish(reject, error);
      });
      request.on('error', (error) => {
        if (error instanceof EgressUnavailableError) {
          finish(reject, error);
          return;
        }
        finish(reject, new EgressUnavailableError(`egress bus 不可达: ${error.message}`, error));
      });
      if (body) request.write(body);
      request.end();
    });
  }

  function rememberSlot(row) {
    if (!row || typeof row !== 'object') return null;
    const matrixSlotId = String(row.matrixSlotId || '');
    if (!contract.indexForSlotId(matrixSlotId)) return null;
    const normalized = {
      ...row,
      matrixSlotId,
      egressPort: Number(row.egressPort) || contract.egressPortForSlotId(matrixSlotId),
      routingPlane: contract.normalizeRoutingPlane(row.routingPlane),
      healthState: contract.normalizeHealthState(row.healthState),
      egressFingerprint: contract.normalizeFingerprint(row.egressFingerprint, row.leaseId),
    };
    slotCache.set(matrixSlotId, normalized);
    return normalized;
  }

  async function state() {
    const payload = await call('GET', '/api/v1/egress/state');
    lastState = payload;
    lastSyncAt = now();
    return payload;
  }

  async function slots() {
    const payload = await call('GET', '/api/v1/egress/slots');
    const rows = Array.isArray(payload) ? payload : (Array.isArray(payload.slots) ? payload.slots : []);
    for (const row of rows) rememberSlot(row);
    lastSyncAt = now();
    return rows.map((row) => slotCache.get(row.matrixSlotId) || row);
  }

  async function leases() {
    const payload = await call('GET', '/api/v1/egress/leases');
    return Array.isArray(payload) ? payload : (Array.isArray(payload.leases) ? payload.leases : []);
  }

  async function slot(matrixSlotId) {
    if (!contract.indexForSlotId(matrixSlotId)) {
      throw new EgressSlotBlockedError(matrixSlotId, 'UNKNOWN', `matrixSlotId 非法: ${matrixSlotId}`);
    }
    let payload = null;
    try {
      payload = await call('GET', `/api/v1/egress/lease/${encodeURIComponent(matrixSlotId)}`);
    } catch (error) {
      if (error.status === 404) {
        payload = null;
      } else {
        throw error;
      }
    }
    if (payload && payload.slot) payload = payload.slot;
    if (payload && payload.matrixSlotId) return rememberSlot(payload);
    const cached = slotCache.get(matrixSlotId) || null;
    return cached;
  }

  async function refreshSlot(matrixSlotId) {
    try {
      const row = await slot(matrixSlotId);
      lastError = null;
      return row;
    } catch (error) {
      lastError = error;
      throw error;
    }
  }

  function isFrozen(matrixSlotId) {
    return frozen.has(String(matrixSlotId || ''));
  }

  function frozenSlot(matrixSlotId) {
    return frozen.get(String(matrixSlotId || '')) || null;
  }

  function cachedSlot(matrixSlotId) {
    return slotCache.get(String(matrixSlotId || '')) || null;
  }

  function blockedReason(row, freeze) {
    if (freeze) return `slot ${row && row.matrixSlotId ? row.matrixSlotId : ''} 正在换血冻结`;
    const stateName = contract.normalizeHealthState(row && row.healthState);
    if (stateName !== 'ACTIVE') return `slot ${row.matrixSlotId} 状态 ${stateName}`;
    return '';
  }

  async function assertSlotUsable(matrixSlotId, assertOptions = {}) {
    const slotId = String(matrixSlotId || '');
    if (!contract.indexForSlotId(slotId)) {
      throw new EgressSlotBlockedError(slotId, 'UNKNOWN', `matrixSlotId 非法: ${slotId || '(空)'}`);
    }
    const freeze = frozen.get(slotId);
    if (freeze) {
      throw new EgressSlotBlockedError(slotId, 'ROTATING', blockedReason({ matrixSlotId: slotId }, freeze), true);
    }
    const freshness = assertOptions.freshMs === undefined ? 1500 : Number(assertOptions.freshMs);
    let row = slotCache.get(slotId);
    const stale = !row || (now() - Number(row.__cachedAt || 0)) > freshness;
    if (stale) {
      try {
        row = await refreshSlot(slotId);
      } catch (error) {
        if (error instanceof EgressSlotBlockedError) throw error;
        throw new EgressUnavailableError(`无法核验槽位 ${slotId}: ${error.message}`, error);
      }
    }
    if (!row) {
      throw new EgressSlotBlockedError(slotId, 'UNKNOWN', `egress 槽位 ${slotId} 尚未分配租约`);
    }
    if (row.healthState !== 'ACTIVE') {
      throw new EgressSlotBlockedError(slotId, row.healthState, `egress 槽位 ${slotId} 状态 ${row.healthState}`);
    }
    return row;
  }

  async function bindLease(body = {}) {
    const matrixSlotId = String(body.matrixSlotId || '');
    if (!contract.indexForSlotId(matrixSlotId)) {
      throw new EgressSlotBlockedError(matrixSlotId, 'UNKNOWN', `matrixSlotId 非法: ${matrixSlotId || '(空)'}`);
    }
    if (!body.leaseId && !body.intentId && !body.key) {
      throw new Error('bindLease 需要 leaseId、intentId 或 key');
    }
    const payload = await call('POST', '/api/v1/egress/lease/bind', {
      body: {
        matrixSlotId,
        ...(body.leaseId ? { leaseId: body.leaseId } : {}),
        ...(body.intentId ? { intentId: body.intentId } : {}),
        ...(body.key ? { key: body.key } : {}),
      },
    });
    const row = payload.slot || payload.lease || payload;
    if (row && row.matrixSlotId) rememberSlot(row);
    return payload;
  }

  async function rotateSlot(matrixSlotId, body = {}) {
    const payload = await call('POST', `/api/v1/egress/slots/${encodeURIComponent(matrixSlotId)}/rotate`, {
      body,
    });
    const row = payload.slot || payload;
    if (row && row.matrixSlotId) rememberSlot(row);
    return payload;
  }

  async function probeSlot(matrixSlotId) {
    const payload = await call('POST', `/api/v1/egress/slots/${encodeURIComponent(matrixSlotId)}/probe`, {
      body: {},
    });
    const row = payload.slot || payload;
    if (row && row.matrixSlotId) rememberSlot(row);
    return payload;
  }

  async function ackFreeze(eventId, ok = true) {
    if (!eventId) return { ok: false };
    try {
      return await call('POST', '/api/v1/egress/ack-freeze', {
        body: { clientId, eventId, ok: ok !== false },
      });
    } catch (error) {
      log(`egress ACK_FREEZE 失败 (${eventId}): ${error.message}`);
      return { ok: false, error: error.message };
    }
  }

  function resolveWaiters(matrixSlotId, result) {
    const list = waiters.get(matrixSlotId);
    if (!list) return;
    waiters.delete(matrixSlotId);
    for (const resolve of list) {
      try { resolve(result); } catch { /* ignore */ }
    }
  }

  function waitForResume(matrixSlotId, waitOptions = {}) {
    const slotId = String(matrixSlotId || '');
    if (!frozen.has(slotId)) return Promise.resolve({ ok: true, already: true });
    const limit = waitOptions.timeoutMs === undefined ? 30000 : Number(waitOptions.timeoutMs);
    return new Promise((resolve) => {
      const list = waiters.get(slotId) || new Set();
      const settle = (result) => {
        clearTimeout(timer);
        list.delete(settle);
        if (!list.size) waiters.delete(slotId);
        resolve(result);
      };
      const timer = limit > 0 ? setTimeout(() => settle({ ok: false, timeout: true }), limit) : null;
      if (timer && timer.unref) timer.unref();
      list.add(settle);
      waiters.set(slotId, list);
    });
  }

  function markFrozen(payload) {
    const slotId = String(payload.matrixSlotId || '');
    if (!contract.indexForSlotId(slotId)) return null;
    const record = {
      matrixSlotId: slotId,
      reason: String(payload.reason || 'rotation'),
      deadlineMs: Number(payload.deadlineMs) || 500,
      eventId: payload.eventId || '',
      at: now(),
    };
    frozen.set(slotId, record);
    const row = slotCache.get(slotId);
    if (row) slotCache.set(slotId, { ...row, healthState: 'ROTATING' });
    return record;
  }

  function markResumed(payload) {
    const slotId = String(payload.matrixSlotId || '');
    if (!contract.indexForSlotId(slotId)) return null;
    frozen.delete(slotId);
    const cached = slotCache.get(slotId) || { matrixSlotId: slotId };
    const next = rememberSlot({
      ...cached,
      matrixSlotId: slotId,
      healthState: 'ACTIVE',
      leaseId: payload.leaseId || cached.leaseId || '',
      egressFingerprint: payload.egressFingerprint || cached.egressFingerprint,
      egressPort: contract.egressPortForSlotId(slotId),
    });
    resolveWaiters(slotId, { ok: true, slot: next });
    return next;
  }

  function applySlotUpdate(payload) {
    const row = payload.slot || payload;
    if (!row || !contract.indexForSlotId(row.matrixSlotId)) return null;
    if (payload.removed === true || row.removed === true) {
      slotCache.delete(row.matrixSlotId);
      frozen.delete(row.matrixSlotId);
      return null;
    }
    const next = rememberSlot(row);
    if (next && next.healthState === 'ACTIVE' && frozen.has(next.matrixSlotId)) {
      frozen.delete(next.matrixSlotId);
      resolveWaiters(next.matrixSlotId, { ok: true, slot: next });
    }
    return next;
  }

  async function handleMessage(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      log('egress WS 收到非 JSON 帧，已丢弃');
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    const type = String(payload.type || '');
    if (type === 'PRE_ROTATION_FREEZE') {
      const record = markFrozen(payload);
      if (record) {
        log(`egress 冻结 ${record.matrixSlotId}: ${record.reason}`);
        await emit('freeze', record);
        await ackFreeze(payload.eventId, true);
      }
      return;
    }
    if (type === 'POST_ROTATION_RESUME') {
      const row = markResumed(payload);
      if (row) {
        log(`egress 恢复 ${row.matrixSlotId} exit=${row.egressFingerprint.exitIp || '-'}`);
        await emit('resume', { slot: row, payload });
      }
      return;
    }
    if (type === 'ROTATION_FAILED') {
      const slotId = String(payload.matrixSlotId || '');
      if (contract.indexForSlotId(slotId)) {
        const cached = slotCache.get(slotId) || { matrixSlotId: slotId };
        slotCache.set(slotId, { ...cached, healthState: contract.normalizeHealthState(payload.healthState, 'COOLDOWN') });
        resolveWaiters(slotId, { ok: false, payload });
        log(`egress 轮换失败 ${slotId}: ${payload.reason || payload.error || 'unknown'}`);
        await emit('failed', payload);
      }
      return;
    }
    if (type === 'SLOT_STATE_UPDATED') {
      const row = applySlotUpdate(payload);
      if (row) await emit('slot', { slot: row, payload });
      return;
    }
    if (payload.matrixSlotId && contract.indexForSlotId(payload.matrixSlotId) && payload.healthState) {
      const row = rememberSlot(payload);
      if (row) await emit('slot', { slot: row, payload });
    }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const delay = Math.max(250, reconnectDelay);
    reconnectDelay = Math.min(MAX_RECONNECT_MS, Math.round(reconnectDelay * 1.7));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWs();
    }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
  }

  function connectWs() {
    if (closed || connecting || (socket && socket.isOpen)) return null;
    connecting = true;
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/v1/egress/ws?clientId=${encodeURIComponent(clientId)}`;
    return Promise.resolve(wsFactory(wsUrl, { timeoutMs: Math.max(timeoutMs, 8000) }))
      .then((conn) => {
        if (closed) {
          try { conn.close(); } catch { /* ignore */ }
          return null;
        }
        connecting = false;
        socket = conn;
        reconnectDelay = options.reconnectMs === undefined ? DEFAULT_RECONNECT_MS : Number(options.reconnectMs);
        conn.on('message', ({ data }) => {
          handleMessage(data).catch((error) => log(`egress WS 处理失败: ${error.message}`));
        });
        conn.on('close', () => {
          if (socket === conn) socket = null;
          if (!closed) scheduleReconnect();
        });
        conn.on('error', (error) => {
          lastError = error;
          log(`egress WS 错误: ${error.message}`);
        });
        log(`egress WS 已连接 ${clientId}`);
        emit('open', { clientId });
        return conn;
      })
      .catch((error) => {
        connecting = false;
        lastError = error;
        log(`egress WS 连接失败: ${error.message}`);
        scheduleReconnect();
        return null;
      });
  }

  function subscribe(subscribeHandlers = {}) {
    for (const kind of ['freeze', 'resume', 'failed', 'slot', 'open']) {
      if (typeof subscribeHandlers[kind] === 'function') on(kind, subscribeHandlers[kind]);
    }
    connectWs();
    return {
      clientId,
      close() {
        for (const kind of ['freeze', 'resume', 'failed', 'slot', 'open']) {
          if (typeof subscribeHandlers[kind] === 'function') {
            const index = handlers[kind].indexOf(subscribeHandlers[kind]);
            if (index >= 0) handlers[kind].splice(index, 1);
          }
        }
        if (!handlers.freeze.length && !handlers.resume.length && !handlers.failed.length
          && !handlers.slot.length && !handlers.open.length) {
          closeSocket();
        }
      },
    };
  }

  function closeSocket() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      const conn = socket;
      socket = null;
      try { conn.close(); } catch { /* ignore */ }
    }
  }

  function close() {
    closed = true;
    closeSocket();
    for (const slotId of [...waiters.keys()]) {
      resolveWaiters(slotId, { ok: false, closed: true });
    }
  }

  function status() {
    return {
      baseUrl,
      clientId,
      connected: Boolean(socket && socket.isOpen),
      lastError: lastError ? String(lastError.message || lastError) : null,
      lastSyncAt,
      frozenSlots: [...frozen.values()],
      slots: [...slotCache.values()],
      state: lastState,
    };
  }

  return {
    baseUrl,
    clientId,
    call,
    request: call,
    state,
    slots,
    leases,
    slot,
    refreshSlot,
    bindLease,
    rotateSlot,
    probeSlot,
    ackFreeze,
    assertSlotUsable,
    isFrozen,
    frozenSlot,
    cachedSlot,
    waitForResume,
    subscribe,
    on,
    status,
    close,
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  createEgressClient,
  EgressUnavailableError,
  EgressSlotBlockedError,
};
