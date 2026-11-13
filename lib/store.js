'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeMode, normalizeTtl } = require('./leases');
const { withStateLock, atomicWriteFile } = require('./store-lock');

const DATA_DIR = process.env.INSTABOX_MATRIX_DATA_DIR
  ? path.resolve(process.env.INSTABOX_MATRIX_DATA_DIR)
  : path.join(os.homedir(), '.openchamber-instabox-matrix');
const STORE_FILE = path.join(DATA_DIR, 'state.json');

const PROXY_DEFAULTS = {
  enabled: false,
  basePort: 24001,
  size: 250,
  ports: {},
  nodes: {},
  checkUrl: '',
};

const RATE_LIMIT_DEFAULTS = {
  rps: 5,
  concurrency: 2,
};

const RECYCLE_DEFAULTS = {
  enabled: false,
  leadMinutes: null,
  minUptimeMinutes: 60,
  pollMinutes: 5,
  verifyTimeoutMs: 180000,
  bootstrapTimeoutSeconds: 300,
  machines: {},
};

const DEFAULTS = {
  version: 1,
  settings: {
    gatewayUrl: '',
    defaultTtlSeconds: 900,
    proxy: PROXY_DEFAULTS,
    rateLimit: RATE_LIMIT_DEFAULTS,
    recycle: RECYCLE_DEFAULTS,
  },
  accounts: [],
  keepalive: [],
  machineMeta: [],
  recycle: [],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function normalizeBaseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('网关地址必须是完整的 http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('网关地址只支持 http 或 https');
  }
  if (url.username || url.password) {
    throw new Error('网关地址不能包含用户名或密码');
  }
  return url.toString().replace(/\/+$/, '');
}

function normalizeAlias(raw) {
  const alias = String(raw || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,32}$/.test(alias)) {
    throw new Error('别名只能使用 1-32 位字母、数字、下划线、点或短横线');
  }
  return alias;
}

function normalizeProxySettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const settings = {
    enabled: input.enabled === true,
    basePort: Math.max(1024, Math.min(65535, Number(input.basePort) || PROXY_DEFAULTS.basePort)),
    size: Math.max(1, Math.min(1000, Number(input.size) || PROXY_DEFAULTS.size)),
    ports: {},
    nodes: {},
    checkUrl: String(input.checkUrl || '').trim(),
  };
  if (input.ports && typeof input.ports === 'object') {
    for (const [alias, port] of Object.entries(input.ports)) {
      const value = Number(port);
      if (Number.isInteger(value) && value >= 1 && value <= 65535) settings.ports[alias] = value;
    }
  }
  if (input.nodes && typeof input.nodes === 'object') {
    for (const [alias, uri] of Object.entries(input.nodes)) {
      const key = String(alias).trim();
      const text = String(uri || '').trim();
      if (!/^[A-Za-z0-9_.-]{1,32}$/.test(key)) continue;
      if (text.length > 8192) continue;
      if (!/^(vless|trojan|vmess|ss|hy2|hysteria2|socks5|socks|https?):\/\//i.test(text)) continue;
      settings.nodes[key] = text;
    }
  }
  return settings;
}

function normalizeRateLimit(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const rps = Number(input.rps);
  const concurrency = Number(input.concurrency);
  return {
    rps: Number.isFinite(rps) ? Math.max(0.1, Math.min(100, rps)) : RATE_LIMIT_DEFAULTS.rps,
    concurrency: Number.isFinite(concurrency)
      ? Math.max(1, Math.min(16, Math.round(concurrency)))
      : RATE_LIMIT_DEFAULTS.concurrency,
  };
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function recycleKey(account, machineId) {
  return `${account}/${machineId}`;
}

function normalizeRecycleCommand(value) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, 4000);
}

function normalizeRecycleConfig(entry) {
  if (!entry || !entry.account || !entry.machineId) return null;
  const account = String(entry.account).trim();
  const machineId = String(entry.machineId).trim();
  if (!account || !machineId) return null;
  return {
    account,
    machineId,
    enabled: entry.enabled !== false,
    verifyCommand: normalizeRecycleCommand(entry.verifyCommand),
    bootstrapCommand: normalizeRecycleCommand(entry.bootstrapCommand),
    snapshotBeforeFirst: entry.snapshotBeforeFirst === true,
    proxyExitExpect: String(entry.proxyExitExpect || '').trim().slice(0, 64),
    updatedAt: entry.updatedAt || new Date().toISOString(),
  };
}

function normalizeRecycleSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const lead = Number(input.leadMinutes);
  const settings = {
    enabled: input.enabled === true,
    leadMinutes:
      input.leadMinutes !== null && input.leadMinutes !== '' && Number.isFinite(lead)
        ? Math.max(5, Math.min(120, Math.round(lead)))
        : null,
    minUptimeMinutes: clampInt(input.minUptimeMinutes, 0, 1440, RECYCLE_DEFAULTS.minUptimeMinutes),
    pollMinutes: clampInt(input.pollMinutes, 1, 60, RECYCLE_DEFAULTS.pollMinutes),
    verifyTimeoutMs: clampInt(input.verifyTimeoutMs, 30000, 900000, RECYCLE_DEFAULTS.verifyTimeoutMs),
    bootstrapTimeoutSeconds: clampInt(
      input.bootstrapTimeoutSeconds,
      30,
      1800,
      RECYCLE_DEFAULTS.bootstrapTimeoutSeconds,
    ),
    machines: {},
  };
  if (input.machines && typeof input.machines === 'object') {
    for (const entry of Object.values(input.machines)) {
      const config = normalizeRecycleConfig(entry);
      if (config) settings.machines[recycleKey(config.account, config.machineId)] = config;
    }
  }
  return settings;
}

function normalizeLastResult(value) {
  if (value && typeof value === 'object') {
    const exitCode = Number(value.exitCode);
    return {
      at: value.at ? String(value.at) : null,
      ok: value.ok === true,
      exitCode: Number.isFinite(exitCode) ? exitCode : null,
      summary: String(value.summary || '').slice(0, 200),
      stderrTail: String(value.stderrTail || '').slice(0, 500),
    };
  }
  return String(value || '').slice(0, 500);
}

function normalizeRecycleStatus(entry) {
  if (!entry || !entry.account || !entry.machineId) return null;
  return {
    account: String(entry.account),
    machineId: String(entry.machineId),
    machineName: String(entry.machineName || '').slice(0, 128),
    status: String(entry.status || 'idle').slice(0, 32),
    lastRecycleAt: entry.lastRecycleAt || null,
    lastRunStartedAt: entry.lastRunStartedAt || null,
    lastResult: normalizeLastResult(entry.lastResult),
    consecutiveFailures: clampInt(entry.consecutiveFailures, 0, 999, 0),
    lastError: String(entry.lastError || '').slice(0, 500),
    nextAt: entry.nextAt || null,
    updatedAt: entry.updatedAt || new Date().toISOString(),
  };
}

function migrateMachineMeta(entry) {
  if (!entry || !entry.account || !entry.machineId) return null;
  return {
    account: String(entry.account),
    machineId: String(entry.machineId),
    projectGroup: String(entry.projectGroup || '').trim().slice(0, 64),
    role: String(entry.role || '').trim().slice(0, 64),
    tags: Array.isArray(entry.tags)
      ? [...new Set(entry.tags.map((tag) => String(tag || '').trim()).filter(Boolean))].slice(0, 16)
      : [],
    notes: String(entry.notes || '').trim().slice(0, 2000),
    updatedAt: entry.updatedAt || new Date().toISOString(),
  };
}

function migrateKeepalive(entry) {
  if (!entry || !entry.account || !entry.machineId) return null;
  return {
    account: entry.account,
    machineId: entry.machineId,
    machineName: entry.machineName || '',
    enabled: entry.enabled !== false,
    mode: normalizeMode(entry.mode),
    ttlSeconds: normalizeTtl(entry.ttlSeconds),
    knockUrl: entry.knockUrl || '',
    autoWake: entry.autoWake === true,
    leaseId: entry.leaseId || '',
    expiresAt: entry.expiresAt || null,
    retryAt: entry.retryAt || null,
    lastWakeAt: entry.lastWakeAt || null,
    lastWakeAction: entry.lastWakeAction || '',
    lastKnockAt: entry.lastKnockAt || null,
    createdAt: entry.createdAt || new Date().toISOString(),
    lastRunAt: entry.lastRunAt || null,
    lastOk: entry.lastOk === undefined ? null : entry.lastOk,
    lastError: entry.lastError || null,
    runs: Number(entry.runs) || 0,
  };
}

