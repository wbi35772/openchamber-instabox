'use strict';

/*
 * Config-driven launcher for `settings.proxy.nodes`.
 *
 * Default mode is DELEGATED: the egress matrix (`127.0.0.1:19880`) owns every
 * port in 24001-24250. This script only maps each node alias onto its contract
 * slot, verifies the slot exists, and prints the plan. It never spawns sing-box
 * and never opens a port itself.
 *
 * `--standalone-fallback` restores the old single-process sing-box behaviour
 * for hosts without the egress matrix.
 *
 * Usage:
 *   node scripts/singbox-up.js [--state PATH] [--base-port N] [--data-dir DIR]
 *        [--bin PATH] [--shared DIR]... [--log-level warn] [--bus URL]
 *        [--client-id ID] [--standalone-fallback] [--dry-run]
 */

const fs = require('node:fs');
const path = require('node:path');
const { load, PROXY_DEFAULTS } = require('../lib/store');
const contract = require('../core/contract');
const {
  parseNode,
  buildSingBoxConfig,
  resolveSingBoxBin,
  createSingBoxSupervisor,
  resolveMode,
  createEgressDelegator,
  DEFAULT_EGRESS_BUS_URL,
} = require('../lib/sub2port');

function parseArgs(argv) {
  const out = { shared: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state') out.state = argv[++i];
    else if (arg === '--base-port') out.basePort = Number(argv[++i]);
    else if (arg === '--data-dir') out.dataDir = argv[++i];
    else if (arg === '--bin') out.bin = argv[++i];
    else if (arg === '--shared') out.shared.push(argv[++i]);
    else if (arg === '--log-level') out.logLevel = argv[++i];
    else if (arg === '--bus') out.busUrl = argv[++i];
    else if (arg === '--client-id') out.clientId = argv[++i];
    else if (arg === '--standalone-fallback') out.standaloneFallback = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    'usage: node scripts/singbox-up.js [--state PATH] [--base-port N] [--data-dir DIR]',
    '       [--bin PATH] [--shared DIR]... [--log-level warn] [--bus URL]',
    '       [--client-id ID] [--standalone-fallback] [--dry-run]',
  ].join('\n');
}

/*
 * Map every alias onto one matrix slot:
 *   1. `settings.proxy.slots[alias]`
 *   2. `settings.proxy.ports[alias]` inside 24001-24250 (slot derived)
 *   3. lowest free slot, in sorted alias order
 * Legacy explicit ports outside the matrix range are rejected in delegated
 * mode: the egress matrix can never own them.
 */
