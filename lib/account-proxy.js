'use strict';

/*
 * Extension glue: map each account alias to one fixed egress matrix slot and
 * hand the account client a `fetchImpl` that never leaves without a proxy when
 * `settings.proxy.enabled` is true.
 *
 * Slot choice:
 *   1. explicit `settings.proxy.slots[alias]` (`slot-001`..`slot-250`)
 *   2. explicit `settings.proxy.ports[alias]` inside 24001..24250 (slot derived)
 *   3. stable slot by sorted alias index + 1
 *
 * Fail-closed gate: when an egress client is wired in, every request first
 * verifies the slot is ACTIVE and not inside a rotation freeze. WARP_OVERFLOW,
 * ROTATING and QUARANTINED (and an unreachable bus) all reject the request.
 * Off by default, so the extension keeps working without any proxy.
 */

const contract = require('../core/contract');
const { createProxyFetch } = require('./proxy-fetch');
const { createTransport, ProxyRequiredError } = require('./account-transport');

function proxyConfig(state) {
  return (state && state.settings && state.settings.proxy) || {};
}

function enabledAliases(state, alias, options = {}) {
  const aliases = (state.accounts || [])
    .filter((account) => account.enabled !== false)
    .map((account) => account.alias);
  if (options.candidate === true && alias && !aliases.includes(alias)) aliases.push(alias);
  aliases.sort();
  return aliases;
}

function resolveMatrixSlot(state, alias, options = {}) {
  const proxy = proxyConfig(state);
  if (proxy.enabled !== true) return null;
  const explicitSlot = proxy.slots && proxy.slots[alias];
  if (explicitSlot) {
    const index = contract.indexForSlotId(explicitSlot);
    if (!index) {
      throw Object.assign(new Error(`账号 ${alias} 的 matrixSlotId 非法: ${explicitSlot}`), {
        code: 'invalid_matrix_slot',
        status: 400,
      });
    }
    return {
      matrixSlotId: explicitSlot,
      egressPort: contract.egressPortForSlotId(explicitSlot),
      routingPlane: 'STRICT_CONTROL',
      explicit: true,
      legacyPort: false,
    };
  }
  const explicitPort = proxy.ports && proxy.ports[alias];
  if (explicitPort) {
    const port = Number(explicitPort);
    const matrixSlotId = contract.matrixSlotIdForPort(port);
    if (matrixSlotId) {
      return {
        matrixSlotId,
        egressPort: port,
        routingPlane: 'STRICT_CONTROL',
        explicit: true,
        legacyPort: false,
      };
    }
    return {
      matrixSlotId: '',
      egressPort: port,
      routingPlane: 'STRICT_CONTROL',
      explicit: true,
      legacyPort: true,
    };
  }
  const aliases = enabledAliases(state, alias, options);
  const index = aliases.indexOf(alias);
  if (index < 0) return null;
  if (index >= contract.SLOT_COUNT) {
    throw Object.assign(new Error(`矩阵槽位已用尽（最多 ${contract.SLOT_COUNT} 个账号）`), {
      code: 'matrix_slot_exhausted',
      status: 409,
    });
  }
  const matrixSlotId = contract.slotIdForIndex(index + 1);
  return {
    matrixSlotId,
    egressPort: contract.egressPortForIndex(index + 1),
    routingPlane: 'STRICT_CONTROL',
    explicit: false,
    legacyPort: false,
  };
}

function resolveProxyPort(state, alias, options = {}) {
  const target = resolveMatrixSlot(state, alias, options);
  return target ? target.egressPort : null;
}

function proxyCooldown(state, options = {}) {
  const proxy = proxyConfig(state);
  const fromSettings = Number(proxy.quarantineCooldownMs);
  if (Number.isFinite(fromSettings) && fromSettings >= 0) return fromSettings;
  return options.cooldownMs === undefined ? 15000 : options.cooldownMs;
}

function blockedError(slotId, reason) {
  const error = new Error(reason);
  error.name = 'EgressSlotBlockedError';
  error.code = 'ERR_EGRESS_SLOT_BLOCKED';
  error.status = 503;
  error.matrixSlotId = slotId;
  error.healthState = 'ROTATING';
  error.frozen = true;
  return error;
}

