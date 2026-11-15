'use strict';

// Publish a machine page into the OpenChamber Canvas store and mint a
// detached viewer URL. The Canvas extension is optional and never imported
// directly: this module speaks its on-disk store format and local viewer HTTP
// contract, so it can be copied to another matrix extension unchanged.

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ARTIFACT_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_ID_RE = /^\d{8}T\d{9}Z$/;
const META_SCHEMA = 2;
const MANIFEST_SCHEMA = 1;
const HTML_MIME = 'text/html; charset=utf-8';
const VIEWER_PROTOCOL = 2;

function canvasError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function encodeTime(ms) {
  let time = Math.max(0, Math.floor(ms));
  let out = '';
  for (let index = 0; index < 10; index += 1) {
    out = ALPHABET[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function ulid(now, random) {
  return encodeTime(now) + encodeRandom(random || crypto.randomBytes(10));
}

function slugify(input) {
  const text = String(input == null ? '' : input)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return text || 'artifact';
}

function newArtifactId(title, now, random) {
  return ulid(now == null ? Date.now() : now, random) + '-' + slugify(title);
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function formatVersionId(date) {
  return date.toISOString().replace(/[-:.]/g, '');
}

function parseVersionId(id) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(String(id || ''));
  if (!match) return null;
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  );
}

function nextVersionId(now, previous) {
  let time = now.getTime();
  const previousTime = parseVersionId(previous);
  if (previousTime !== null && time <= previousTime) time = previousTime + 1;
  return formatVersionId(new Date(time));
}

function normalizeTitle(title) {
  const text = String(title == null ? '' : title)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return text || '未命名画布';
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const tag of tags) {
    const value = String(tag == null ? '' : tag).trim().toLowerCase();
    if (!value || value.length > 32 || !/^[a-z0-9][a-z0-9-]*$/.test(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= 16) break;
  }
  return out;
}

function defaultStoreRoot(env, home) {
  const scope = env || process.env;
  const userHome = home || os.homedir();
  if (scope.CANVAS_STORE && String(scope.CANVAS_STORE).trim()) return path.resolve(String(scope.CANVAS_STORE).trim());
  return path.join(userHome, '.config', 'openchamber', 'artifacts');
}

function defaultCanvasDir(env, home) {
  const scope = env || process.env;
  const userHome = home || os.homedir();
  if (scope.CANVAS_EXTENSION_DIR && String(scope.CANVAS_EXTENSION_DIR).trim()) {
    return path.resolve(String(scope.CANVAS_EXTENSION_DIR).trim());
  }
  return path.join(userHome, '.config', 'openchamber', 'extensions', 'canvas');
}

function viewerPortFile(storeRoot) {
  return path.join(storeRoot, '.viewer.json');
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
}

function readJsonSync(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

async function writeFileAtomic(file, data, mode) {
  const temp = file + '.tmp-' + process.pid + '-' + randomHex(4);
  await fsp.writeFile(temp, data, { mode: mode == null ? 0o600 : mode });
  await fsp.rename(temp, file);
}

async function writeJsonAtomic(file, value) {
  return writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', 0o600);
}

async function withLock(lockDir, task, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs == null ? 15000 : opts.timeoutMs;
  const staleMs = opts.staleMs == null ? 30000 : opts.staleMs;
  const retryMs = opts.retryMs == null ? 50 : opts.retryMs;
  const startedAt = Date.now();
  for (;;) {
    try {
      await fsp.mkdir(lockDir, { recursive: false, mode: 0o700 });
      break;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      const owner = readJsonSync(path.join(lockDir, 'owner.json'));
      const ownerAt = owner ? Date.parse(owner.at) : NaN;
      if (Number.isFinite(ownerAt) && Date.now() - ownerAt > staleMs) {
        await fsp.rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw canvasError('canvas_lock_timeout', 'Canvas 存储锁被占用，稍后重试');
      }
      await sleep(retryMs);
    }
  }
  try {
    await fsp.writeFile(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      { mode: 0o600 },
    );
  } catch {
    /* the lock directory itself is the guard */
  }
  try {
    return await task();
  } finally {
    await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function allocateArtifactId(root, title, now) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const id = newArtifactId(title, now && now.getTime ? now.getTime() + attempt : undefined);
    if (!ARTIFACT_ID_RE.test(id)) continue;
    const dir = path.join(root, id);
    try {
      await fsp.mkdir(dir, { recursive: false, mode: 0o700 });
      return { id, dir };
    } catch (error) {
      if (error && error.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw canvasError('canvas_allocate_failed', '无法分配 Canvas artifact 目录');
}

async function findArtifactByDedupeKey(root, dedupeKey, kind, directory) {
  if (!dedupeKey) return null;
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'trash' || entry.name === 'exports') continue;
    const meta = await readJson(path.join(root, entry.name, 'meta.json')).catch(() => null);
    if (!meta || meta.id !== entry.name) continue;
    if (meta.dedupeKey === dedupeKey && meta.kind === kind && meta.directory === directory) {
      return { id: meta.id, meta };
    }
  }
  return null;
}

async function writeVersion(artifactDir, input) {
  const versionsDir = path.join(artifactDir, 'versions');
  await ensureDir(versionsDir);
  let version = input.version;
  if (!VERSION_ID_RE.test(String(version || ''))) version = formatVersionId(input.now);
  const tempDir = path.join(artifactDir, '.tmp-' + version + '-' + randomHex(3));
  await fsp.mkdir(tempDir, { mode: 0o700 });
  try {
    await fsp.writeFile(path.join(tempDir, 'index.html'), input.bytes, { mode: 0o600 });
    const manifest = {
      schema: MANIFEST_SCHEMA,
      kind: 'html',
      entry: 'index.html',
      title: input.title,
      createdAt: input.now.toISOString(),
      restoredFrom: null,
      files: [
        {
          path: 'index.html',
          bytes: input.bytes.byteLength,
          sha256: sha256(input.bytes),
          mime: HTML_MIME,
        },
      ],
    };
    await writeFileAtomic(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 0o600);
    await fsp.rename(tempDir, path.join(versionsDir, version));
    return {
      id: version,
      createdAt: manifest.createdAt,
      bytes: input.bytes.byteLength,
      files: 1,
      title: input.title,
      restoredFrom: null,
    };
  } catch (error) {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function publishArtifact(options) {
  const opts = options || {};
  const html = String(opts.html == null ? '' : opts.html);
  if (!html.trim()) throw canvasError('canvas_empty', 'Canvas 页面内容为空');
  const bytes = Buffer.from(html, 'utf8');
  const storeRoot = path.resolve(opts.storeRoot || defaultStoreRoot());
  const directory = path.resolve(opts.directory || path.join(__dirname, '..'));
  const title = normalizeTitle(opts.title);
  const tags = normalizeTags(opts.tags);
  const dedupeKey = opts.dedupeKey ? String(opts.dedupeKey).slice(0, 200) : null;
  const now = opts.now instanceof Date ? opts.now : new Date();
  await ensureDir(storeRoot);
  const locksDir = path.join(storeRoot, '.locks');
  await ensureDir(locksDir);

  const lockName = dedupeKey
    ? 'dedupe-' + sha256(Buffer.from(JSON.stringify([directory, 'html', dedupeKey]))) + '.lock'
    : 'artifact-' + randomHex(8) + '.lock';
  const lockDir = path.join(locksDir, lockName);

  return withLock(lockDir, async () => {
    const existing = await findArtifactByDedupeKey(storeRoot, dedupeKey, 'html', directory);
    if (existing) {
      const artifactDir = path.join(storeRoot, existing.id);
      const meta = await readJson(path.join(artifactDir, 'meta.json'));
      const currentManifest = await readJson(
        path.join(artifactDir, 'versions', meta.currentVersion, 'manifest.json'),
      ).catch(() => null);
      const currentFile = currentManifest && Array.isArray(currentManifest.files) ? currentManifest.files[0] : null;
      const unchanged = Boolean(
        currentFile && currentFile.path === 'index.html' && currentFile.sha256 === sha256(bytes),
      );
      if (unchanged) {
        const next = Object.assign({}, meta, {
          title,
          tags: tags.length ? tags : meta.tags,
          updatedAt: now.toISOString(),
        });
        await writeJsonAtomic(path.join(artifactDir, 'meta.json'), next);
        return {
          id: existing.id,
          version: meta.currentVersion,
          deduped: true,
          contentChanged: false,
          artifactDir,
          title,
        };
      }
      const version = nextVersionId(now, meta.currentVersion);
      const summary = await writeVersion(artifactDir, { version, title, bytes, now });
      const next = Object.assign({}, meta, {
        title,
        tags: tags.length ? tags : meta.tags,
        updatedAt: now.toISOString(),
        archivedAt: null,
        currentVersion: version,
        versions: (Array.isArray(meta.versions) ? meta.versions : []).concat(summary),
      });
      await writeJsonAtomic(path.join(artifactDir, 'meta.json'), next);
      return { id: existing.id, version, deduped: true, contentChanged: true, artifactDir, title };
    }

    const allocated = await allocateArtifactId(storeRoot, title, now);
    const artifactDir = allocated.dir;
    const id = allocated.id;
    try {
      const version = formatVersionId(now);
      const summary = await writeVersion(artifactDir, { version, title, bytes, now });
      const meta = {
        schema: META_SCHEMA,
        id,
        title,
        kind: 'html',
        directory,
        projectName: path.basename(directory),
        sessionId: null,
        tags,
        favorite: false,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        archivedAt: null,
        currentVersion: version,
        pinnedVersion: null,
        librarySet: 'none',
        libraries: [],
        versions: [summary],
        live: [],
        openCount: 0,
        lastOpenedAt: null,
        dedupeKey,
      };
      await writeJsonAtomic(path.join(artifactDir, 'meta.json'), meta);
      return { id, version, deduped: false, contentChanged: true, artifactDir, title };
    } catch (error) {
      await fsp.rm(artifactDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }, { timeoutMs: 15000, staleMs: 30000 });
}

function readViewerState(portFile) {
  const state = readJsonSync(portFile);
  if (!state || !Number.isInteger(state.port) || state.port <= 0) return null;
  if (typeof state.secret !== 'string' || state.secret.length < 16) return null;
  return state;
}

function viewerRequest(state, method, route, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      host: '127.0.0.1',
      port: state.port,
      method,
      path: route,
      timeout: timeoutMs == null ? 5000 : timeoutMs,
      headers: Object.assign(
        { authorization: 'Bearer ' + state.secret },
        payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
      ),
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { raw: text };
        }
        resolve({ status: response.statusCode || 0, data });
      });
    });
    request.on('timeout', () => {
      request.destroy(canvasError('canvas_viewer_timeout', 'Canvas viewer 无响应'));
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function viewerHealthy(state, build) {
  try {
    const result = await viewerRequest(state, 'GET', '/health', undefined, 2500);
    if (result.status !== 200 || !result.data || result.data.ok !== true) return false;
    if (result.data.pid !== state.pid) return false;
    if (build && build.protocol != null && result.data.protocol !== build.protocol) return false;
    if (build && build.id && result.data.build && result.data.build !== build.id) return false;
    return true;
  } catch {
    return false;
  }
}

function readViewerBuild(canvasDir) {
  return readJsonSync(path.join(canvasDir, 'viewer', 'build.json'));
}

async function ensureViewer(options) {
  const opts = options || {};
  const storeRoot = path.resolve(opts.storeRoot || defaultStoreRoot());
  const canvasDir = path.resolve(opts.canvasDir || defaultCanvasDir());
  const portFile = path.resolve(opts.portFile || viewerPortFile(storeRoot));
  const entry = path.resolve(opts.viewerEntry || path.join(canvasDir, 'viewer', 'server.js'));
  const idleMs = Number(opts.idleMs) || 30 * 60 * 1000;
  const timeoutMs = Number(opts.timeoutMs) || 20000;
  if (!fs.existsSync(entry)) {
    throw canvasError('canvas_viewer_missing', '未找到 Canvas viewer：' + entry);
  }
  const build = readViewerBuild(canvasDir);
  await ensureDir(storeRoot);
  await ensureDir(path.dirname(portFile));

  return withLock(portFile + '.lock', async () => {
    let state = readViewerState(portFile);
    if (state && await viewerHealthy(state, build)) return state;
    if (state) {
      await viewerRequest(state, 'POST', '/shutdown', {}, 2000).catch(() => {});
      state = null;
    }
    const child = spawn(process.execPath, [entry], {
      detached: true,
      stdio: 'ignore',
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: '1',
        CANVAS_STORE: storeRoot,
        CANVAS_VIEWER_PORT_FILE: portFile,
        CANVAS_VIEWER_IDLE_MS: String(idleMs),
      }),
    });
    child.on('error', () => {});
    child.unref();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(100);
      state = readViewerState(portFile);
      if (state && await viewerHealthy(state, build)) return state;
    }
    throw canvasError('canvas_viewer_timeout', 'Canvas viewer 启动超时');
  }, { timeoutMs: 30000, staleMs: 60000 });
}

async function mintViewUrl(state, options) {
  const opts = options || {};
  if (!state) throw canvasError('canvas_viewer_missing', 'Canvas viewer 未运行');
  const result = await viewerRequest(state, 'POST', '/mint', {
    id: opts.id,
    version: opts.version || undefined,
    theme: opts.theme || undefined,
    follow: opts.follow === undefined ? true : Boolean(opts.follow),
  }, 8000);
  if (result.status !== 200 || !result.data || typeof result.data.url !== 'string') {
    throw canvasError('canvas_mint_failed', 'Canvas viewer 未返回链接');
  }
  return result.data;
}

async function notifyViewerChanged(state, options) {
  const opts = options || {};
  if (!state) return;
  await viewerRequest(state, 'POST', '/notify', {
    id: opts.id,
    event: opts.event || 'changed',
    version: opts.version || undefined,
  }, 3000);
}

module.exports = {
  ARTIFACT_ID_RE,
  VERSION_ID_RE,
  VIEWER_PROTOCOL,
  canvasError,
  sha256,
  ulid,
  slugify,
  newArtifactId,
  formatVersionId,
  parseVersionId,
  nextVersionId,
  defaultStoreRoot,
  defaultCanvasDir,
  viewerPortFile,
  readViewerState,
  readViewerBuild,
  ensureViewer,
  mintViewUrl,
  notifyViewerChanged,
  publishArtifact,
};
