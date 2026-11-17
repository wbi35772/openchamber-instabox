'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createJobs } = require('../lib/jobs');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('start returns running immediately and completes later', async () => {
  const jobs = createJobs();
  const started = jobs.start(() => delay(120).then(() => ({ stdout: 'ok' })));
  assert.equal(started.status, 'running');
  assert.ok(started.id);
  assert.equal(jobs.get(started.id).status, 'running');
  await delay(180);
  const done = jobs.get(started.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result, { stdout: 'ok' });
  assert.ok(done.endedAt);
});

test('a rejected task is recorded as error status', async () => {
  const jobs = createJobs();
  const started = jobs.start(async () => { throw new Error('boom'); });
  await delay(20);
  const done = jobs.get(started.id);
  assert.equal(done.status, 'error');
  assert.match(done.error.message, /boom/);
});

test('gc expires old jobs and keeps recent ones', async () => {
  const jobs = createJobs({ ttlMs: 50, max: 2 });
  const a = jobs.start(async () => 1);
  const b = jobs.start(async () => 2);
  await delay(80);
  const c = jobs.start(async () => 3);
  await delay(10);
  jobs.gc();
  assert.equal(jobs.get(a.id), null);
  assert.equal(jobs.get(b.id), null);
  assert.deepEqual(jobs.list().map((job) => job.id), [c.id]);
});

test('gc enforces the max cap', async () => {
  const jobs = createJobs({ ttlMs: 60000, max: 2 });
  const created = ['a', 'b', 'c', 'd'].map((tag) => jobs.start(async () => tag));
  await delay(10);
  jobs.gc();
  assert.equal(jobs.list().length, 2);
  assert.deepEqual(jobs.list().map((job) => job.id), created.slice(-2).map((job) => job.id));
});

test('unknown job ids return null', () => {
  const jobs = createJobs();
  assert.equal(jobs.get('job-does-not-exist'), null);
});

test('retry starts pending and runs the first attempt after the delay', async () => {
  const jobs = createJobs();
  let calls = 0;
  const job = jobs.retry(async () => { calls += 1; return 'ok'; }, { tag: 't' }, { attempts: 3, delayMs: 20 });
  assert.equal(job.status, 'pending');
  assert.equal(jobs.get(job.id).status, 'pending');
  assert.equal(calls, 0);
  await delay(60);
  const done = jobs.get(job.id);
  assert.equal(done.status, 'done');
  assert.equal(done.result, 'ok');
  assert.equal(done.attempt, 1);
  assert.equal(calls, 1);
});

test('retry backs off and succeeds on a later attempt', async () => {
  const jobs = createJobs();
  let calls = 0;
  const job = jobs.retry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('cold start');
      return 'ready';
    },
    {},
    { attempts: 4, delayMs: 10, factor: 1, maxDelayMs: 20 },
  );
  await delay(120);
  const done = jobs.get(job.id);
  assert.equal(calls, 3);
  assert.equal(done.status, 'done');
  assert.equal(done.result, 'ready');
  assert.equal(done.attempt, 3);
});

test('retry marks the job as error after the final attempt', async () => {
  const jobs = createJobs();
  const job = jobs.retry(
    async () => { throw new Error('still cooling'); },
    {},
    { attempts: 2, delayMs: 5, factor: 1, maxDelayMs: 5 },
  );
  await delay(80);
  const failed = jobs.get(job.id);
  assert.equal(failed.status, 'error');
  assert.match(failed.error.message, /still cooling/);
  assert.equal(failed.retriesExhausted, true);
});

test('pending retry jobs are not pruned by the ttl', async () => {
  const jobs = createJobs({ ttlMs: 10 });
  const job = jobs.retry(async () => 'late', {}, { attempts: 2, delayMs: 40 });
  await delay(25);
  assert.ok(jobs.get(job.id), 'pending job survives ttl prune');
  jobs.cancel(job.id);
});

test('cancel stops a pending retry from running', async () => {
  const jobs = createJobs();
  let calls = 0;
  const job = jobs.retry(
    async () => { calls += 1; return 'never'; },
    {},
    { attempts: 3, delayMs: 20 },
  );
  const cancelled = jobs.cancel(job.id);
  assert.equal(cancelled.status, 'cancelled');
  await delay(60);
  assert.equal(calls, 0);
  assert.equal(jobs.get(job.id).status, 'cancelled');
});
