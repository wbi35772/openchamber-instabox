#!/usr/bin/env node
/*
 * Trinity Matrix E2E verifier.
 *
 * Verifies the live contract between:
 *   openchamber-egress-matrix   http://127.0.0.1:19880
 *   openchamber-cloudflare      http://127.0.0.1:19882
 *   openchamber-instabox        http://127.0.0.1:19883
 *
 * The script never invents a pass. A service that is offline, a slot that does
 * not exist, or a provision that needs credentials the host does not have is a
 * FAIL with the exact evidence, not a skipped success.
 *
 * Usage:
 *   node scripts/verify-trinity-matrix.mjs
 *   node scripts/verify-trinity-matrix.mjs --no-spawn --cf-token ... --instabox-token ...
 *   node scripts/verify-trinity-matrix.mjs --slot slot-002 --rotate-node-id node_xxx
 *   node scripts/verify-trinity-matrix.mjs --slots slot-002,slot-004
 *   node scripts/verify-trinity-matrix.mjs --domain-zone example.com --hostname trinity.example.com
 *
 * Without --slot/--slots the script tests up to three ACTIVE egress slots
 * (sorted by id); the first one drives stages 2-4. Large matrices do not need
 * every node in a single run.
 *
 * Stage 4 always runs scripts/probe-cf-provision.mjs as rows 4.5: that probe
 * exercises the real vault/net-binder/RPC path against a local Cloudflare stub
 * (upstream=stub). It never turns 4.1/4.3 into a pass for real credentials;
 * --skip-cf-probe turns it off.
 *
 * Exit code: 0 when every executed check passed, 1 when anything failed or a
 * required live check could not be executed, 2 on a harness error.
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_PARENT = path.resolve(ROOT, '..');
const DEFAULT_CF_DIR = path.join(REPO_PARENT, 'openchamber-cloudflare');
const DEFAULT_EGRESS_DIR = path.resolve(ROOT, '..', '..', 'openchamber-egress-matrix');

const DEFAULTS = {
  egress: 'http://127.0.0.1:19880',
  cf: 'http://127.0.0.1:19882',
  instabox: 'http://127.0.0.1:19883',
  slot: 'slot-001',
  timeoutMs: 8000,
};

const STATUS = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'SKIP', PARTIAL: 'PARTIAL' };

function parseArgs(argv) {
  const args = {
    ...DEFAULTS, spawn: true, keep: false, verbose: false, jsonOut: '', slots: [], slotExplicit: false,
    skipCfProbe: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      for (let j = i + 1; j < argv.length; j += 1) {
        if (!argv[j].startsWith('--')) return argv[j];
      }
      return '';
    };
    switch (token) {
      case '--egress': args.egress = next(); i += 1; break;
      case '--cf': args.cf = next(); i += 1; break;
      case '--instabox': args.instabox = next(); i += 1; break;
      case '--cf-token': args.cfToken = next(); i += 1; break;
      case '--instabox-token': args.instaboxToken = next(); i += 1; break;
      case '--slot':
        args.slot = next();
        args.slotExplicit = true;
        args.slots = [args.slot];
        i += 1;
        break;
      case '--slots':
        args.slots = next().split(',').map((value) => value.trim()).filter(Boolean);
        args.slotExplicit = args.slots.length > 0;
        if (args.slots.length) args.slot = args.slots[0];
        i += 1;
        break;
      case '--rotate-node-uri': args.rotateNodeUri = next(); i += 1; break;
      case '--rotate-node-id': args.rotateNodeId = next(); i += 1; break;
      case '--domain-zone': args.domainZone = next(); i += 1; break;
      case '--hostname': args.hostname = next(); i += 1; break;
      case '--alias': args.alias = next(); i += 1; break;
      case '--machine-id': args.machineId = next(); i += 1; break;
      case '--timeout': args.timeoutMs = Number(next()) || DEFAULTS.timeoutMs; i += 1; break;
      case '--json-out': args.jsonOut = next(); i += 1; break;
      case '--no-spawn': args.spawn = false; break;
      case '--skip-cf-probe': args.skipCfProbe = true; break;
      case '--keep': args.keep = true; break;
      case '--verbose': args.verbose = true; break;
      case '--help': args.help = true; break;
      default: break;
    }
  }
  args.cfToken = args.cfToken || process.env.TRINITY_CF_TOKEN || '';
  args.instaboxToken = args.instaboxToken || process.env.TRINITY_INSTABOX_TOKEN || '';
  args.cfDir = process.env.TRINITY_CF_DIR || DEFAULT_CF_DIR;
  args.egressDir = process.env.TRINITY_EGRESS_DIR || DEFAULT_EGRESS_DIR;
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tail(file, lines = 30) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function probeTcp(port, host = '127.0.0.1', timeoutMs = 600) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function requestJson(url, options = {}) {
  const {
    method = 'GET',
    body,
    token,
    timeoutMs = DEFAULTS.timeoutMs,
    headers = {},
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return {
      ok: response.ok,
      status: response.status,
      headers: response.headers,
      body: json,
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function safeRequest(url, options = {}) {
  try {
    return await requestJson(url, options);
  } catch (error) {
    return {
      ok: false,
      status: 0,
      headers: new Headers(),
      body: null,
      text: '',
      error: error.name === 'AbortError'
        ? `timeout ${options.timeoutMs || DEFAULTS.timeoutMs}ms`
        : String(error.message || error),
    };
  }
}

function urlPort(value) {
  try { return Number(new URL(value).port); } catch { return 0; }
}

function compactError(result) {
  if (!result) return 'no response';
  if (result.error) return result.error;
  const error = result.body && result.body.error;
  if (error) return `${error.code || 'error'}: ${error.message || JSON.stringify(error)}`;
  return `HTTP ${result.status}${result.text ? ` ${result.text.slice(0, 160)}` : ''}`;
}

function pickField(record, field) {
  if (!record || typeof record !== 'object') return undefined;
  if (record[field] !== undefined) return record[field];
  if (record.egress && typeof record.egress === 'object') return record.egress[field];
  return undefined;
}

function missingContractFields(record) {
  const missing = [];
  for (const field of ['matrixSlotId', 'egressPort', 'routingPlane', 'healthState', 'egressFingerprint']) {
    const value = pickField(record, field);
    if (value === undefined || value === null || value === '') {
      missing.push(field);
      continue;
    }
    if (field === 'egressFingerprint' && typeof value !== 'object') missing.push(field);
  }
  return missing;
}

function describeSlot(record) {
  if (!record) return 'missing';
  const fingerprint = pickField(record, 'egressFingerprint') || {};
  return [
    `slot=${pickField(record, 'matrixSlotId')}`,
    `port=${pickField(record, 'egressPort')}`,
    `plane=${pickField(record, 'routingPlane')}`,
    `state=${pickField(record, 'healthState')}`,
    `exitIp=${fingerprint.exitIp || '-'}`,
    `prefix64=${fingerprint.ipv6Prefix64 || '-'}`,
  ].join(' ');
}

class Report {
  constructor(stageTitles) {
    this.stageTitles = stageTitles;
    this.checks = [];
    this.notes = [];
    this.services = {};
    this.startedAt = new Date().toISOString();
  }

  add(stage, id, name, status, detail = '', evidence = '') {
    const entry = { stage, id, name, status, detail, evidence };
    this.checks.push(entry);
    if (status === STATUS.FAIL || status === STATUS.PARTIAL) {
      this.notes.push(`[${status}] ${stage} ${id} ${name}: ${detail}`);
    }
    return entry;
  }

  stageStatus(stage) {
    const rows = this.checks.filter((check) => check.stage === stage);
    if (!rows.length) return STATUS.SKIP;
    if (rows.some((row) => row.status === STATUS.FAIL)) return STATUS.FAIL;
    if (rows.some((row) => row.status === STATUS.PARTIAL)) return STATUS.PARTIAL;
    if (rows.every((row) => row.status === STATUS.SKIP)) return STATUS.SKIP;
    if (rows.some((row) => row.status === STATUS.SKIP)) return STATUS.PARTIAL;
    return STATUS.PASS;
  }

  summary() {
    return this.stageTitles.map((title, index) => ({
      stage: `${index + 1}. ${title}`,
      status: this.stageStatus(index + 1),
      checks: this.checks.filter((check) => check.stage === index + 1),
    }));
  }
}

function printTable(report) {
  const summary = report.summary();
  const rows = [
    ['阶段', '验收项', '状态', '证据 / 原因'],
    ...summary.flatMap((stage) => stage.checks.map((check) => [
      stage.stage,
      `${check.id} ${check.name}`,
      check.status,
      check.detail || check.evidence || '',
    ])),
  ];
  const widths = [0, 0, 0, 0];
  for (const row of rows) {
    for (let i = 0; i < 4; i += 1) {
      widths[i] = Math.max(widths[i], String(row[i] ?? '').length);
    }
  }
  const line = (cells) => `| ${cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join(' | ')} |`;
  const border = `+-${widths.map((width) => '-'.repeat(width)).join('-+-')}-+`;
  console.log('\n' + border);
  console.log(line(rows[0]));
  console.log(border.replace(/-/g, '='));
  for (const row of rows.slice(1)) console.log(line(row));
  console.log(border);
  console.log('\n阶段汇总:');
  for (const stage of summary) {
    console.log(`  ${stage.stage.padEnd(18)} ${stage.status}`);
  }
}

async function startService(ctx, options) {
  const {
    name, cwd, entry, env, healthUrl, expectService, timeoutMs = 25000,
  } = options;
  if (!fs.existsSync(path.join(cwd, entry))) {
    throw new Error(`${name}: entry not found ${path.join(cwd, entry)}`);
  }
  const logPath = path.join(ctx.tmpDir, `${name}.log`);
  const fd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  });
  const record = { name, child, logPath, spawned: true };
  ctx.services[name] = record;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${name} exited ${child.exitCode}\n${tail(logPath)}`);
    }
    const probe = await safeRequest(healthUrl, { timeoutMs: 1200 });
    const body = probe.body || {};
    if (probe.ok && (!expectService || body.service === expectService)) {
      return record;
    }
    await sleep(250);
  }
  throw new Error(`${name} health timeout ${healthUrl}\n${tail(logPath)}`);
}

async function stopService(record) {
  if (!record || !record.spawned || !record.child) return;
  const child = record.child;
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && child.exitCode === null) await sleep(100);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await sleep(200);
  }
}

async function ensureServices(ctx) {
  const report = ctx.report;
  const cfPort = urlPort(ctx.args.cf);
  const instaboxPort = urlPort(ctx.args.instabox);
  const egressPort = urlPort(ctx.args.egress);
  const cfLive = await probeTcp(cfPort);
  const instaboxLive = await probeTcp(instaboxPort);
  const egressLive = await probeTcp(egressPort);
  report.services.egress = { url: ctx.args.egress, port: egressPort, live: egressLive, spawned: false };
  report.services.cf = { url: ctx.args.cf, port: cfPort, live: cfLive, spawned: false };
  report.services.instabox = { url: ctx.args.instabox, port: instaboxPort, live: instaboxLive, spawned: false };

  if (!egressLive) {
    throw new Error(`egress bus ${ctx.args.egress} is offline; start openchamber-egress-matrix first`);
  }

  if (!ctx.args.spawn) {
    if (!cfLive) report.add(0, 'spawn.cf', 'cloudflare 服务', STATUS.SKIP, `${ctx.args.cf} 离线，--no-spawn`);
    if (!instaboxLive) report.add(0, 'spawn.instabox', 'instabox 服务', STATUS.SKIP, `${ctx.args.instabox} 离线，--no-spawn`);
    return;
  }

  if (!cfLive) {
    if (!fs.existsSync(path.join(ctx.args.cfDir, 'service', 'main.js'))) {
      report.add(0, 'spawn.cf', 'cloudflare 服务', STATUS.FAIL, `未找到 ${path.join(ctx.args.cfDir, 'service', 'main.js')}`);
    } else {
      ctx.cfToken = ctx.cfToken || `trinity-cf-${Date.now().toString(36)}`;
      try {
        const record = await startService(ctx, {
          name: 'cf',
          cwd: ctx.args.cfDir,
          entry: path.join('service', 'main.js'),
          env: {
            OPENCHAMBER_SERVICE_PORT: String(cfPort),
            OPENCHAMBER_SERVICE_TOKEN: ctx.cfToken,
            CF_MATRIX_DATA_DIR: path.join(ctx.tmpDir, 'cf-data'),
            CF_FAIL_CLOSED: 'true',
            CF_PORT_RANGE_START: '24001',
            CF_PORT_RANGE_END: '24250',
          },
          healthUrl: `${ctx.args.cf}/health`,
          expectService: null,
          timeoutMs: 30000,
        });
        report.services.cf = { url: ctx.args.cf, port: cfPort, live: true, spawned: true, log: record.logPath };
        report.add(0, 'spawn.cf', 'cloudflare 服务', STATUS.PASS, `临时实例 ${path.basename(record.logPath)}`);
      } catch (error) {
        report.add(0, 'spawn.cf', 'cloudflare 服务', STATUS.FAIL, String(error.message || error));
      }
    }
  } else {
    report.services.cf = { url: ctx.args.cf, port: cfPort, live: true, spawned: false };
  }

  if (!instaboxLive) {
    ctx.instaboxToken = ctx.instaboxToken || `trinity-ibx-${Date.now().toString(36)}`;
    try {
      const record = await startService(ctx, {
        name: 'instabox',
        cwd: ROOT,
        entry: path.join('service', 'main.js'),
        env: {
          OPENCHAMBER_SERVICE_PORT: String(instaboxPort),
          OPENCHAMBER_SERVICE_TOKEN: ctx.instaboxToken,
          INSTABOX_MATRIX_DATA_DIR: path.join(ctx.tmpDir, 'instabox-data'),
          OPENCHAMBER_EGRESS_BUS_URL: ctx.args.egress,
          OPENCHAMBER_CF_BRIDGE_URL: ctx.args.cf,
        },
        healthUrl: `${ctx.args.instabox}/api/v1/instabox/bus-health`,
        expectService: 'instabox-matrix',
        timeoutMs: 30000,
      });
      report.services.instabox = {
        url: ctx.args.instabox, port: instaboxPort, live: true, spawned: true, log: record.logPath,
      };
      report.add(0, 'spawn.instabox', 'instabox 服务', STATUS.PASS, `临时实例 ${path.basename(record.logPath)}`);
    } catch (error) {
      report.add(0, 'spawn.instabox', 'instabox 服务', STATUS.FAIL, String(error.message || error));
    }
  } else {
    report.services.instabox = { url: ctx.args.instabox, port: instaboxPort, live: true, spawned: false };
  }
}

function requireContract(order, file) {
  try {
    return require(file);
  } catch (error) {
    throw new Error(`contract load failed (${order}): ${file}: ${error.message}`);
  }
}

function loadContracts(ctx) {
  ctx.contracts = {
    egress: requireContract('egress', path.join(ctx.args.egressDir, 'core', 'contract.js')),
    cf: requireContract('cloudflare', path.join(ctx.args.cfDir, 'core', 'contract.js')),
    instabox: requireContract('instabox', path.join(ROOT, 'core', 'contract.js')),
  };
}

async function stage1(ctx) {
  const stage = 1;
  const { report, args } = ctx;
  const healthTargets = [
    { key: 'egress', label: '19880 egress', url: `${args.egress}/api/v1/egress/bus-health`, service: 'egress-matrix' },
    { key: 'cf', label: '19882 cloudflare', url: `${args.cf}/api/v1/cf/bus-health`, service: 'cloudflare-matrix' },
    { key: 'instabox', label: '19883 instabox', url: `${args.instabox}/api/v1/instabox/bus-health`, service: 'instabox-matrix' },
  ];

  const health = {};
  await Promise.all(healthTargets.map(async (target) => {
    const result = await safeRequest(target.url, { timeoutMs: 4000 });
    health[target.key] = { target, result };
  }));
  ctx.health = health;

  for (const target of healthTargets) {
    const { result } = health[target.key];
    const body = result.body || {};
    if (result.ok && body.ok !== false && (!target.service || body.service === target.service)) {
      report.add(stage, `1.1 ${target.key}.online`, `${target.label} bus-health`, STATUS.PASS,
        `service=${body.service || 'n/a'} ${JSON.stringify(body).slice(0, 180)}`);
      continue;
    }
    if (target.key === 'egress' && result.status === 404) {
      const fallback = await safeRequest(`${args.egress}/api/v1/egress/state`, { timeoutMs: 4000 });
      if (fallback.ok && fallback.body && fallback.body.ok !== false) {
        report.add(stage, `1.1 ${target.key}.online`, `${target.label} bus-health`, STATUS.FAIL,
          '运行中的 19880 没有 /api/v1/egress/bus-health（旧进程，v' + (fallback.body.version || '?') + '）；/state 可用');
        continue;
      }
    }
    report.add(stage, `1.1 ${target.key}.online`, `${target.label} bus-health`, STATUS.FAIL, compactError(result));
  }

  for (const target of healthTargets) {
    const corsUrl = target.key === 'egress' && health[target.key].result.status === 404
      ? `${args.egress}/api/v1/egress/state`
      : target.url;
    let preflight;
    try {
      const response = await fetch(corsUrl, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://127.0.0.1:18083',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'authorization,content-type',
        },
        signal: AbortSignal.timeout(3000),
      });
      preflight = {
        status: response.status,
        allowOrigin: response.headers.get('access-control-allow-origin'),
        allowMethods: response.headers.get('access-control-allow-methods'),
      };
      try { await response.text(); } catch { /* ignore */ }
    } catch (error) {
      preflight = { status: 0, allowOrigin: null, allowMethods: null, error: String(error.message || error) };
    }
    const preflightOk = preflight.status >= 200 && preflight.status < 300 && Boolean(preflight.allowOrigin);
    report.add(stage, `1.2 ${target.key}.cors.preflight`, `${target.label} CORS preflight`, preflightOk ? STATUS.PASS : STATUS.FAIL,
      preflightOk
        ? `allow-origin=${preflight.allowOrigin} methods=${preflight.allowMethods || '-'}`
        : `status=${preflight.status} allow-origin=${preflight.allowOrigin || '-'} ${preflight.error || ''}`);

    const getResult = health[target.key].result;
    const allowOrigin = getResult.headers ? getResult.headers.get('access-control-allow-origin') : null;
    const corsGetOk = Boolean(allowOrigin);
    report.add(stage, `1.2 ${target.key}.cors.get`, `${target.label} CORS on GET`, corsGetOk ? STATUS.PASS : STATUS.FAIL,
      corsGetOk ? `allow-origin=${allowOrigin}` : `响应缺少 access-control-allow-origin（浏览器跨源 fetch 会被拦截）`);
  }

  const slotsResult = await safeRequest(`${args.egress}/api/v1/egress/slots`, { timeoutMs: 5000 });
  const slots = (slotsResult.body && Array.isArray(slotsResult.body.slots)) ? slotsResult.body.slots : [];
  ctx.egressSlots = slots;
  report.meta = { ...(report.meta || {}), existingSlots: slots.map((slot) => slot.matrixSlotId) };

  let testedSlots = Array.isArray(args.slots) && args.slots.length ? args.slots.slice() : null;
  if (!testedSlots) {
    testedSlots = args.slotExplicit ? [args.slot] : slots
      .filter((slot) => slot && slot.healthState === 'ACTIVE')
      .map((slot) => slot.matrixSlotId)
      .sort()
      .slice(0, 3);
    if (!testedSlots.length) {
      report.add(stage, '1.3 slots.auto', '自动选择测试槽位', STATUS.FAIL,
        `egress 返回 ${slots.length} 个槽位，但没有 ACTIVE；用 --slots 指定要测的槽位`);
    }
  }
  if (testedSlots.length) {
    args.slots = testedSlots;
    args.slot = testedSlots[0];
  }
  ctx.testedSlots = testedSlots;
  report.meta = { ...report.meta, testedSlots, primarySlot: args.slot };

  for (const slotId of testedSlots) {
    const targetSlot = slots.find((slot) => slot && slot.matrixSlotId === slotId);
    const expectedPort = ctx.contracts.egress.egressPortForSlotId(slotId);
    if (!targetSlot) {
      report.add(stage, `1.3 ${slotId}.exists`, `${slotId} 是否存在`, STATUS.FAIL,
        `egress 返回 ${slots.length} 个槽位: ${slots.map((slot) => slot.matrixSlotId).join(', ') || '(空)'}；${slotId} 不在其中`);
      continue;
    }
    report.add(stage, `1.3 ${slotId}.exists`, `${slotId} 是否存在`, STATUS.PASS, describeSlot(targetSlot));
    const portOk = Number(targetSlot.egressPort) === expectedPort;
    report.add(stage, `1.3 ${slotId}.port`, `${slotId} 端口映射`, portOk ? STATUS.PASS : STATUS.FAIL,
      `egressPort=${targetSlot.egressPort} expected=${expectedPort}`);
  }

  const instaboxSlots = await safeRequest(`${args.instabox}/api/matrix/slots`, {
    token: ctx.instaboxToken,
    timeoutMs: 5000,
  });
  const instaboxRecords = instaboxSlots.body && Array.isArray(instaboxSlots.body.slots)
    ? instaboxSlots.body.slots
    : [];
  const cfSlots = await safeRequest(`${args.cf}/api/v1/cf/slots`, {
    token: ctx.cfToken,
    timeoutMs: 5000,
  });
  const cfRecords = cfSlots.body && Array.isArray(cfSlots.body.result) ? cfSlots.body.result : [];

  ctx.slotRecords = testedSlots.map((slotId) => ({
    slotId,
    egress: slots.find((slot) => slot && slot.matrixSlotId === slotId) || null,
    instabox: instaboxRecords.find((entry) => pickField(entry, 'matrixSlotId') === slotId) || null,
    cf: cfRecords.find((entry) => pickField(entry, 'matrixSlotId') === slotId) || null,
  }));

  let cfEmptyReported = false;
  for (const slotId of testedSlots) {
    const serviceRecords = [
      {
        key: 'egress',
        label: '19880',
        record: slots.find((slot) => slot && slot.matrixSlotId === slotId),
        result: slotsResult,
      },
      {
        key: 'instabox',
        label: '19883',
        record: instaboxRecords.find((entry) => pickField(entry, 'matrixSlotId') === slotId),
        result: instaboxSlots,
      },
      {
        key: 'cf',
        label: '19882',
        record: cfRecords.find((entry) => pickField(entry, 'matrixSlotId') === slotId),
        result: cfSlots,
      },
    ];
    for (const service of serviceRecords) {
      const id = `1.3 ${service.key}.contract@${slotId}`;
      if (!service.result.ok) {
        report.add(stage, id, `${service.label} 槽位契约`, STATUS.FAIL,
          compactError(service.result) + (service.result.status === 401 ? '（需要 token）' : ''));
        continue;
      }
      if (!service.record) {
        if (service.key === 'cf' && cfEmptyReported) continue;
        if (service.key === 'cf') cfEmptyReported = true;
        const extra = service.key === 'cf' && cfSlots.ok
          ? `cf.matrix.slots 返回 ${cfRecords.length} 条（CF vault 无账号时为 0）`
          : '响应中没有该槽位';
        report.add(stage, id, `${service.label} 槽位契约`, STATUS.FAIL, extra);
        continue;
      }
      const missing = missingContractFields(service.record);
      report.add(stage, id, `${service.label} 槽位契约`,
        missing.length ? STATUS.FAIL : STATUS.PASS,
        missing.length ? `缺少 ${missing.join(', ')}` : describeSlot(service.record));
    }
  }
}

