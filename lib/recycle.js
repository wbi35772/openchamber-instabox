'use strict';

const MIN_LEAD_MINUTES = 10;
const MAX_LEAD_MINUTES = 30;
const COOLDOWN_GUARD_MS = 60 * 1000;
const BUSY_STATUSES = new Set(['suspending', 'suspended', 'resuming', 'verifying', 'bootstrapping']);
const DEFAULT_TIMEOUTS = {
  suspendTimeoutMs: 90000,
  resumeTimeoutMs: 120000,
  execReadyTimeoutMs: 90000,
  verifyTimeoutMs: 180000,
  bootstrapTimeoutSeconds: 300,
  pollMs: 5000,
  totalTimeoutMs: 900000,
};

function leadMsFor(maxRunMinutes, overrideMinutes) {
  if (overrideMinutes !== null && overrideMinutes !== undefined && overrideMinutes !== '') {
    const override = Number(overrideMinutes);
    if (Number.isFinite(override) && override >= 0) return Math.round(override * 60000);
  }
  const maxRun = Number(maxRunMinutes);
  if (!Number.isFinite(maxRun) || maxRun <= 0) return MIN_LEAD_MINUTES * 60000;
  const minutes = Math.min(MAX_LEAD_MINUTES, Math.max(MIN_LEAD_MINUTES, Math.round(maxRun * 0.1)));
  return minutes * 60000;
}

function nextRecycleAt({ runStartedAt, maxRunMinutes, leadMinutes }) {
  const started = Date.parse(runStartedAt);
  const maxRun = Number(maxRunMinutes);
  if (!Number.isFinite(started) || !Number.isFinite(maxRun) || maxRun <= 0) return null;
  return started + maxRun * 60000 - leadMsFor(maxRunMinutes, leadMinutes);
}

function planRecycle({ machine, config = {}, status = {}, now = Date.now() }) {
  const leadMs = leadMsFor(machine && machine.maxRunMinutes, config.leadMinutes);
  const nextAt = machine
    ? nextRecycleAt({ runStartedAt: machine.runStartedAt, maxRunMinutes: machine.maxRunMinutes, leadMinutes: config.leadMinutes })
    : null;

  const result = (due, reason) => ({ due, reason, leadMs, nextAt });

  if (config.enabled !== true) return result(false, 'disabled');
  if (config.machineEnabled === false) return result(false, 'machine_disabled');
  if (!String(config.verifyCommand || '').trim()) return result(false, 'not_configured');
  if (status.status === 'degraded') return result(false, 'degraded');
  if (status.status === 'race_cooldown') return result(false, 'race_cooldown');
  if (!machine || machine.state !== 'running') return result(false, 'not_running');

  const started = Date.parse(machine.runStartedAt);
  if (!Number.isFinite(started) || started > now + COOLDOWN_GUARD_MS) {
    return result(false, 'invalid_run_start');
  }

  const cooldownUntil = Date.parse(machine.cooldownUntil);
  if (Number.isFinite(cooldownUntil) && cooldownUntil > now + COOLDOWN_GUARD_MS) {
    return result(false, 'cooldown');
  }

  const maxRun = Number(machine.maxRunMinutes);
  if (!Number.isFinite(maxRun) || maxRun <= 0) return result(false, 'invalid_max_run');

  const minUptime = Number(config.minUptimeMinutes);
  const uptimeFloorMs = (Number.isFinite(minUptime) && minUptime > 0 ? minUptime : 60) * 60000;
  if (now - started < uptimeFloorMs) return result(false, 'uptime_low');

  if (status.lastRunStartedAt && Date.parse(status.lastRunStartedAt) === started) {
    return result(false, 'already_recycled');
  }

  if (nextAt !== null && now < nextAt) return result(false, 'not_due');
  return result(true, 'due');
}

function pickMachine(machines, id) {
  const list = Array.isArray(machines) ? machines : [];
  return list.find((machine) => machine && machine.id === id) || null;
}

function sleepFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function tailText(value, limit = 1024) {
  const text = String(value === undefined || value === null ? '' : value);
  return text.length > limit ? text.slice(-limit) : text;
}

