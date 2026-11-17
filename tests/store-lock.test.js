'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createMutex,
  atomicWriteFile,
  atomicWriteJson,
  withStateLock,
  renameWithRetry,
  RuntimeDb,
} = require('../lib/store-lock');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ibx-store-'));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('createMutex serializes tasks in call order', async () => {
  const mutex = createMutex();
  const order = [];
  await Promise.all([
    mutex.run(async () => { await delay(30); order.push(1); }),
    mutex.run(async () => { await delay(5); order.push(2); }),
    mutex.run(async () => { order.push(3); }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
});

test('atomicWriteFile replaces content without leaving temp files', () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  atomicWriteFile(file, '{"a":1}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
  atomicWriteJson(file, { a: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 2 });
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('withStateLock keeps concurrent read-modify-write consistent', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  atomicWriteJson(file, { n: 0 });
  await Promise.all(
    Array.from({ length: 20 }, () =>
      withStateLock(file, async () => {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        await delay(2);
        state.n += 1;
        atomicWriteJson(file, state);
      })),
  );
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 20);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('withStateLock takes over a stale lock', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, host: 'not-this-host', startedAt: '2000-01-01T00:00:00Z' }));
  const result = await withStateLock(file, async () => 'ok', { staleMs: 1, timeoutMs: 1000 });
  assert.equal(result, 'ok');
});

test('RuntimeDb stores, lists and persists rows', () => {
  const dir = tempDir();
  const file = path.join(dir, 'runtime.db');
  const db = new RuntimeDb(file);
  db.put('a/1', { cpu: 1 }, { kind: 'probe' });
  db.put('a/2', { cpu: 2 }, { kind: 'probe' });
  db.put('b/1', { ok: true }, { kind: 'health' });
  assert.equal(db.get('a/1').value.cpu, 1);
  assert.equal(db.list({ kind: 'probe' }).length, 2);
  assert.equal(db.list().length, 3);
  db.close();

  const reopened = new RuntimeDb(file);
  assert.deepEqual(reopened.get('a/2').value, { cpu: 2 });
  reopened.delete('a/2');
  assert.equal(reopened.get('a/2'), null);
  reopened.close();
});

test('renameWithRetry retries EPERM and EBUSY before succeeding', () => {
  const original = fs.renameSync;
  const codes = ['EPERM', 'EBUSY'];
  let attempts = 0;
  fs.renameSync = () => {
    attempts += 1;
    if (codes.length) {
      const error = new Error('target is locked');
      error.code = codes.shift();
      throw error;
    }
  };
  try {
    renameWithRetry('state.json.tmp', 'state.json');
  } finally {
    fs.renameSync = original;
  }
  assert.equal(attempts, 3);
});

test('renameWithRetry rethrows non-retryable errors immediately', () => {
  const original = fs.renameSync;
  let attempts = 0;
  fs.renameSync = () => {
    attempts += 1;
    const error = new Error('missing source');
    error.code = 'ENOENT';
    throw error;
  };
  try {
    assert.throws(
      () => renameWithRetry('missing.tmp', 'state.json'),
      (error) => error.code === 'ENOENT',
    );
  } finally {
    fs.renameSync = original;
  }
  assert.equal(attempts, 1);
});

test('renameWithRetry gives up after five locked attempts', () => {
  const original = fs.renameSync;
  let attempts = 0;
  fs.renameSync = () => {
    attempts += 1;
    const error = new Error('still locked');
    error.code = 'EPERM';
    throw error;
  };
  try {
    assert.throws(
      () => renameWithRetry('state.json.tmp', 'state.json'),
      (error) => error.code === 'EPERM',
    );
  } finally {
    fs.renameSync = original;
  }
  assert.equal(attempts, 5);
});