async function stage2(ctx) {
  const stage = 2;
  const { report, args } = ctx;
  const slot = ctx.egressSlots.find((entry) => entry && entry.matrixSlotId === args.slot);
  if (!slot) {
    report.add(stage, '2.1 preconditions', '换血前置条件', STATUS.FAIL,
      `${args.slot} 不存在，无法触发冻结广播`);
    return;
  }

  const bus = ctx.health && ctx.health.egress && ctx.health.egress.result;
  const wsClients = Number((bus && bus.body && bus.body.wsClientsCount) || 0);
  report.add(stage, '2.1 ws.clients', 'WS 客户端连接数', wsClients >= 2 ? STATUS.PASS : STATUS.FAIL,
    `wsClientsCount=${wsClients}（期望 cloudflare + instabox 至少 2 个）`);

  if (!args.rotateNodeUri && !args.rotateNodeId) {
    report.add(stage, '2.2 rotate', '模拟换血', STATUS.SKIP,
      '未提供 --rotate-node-uri / --rotate-node-id；egress 没有不换上游的“空旋转”接口');
    return;
  }

  const beforeEpoch = Number(slot.rotationEpoch) || 0;
  const rotateBody = {
    matrixSlotId: args.slot,
    reason: 'trinity-verify',
    ...(args.rotateNodeId ? { nodeId: args.rotateNodeId } : { nodeUri: args.rotateNodeUri }),
    ...(args.rotateExitIp ? { egressFingerprint: { exitIp: args.rotateExitIp } } : {}),
  };
  const rotate = await safeRequest(`${args.egress}/api/v1/egress/lease/rotate`, {
    method: 'POST',
    body: rotateBody,
    timeoutMs: 45000,
  });
  report.add(stage, '2.2 rotate', '模拟换血', rotate.ok && (!rotate.body || rotate.body.ok !== false) ? STATUS.PASS : STATUS.FAIL,
    rotate.ok && (!rotate.body || rotate.body.ok !== false)
      ? `matrixSlotId=${args.slot} state=${rotate.body && rotate.body.slot ? rotate.body.slot.healthState : '?'}`
      : compactError(rotate));

  const events = await safeRequest(`${args.egress}/api/v1/egress/events?limit=100`, { timeoutMs: 5000 });
  const list = events.body && Array.isArray(events.body.events) ? events.body.events : [];
  const eventName = (event) => event.event || event.type || event.name;
  const freeze = [...list].reverse().find((event) => eventName(event) === 'PRE_ROTATION_FREEZE'
    && (event.matrixSlotId === args.slot || (event.payload && event.payload.matrixSlotId === args.slot)));
  const resume = [...list].reverse().find((event) => eventName(event) === 'POST_ROTATION_RESUME'
    && (event.matrixSlotId === args.slot || (event.payload && event.payload.matrixSlotId === args.slot)));

  if (!freeze) {
    report.add(stage, '2.3 freeze.event', 'PRE_ROTATION_FREEZE 事件', STATUS.FAIL, 'event log 中没有该槽位的冻结事件');
  } else {
    const delivery = Array.isArray(freeze.delivery) ? freeze.delivery : [];
    const match = (prefix) => delivery.find((entry) => String(entry.clientId || '').startsWith(prefix));
    const cfAck = match('cf-matrix-');
    const ibAck = match('instabox-');
    for (const [key, ack, label] of [['cf', cfAck, 'cloudflare'], ['instabox', ibAck, 'instabox']]) {
      if (!ack) {
        report.add(stage, `2.3 ${key}.ack`, `${label} ack-freeze`, STATUS.FAIL,
          `冻结投递记录中无 ${label} 客户端；delivery=${JSON.stringify(delivery).slice(0, 300)}`);
        continue;
      }
      const latency = Number(ack.latencyMs);
      const ok = ack.ok !== false && Number.isFinite(latency) && latency <= 200;
      report.add(stage, `2.3 ${key}.ack`, `${label} ack-freeze`, ok ? STATUS.PASS : STATUS.FAIL,
        `clientId=${ack.clientId} latencyMs=${Number.isFinite(latency) ? latency : '?'} ok=${ack.ok}（阈值 200ms）`);
    }
  }

  if (!resume) {
    report.add(stage, '2.4 resume.event', 'POST_ROTATION_RESUME 事件', STATUS.FAIL, 'event log 中没有恢复事件');
  } else {
    const payload = resume.payload || resume;
    const fingerprint = payload.egressFingerprint || {};
    const ok = Boolean(payload.leaseId) && Boolean(fingerprint.exitIp || fingerprint.ipv6Prefix64);
    report.add(stage, '2.4 resume.event', 'POST_ROTATION_RESUME 事件', ok ? STATUS.PASS : STATUS.FAIL,
      `leaseId=${payload.leaseId || '-'} exitIp=${fingerprint.exitIp || '-'} prefix64=${fingerprint.ipv6Prefix64 || '-'}`);
  }

  const after = await safeRequest(`${args.egress}/api/v1/egress/slots`, { timeoutMs: 5000 });
  const afterSlot = after.body && Array.isArray(after.body.slots)
    ? after.body.slots.find((entry) => entry.matrixSlotId === args.slot)
    : null;
  if (afterSlot) {
    const epochOk = Number(afterSlot.rotationEpoch) > beforeEpoch;
    report.add(stage, '2.5 slot.active', '换血后槽位状态', afterSlot.healthState === 'ACTIVE' && epochOk ? STATUS.PASS : STATUS.FAIL,
      `state=${afterSlot.healthState} epoch=${beforeEpoch}->${afterSlot.rotationEpoch}`);
  }

  const instaboxStatus = await safeRequest(`${args.instabox}/api/matrix/status`, {
    token: ctx.instaboxToken,
    timeoutMs: 5000,
  });
  const frozen = instaboxStatus.body && instaboxStatus.body.egress && Array.isArray(instaboxStatus.body.egress.frozenSlots)
    ? instaboxStatus.body.egress.frozenSlots
    : [];
  report.add(stage, '2.5 instabox.unfrozen', 'instabox 冻结表清空', frozen.some((entry) => entry.matrixSlotId === args.slot) ? STATUS.FAIL : STATUS.PASS,
    `frozenSlots=${frozen.map((entry) => entry.matrixSlotId).join(',') || '(空)'}`);
}