function execOk(result) {
  return Boolean(result) && Number(result.exitCode) === 0;
}

async function waitFor(check, options = {}) {
  const now = options.now || Date.now;
  const sleep = options.sleep || sleepFor;
  const pollMs = Math.max(0, Number(options.pollMs) || 0);
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, pollMs)) + 2);
  const started = now();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const value = await check();
    if (value) return value;
    const elapsed = now() - started;
    if (elapsed >= timeoutMs) return null;
    await sleep(pollMs);
  }
  return null;
}

function report(status, machine, extra = {}) {
  return { status, machine: machine || null, ...extra };
}

async function safeList(direct) {
  try {
    return await direct.listMachines();
  } catch {
    return [];
  }
}

async function verifyVia(proxy, id, command, timeoutMs) {
  try {
    return await proxy.exec(id, command, {
      timeoutSeconds: Math.max(1, Math.ceil(Number(timeoutMs) / 1000)),
    });
  } catch (error) {
    return { exitCode: -1, stdout: '', stderr: error && error.message ? error.message : String(error) };
  }
}

async function runRecycle(options = {}) {
  const {
    account = '',
    machine: initialMachine,
    config = {},
    status = {},
    direct,
    proxy,
    now = Date.now,
    log = () => {},
    timeouts = {},
    idempotencyBase,
    snapshotFirst,
  } = options;

  if (!direct || !proxy) throw new Error('runRecycle requires direct and proxy clients');
  if (!initialMachine || !initialMachine.id) return report('invalid_machine', null, { error: 'machine required' });
  if (config.enabled === false || config.machineEnabled === false) return report('disabled', initialMachine);

  const verifyCommand = String(config.verifyCommand || '').trim();
  if (!verifyCommand) return report('not_configured', initialMachine);

  const budget = { ...DEFAULT_TIMEOUTS, ...(timeouts || {}) };
  const started = now();
  const id = initialMachine.id;
  const remaining = () => Math.max(1, Number(budget.totalTimeoutMs) - (now() - started));

  const before = pickMachine(await safeList(direct), id) || initialMachine;
  if (initialMachine.state && before.state && before.state !== initialMachine.state) {
    return report('state_changed', before, { error: 'machine state changed before recycle' });
  }
  if (
    initialMachine.runStartedAt &&
    before.runStartedAt &&
    before.runStartedAt !== initialMachine.runStartedAt
  ) {
    return report('state_changed', before, { error: 'runStartedAt changed before recycle' });
  }

  const baseline = await verifyVia(proxy, id, verifyCommand, budget.verifyTimeoutMs);
  if (!execOk(baseline)) {
    log(`recycle baseline failed ${account}/${id}: ${tailText(baseline.stderr, 200)}`);
    let bootstrapped = false;
    const bootstrapCommand = String(config.bootstrapCommand || '').trim();
    if (bootstrapCommand) {
      const result = await verifyVia(proxy, id, bootstrapCommand, Number(budget.bootstrapTimeoutSeconds) * 1000);
      bootstrapped = execOk(result);
    }
    return report('degraded', before, {
      error: 'baseline_failed',
      bootstrapped,
      verified: false,
      result: { exitCode: baseline.exitCode, stderrTail: tailText(baseline.stderr) },
    });
  }

  if ((snapshotFirst === true || config.snapshotBeforeFirst === true) && typeof direct.snapshot === 'function') {
    try {
      await direct.snapshot(id);
    } catch (error) {
      log(`recycle snapshot skipped ${account}/${id}: ${error.message}`);
    }
  }

  const keyBase = idempotencyBase || `${account}/${id}/${before.runStartedAt || 'unknown'}`;

  let suspendError = null;
  try {
    await direct.power(id, 'suspend', { idempotencyKey: `${keyBase}/suspend` });
  } catch (error) {
    suspendError = error;
  }

  const paused = await waitFor(async () => {
    const current = pickMachine(await safeList(direct), id);
    if (!current) return null;
    return current.state === 'suspended' || current.state === 'paused' ? current : null;
  }, {
    now,
    pollMs: budget.pollMs,
    timeoutMs: Math.min(Number(budget.suspendTimeoutMs), remaining()),
  });

  if (!paused) {
    const current = pickMachine(await safeList(direct), id) || before;
    if (current.state === 'suspended' || current.state === 'paused') {
      return checkPaused(current, now, account, id, log);
    }
    return report('failed', current, {
      error: suspendError ? `suspend_failed: ${suspendError.message}` : 'suspend_timeout',
    });
  }

  const race = checkPaused(paused, now, account, id, log);
  if (race) return race;

  let resumeError = null;
  try {
    await direct.power(id, 'resume', { idempotencyKey: `${keyBase}/resume` });
  } catch (error) {
    if (error && (error.status === 409 || error.code === 'machine_cooldown')) {
      return report('race_cooldown', paused, { error: error.message, nextAt: paused.cooldownUntil || null });
    }
    resumeError = error;
  }

  const running = await waitFor(async () => {
    const current = pickMachine(await safeList(direct), id);
    return current && current.state === 'running' ? current : null;
  }, {
    now,
    pollMs: budget.pollMs,
    timeoutMs: Math.min(Number(budget.resumeTimeoutMs), remaining()),
  });

  if (!running) {
    const current = pickMachine(await safeList(direct), id) || paused;
    return report('degraded', current, {
      resumed: false,
      error: resumeError ? `resume_failed: ${resumeError.message}` : 'resume_timeout',
    });
  }

  let verification = await verifyVia(proxy, id, verifyCommand, budget.verifyTimeoutMs);
  let verified = execOk(verification);
  let bootstrapped = false;
  const bootstrapCommand = String(config.bootstrapCommand || '').trim();
  if (!verified && bootstrapCommand) {
    const result = await verifyVia(proxy, id, bootstrapCommand, Number(budget.bootstrapTimeoutSeconds) * 1000);
    bootstrapped = execOk(result);
    verification = await verifyVia(proxy, id, verifyCommand, budget.verifyTimeoutMs);
    verified = execOk(verification);
  }

  if (!verified) {
    return report('degraded', running, {
      resumed: true,
      verified: false,
      bootstrapped,
      error: 'verify_failed',
      consecutiveFailures: (Number(status.consecutiveFailures) || 0) + 1,
      result: { exitCode: verification.exitCode, stderrTail: tailText(verification.stderr) },
    });
  }

  return report('idle', running, {
    resumed: true,
    verified: true,
    nextAt: running.runStartedAt || null,
    result: { exitCode: verification.exitCode, stderrTail: tailText(verification.stderr) },
  });
}

