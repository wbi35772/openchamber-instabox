#!/usr/bin/env node
'use strict';

const path = require('node:path');
const store = require(path.join(__dirname, '..', 'lib', 'store.js'));
const { InstaboxClient } = require(path.join(__dirname, '..', 'lib', 'instabox.js'));
const { createAccountProxy } = require(path.join(__dirname, '..', 'lib', 'account-proxy.js'));
const { createKeepalive } = require(path.join(__dirname, '..', 'lib', 'keepalive.js'));

function log(line) {
  process.stdout.write(new Date().toISOString() + ' ' + line + '\n');
}

function proxyRequired(state) {
  return Boolean(state.settings && state.settings.proxy && state.settings.proxy.enabled === true);
}

const proxies = createAccountProxy({ getState: () => store.load(), log });

function clientFor(alias) {
  const state = store.load();
  const account = store.findAccount(state, alias);
  if (!account) throw new Error(`unknown account: ${alias}`);
  const fetchImpl = proxyRequired(state) ? proxies.requireFetchFor(alias) : undefined;
  return InstaboxClient.fromAccount(account, state.settings, { fetchImpl });
}

(async () => {
  const keepalive = createKeepalive({ log, clientFor });
  const patches = await keepalive.tick();
  for (const { entry, patch } of patches) {
    log(
      'tick ' + entry.account + '/' + entry.machineId +
      ' action=' + (patch.lastWakeAction || '-') +
      ' ok=' + patch.lastOk +
      ' retryAt=' + (patch.retryAt || '-') +
      (patch.lastError ? ' error=' + patch.lastError : ''),
    );
  }
  proxies.closeAll();
  process.exit(0);
})().catch((error) => {
  log('tick crashed: ' + ((error && error.stack) || error));
  proxies.closeAll();
  process.exit(1);
});
