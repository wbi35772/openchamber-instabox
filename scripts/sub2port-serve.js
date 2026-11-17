'use strict';

/*
 * Dev CLI: raw subscription -> matrix slots.
 *
 * Default mode is DELEGATED: the egress matrix owns 24001-24250, so this CLI
 * only plans one contract slot per parsed node and verifies them against the
 * bus at `127.0.0.1:19880`. It prints `ready ports=...` and exits.
 *
 *   node scripts/sub2port-serve.js <subscription-file> [--base-port 24001]
 *        [--size 250] [--bus URL] [--client-id ID] [--start-index N]
 *        [--dry-run] [--standalone-fallback] [--bin PATH] [--data-dir DIR]
 *
 * `--standalone-fallback` keeps the old behaviour: build a sing-box config and
 * spawn one supervised child that owns the port range.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const contract = require('../core/contract');
const {
  parseSubscription,
  buildSingBoxConfig,
  resolveSingBoxBin,
  createSingBoxSupervisor,
  resolveMode,
  createEgressDelegator,
  DEFAULT_EGRESS_BUS_URL,
} = require('../lib/sub2port');

function parseArgs(argv) {
  const out = {
    file: '',
    basePort: 24001,
    size: 250,
    bin: '',
    dataDir: '',
    logLevel: 'warn',
    busUrl: '',
    clientId: '',
    startIndex: contract.SLOT_MIN_INDEX,
    standaloneFallback: false,
    dryRun: false,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-port') out.basePort = Number(argv[++i]);
    else if (arg === '--size') out.size = Number(argv[++i]);
    else if (arg === '--bin') out.bin = argv[++i];
    else if (arg === '--data-dir') out.dataDir = argv[++i];
    else if (arg === '--log-level') out.logLevel = argv[++i];
    else if (arg === '--bus') out.busUrl = argv[++i];
    else if (arg === '--client-id') out.clientId = argv[++i];
    else if (arg === '--start-index') out.startIndex = Number(argv[++i]) || contract.SLOT_MIN_INDEX;
    else if (arg === '--standalone-fallback') out.standaloneFallback = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else rest.push(arg);
  }
  out.file = rest[0] || '';
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error(
      'usage: node scripts/sub2port-serve.js <subscription-file> [--base-port N] [--size N] '
      + '[--bus URL] [--start-index N] [--dry-run] [--standalone-fallback] [--bin PATH] [--data-dir DIR]',
    );
    process.exitCode = 2;
    return;
  }
  const raw = fs.readFileSync(args.file, 'utf8');
  const nodes = parseSubscription(raw);
  if (nodes.length === 0) throw new Error('no nodes parsed from subscription');

  const mode = resolveMode({ standaloneFallback: args.standaloneFallback === true });
  if (mode === 'delegated') {
    const busUrl = args.busUrl || DEFAULT_EGRESS_BUS_URL;
    const delegator = createEgressDelegator({ busUrl, clientId: args.clientId });
    const plan = delegator.plan(nodes, { startIndex: args.startIndex });
    const ports = plan.slots.map((slot) => slot.egressPort);
    if (args.dryRun) {
      console.log(JSON.stringify({
        mode,
        busUrl,
        startIndex: args.startIndex,
        ports,
        slots: plan.slots.map((slot) => ({
          matrixSlotId: slot.matrixSlotId,
          egressPort: slot.egressPort,
          nodeTag: slot.nodeTag,
        })),
        nodes: nodes.length,
      }, null, 2));
      return;
    }
    const live = await delegator.listSlots();
    const known = new Map(
      live
        .filter((slot) => slot && contract.indexForSlotId(slot.matrixSlotId))
        .map((slot) => [slot.matrixSlotId, slot]),
    );
    const missing = plan.slots.filter((slot) => !known.has(slot.matrixSlotId)).map((slot) => slot.matrixSlotId);
    if (missing.length) {
      throw new Error(
        `egress matrix 缺少槽位: ${missing.join(', ')}（先在 19880 分配租约，或加 --standalone-fallback）`,
      );
    }
    const blocked = plan.slots
      .map((slot) => ({
        matrixSlotId: slot.matrixSlotId,
        healthState: contract.normalizeHealthState(known.get(slot.matrixSlotId).healthState),
      }))
      .filter((slot) => slot.healthState !== 'ACTIVE');
    console.log(`delegated to ${busUrl}`);
    for (const slot of plan.slots) {
      console.log(`plan ${slot.matrixSlotId}:${slot.egressPort} <- ${slot.nodeTag}`);
    }
    console.log(`ready ports=${ports.join(',')} (owned by egress matrix)`);
    if (blocked.length) {
      console.error(`blocked slots: ${blocked.map((slot) => `${slot.matrixSlotId}=${slot.healthState}`).join(', ')}`);
      process.exitCode = 3;
    }
    return;
  }

  const built = buildSingBoxConfig(nodes, {
    basePort: args.basePort,
    size: args.size,
    logLevel: args.logLevel,
  });
  if (args.dryRun) {
    console.log(JSON.stringify({
      mode,
      basePort: args.basePort,
      size: args.size,
      ports: built.slots.map((slot) => slot.port),
      nodes: nodes.length,
    }, null, 2));
    return;
  }

  const binaryPath = args.bin || resolveSingBoxBin({
    settings: {},
    sharedPaths: [
      path.resolve(__dirname, '..', '..', 'proxygate-matrix', 'proxygate-nodes', 'shardx', process.platform === 'win32' ? 'sing-box.exe' : 'sing-box'),
    ],
  });
  if (!binaryPath) throw new Error('sing-box binary not found; pass --bin or set SINGBOX_BIN');
  if (!fs.existsSync(binaryPath)) throw new Error(`sing-box binary missing: ${binaryPath}`);

  const dataDir = args.dataDir || path.join(os.homedir(), '.openchamber-instabox-matrix');
  const supervisor = createSingBoxSupervisor({
    dataDir,
    basePort: args.basePort,
    binaryPath,
    stdio: 'inherit',
  });

  const started = await supervisor.start(built.config);
  if (!started.owner) {
    console.log(`owner exists for base port ${args.basePort}; reusing it`);
    console.log(`ready ports=${built.slots.map((slot) => slot.port).join(',')}`);
  } else {
    console.log(`sing-box pid=${started.pid} config=${supervisor.configPath}`);
    console.log(`ready ports=${built.slots.map((slot) => slot.port).join(',')}`);
  }

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`stopping on ${signal}`);
    await supervisor.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('sub2port-serve failed:', error && error.message ? error.message : error);
    process.exit(1);
  });
}

module.exports = { parseArgs, main };
