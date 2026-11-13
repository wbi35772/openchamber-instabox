#!/usr/bin/env node
'use strict';

/*
 * Recycle CLI: one pass over configured machines.
 *
 *   node scripts/recycle.js --once [--dry-run] [--force] [--account A] [--machine ID]
 *
 * Prints one JSON line and appends it to <DATA_DIR>/recycle.log.
 * Exit codes: 0 ok, 1 execution failed, 2 recycle settings missing.
 */

const fs = require('node:fs');
const path = require('node:path');

const store = require('../lib/store');
const { InstaboxClient } = require('../lib/instabox');
const { createAccountProxy } = require('../lib/account-proxy');
const { createRecycler } = require('../lib/recycle');

function parseArgs(argv) {
  const options = { dryRun: false, force: false, account: '', machineId: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once') continue;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--account') {
      if (!argv[i + 1]) throw new Error('--account needs a value');
      options.account = argv[++i];
    } else if (arg === '--machine') {
      if (!argv[i + 1]) throw new Error('--machine needs a value');
      options.machineId = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function log(message) {
  process.stderr.write(`[recycle ${new Date().toISOString()}] ${message}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('usage: node scripts/recycle.js --once [--dry-run] [--force] [--account A] [--machine ID]\n');
    return 0;
  }

  const state = store.load();
  let configured = false;
  try {
    const raw = JSON.parse(fs.readFileSync(store.STORE_FILE, 'utf8'));
    configured = Boolean(raw && raw.settings && raw.settings.recycle);
  } catch {
    configured = false;
  }
  if (!configured) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'recycle_not_configured', results: [] })}\n`);
    return 2;
  }

  const proxies = createAccountProxy({ getState: () => store.load(), log });

  function clientFor(alias) {
    const current = store.load();
    const account = store.findAccount(current, alias);
    if (!account) return null;
    return InstaboxClient.fromAccount(account, current.settings, {});
  }

  function proxiedClientFor(alias) {
    const current = store.load();
    const account = store.findAccount(current, alias);
    if (!account) return null;
    const fetchImpl = proxies.fetchFor(alias);
    return InstaboxClient.fromAccount(account, current.settings, { fetchImpl });
  }

  async function saveStatus(patch) {
    await store.update((draft) => {
      store.upsertRecycleStatus(draft, patch);
      return true;
    });
  }

  const recycler = createRecycler({
    getState: () => store.load(),
    saveStatus,
    directClientFor: clientFor,
    proxyClientFor: proxiedClientFor,
    lockPath: path.join(store.DATA_DIR, 'recycle.lock'),
    log,
  });

  return recycler
    .tick({
      dryRun: options.dryRun,
      force: options.force,
      account: options.account || undefined,
      machineId: options.machineId || undefined,
    })
    .then((result) => {
      const line = JSON.stringify({ at: new Date().toISOString(), ...result });
      process.stdout.write(`${line}\n`);
      if (!options.dryRun) {
        try {
          store.ensureDir();
          fs.appendFileSync(path.join(store.DATA_DIR, 'recycle.log'), `${line}\n`);
        } catch (error) {
          log(`recycle.log append failed: ${error.message}`);
        }
      }
      return result.ok ? 0 : 1;
    })
    .catch((error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error.message, results: [] })}\n`);
      return 1;
    });
}

Promise.resolve()
  .then(main)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    log(error.message);
    process.exitCode = 1;
  });