async function stage3(ctx) {
  const stage = 3;
  const { report } = ctx;
  const states = ['QUARANTINED', 'WARP_OVERFLOW', 'ROTATING'];
  const ib = ctx.contracts.instabox;
  const cf = ctx.contracts.cf;
  const eg = ctx.contracts.egress;

  const ibBlocked = states.filter((state) => {
    try { return ib.isBlockedHealthState(state) === true; } catch { return false; }
  });
  report.add(stage, '3.1 instabox.classifier', 'instabox isBlockedHealthState', ibBlocked.length === states.length ? STATUS.PASS : STATUS.FAIL,
    `blocked=${ibBlocked.join(',') || '(none)'} of ${states.join(',')}`);

  const cfUnsafe = states.filter((state) => {
    try { return cf.isEgressSafeForControl(state) === false; } catch { return false; }
  });
  const cfSetOk = Array.isArray(cf.UNSAFE_HEALTH_STATES)
    && states.every((state) => cf.UNSAFE_HEALTH_STATES.includes(state));
  report.add(stage, '3.1 cf.classifier', 'cloudflare isEgressSafeForControl', cfUnsafe.length === states.length && cfSetOk ? STATUS.PASS : STATUS.FAIL,
    `unsafe=${cfUnsafe.join(',') || '(none)'} UNSAFE_HEALTH_STATES=${Array.isArray(cf.UNSAFE_HEALTH_STATES) ? cf.UNSAFE_HEALTH_STATES.join(',') : '?'}`);

  const egNormalized = states.filter((state) => {
    try { return eg.normalizeHealthState(state) === state; } catch { return false; }
  });
  report.add(stage, '3.1 egress.normalize', 'egress 健康态归一化', egNormalized.length === states.length ? STATUS.PASS : STATUS.FAIL,
    `normalized=${egNormalized.join(',') || '(none)'}`);

  report.add(stage, '3.2 live.injection', 'WARP_OVERFLOW 真实注入', STATUS.SKIP,
    'WARP_OVERFLOW 由 WARP 池溢出在 router-engine 内部派生，19880 没有外部置位接口；未对生产槽位做破坏性状态注入。'
    + '要验证真实阻断，需在 egress 测试实例上触发 WARP 溢出，或使用 CF self-check 的故障注入用例。');

  const live = await safeRequest(`${ctx.args.egress}/api/v1/egress/slots/${encodeURIComponent(ctx.args.slot)}`, { timeoutMs: 4000 });
  const liveState = live.body && live.body.slot ? live.body.slot.healthState : null;
  report.add(stage, '3.2 live.state', `${ctx.args.slot} 当前状态`, liveState ? STATUS.PASS : STATUS.FAIL,
    liveState ? `healthState=${liveState}` : compactError(live));

  report.add(stage, '3.3 summary', 'STRICT_CONTROL 防泄漏', STATUS.PARTIAL,
    '代码级门禁已核对；真实 WARP_OVERFLOW 故障注入未执行，不能宣称 100% 流量阻断已验证');
}