function createAccountProxy(options = {}) {
  const getState = options.getState;
  if (typeof getState !== 'function') throw new Error('createAccountProxy requires getState');
  const log = options.log || (() => {});
  const fetchFactory = options.fetchFactory || createProxyFetch;
  const timeoutMs = options.timeoutMs === undefined ? 30000 : options.timeoutMs;
  const egress = options.egress || null;
  const entries = new Map();
  const frozen = new Map();

  function dispose(alias) {
    const entry = entries.get(alias);
    if (!entry) return;
    entries.delete(alias);
    try { entry.transport.destroy(); } catch { /* ignore */ }
  }

  function slotFor(state, alias, opts = {}) {
    try {
      return resolveMatrixSlot(state, alias, { candidate: opts.candidate === true });
    } catch (error) {
      if (error.code === 'matrix_slot_exhausted' || error.code === 'invalid_matrix_slot') throw error;
      return null;
    }
  }

  function entryFor(alias, opts = {}) {
    const state = getState();
    const target = slotFor(state, alias, opts);
    if (!target || !target.egressPort) {
      dispose(alias);
      return null;
    }
    const current = entries.get(alias);
    if (current && current.port === target.egressPort
      && current.matrixSlotId === target.matrixSlotId) return current;
    dispose(alias);
    const transport = createTransport({
      alias,
      port: target.egressPort,
      matrixSlotId: target.matrixSlotId || undefined,
      routingPlane: target.routingPlane,
      fetchFactory,
      proxyHost: proxyConfig(state).host || undefined,
      proxyAuth: proxyConfig(state).auth || undefined,
      fetchOptions: {
        timeoutMs,
        failClosed: opts.failClosed !== false,
        cooldownMs: proxyCooldown(state, opts),
        onQuarantine: (reason) => {
          log(`proxy quarantined ${alias} on :${target.egressPort}: ${reason}`);
          if (opts.onQuarantine) opts.onQuarantine(alias, reason, target.egressPort);
        },
      },
    });
    const baseFetch = transport.fetch;
    const entry = {
      alias,
      port: target.egressPort,
      matrixSlotId: target.matrixSlotId,
      routingPlane: target.routingPlane,
      transport,
      fetch(input, init) {
        const gate = async () => {
          if (frozen.has(target.matrixSlotId)) {
            throw blockedError(target.matrixSlotId, `egress 槽位 ${target.matrixSlotId} 正在换血冻结`);
          }
          if (egress && target.matrixSlotId) {
            await egress.assertSlotUsable(target.matrixSlotId);
          }
        };
        return gate().then(() => baseFetch(input, init));
      },
    };
    entries.set(alias, entry);
    return entry;
  }

  function fetchFor(alias, opts) {
    const entry = entryFor(alias, opts);
    return entry ? entry.fetch : undefined;
  }

  function requireFetchFor(alias, opts) {
    const entry = entryFor(alias, opts);
    if (!entry) {
      throw new ProxyRequiredError(`账号 ${alias} 没有可用代理端口，已拒绝直连`);
    }
    return entry.fetch;
  }

  function connectWebSocket(alias, url, wsOptions) {
    const entry = entryFor(alias);
    if (!entry) {
      throw new ProxyRequiredError(`账号 ${alias} 没有可用代理端口，已拒绝直连`);
    }
    if (frozen.has(entry.matrixSlotId)) {
      throw blockedError(entry.matrixSlotId, `egress 槽位 ${entry.matrixSlotId} 正在换血冻结`);
    }
    return entry.transport.connectWebSocket(url, wsOptions);
  }

  function freezeSlot(matrixSlotId, info = {}) {
    const slotId = String(matrixSlotId || '');
    if (!slotId) return [];
    frozen.set(slotId, {
      matrixSlotId: slotId,
      reason: String(info.reason || 'rotation'),
      at: Date.now(),
    });
    const paused = [];
    for (const entry of entries.values()) {
      if (entry.matrixSlotId !== slotId) continue;
      try { entry.transport.suspend(); } catch { /* ignore */ }
      paused.push(entry.alias);
    }
    if (paused.length) log(`egress ${slotId} 冻结，暂停 ${paused.join(', ')}`);
    return paused;
  }

  function resumeSlot(matrixSlotId, fingerprint) {
    const slotId = String(matrixSlotId || '');
    if (!slotId) return [];
    frozen.delete(slotId);
    const resumed = [];
    for (const entry of entries.values()) {
      if (entry.matrixSlotId !== slotId) continue;
      try { entry.transport.resume(); } catch { /* ignore */ }
      resumed.push(entry.alias);
    }
    if (resumed.length) {
      log(`egress ${slotId} 恢复${fingerprint && fingerprint.exitIp ? ` exit=${fingerprint.exitIp}` : ''}，恢复 ${resumed.join(', ')}`);
    }
    return resumed;
  }

  function isPaused(alias) {
    const entry = entries.get(alias);
    if (entry) return frozen.has(entry.matrixSlotId);
    const state = getState();
    let target = null;
    try { target = resolveMatrixSlot(state, alias); } catch { target = null; }
    return Boolean(target && frozen.has(target.matrixSlotId));
  }

  function pausedSlots() {
    return [...frozen.keys()];
  }

  function waitForResume(alias, waitOptions) {
    if (!egress) return Promise.resolve({ ok: true, already: true });
    const state = getState();
    let target = null;
    try { target = resolveMatrixSlot(state, alias); } catch { target = null; }
    if (!target || !target.matrixSlotId) return Promise.resolve({ ok: true, already: true });
    return egress.waitForResume(target.matrixSlotId, waitOptions);
  }

  function status() {
    const state = getState();
    return (state.accounts || [])
      .filter((account) => account.enabled !== false)
      .map((account) => {
        let target = null;
        try { target = resolveMatrixSlot(state, account.alias); } catch { target = null; }
        const entry = entries.get(account.alias) || null;
        const transportState = entry ? entry.transport.state : null;
        const slotId = target ? target.matrixSlotId : '';
        const cached = egress && slotId ? egress.cachedSlot(slotId) : null;
        const isFrozen = Boolean(slotId && frozen.has(slotId));
        return {
          alias: account.alias,
          enabled: Boolean(target && target.egressPort),
          port: target ? target.egressPort : null,
          matrixSlotId: slotId || null,
          egressPort: target ? target.egressPort : null,
          routingPlane: target ? target.routingPlane : null,
          healthState: isFrozen
            ? 'ROTATING'
            : (cached && cached.healthState ? cached.healthState : 'ACTIVE'),
          frozen: isFrozen,
          suspended: Boolean(transportState && transportState.suspended),
          active: Boolean(entry),
          quarantined: Boolean(transportState && transportState.quarantined),
          reason: transportState ? transportState.reason : null,
          quarantinedAt: transportState ? transportState.quarantinedAt : null,
        };
      });
  }

  function release(alias) {
    if (alias) {
      const entry = entries.get(alias);
      if (entry) entry.transport.release();
      return;
    }
    for (const entry of entries.values()) entry.transport.release();
  }

  function closeAll() {
    for (const alias of [...entries.keys()]) dispose(alias);
    frozen.clear();
  }

  async function probe(alias) {
    const entry = entryFor(alias);
    if (!entry) return { ok: false, alias, error: 'proxy_disabled' };
    if (frozen.has(entry.matrixSlotId)) {
      return { ok: false, alias, port: entry.port, matrixSlotId: entry.matrixSlotId, error: 'rotation_frozen' };
    }
    const state = getState();
    const url = proxyConfig(state).checkUrl || '';
    if (!url) return { ok: false, alias, port: entry.port, error: 'no_check_url' };
    const started = Date.now();
    try {
      const response = await entry.fetch(url, { timeoutMs });
      const body = await response.text();
      return {
        ok: response.ok,
        alias,
        port: entry.port,
        matrixSlotId: entry.matrixSlotId,
        status: response.status,
        body: body.slice(0, 500),
        elapsedMs: Date.now() - started,
      };
    } catch (error) {
      return {
        ok: false,
        alias,
        port: entry.port,
        matrixSlotId: entry.matrixSlotId,
        error: error.message,
        elapsedMs: Date.now() - started,
      };
    }
  }

  return {
    portFor: (alias) => resolveProxyPort(getState(), alias),
    slotFor: (alias, opts) => resolveMatrixSlot(getState(), alias, opts),
    fetchFor,
    requireFetchFor,
    connectWebSocket,
    status,
    release,
    closeAll,
    probe,
    freezeSlot,
    resumeSlot,
    isPaused,
    pausedSlots,
    waitForResume,
  };
}

module.exports = {
  createAccountProxy,
  resolveProxyPort,
  resolveMatrixSlot,
  proxyCooldown,
  ProxyRequiredError,
};
