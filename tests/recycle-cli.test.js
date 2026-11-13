'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'scripts', 'recycle.js');

test('dry-run prints not_running and exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibx-recycle-cli-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    version: 1,
    accounts: [],
    keepalive: [],
    machineMeta: [],
    recycle: [],
    settings: {
      recycle: {
        enabled: true,
        machines: {
          'wbi/m_1': { account: 'wbi', machineId: 'm_1', enabled: true, verifyCommand: 'true' },
        },
      },
    },
  }));
  const out = execFileSync(process.execPath, [CLI, '--dry-run', '--machine', 'm_1'], {
    env: { ...process.env, INSTABOX_MATRIX_DATA_DIR: dir },
    encoding: 'utf8',
  });
  assert.match(out, /"reason":"not_running"/);
});

test('missing recycle settings exits 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibx-recycle-cli-empty-'));
  let failed = null;
  try {
    execFileSync(process.execPath, [CLI, '--dry-run'], {
      env: { ...process.env, INSTABOX_MATRIX_DATA_DIR: dir },
      encoding: 'utf8',
    });
  } catch (error) {
    failed = error;
  }
  assert.ok(failed, 'expected non-zero exit');
  assert.equal(failed.status, 2);
  assert.match(String(failed.stdout), /"ok":false/);
});