function load() {
  try {
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const state = Object.assign(clone(DEFAULTS), parsed);
    state.settings = Object.assign(clone(DEFAULTS.settings), parsed.settings || {});
    state.settings.proxy = normalizeProxySettings(state.settings.proxy);
    state.settings.rateLimit = normalizeRateLimit(state.settings.rateLimit);
    state.settings.recycle = normalizeRecycleSettings(state.settings.recycle);
    state.accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    state.keepalive = (Array.isArray(parsed.keepalive) ? parsed.keepalive : [])
      .map(migrateKeepalive)
      .filter(Boolean);
    state.machineMeta = (Array.isArray(parsed.machineMeta) ? parsed.machineMeta : [])
      .map(migrateMachineMeta)
      .filter(Boolean);
    state.recycle = (Array.isArray(parsed.recycle) ? parsed.recycle : [])
      .map(normalizeRecycleStatus)
      .filter(Boolean);
    return state;
  } catch (error) {
    if (error && error.code === 'ENOENT') return clone(DEFAULTS);
    if (error instanceof SyntaxError) {
      const broken = `${STORE_FILE}.broken-${Date.now()}`;
      try { fs.renameSync(STORE_FILE, broken); } catch { /* ignore */ }
      return clone(DEFAULTS);
    }
    throw error;
  }
}

