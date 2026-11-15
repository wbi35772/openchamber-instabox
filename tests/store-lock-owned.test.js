'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireOwnedLock } = require('../lib/store-lock');

test('owned lock blocks a second owner and release checks token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibx-owned-lock-'));
  const file = path.join(dir, 'recycle.lock');
  const a = await acquireOwnedLock(file, { staleMs: 200, heartbeatMs: 20 });
  await assert.rejects(() => acquireOwnedLock(file, { staleMs: 200, heartbeatMs: 20 }), /lock busy/);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Date.parse(info.heartbeatAt) > Date.parse(info.startedAt));
  fs.writeFileSync(file, JSON.stringify({ ...info, token: 'other' }));
  a.release();
  assert.equal(fs.existsSync(file), true);
  fs.unlinkSync(file);
});

test('owned lock takes over a stale lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibx-owned-stale-'));
  const file = path.join(dir, 'recycle.lock');
  fs.writeFileSync(
    file,
    JSON.stringify({ pid: 999999, host: 'other', token: 'x', heartbeatAt: new Date(0).toISOString() }),
  );
  const lock = await acquireOwnedLock(file, { staleMs: 50, heartbeatMs: 0 });
  assert.equal(lock.owned, true);
  lock.release();
});