function planSlots(aliases, proxy = {}) {
  const slots = proxy.slots && typeof proxy.slots === 'object' ? proxy.slots : {};
  const ports = proxy.ports && typeof proxy.ports === 'object' ? proxy.ports : {};
  const assigned = new Map();
  const taken = new Set();
  const pending = [];

  for (const alias of aliases) {
    const declared = slots[alias];
    if (declared) {
      const index = contract.indexForSlotId(declared);
      if (!index) throw new Error(`账号 ${alias} 的 matrixSlotId 非法: ${declared}`);
      if (taken.has(declared)) throw new Error(`matrixSlotId 重复分配: ${declared}（${alias}）`);
      taken.add(declared);
      assigned.set(alias, {
        matrixSlotId: declared,
        egressPort: contract.egressPortForSlotId(declared),
        source: 'slots',
      });
      continue;
    }
    const port = Number(ports[alias]) || 0;
    if (port) {
      const matrixSlotId = contract.matrixSlotIdForPort(port);
      if (!matrixSlotId) {
        throw new Error(
          `账号 ${alias} 的端口 ${port} 不在矩阵范围 ${contract.EGRESS_PORT_MIN}-${contract.EGRESS_PORT_MAX}；`
          + '改用 settings.proxy.slots 或 --standalone-fallback',
        );
      }
      if (taken.has(matrixSlotId)) throw new Error(`matrixSlotId 重复分配: ${matrixSlotId}（${alias}）`);
      taken.add(matrixSlotId);
      assigned.set(alias, { matrixSlotId, egressPort: port, source: 'ports' });
      continue;
    }
    pending.push(alias);
  }

  for (const alias of pending) {
    const index = aliases.indexOf(alias) + 1;
    if (index > contract.SLOT_MAX_INDEX) {
      throw Object.assign(
        new Error(`矩阵槽位已用尽（最多 ${contract.SLOT_COUNT} 个账号）`),
        { code: 'matrix_slot_exhausted' },
      );
    }
    const matrixSlotId = contract.slotIdForIndex(index);
    if (taken.has(matrixSlotId)) {
      throw new Error(`matrixSlotId 重复分配: ${matrixSlotId}（${alias}）`);
    }
    taken.add(matrixSlotId);
    assigned.set(alias, {
      matrixSlotId,
      egressPort: contract.egressPortForIndex(index),
      source: 'auto',
    });
  }

  return aliases.map((alias) => ({ alias, ...assigned.get(alias) }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const state = args.state ? JSON.parse(fs.readFileSync(args.state, 'utf8')) : load();
  const proxy = (state.settings && state.settings.proxy) || {};
  if (proxy.enabled !== true) throw new Error('settings.proxy.enabled is false');

  const aliases = Object.keys(proxy.nodes || {}).sort();
  if (aliases.length === 0) throw new Error('settings.proxy.nodes is empty');

  const basePort = Math.max(
    1024,
    Math.min(65535, Number(args.basePort) || Number(proxy.basePort) || PROXY_DEFAULTS.basePort),
  );
  const size = Math.max(1, Math.min(1000, Number(proxy.size) || PROXY_DEFAULTS.size));
  if (aliases.length > size) throw new Error(`too many nodes: ${aliases.length} > size ${size}`);

  const nodes = aliases.map((alias) => {
    const node = parseNode(proxy.nodes[alias], alias);
    if (!node) throw new Error(`cannot parse node for alias ${alias}`);
    return node;
  });

  const mode = resolveMode({
    standaloneFallback: args.standaloneFallback === true || proxy.standaloneFallback === true,
  });

  if (mode === 'delegated') {
    const plan = planSlots(aliases, proxy);
    const ports = Object.fromEntries(plan.map((entry) => [entry.alias, entry.egressPort]));
    const busUrl = args.busUrl || proxy.egressBusUrl || DEFAULT_EGRESS_BUS_URL;
    const summary = { mode, busUrl, basePort, size, ports, nodes: aliases.length, slots: plan };
    if (args.dryRun) {
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    const delegator = createEgressDelegator({ busUrl, clientId: args.clientId });
    const live = await delegator.listSlots();
    const known = new Map(
      live
        .filter((slot) => slot && contract.indexForSlotId(slot.matrixSlotId))
        .map((slot) => [slot.matrixSlotId, slot]),
    );
    const missing = plan
      .filter((entry) => !known.has(entry.matrixSlotId))
      .map((entry) => entry.matrixSlotId);
    if (missing.length) {
      throw new Error(
        `egress matrix 缺少槽位: ${missing.join(', ')}（先在 19880 分配租约，或加 --standalone-fallback）`,
      );
    }
    for (const entry of plan) {
      entry.healthState = contract.normalizeHealthState(known.get(entry.matrixSlotId).healthState);
      entry.leaseId = String(known.get(entry.matrixSlotId).leaseId || '');
    }
    const blocked = plan.filter((entry) => entry.healthState !== 'ACTIVE');
    console.log(JSON.stringify({ ...summary, verified: true, blocked }, null, 2));
    if (blocked.length) process.exitCode = 3;
    return;
  }

  const ports = aliases.map((alias, index) => Number(proxy.ports && proxy.ports[alias]) || basePort + index);
  const built = buildSingBoxConfig(nodes, { ports, basePort, size, logLevel: args.logLevel });
  const mapping = Object.fromEntries(aliases.map((alias, index) => [alias, ports[index]]));
  if (args.dryRun) {
    console.log(JSON.stringify({ mode, basePort, size, ports: mapping, nodes: aliases.length }, null, 2));
    return;
  }

  const binaryPath = args.bin || resolveSingBoxBin({
    settings: proxy,
    env: process.env,
    extensionRoot: path.resolve(__dirname, '..'),
    sharedPaths: args.shared,
  });
  if (!binaryPath) throw new Error('sing-box binary not found; pass --bin or set SINGBOX_BIN/PROXYGATE_SINGBOX');

  const dataDir = args.dataDir
    ? path.resolve(args.dataDir)
    : path.join(require('node:os').homedir(), '.openchamber-instabox-matrix');
  const supervisor = createSingBoxSupervisor({
    dataDir,
    basePort,
    binaryPath,
    configPath: path.join(dataDir, `singbox-${basePort}.json`),
    stdio: 'ignore',
  });

  const result = await supervisor.start(built.config);
  console.log(JSON.stringify({
    mode,
    owner: result.owner,
    pid: result.pid,
    ports: mapping,
    configPath: supervisor.configPath,
  }, null, 2));
  if (!result.owner) return;

  process.on('SIGINT', async () => {
    await supervisor.stop();
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`singbox-up: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, planSlots, main };