function save(state) {
  ensureDir();
  atomicWriteFile(STORE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

/**
 * Serialized read-modify-write. Use for every mutation that can race with the
 * panel, MCP server or keepalive loop.
 */
async function update(mutator, options = {}) {
  return withStateLock(STORE_FILE, async () => {
    const state = load();
    const result = await mutator(state);
    if (result === false) return load();
    save(state);
    return result === undefined ? state : result;
  }, options);
}

function publicAccount(account) {
  const key = String(account.apiKey || '');
  return {
    alias: account.alias,
    keyPreview: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '',
    gatewayUrl: account.gatewayUrl || '',
    enabled: account.enabled !== false,
    createdAt: account.createdAt || null,
    lastCheckedAt: account.lastCheckedAt || null,
    identity: account.identity || null,
    lastError: account.lastError || null,
  };
}

function findAccount(state, alias) {
  if (!alias) return state.accounts.find((a) => a.enabled !== false) || null;
  return state.accounts.find((a) => a.alias === alias) || null;
}

function setAccountMeta(state, alias, patch) {
  const account = state.accounts.find((a) => a.alias === alias);
  if (!account) return null;
  Object.assign(account, patch);
  return account;
}

function findMachineMeta(state, account, machineId) {
  return state.machineMeta.find(
    (meta) => meta.account === account && meta.machineId === machineId,
  ) || null;
}

function setMachineMeta(state, input) {
  if (!input || !input.account || !input.machineId) return null;
  if (!Array.isArray(state.machineMeta)) state.machineMeta = [];
  const index = state.machineMeta.findIndex(
    (meta) => meta.account === input.account && meta.machineId === input.machineId,
  );
  const current = index >= 0 ? state.machineMeta[index] : null;
  const next = migrateMachineMeta({
    ...(current || {}),
    ...input,
    account: input.account,
    machineId: input.machineId,
    updatedAt: new Date().toISOString(),
  });
  if (!next) return null;
  const empty = !next.projectGroup && !next.role && !next.tags.length && !next.notes;
  if (empty) {
    if (index >= 0) state.machineMeta.splice(index, 1);
    return null;
  }
  if (index >= 0) state.machineMeta[index] = next;
  else state.machineMeta.push(next);
  return next;
}

function removeMachineMeta(state, account, machineId) {
  const before = state.machineMeta.length;
  state.machineMeta = state.machineMeta.filter(
    (meta) => !(meta.account === account && meta.machineId === machineId),
  );
  return state.machineMeta.length !== before;
}

function removeAccount(state, alias) {
  const before = state.accounts.length;
  state.accounts = state.accounts.filter((a) => a.alias !== alias);
  state.keepalive = state.keepalive.filter((k) => k.account !== alias);
  state.machineMeta = state.machineMeta.filter((meta) => meta.account !== alias);
  const machines = state.settings && state.settings.recycle && state.settings.recycle.machines;
  if (machines) {
    for (const [key, config] of Object.entries(machines)) {
      if (config && config.account === alias) delete machines[key];
    }
  }
  state.recycle = (Array.isArray(state.recycle) ? state.recycle : [])
    .filter((entry) => entry && entry.account !== alias);
  return state.accounts.length !== before;
}

function upsertKeepalive(state, next) {
  const index = state.keepalive.findIndex(
    (k) => k.account === next.account && k.machineId === next.machineId,
  );
  if (next.enabled === false) {
    if (index >= 0) state.keepalive.splice(index, 1);
    return null;
  }
  const current = index >= 0 ? state.keepalive[index] : null;
  const entry = {
    account: next.account,
    machineId: next.machineId,
    machineName: next.machineName || (current && current.machineName) || '',
    enabled: true,
    mode: normalizeMode(next.mode !== undefined ? next.mode : current && current.mode),
    ttlSeconds: normalizeTtl(next.ttlSeconds !== undefined ? next.ttlSeconds : current && current.ttlSeconds),
    knockUrl: next.knockUrl !== undefined ? String(next.knockUrl || '') : (current && current.knockUrl) || '',
    autoWake: next.autoWake !== undefined ? next.autoWake === true : (current ? current.autoWake === true : false),
    leaseId: (current && current.leaseId) || '',
    expiresAt: (current && current.expiresAt) || null,
    retryAt: (current && current.retryAt) || null,
    lastWakeAt: (current && current.lastWakeAt) || null,
    lastWakeAction: (current && current.lastWakeAction) || '',
    lastKnockAt: (current && current.lastKnockAt) || null,
    createdAt: (current && current.createdAt) || new Date().toISOString(),
    lastRunAt: (current && current.lastRunAt) || null,
    lastOk: current ? (current.lastOk === undefined ? null : current.lastOk) : null,
    lastError: (current && current.lastError) || null,
    runs: (current && Number(current.runs)) || 0,
  };
  if (index >= 0) state.keepalive[index] = entry;
  else state.keepalive.push(entry);
  return entry;
}

function findRecycleConfig(state, account, machineId) {
  const machines = state && state.settings && state.settings.recycle && state.settings.recycle.machines;
  if (!machines) return null;
  return machines[recycleKey(account, machineId)] || null;
}

function setRecycleConfig(state, input) {
  if (!state.settings.recycle) state.settings.recycle = normalizeRecycleSettings();
  if (!input || !input.account || !input.machineId) return null;
  const key = recycleKey(input.account, input.machineId);
  const current = state.settings.recycle.machines[key] || null;
  const next = normalizeRecycleConfig({
    ...(current || {}),
    ...input,
    account: input.account,
    machineId: input.machineId,
    updatedAt: new Date().toISOString(),
  });
  if (!next) return null;
  state.settings.recycle.machines[key] = next;
  return next;
}

function findRecycleStatus(state, account, machineId) {
  const list = state && Array.isArray(state.recycle) ? state.recycle : [];
  return list.find((entry) => entry.account === account && entry.machineId === machineId) || null;
}

function upsertRecycleStatus(state, patch) {
  if (!patch || !patch.account || !patch.machineId) return null;
  if (!Array.isArray(state.recycle)) state.recycle = [];
  const index = state.recycle.findIndex(
    (entry) => entry.account === patch.account && entry.machineId === patch.machineId,
  );
  const current = index >= 0 ? state.recycle[index] : null;
  const next = normalizeRecycleStatus({
    ...(current || {}),
    ...patch,
    account: patch.account,
    machineId: patch.machineId,
  });
  if (!next) return null;
  if (index >= 0) state.recycle[index] = next;
  else state.recycle.push(next);
  return next;
}

module.exports = {
  DATA_DIR,
  STORE_FILE,
  DEFAULTS,
  PROXY_DEFAULTS,
  RECYCLE_DEFAULTS,
  load,
  save,
  update,
  ensureDir,
  normalizeAlias,
  normalizeBaseUrl,
  normalizeProxySettings,
  normalizeRateLimit,
  normalizeRecycleSettings,
  recycleKey,
  publicAccount,
  findAccount,
  setAccountMeta,
  findMachineMeta,
  setMachineMeta,
  removeMachineMeta,
  findRecycleConfig,
  setRecycleConfig,
  findRecycleStatus,
  upsertRecycleStatus,
  removeAccount,
  upsertKeepalive,
};
