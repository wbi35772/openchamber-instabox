'use strict';

/*
 * Publish the repository documentation page into the OpenChamber Canvas store.
 *
 *   node scripts/docs-canvas.js             publish + mint a viewer URL
 *   node scripts/docs-canvas.js --no-viewer publish only
 *
 * The artifact is deduped by key, so every run appends a version only when the
 * HTML actually changed. The viewer is optional: with no Canvas extension the
 * artifact still lands in the store and the command prints its directory.
 */

const fs = require('node:fs');
const path = require('node:path');
const canvas = require('../lib/canvas');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'docs', 'canvas', 'openchamber-instabox-docs.html');

async function main() {
  const html = fs.readFileSync(SOURCE, 'utf8');
  const artifact = await canvas.publishArtifact({
    html,
    directory: ROOT,
    title: 'OpenChamber Instabox 全景文档',
    tags: ['instabox', 'architecture', 'docs'],
    dedupeKey: 'openchamber-instabox-docs',
  });

  const result = {
    artifactId: artifact.id,
    version: artifact.version,
    contentChanged: artifact.contentChanged,
    artifactDir: artifact.artifactDir,
  };

  if (!process.argv.includes('--no-viewer')) {
    const state = await canvas.ensureViewer({});
    const minted = await canvas.mintViewUrl(state, { id: artifact.id, version: artifact.version });
    result.url = minted.url;
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write('docs canvas failed: ' + ((error && error.message) || error) + '\n');
  process.exit(1);
});
