'use strict';

const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX = 50;
const DEFAULT_RETRY = {
  attempts: 5,
  delayMs: 5000,
  factor: 2,
  maxDelayMs: 5 * 60 * 1000,
};

function errorSummary(error) {
  return {
    message: error && error.message ? error.message : String(error),
    code: error && error.code ? error.code : 'error',
  };
}

function createJobs(options = {}) {
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  const max = options.max || DEFAULT_MAX;
  const now = options.now || (() => Date.now());
  const gate = typeof options.gate === 'function' ? options.gate : null;
  const jobs = new Map();
  const timers = new Map();

  function clearTimer(id) {
    const timer = timers.get(id);
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(id);
  }

  function prune(nowValue) {
    for (const [id, job] of jobs) {
      if (job.status === 'running' || job.status === 'pending') continue;
      const endedAt = job.endedAt ? new Date(job.endedAt).getTime() : new Date(job.startedAt).getTime();
      if (nowValue - endedAt >= ttlMs) {
        clearTimer(id);
        jobs.delete(id);
      }
    }
    while (jobs.size > max) {
      const oldest = jobs.keys().next().value;
      clearTimer(oldest);
      jobs.delete(oldest);
    }
  }

  function get(id) {
    prune(now());
    return jobs.get(id) || null;
  }

  function list() {
    prune(now());
    return Array.from(jobs.values());
  }

  function gc(nowValue) {
    prune(nowValue === undefined ? now() : nowValue);
  }

  function finish(id, payload) {
    const job = jobs.get(id);
    if (!job) return null;
    if (job.status !== 'running' && job.status !== 'pending') return job;
    job.endedAt = new Date().toISOString();
    job.nextAt = null;
    if (payload && payload.error !== undefined) {
      job.status = 'error';
      job.error = errorSummary(payload.error);
    } else {
      job.status = 'done';
      job.result = payload ? payload.result : undefined;
    }
    return job;
  }

  function runAttempt(job, task, retryOptions) {
    clearTimer(job.id);
    job.status = 'running';
    job.attempt = (Number(job.attempt) || 0) + 1;
    job.lastAttemptAt = new Date().toISOString();
    job.nextAt = null;
    Promise.resolve()
      .then(() => (gate ? gate(job) : undefined))
      .then(task)
      .then((result) => finish(job.id, { result }))
      .catch((error) => {
        const current = jobs.get(job.id);
        if (!current || current.status !== 'running') return;
        current.lastError = errorSummary(error);
        if (current.attempt >= retryOptions.attempts) {
          current.retriesExhausted = true;
          finish(job.id, { error });
          return;
        }
        const delay = Math.min(
          retryOptions.maxDelayMs,
          Math.round(retryOptions.delayMs * Math.pow(retryOptions.factor, current.attempt - 1)),
        );
        current.status = 'pending';
        current.nextAt = new Date(now() + delay).toISOString();
        const timer = setTimeout(() => {
          timers.delete(job.id);
          runAttempt(job, task, retryOptions);
        }, delay);
        if (timer.unref) timer.unref();
        timers.set(job.id, timer);
      });
  }

  function start(task, meta) {
    prune(now());
    const job = {
      id: `job_${crypto.randomUUID()}`,
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      meta: meta || {},
    };
    jobs.set(job.id, job);
    Promise.resolve()
      .then(() => (gate ? gate(job) : undefined))
      .then(task)
      .then((result) => finish(job.id, { result }))
      .catch((error) => finish(job.id, { error }));
    return job;
  }

  /*
   * Async retry queue: the first attempt starts after `delayMs`, later attempts
   * back off exponentially. A job stays `pending` between attempts so the TTL
   * prune never drops a retry that is still scheduled.
   */
  function retry(task, meta, retryOptions = {}) {
    prune(now());
    const settings = {
      attempts: Math.max(1, Math.round(Number(retryOptions.attempts) || DEFAULT_RETRY.attempts)),
      delayMs: Math.max(0, Number(retryOptions.delayMs === undefined ? DEFAULT_RETRY.delayMs : retryOptions.delayMs)),
      factor: Math.max(1, Number(retryOptions.factor) || DEFAULT_RETRY.factor),
      maxDelayMs: Math.max(0, Number(retryOptions.maxDelayMs) || DEFAULT_RETRY.maxDelayMs),
    };
    const job = {
      id: `job_${crypto.randomUUID()}`,
      status: 'pending',
      startedAt: new Date().toISOString(),
      endedAt: null,
      attempt: 0,
      maxAttempts: settings.attempts,
      nextAt: new Date(now() + settings.delayMs).toISOString(),
      meta: meta || {},
    };
    jobs.set(job.id, job);
    const timer = setTimeout(() => {
      timers.delete(job.id);
      runAttempt(job, task, settings);
    }, settings.delayMs);
    if (timer.unref) timer.unref();
    timers.set(job.id, timer);
    return job;
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return null;
    clearTimer(id);
    if (job.status === 'running' || job.status === 'pending') {
      job.status = 'cancelled';
      job.endedAt = new Date().toISOString();
      job.nextAt = null;
    }
    return job;
  }

  return { start, finish, retry, cancel, get, list, gc };
}

module.exports = { createJobs, DEFAULT_TTL_MS, DEFAULT_MAX, DEFAULT_RETRY };