function checkPaused(machine, now, account, id, log) {
  const cooldownUntil = Date.parse(machine.cooldownUntil);
  if (Number.isFinite(cooldownUntil) && cooldownUntil > now() + COOLDOWN_GUARD_MS) {
    log(`recycle race_cooldown ${account}/${id}: platform paused before resume`);
    return report('race_cooldown', machine, {
      error: 'platform_cooldown',
      nextAt: machine.cooldownUntil || null,
    });
  }
  return null;
}

async function reconcileMachine(options = {}) {
  const {
    account = '',
    machineId,
    status = {},
    config = {},
    direct,
    proxy,
    now = Date.now,
    log = () => {},
    timeouts = {},
  } = options;

  if (!direct || !machineId) return report('invalid_machine', null, { error: 'machine required' });
  const budget = { ...DEFAULT_TIMEOUTS, ...(timeouts || {}) };
  const machine = pickMachine(await safeList(direct), machineId);
  if (!machine) return report('degraded', null, { error: 'machine_not_found' });

  const verifyCommand = String(config.verifyCommand || '').trim();

  if (machine.state === 'running') {
    if (!verifyCommand || !proxy) return report('idle', machine, { verified: false });
    const verification = await verifyVia(proxy, machineId, verifyCommand, budget.verifyTimeoutMs);
    return execOk(verification)
      ? report('idle', machine, { verified: true })
      : report('degraded', machine, {
        verified: false,
        error: 'verify_failed',
        consecutiveFailures: (Number(status.consecutiveFailures) || 0) + 1,
      });
  }

  if (machine.state !== 'suspended' && machine.state !== 'paused') {
    return report(status.status || 'suspending', machine, {
      nextAt: new Date(now() + 120000).toISOString(),
    });
  }

  const cooldownUntil = Date.parse(machine.cooldownUntil);
  if (Number.isFinite(cooldownUntil) && cooldownUntil > now() + COOLDOWN_GUARD_MS) {
    return report('race_cooldown', machine, { nextAt: machine.cooldownUntil || null });
  }

  const keyBase = `${account}/${machineId}/${status.lastAttemptRunStartedAt || status.lastRunStartedAt || 'recover'}`;
  try {
    await direct.power(machineId, 'resume', { idempotencyKey: `${keyBase}/resume` });
  } catch (error) {
    if (error && (error.status === 409 || error.code === 'machine_cooldown')) {
      return report('race_cooldown', machine, { error: error.message });
    }
    return report('degraded', machine, { error: `resume_failed: ${error.message}` });
  }

  const running = await waitFor(async () => {
    const current = pickMachine(await safeList(direct), machineId);
    return current && current.state === 'running' ? current : null;
  }, {
    now,
    pollMs: budget.pollMs,
    timeoutMs: Number(budget.resumeTimeoutMs),
  });

  if (!running) return report('degraded', machine, { error: 'resume_timeout' });
  if (!verifyCommand || !proxy) return report('idle', running, { resumed: true, verified: false });

  const verification = await verifyVia(proxy, machineId, verifyCommand, budget.verifyTimeoutMs);
  return execOk(verification)
    ? report('idle', running, { resumed: true, verified: true })
    : report('degraded', running, {
      resumed: true,
      verified: false,
      error: 'verify_failed',
      consecutiveFailures: (Number(status.consecutiveFailures) || 0) + 1,
    });
}

