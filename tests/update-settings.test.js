'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  DEFAULTS,
  UPDATE_DEFAULTS,
  normalizeUpdateSettings,
} = require('../lib/store');
const selfUpdate = require('../lib/self-update');

test('update defaults are wired into the settings defaults', () => {
  assert.deepEqual(DEFAULTS.settings.update, UPDATE_DEFAULTS);
  assert.equal(UPDATE_DEFAULTS.channel, 'system');
  assert.equal(UPDATE_DEFAULTS.ref, 'main');
  assert.match(UPDATE_DEFAULTS.repo, /^https:\/\/github\.com\/.+\.git$/);
});

test('update settings normalize channel and empty proxy', () => {
  const settings = normalizeUpdateSettings({ channel: 'custom', proxyUrl: '  ' });
  assert.equal(settings.channel, 'custom');
  assert.equal(settings.proxyUrl, '');
  assert.equal(settings.lastCheck, null);
});

test('unknown update channel falls back to system', () => {
  assert.equal(normalizeUpdateSettings({ channel: 'sneaky' }).channel, 'system');
  assert.equal(normalizeUpdateSettings(undefined).channel, 'system');
});

test('update proxy accepts http and socks urls', () => {
  assert.equal(
    normalizeUpdateSettings({ channel: 'custom', proxyUrl: 'http://127.0.0.1:10809' }).proxyUrl,
    'http://127.0.0.1:10809',
  );
  assert.equal(
    normalizeUpdateSettings({ proxyUrl: 'socks5h://127.0.0.1:1080' }).proxyUrl,
    'socks5h://127.0.0.1:1080',
  );
});

test('update proxy rejects junk and whitespace', () => {
  assert.throws(() => normalizeUpdateSettings({ proxyUrl: 'ftp://nope:1' }), /更新代理地址/);
  assert.throws(() => normalizeUpdateSettings({ proxyUrl: 'http://a b:1' }), /更新代理地址/);
});

test('update repo accepts owner/name and https, rejects others', () => {
  assert.equal(
    normalizeUpdateSettings({ repo: 'wbi35772/openchamber-instabox' }).repo,
    'https://github.com/wbi35772/openchamber-instabox.git',
  );
  assert.equal(
    normalizeUpdateSettings({ repo: 'https://git.example.com/x/y.git' }).repo,
    'https://git.example.com/x/y.git',
  );
  assert.throws(() => normalizeUpdateSettings({ repo: 'http://insecure/x' }), /更新仓库地址/);
  assert.throws(() => normalizeUpdateSettings({ repo: '--upload-pack=calc' }), /更新仓库地址/);
});

test('update ref falls back when invalid', () => {
  assert.equal(normalizeUpdateSettings({ ref: 'dev' }).ref, 'dev');
  assert.equal(normalizeUpdateSettings({ ref: 'bad ref!' }).ref, 'main');
  assert.equal(normalizeUpdateSettings({ ref: '--exec' }).ref, 'main');
});

test('update lastCheck is trimmed and typed', () => {
  const settings = normalizeUpdateSettings({
    lastCheck: {
      at: '2026-01-01T00:00:00.000Z',
      currentVersion: '1.4.0',
      latestVersion: '1.5.0',
      available: true,
      commit: 'abc123',
      error: 'x'.repeat(999),
      extra: 'drop me',
    },
  });
  assert.equal(settings.lastCheck.currentVersion, '1.4.0');
  assert.equal(settings.lastCheck.available, true);
  assert.equal(settings.lastCheck.error.length, 300);
  assert.equal(settings.lastCheck.extra, undefined);
});

test('self-update git proxy args follow the channel', () => {
  assert.deepEqual(selfUpdate.proxyArgs({ channel: 'system' }), []);
  assert.deepEqual(selfUpdate.proxyArgs({ channel: 'direct' }), [
    '-c', 'http.proxy=', '-c', 'https.proxy=',
  ]);
  assert.deepEqual(selfUpdate.proxyArgs({ channel: 'custom', proxyUrl: 'http://127.0.0.1:10809' }), [
    '-c', 'http.proxy=http://127.0.0.1:10809',
    '-c', 'https.proxy=http://127.0.0.1:10809',
  ]);
});

test('self-update custom channel requires a usable proxy', () => {
  assert.throws(() => selfUpdate.proxyArgs({ channel: 'custom' }), /需要填写代理地址/);
  assert.throws(() => selfUpdate.proxyArgs({ channel: 'custom', proxyUrl: 'nope' }), /更新代理地址/);
});

test('self-update resolves repo and ref', () => {
  assert.equal(selfUpdate.resolveRepo({}), selfUpdate.DEFAULT_REPO);
  assert.equal(selfUpdate.resolveRepo({ repo: 'a/b' }), 'https://github.com/a/b.git');
  assert.equal(selfUpdate.resolveRef({}), 'main');
  assert.throws(() => selfUpdate.resolveRef({ ref: '-x' }), /无效的更新分支名/);
  assert.throws(() => selfUpdate.resolveRepo({ repo: 'file:///etc/passwd' }), /更新仓库地址/);
});
