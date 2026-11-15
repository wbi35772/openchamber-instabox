'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const canvas = require('../lib/canvas');

async function tempRoot(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'canvas-store-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

function readJson(file) {
  return fsp.readFile(file, 'utf8').then((text) => JSON.parse(text));
}

test('newArtifactId keeps the canvas ULID-slug shape', () => {
  const id = canvas.newArtifactId('机器画布 · proxygate');
  assert.match(id, canvas.ARTIFACT_ID_RE);
  assert.equal(id.slice(26), '-proxygate');
  assert.notEqual(id, canvas.newArtifactId('机器画布 · proxygate'));
});

test('formatVersionId and nextVersionId stay monotonic', () => {
  const date = new Date('2026-11-14T10:20:30.400Z');
  const version = canvas.formatVersionId(date);
  assert.match(version, canvas.VERSION_ID_RE);
  assert.equal(version, '20261114T102030400Z');
  assert.equal(canvas.nextVersionId(date, version), '20261114T102030401Z');
  assert.equal(canvas.nextVersionId(date, null), version);
});

test('publishArtifact writes meta schema 2 and manifest schema 1', async (t) => {
  const storeRoot = await tempRoot(t);
  const html = '<h1>one</h1>';
  const result = await canvas.publishArtifact({
    storeRoot,
    directory: path.join(storeRoot, 'project'),
    title: '机器画布 · proxygate',
    html,
    dedupeKey: 'instabox-matrix:machine-canvas:a:m_1',
  });

  assert.equal(result.deduped, false);
  assert.equal(result.contentChanged, true);
  assert.match(result.id, canvas.ARTIFACT_ID_RE);
  assert.match(result.version, canvas.VERSION_ID_RE);

  const meta = await readJson(path.join(storeRoot, result.id, 'meta.json'));
  assert.equal(meta.schema, 2);
  assert.equal(meta.id, result.id);
  assert.equal(meta.kind, 'html');
  assert.equal(meta.currentVersion, result.version);
  assert.equal(meta.dedupeKey, 'instabox-matrix:machine-canvas:a:m_1');
  assert.equal(meta.versions.length, 1);
  assert.equal(meta.versions[0].id, result.version);
  assert.equal(meta.projectName, 'project');

  const manifest = await readJson(path.join(storeRoot, result.id, 'versions', result.version, 'manifest.json'));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.kind, 'html');
  assert.equal(manifest.entry, 'index.html');
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].path, 'index.html');
  assert.equal(manifest.files[0].bytes, Buffer.byteLength(html));
  assert.equal(manifest.files[0].sha256, canvas.sha256(Buffer.from(html)));

  const stored = await fsp.readFile(path.join(storeRoot, result.id, 'versions', result.version, 'index.html'), 'utf8');
  assert.equal(stored, html);
});

test('publishArtifact dedupes identical html and versions changed html', async (t) => {
  const storeRoot = await tempRoot(t);
  const options = {
    storeRoot,
    directory: path.join(storeRoot, 'project'),
    title: '机器画布 · proxygate',
    dedupeKey: 'instabox-matrix:machine-canvas:a:m_1',
    now: Date.parse('2026-11-14T10:00:00.000Z'),
  };
  const first = await canvas.publishArtifact(Object.assign({}, options, { html: '<h1>one</h1>' }));

  const same = await canvas.publishArtifact(Object.assign({}, options, {
    html: '<h1>one</h1>',
    now: Date.parse('2026-11-14T10:05:00.000Z'),
  }));
  assert.equal(same.id, first.id);
  assert.equal(same.version, first.version);
  assert.equal(same.deduped, true);
  assert.equal(same.contentChanged, false);

  const changed = await canvas.publishArtifact(Object.assign({}, options, {
    html: '<h1>two</h1>',
    now: Date.parse('2026-11-14T10:10:00.000Z'),
  }));
  assert.equal(changed.id, first.id);
  assert.notEqual(changed.version, first.version);
  assert.equal(changed.deduped, true);
  assert.equal(changed.contentChanged, true);

  const meta = await readJson(path.join(storeRoot, first.id, 'meta.json'));
  assert.equal(meta.currentVersion, changed.version);
  assert.equal(meta.versions.length, 2);
  assert.equal(meta.versions[1].id, changed.version);

  const latest = await fsp.readFile(path.join(storeRoot, first.id, 'versions', changed.version, 'index.html'), 'utf8');
  assert.equal(latest, '<h1>two</h1>');
});

test('ensureViewer fails clearly when the canvas viewer is missing', async (t) => {
  const storeRoot = await tempRoot(t);
  const canvasDir = path.join(storeRoot, 'canvas-not-installed');
  await assert.rejects(
    canvas.ensureViewer({
      storeRoot,
      canvasDir,
      portFile: path.join(storeRoot, '.viewer.json'),
    }),
    (error) => error && error.code === 'canvas_viewer_missing',
  );
});