async function runCfStubProbe(ctx) {
  if (ctx.args.skipCfProbe) return null;
  const script = path.join(ROOT, 'scripts', 'probe-cf-provision.mjs');
  if (!fs.existsSync(script)) {
    return { ok: false, upstream: 'stub', checks: [], error: `${script} 不存在` };
  }
  const jsonPath = path.join(os.tmpdir(), `trinity-cf-stub-${process.pid}-${Date.now()}.json`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, '--json-out', jsonPath], {
      cwd: ROOT,
      windowsHide: true,
    });
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, upstream: 'stub', checks: [], error: 'stub probe timeout (90s)' });
    }, 90000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, upstream: 'stub', checks: [], error: error.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      let body = null;
      try {
        body = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch {
        body = null;
      }
      try {
        fs.rmSync(jsonPath, { force: true });
      } catch {
        /* ignore */
      }
      resolve(
        body || {
          ok: false,
          upstream: 'stub',
          checks: [],
          error: `probe exit=${code} ${stderr.trim().slice(-300)}`,
        },
      );
    });
  });
}

async function stage4(ctx) {
  const stage = 4;
  const { report, args } = ctx;
  const cfHealth = ctx.health && ctx.health.cf && ctx.health.cf.result;
  const activeAccounts = Number(cfHealth && cfHealth.body && cfHealth.body.activeAccounts);
  report.add(stage, '4.1 cf.accounts', 'CF 账号数', Number.isFinite(activeAccounts) && activeAccounts > 0 ? STATUS.PASS : STATUS.FAIL,
    Number.isFinite(activeAccounts) ? `activeAccounts=${activeAccounts}` : 'bus-health 未返回 activeAccounts');

  const cfSlots = await safeRequest(`${args.cf}/api/v1/cf/slots`, { token: ctx.cfToken, timeoutMs: 5000 });
  const cfRecords = cfSlots.body && Array.isArray(cfSlots.body.result) ? cfSlots.body.result : [];
  const bound = cfRecords.find((entry) => pickField(entry, 'matrixSlotId') === args.slot) || cfRecords[0] || null;
  const provisionSlot = bound ? pickField(bound, 'matrixSlotId') : args.slot;
  const expectedPort = ctx.contracts.cf.egressPortForSlotId(provisionSlot);

  const bridgePayload = {
    vmInstanceId: args.machineId || 'm_trinity',
    machineId: args.machineId || 'm_trinity',
    matrixSlotId: provisionSlot,
    egressPort: expectedPort,
    internalPort: 8080,
    hostname: args.hostname || `trinity-${Date.now().toString(36)}.example.com`,
    routingPlane: 'STRICT_CONTROL',
  };

  const bridgeModule = require(path.join(ROOT, 'lib', 'cf-bridge.js'));
  const seenAuth = [];
  const stub = http.createServer((req, res) => {
    seenAuth.push(req.headers.authorization || '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'cf-matrix-channel' }));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  try {
    const stubBridge = bridgeModule.createCfBridge({
      baseUrl: `http://127.0.0.1:${stub.address().port}`,
      token: 'TRINITY-TOKEN',
      log: () => {},
    });
    const status = await stubBridge.status();
    const authOk = status.reachable === true && seenAuth[0] === 'Bearer TRINITY-TOKEN';
    report.add(stage, '4.2 bridge.auth', 'instabox cf-bridge 鉴权', authOk ? STATUS.PASS : STATUS.FAIL,
      authOk
        ? 'cf-bridge.status() 已带 Authorization: Bearer <token>'
        : `cf-bridge 未发送 Bearer（seen=${JSON.stringify(seenAuth)} reachable=${status.reachable}）`);
  } finally {
    await new Promise((resolve) => stub.close(resolve));
  }

  let normalized = null;
  let normalizeError = null;
  try {
    normalized = bridgeModule.normalizeProvisionBody({
      matrixSlotId: provisionSlot,
      machineId: args.machineId || 'm_trinity',
      hostname: bridgePayload.hostname,
      internalPort: bridgePayload.internalPort,
      routingPlane: bridgePayload.routingPlane,
    });
  } catch (error) {
    normalizeError = error;
  }
  const expectedZone = bridgePayload.hostname.split('.').slice(1).join('.').toLowerCase();
  const contractOk = Boolean(
    normalized
    && normalized.domainZone === expectedZone
    && normalized.publicHostname === bridgePayload.hostname
    && normalized.localPort === 8080
    && normalized.vmInstanceId,
  );
  report.add(stage, '4.2 bridge.contract', 'instabox → CF 载荷契约', contractOk ? STATUS.PASS : STATUS.FAIL,
    contractOk
      ? `domainZone=${normalized.domainZone} localPort=${normalized.localPort} publicHostname=${normalized.publicHostname}`
      : normalizeError
        ? `${normalizeError.code || 'error'}: ${normalizeError.message}`
        : `输出缺字段: ${JSON.stringify(normalized)}`);

  const noAuth = await safeRequest(`${args.cf}/api/v1/cf/tunnel/provision`, {
    method: 'POST',
    body: bridgePayload,
    timeoutMs: 8000,
  });
  const authRequired = noAuth.status === 401;
  report.add(stage, '4.2 cf.auth', 'CF 服务端鉴权', authRequired ? STATUS.PASS : STATUS.FAIL,
    authRequired
      ? '无 Bearer 的 provision 被 CF 以 401 拒绝'
      : `CF 未拒绝无鉴权请求：HTTP ${noAuth.status} ${JSON.stringify(noAuth.body || {}).slice(0, 200)}`);

  if (!Number.isFinite(activeAccounts) || activeAccounts === 0) {
    report.add(stage, '4.3 provision', 'CF tunnel provision', STATUS.FAIL,
      'CF vault 无账号（activeAccounts=0）；provision 需要先绑定 Cloudflare 账号');
  } else {
    const domainZone = args.domainZone;
    if (!domainZone) {
      report.add(stage, '4.3 provision', 'CF tunnel provision', STATUS.SKIP, '缺少 --domain-zone');
    } else {
      const hostname = args.hostname || `trinity-${Date.now().toString(36)}.${domainZone}`;
      const direct = await safeRequest(`${args.cf}/api/v1/cf/tunnel/provision`, {
        method: 'POST',
        token: ctx.cfToken,
        timeoutMs: 30000,
        body: {
          matrixSlotId: provisionSlot,
          vmInstanceId: args.machineId || 'm_trinity',
          localPort: 8080,
          domainZone,
          tunnelName: `trinity-${Date.now().toString(36)}`,
          publicHostname: hostname,
        },
      });
      const result = direct.body && direct.body.result;
      const ok = Boolean(direct.body && direct.body.ok === true && result && result.tunnelId && result.publicHostname);
      report.add(stage, '4.3 provision', 'CF tunnel provision', ok ? STATUS.PASS : STATUS.FAIL,
        ok
          ? `tunnelId=${result.tunnelId} hostname=${result.publicHostname} egressPort=${result.egressPort}`
          : compactError(direct));
      if (ok) {
        const portOk = Number(result.egressPort) === expectedPort;
        report.add(stage, '4.3 egress.port', '槽位出口端口', portOk ? STATUS.PASS : STATUS.FAIL,
          `egressPort=${result.egressPort} expected=${expectedPort}`);
        const teardown = await safeRequest(`${args.cf}/api/v1/cf/tunnel/teardown`, {
          method: 'POST',
          token: ctx.cfToken,
          timeoutMs: 15000,
          body: { tunnelId: result.tunnelId, matrixSlotId: provisionSlot },
        });
        report.add(stage, '4.3 teardown', '清理测试隧道', teardown.ok && (!teardown.body || teardown.body.ok !== false) ? STATUS.PASS : STATUS.FAIL,
          compactError(teardown));
      }
    }
  }

  if (!args.alias || !args.machineId) {
    report.add(stage, '4.4 writeback', 'instabox 状态回填', STATUS.SKIP, '缺少 --alias / --machine-id');
  } else {
    const provision = await safeRequest(`${args.instabox}/api/cf/tunnel/provision`, {
      method: 'POST',
      token: ctx.instaboxToken,
      timeoutMs: 45000,
      body: { alias: args.alias, machineId: args.machineId, hostname: args.hostname || '' },
    });
    const tunnel = provision.body && provision.body.tunnel;
    report.add(stage, '4.4 writeback', 'instabox 状态回填', provision.ok && provision.body && provision.body.ok !== false && tunnel ? STATUS.PASS : STATUS.FAIL,
      provision.ok && provision.body && provision.body.ok !== false && tunnel
        ? `tunnel=${JSON.stringify(tunnel).slice(0, 240)}`
        : compactError(provision));
  }

  const stubProbe = await runCfStubProbe(ctx);
  if (stubProbe) {
    const checks = Array.isArray(stubProbe.checks) ? stubProbe.checks : [];
    const verdict = (id) => (checks.find((check) => check.id === id) || {}).status || STATUS.FAIL;
    const evidenceOf = (id) => (checks.find((check) => check.id === id) || {}).evidence || '无输出';
    const suffix = 'upstream=stub（本地 Cloudflare 模拟，不代表真实账号已通）';

    const provisionIds = ['account.add', 'provision.contract', 'provision.routes', 'provision.control'];
    const provisionOk = provisionIds.every((id) => verdict(id) === STATUS.PASS);
    report.add(stage, '4.5 stub.provision', 'CF provision 契约（stub 上游）',
      provisionOk ? STATUS.PASS : STATUS.FAIL,
      `${suffix}；${evidenceOf('provision.contract')}`);

    const redactionIds = ['provision.redaction', 'provision.sealed'];
    const redactionOk = redactionIds.every((id) => verdict(id) === STATUS.PASS);
    report.add(stage, '4.5 stub.redaction', '隧道 token 只存密封态',
      redactionOk ? STATUS.PASS : STATUS.FAIL,
      `${suffix}；${evidenceOf('provision.redaction')}；${evidenceOf('provision.sealed')}`);

    const teardownOk = verdict('teardown.contract') === STATUS.PASS;
    report.add(stage, '4.5 stub.teardown', 'teardown 删隧道与 DNS',
      teardownOk ? STATUS.PASS : STATUS.FAIL,
      `${suffix}；${evidenceOf('teardown.contract')}`);
    report.meta = {
      ...(report.meta || {}),
      cfStubProbe: {
        ok: stubProbe.ok === true,
        upstream: stubProbe.upstream || 'stub',
        slot: stubProbe.slot || null,
        checks: checks.map((check) => `${check.status} ${check.id}`),
      },
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/verify-trinity-matrix.mjs [--egress URL] [--cf URL] [--instabox URL]');
    console.log('  [--cf-token TOKEN] [--instabox-token TOKEN] [--slot slot-001] [--slots a,b,c]');
    console.log('  (no --slot/--slots: test up to three ACTIVE slots; the first drives stages 2-4)');
    console.log('  [--rotate-node-uri URI | --rotate-node-id ID] [--domain-zone ZONE] [--hostname HOST]');
    console.log('  [--alias ALIAS --machine-id ID] [--no-spawn] [--skip-cf-probe] [--keep] [--json-out FILE] [--verbose]');
    return 0;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trinity-verify-'));
  const ctx = {
    args,
    tmpDir,
    services: {},
    cfToken: args.cfToken,
    instaboxToken: args.instaboxToken,
    report: new Report(['三方总线连通性与契约', '换血冻结与连接池排空', 'STRICT_CONTROL 防泄漏', 'Instabox → Cloudflare 隧道']),
  };

  try {
    loadContracts(ctx);
    await ensureServices(ctx);
    await stage1(ctx);
    await stage2(ctx);
    await stage3(ctx);
    await stage4(ctx);
  } catch (error) {
    ctx.report.add(0, 'harness', '脚本执行', STATUS.FAIL, String(error.stack || error.message || error));
  } finally {
    for (const record of Object.values(ctx.services)) await stopService(record);
  }

  const report = ctx.report;
  const summary = report.summary();
  console.log('\nTrinity Matrix E2E');
  console.log(`  egress   ${args.egress}`);
  console.log(`  cf       ${args.cf}`);
  console.log(`  instabox ${args.instabox}`);
  console.log(`  slots    ${(args.slots && args.slots.length ? args.slots : [args.slot]).join(', ')}`);
  console.log(`  temp     ${tmpDir}${args.keep ? ' (kept)' : ''}`);
  printTable(report);

  const failed = report.checks.some((check) => check.status === STATUS.FAIL);
  const partial = report.checks.some((check) => check.status === STATUS.PARTIAL);
  if (args.verbose) {
    console.log('\n证据:');
    for (const check of report.checks) {
      console.log(`- ${check.id} ${check.name}: ${check.status} ${check.evidence || ''}`);
    }
  }

  const out = args.jsonOut || path.join(tmpDir, 'trinity-report.json');
  fs.writeFileSync(out, JSON.stringify({
    startedAt: report.startedAt,
    finishedAt: new Date().toISOString(),
    args: { ...args, cfToken: args.cfToken ? '[redacted]' : '', instaboxToken: args.instaboxToken ? '[redacted]' : '' },
    services: report.services,
    meta: report.meta,
    summary: summary.map((stage) => ({
      stage: stage.stage,
      status: stage.status,
      checks: stage.checks,
    })),
    checks: report.checks,
  }, null, 2));
  console.log(`\nJSON: ${out}`);

  if (!args.keep) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (failed) return 1;
  if (partial) return 1;
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 2;
  });
