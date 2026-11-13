'use strict';

const MIN_LEAD_MINUTES = 10;
const MAX_LEAD_MINUTES = 30;
const COOLDOWN_GUARD_MS = 60 * 1000;

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

module.exports = { leadMsFor, nextRecycleAt, planRecycle };