function createRecycler(options = {}) {
  const getState = options.getState || (() => ({ settings: {}, recycle: [] }));
  const saveStatus = options.saveStatus || (() => {});
  const directClientFor = options.directClientFor || (() => null);
  const proxyClientFor = options.proxyClientFor || (() => null);
  const lockPath = options.lockPath || '';
  const now = options.now || Date.now;
  const log = options.log || (() => {});
  const inFlight = new Set();

  function stateNow() {
    return getState() || { settings: {}, recycle: [] };
  }

  function isBusy(account, machineId) {
    const state = stateNow();
    const entry = (state.recycle || []).find(
      (item) => item.account === account && item.machineId === machineId,
    );
    return Boolean(entry && BUSY_STATUSES.has(entry.status));
  }

  async function persist(patch) {
    if (typeof saveStatus !== 'function') return;
    await saveStatus({ ...patch, updatedAt: patch.updatedAt || new Date(now()).toISOString() });
  }

  async function execute(account, machine, config, statusEntry, opts = {}) {
    const key = `${account}/${machine.id}`;
    if (inFlight.has(key)) return report('busy', machine);
    const direct = directClientFor(account);
    const proxy = proxyClientFor(account);
    if (!direct || !proxy) return report('failed', machine, { error: 'client_unavailable' });
    inFlight.add(key);
    try {
      const outcome = await runRecycle({
        account,
        machine,
        config,
        status: statusEntry,
        direct,
        proxy,
        now,
        log,
        timeouts: opts.timeouts,
        idempotencyBase: `${account}/${machine.id}/${machine.runStartedAt || 'unknown'}`,
        snapshotFirst: opts.snapshotFirst,
      });
      const patch = {
        account,
        machineId: machine.id,
        machineName: machine.name || '',
        status: outcome.status,
        lastError: outcome.error || null,
        nextAt: outcome.nextAt || null,
      };
      if (outcome.status === 'idle') {
        patch.lastRecycleAt = new Date(now()).toISOString();
        patch.lastRunStartedAt = (outcome.machine && outcome.machine.runStartedAt) || null;
        patch.consecutiveFailures = 0;
        patch.lastResult = {
          at: new Date(now()).toISOString(),
          ok: true,
          exitCode: outcome.result ? outcome.result.exitCode : 0,
          summary: 'verify ok',
        };
      } else if (outcome.status === 'degraded' || outcome.status === 'failed') {
        patch.consecutiveFailures = outcome.consecutiveFailures
          || ((Number(statusEntry.consecutiveFailures) || 0) + 1);
        patch.lastResult = {
          at: new Date(now()).toISOString(),
          ok: false,
          exitCode: outcome.result ? outcome.result.exitCode : null,
          summary: outcome.error || outcome.status,
          stderrTail: outcome.result ? outcome.result.stderrTail : '',
        };
      }
      await persist(patch);
      return outcome;
    } finally {
      inFlight.delete(key);
    }
  }

  async function reconcileStale(settings) {
    const state = stateNow();
    const staleMs = 2 * 60 * 1000;
    for (const entry of state.recycle || []) {
      if (!entry || !BUSY_STATUSES.has(entry.status)) continue;
      const updated = Date.parse(entry.updatedAt);
      if (Number.isFinite(updated) && now() - updated < staleMs) continue;
      const config = (settings.machines || {})[`${entry.account}/${entry.machineId}`];
      if (!config) continue;
      const direct = directClientFor(entry.account);
      const proxy = proxyClientFor(entry.account);
      if (!direct) continue;
      try {
        const outcome = await reconcileMachine({
          account: entry.account,
          machineId: entry.machineId,
          status: entry,
          config: { ...settings, ...config },
          direct,
          proxy,
          now,
          log,
        });
        await persist({
          account: entry.account,
          machineId: entry.machineId,
          status: outcome.status,
          lastError: outcome.error || null,
          nextAt: outcome.nextAt || null,
        });
      } catch (error) {
        await persist({
          account: entry.account,
          machineId: entry.machineId,
          status: 'degraded',
          lastError: error.message,
        });
      }
    }
  }

  async function tick(opts = {}) {
    const state = stateNow();
    const settings = (state.settings && state.settings.recycle) || {};
    const dryRun = opts.dryRun === true;
    const results = [];
    if (settings.enabled !== true && opts.force !== true) return { ok: true, results };

    const selected = Object.values(settings.machines || {}).filter((config) => {
      if (!config || !config.account || !config.machineId) return false;
      if (opts.account && config.account !== opts.account) return false;
      if (opts.machineId && config.machineId !== opts.machineId) return false;
      return true;
    });
    if (!selected.length) return { ok: true, results };

    let lock = null;
    if (!dryRun && lockPath) {
      const { acquireOwnedLock } = require('./store-lock');
      try {
        lock = await acquireOwnedLock(lockPath, {
          staleMs: Number(settings.lockStaleMs) || 1200000,
          heartbeatMs: 10000,
        });
      } catch (error) {
        return { ok: false, error: `lock busy: ${error.message}`, results };
      }
    }

    try {
      if (!dryRun) await reconcileStale(settings);
      for (const config of selected) {
        const account = config.account;
        const latest = stateNow();
        const statusEntry = (latest.recycle || []).find(
          (entry) => entry.account === account && entry.machineId === config.machineId,
        ) || {};
        const direct = directClientFor(account);
        if (!direct) {
          results.push({ account, machineId: config.machineId, reason: 'not_running', status: 'dry_run' });
          continue;
        }
        let machines = [];
        try {
          machines = await direct.listMachines();
        } catch (error) {
          results.push({ account, machineId: config.machineId, reason: 'list_failed', status: 'error', error: error.message });
          continue;
        }
        const machine = pickMachine(machines, config.machineId);
        const planConfig = { ...settings, ...config, leadMinutes: settings.leadMinutes };
        const plan = planRecycle({ machine, config: planConfig, status: statusEntry, now: now() });

        if (dryRun) {
          results.push({
            account,
            machineId: config.machineId,
            reason: plan.reason,
            status: 'dry_run',
            nextAt: plan.nextAt ? new Date(plan.nextAt).toISOString() : null,
          });
          continue;
        }

        if (!plan.due && opts.force !== true) {
          results.push({
            account,
            machineId: config.machineId,
            reason: plan.reason,
            status: statusEntry.status || 'idle',
            nextAt: plan.nextAt ? new Date(plan.nextAt).toISOString() : null,
          });
          await persist({
            account,
            machineId: config.machineId,
            machineName: machine && machine.name ? machine.name : '',
            status: statusEntry.status || 'idle',
            nextAt: plan.nextAt ? new Date(plan.nextAt).toISOString() : null,
          });
          continue;
        }

        const outcome = await execute(account, machine, planConfig, statusEntry, {
          snapshotFirst: config.snapshotBeforeFirst === true,
        });
        results.push({
          account,
          machineId: config.machineId,
          reason: outcome.status,
          status: outcome.status,
          error: outcome.error || null,
        });
      }
    } finally {
      if (lock && typeof lock.release === 'function') {
        try { lock.release(); } catch { /* ignore */ }
      }
    }

    return {
      ok: results.every((item) => item.status !== 'failed' && item.status !== 'degraded'),
      results,
    };
  }

  async function runNow(account, machineId, opts = {}) {
    const state = stateNow();
    const settings = (state.settings && state.settings.recycle) || {};
    const config = (settings.machines || {})[`${account}/${machineId}`];
    if (!config) return report('not_configured', null, { error: 'machine not configured' });
    if (config.enabled === false) return report('disabled', null);
    const direct = directClientFor(account);
    if (!direct) return report('failed', null, { error: 'client_unavailable' });
    const proxy = proxyClientFor(account);
    const machines = await direct.listMachines();
    const machine = pickMachine(machines, machineId);
    if (!machine) return report('not_running', null, { error: 'machine not found' });
    const statusEntry = (state.recycle || []).find(
      (entry) => entry.account === account && entry.machineId === machineId,
    ) || {};
    return execute(account, machine, { ...settings, ...config }, statusEntry, {
      snapshotFirst: config.snapshotBeforeFirst === true,
      timeouts: opts.timeouts,
    });
  }

  function status() {
    return stateNow().recycle || [];
  }

  return { tick, runNow, isBusy, status };
}

