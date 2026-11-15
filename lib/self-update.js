'use strict';

/*
 * Self-update for the Instabox Matrix extension.
 *
 * The update channel is separate from the per-account machine proxy:
 *   system  -> git inherits its own environment and global config
 *   direct  -> git proxy explicitly disabled
 *   custom  -> git uses the configured proxy URL
 *
 * The update clones the public repo into a temp directory and then runs the
 * repository's own scripts/sync.mjs against the installed extension, so the
 * file manifest is identical to a manual sync.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_REPO = 'https://github.com/wbi35772/openchamber-instabox-matrix.git';
const DEFAULT_REF = 'main';
const EXTENSION_NAME = 'openchamber-instabox-matrix';
const PROXY_URL = /^(https?|socks5h?|socks):\/\/\S+$/i;
const MAX_TIMEOUT_MS = 300000;

function validateProxyUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (!PROXY_URL.test(url) || /\s/.test(url)) {
    throw new Error('更新代理地址必须形如 http://127.0.0.1:10809 或 socks5h://127.0.0.1:1080');
  }
  return url;
}

function resolveRepo(update) {
  const raw = String((update && update.repo) || DEFAULT_REPO).trim() || DEFAULT_REPO;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) return `https://github.com/${raw}.git`;
  if (!/^https:\/\/[^\s]+$/i.test(raw) || raw.startsWith('-')) {
    throw new Error('更新仓库地址必须是 https://... 或 owner/name');
  }
  return raw;
}

function resolveRef(update) {
  const raw = String((update && update.ref) || DEFAULT_REF).trim() || DEFAULT_REF;
  if (!/^[A-Za-z0-9._/-]{1,64}$/.test(raw) || raw.startsWith('-')) {
    throw new Error('无效的更新分支名');
  }
  return raw;
}

function proxyArgs(update) {
  const channel = (update && update.channel) || 'system';
  if (channel === 'direct') return ['-c', 'http.proxy=', '-c', 'https.proxy='];
  if (channel === 'custom') {
    const url = validateProxyUrl(update && update.proxyUrl);
    if (!url) throw new Error('自定义代理通道需要填写代理地址');
    return ['-c', `http.proxy=${url}`, '-c', `https.proxy=${url}`];
  }
  return [];
}

function run(file, args, options = {}) {
  const timeout = Math.max(1000, Math.min(MAX_TIMEOUT_MS, Number(options.timeoutMs) || 120000));
  return new Promise((resolve) => {
    execFile(file, args, {
      timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      cwd: options.cwd || os.tmpdir(),
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
        return;
      }
      let message = String(stderr || '').trim() || String(error.message || 'command failed');
      if (error.killed) message = `命令超时（${Math.round(timeout / 1000)}s）：${message}`;
      resolve({
        ok: false,
        code: error.code === undefined ? null : error.code,
        killed: Boolean(error.killed),
        stdout: String(stdout || ''),
        stderr: message,
      });
    });
  });
}

function readPackage(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
    return { name: String(pkg.name || ''), version: String(pkg.version || '') };
  } catch {
    return null;
  }
}

function lastLine(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || '';
}

async function cloneTemp(update, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instabox-update-'));
  const args = [
    ...proxyArgs(update),
    'clone', '--depth', '1', '--single-branch',
    '--branch', resolveRef(update),
    resolveRepo(update),
    dir,
  ];
  const started = Date.now();
  if (typeof options.log === 'function') {
    options.log(`update: cloning ${resolveRepo(update)}#${resolveRef(update)} via ${(update && update.channel) || 'system'} channel`);
  }
  const result = await run('git', args, { timeoutMs: options.timeoutMs });
  if (!result.ok) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (result.code === 'ENOENT') throw new Error('未找到 git 命令，请先安装 Git 并确保在 PATH 中');
    throw new Error(`更新失败：${lastLine(result.stderr) || 'git clone 失败'}`);
  }
  return { dir, durationMs: Date.now() - started };
}

function currentVersion(installDir) {
  const pkg = readPackage(installDir);
  return pkg ? pkg.version : '';
}

async function check(options = {}) {
  const update = options.update || {};
  const installDir = options.installDir;
  const current = readPackage(installDir);
  const clone = await cloneTemp(update, options);
  try {
    const latest = readPackage(clone.dir);
    if (!latest || latest.name !== EXTENSION_NAME) throw new Error('远端仓库不是 Instabox Matrix 扩展，已取消');
    const head = await run('git', ['-C', clone.dir, 'rev-parse', 'HEAD'], { timeoutMs: 20000 });
    return {
      channel: update.channel || 'system',
      currentVersion: current ? current.version : '',
      latestVersion: latest.version,
      available: !current || current.version !== latest.version,
      commit: head.ok ? head.stdout.trim() : '',
      durationMs: clone.durationMs,
      checkedAt: new Date().toISOString(),
    };
  } finally {
    try { fs.rmSync(clone.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function apply(options = {}) {
  const update = options.update || {};
  const installDir = options.installDir;
  if (!installDir) throw new Error('缺少扩展安装目录');
  const from = readPackage(installDir);
  const clone = await cloneTemp(update, options);
  try {
    const latest = readPackage(clone.dir);
    if (!latest || latest.name !== EXTENSION_NAME) throw new Error('远端仓库不是 Instabox Matrix 扩展，已取消');
    const syncScript = path.join(clone.dir, 'scripts', 'sync.mjs');
    if (!fs.existsSync(syncScript)) throw new Error('远端仓库缺少 scripts/sync.mjs，无法安装');
    const args = [syncScript, '--install-dir', installDir];
    if (options.registry) args.push('--registry', options.registry);
    if (typeof options.log === 'function') options.log(`update: syncing ${latest.version} into ${installDir}`);
    const synced = await run(process.execPath, args, { timeoutMs: options.timeoutMs, cwd: clone.dir });
    if (!synced.ok) throw new Error(`写入扩展文件失败：${lastLine(synced.stderr) || 'sync failed'}`);
    return {
      currentVersion: from ? from.version : '',
      latestVersion: latest.version,
      updated: !from || from.version !== latest.version,
      restartRequired: true,
      output: String(synced.stdout || '').trim(),
      appliedAt: new Date().toISOString(),
    };
  } finally {
    try { fs.rmSync(clone.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = {
  DEFAULT_REPO,
  DEFAULT_REF,
  EXTENSION_NAME,
  validateProxyUrl,
  resolveRepo,
  resolveRef,
  proxyArgs,
  currentVersion,
  check,
  apply,
};