function buildRecycleView(state, now = Date.now()) {
  const settings = (state && state.settings && state.settings.recycle) || {};
  const statuses = Array.isArray(state && state.recycle) ? state.recycle : [];
  const machines = Object.values(settings.machines || {})
    .filter((config) => config && config.account && config.machineId)
    .sort((a, b) => `${a.account}/${a.machineId}`.localeCompare(`${b.account}/${b.machineId}`))
    .map((config) => {
      const status = statuses.find(
        (entry) => entry.account === config.account && entry.machineId === config.machineId,
      ) || null;
      return {
        account: config.account,
        machineId: config.machineId,
        enabled: config.enabled !== false,
        verifyCommand: config.verifyCommand || '',
        bootstrapCommand: config.bootstrapCommand || '',
        snapshotBeforeFirst: config.snapshotBeforeFirst === true,
        proxyExitExpect: config.proxyExitExpect || '',
        status: status
          ? { ...status }
          : { account: config.account, machineId: config.machineId, status: 'idle', nextAt: null },
      };
    });
  return {
    enabled: settings.enabled === true,
    leadMinutes: settings.leadMinutes === undefined ? null : settings.leadMinutes,
    minUptimeMinutes: settings.minUptimeMinutes,
    pollMinutes: settings.pollMinutes,
    verifyTimeoutMs: settings.verifyTimeoutMs,
    bootstrapTimeoutSeconds: settings.bootstrapTimeoutSeconds,
    machines,
  };
}

module.exports = {
  leadMsFor,
  nextRecycleAt,
  planRecycle,
  buildRecycleView,
  runRecycle,
  reconcileMachine,
  createRecycler,
  BUSY_STATUSES,
  DEFAULT_TIMEOUTS,
};
