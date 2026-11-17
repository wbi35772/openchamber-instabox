#!/usr/bin/env node
/*
 * Cloudflare provision/teardown contract probe (upstream = local stub).
 *
 * Why this exists: the live CF vault on this host has zero accounts, so the
 * trinity verifier cannot exercise `cf.tunnel.provision`. This probe keeps the
 * whole code path real (vault on disk, net binder, proxy-fetch, RPC handler)
 * and replaces only api.cloudflare.com with a local stub API reached through a
 * local HTTP forward proxy. It never claims the live Cloudflare path passed:
 * every line says upstream=stub.
 *
 * Checks:
 *   provision.contract   tunnelId/tunnelToken/publicHostname/egressPort
 *   provision.routes     POST cfd_tunnel + PUT configurations + POST dns_records
 *   provision.redaction  cf.matrix.slots / vault files never expose the token
 *   provision.control    proxy saw STRICT_CONTROL plane + slot authorization
 *   teardown.contract    tunnel + DNS removed, vault record deleted
 *
 * Usage:
 *   node scripts/probe-cf-provision.mjs
 *   node scripts/probe-cf-provision.mjs --cf-root ..\openchamber-cloudflare --json-out out.json
 *
 * Exit code: 0 all checks passed, 1 any check failed, 2 harness error.
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const STATUS = { PASS: 'PASS', FAIL: 'FAIL' };
const SLOT = 'slot-010';
const PROXY_PORT_START = 24010;
const PROXY_PORT_END = 24150;
const TUNNEL_NAME = 'probe-slot-010';
const DOMAIN = 'example.com';
const PUBLIC_HOSTNAME = `${TUNNEL_NAME}.${DOMAIN}`;
const TUNNEL_TOKEN = 'probe-tunnel-token-0001';

function parseArgs(argv) {
  const args = {
    cfRoot: path.resolve(HERE, '..', '..', 'openchamber-cloudflare'),
    jsonOut: '',
    keep: false,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--cf-root') args.cfRoot = path.resolve(argv[i + 1] || '');
    else if (token === '--json-out') args.jsonOut = argv[i + 1] || '';
    else if (token === '--keep') args.keep = true;
    else if (token === '--verbose') args.verbose = true;
    if (token.startsWith('--')) i += 1;
  }
  return args;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function json(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cf-ray': 'stub-probe-LHR',
    ...extraHeaders,
  });
  res.end(body);
}

function ok(res, result) {
  json(res, 200, { success: true, result });
}

function startStub() {
  const state = {
    zones: [{ id: 'zone-probe-1', name: DOMAIN, status: 'active' }],
    tunnels: [],
    dns: [],
    routes: [],
    nextTunnel: 1,
    nextDns: 1,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub.local');
    const at = url.pathname;
    const method = String(req.method || 'GET').toUpperCase();
    state.routes.push(`${method} ${at}${url.search}`);
    const bodyText = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : '';
    let body = {};
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = {};
      }
    }

    if (method === 'GET' && at.endsWith('/user/tokens/verify')) {
      return ok(res, { id: 'probe-token-id', status: 'active' });
    }
    if (method === 'GET' && /\/zones$/.test(at)) {
      const name = url.searchParams.get('name');
      return ok(res, name ? state.zones.filter((zone) => zone.name === name) : state.zones);
    }
    if (/\/accounts\/[^/]+\/cfd_tunnel$/.test(at)) {
      if (method === 'GET') {
        const name = url.searchParams.get('name');
        return ok(res, name ? state.tunnels.filter((entry) => entry.name === name) : state.tunnels);
      }
      if (method === 'POST') {
        const tunnel = {
          id: `tun-${state.nextTunnel}`,
          name: body.name || `tunnel-${state.nextTunnel}`,
          token: TUNNEL_TOKEN,
          created_at: new Date().toISOString(),
        };
        state.nextTunnel += 1;
        state.tunnels.push(tunnel);
        return ok(res, tunnel);
      }
    }
    const tunnelConfig = at.match(/\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)\/configurations$/);
    if (tunnelConfig && (method === 'PUT' || method === 'GET')) {
      return ok(res, { tunnel_id: tunnelConfig[1], config: body.config || { ingress: [] } });
    }
    const tunnelToken = at.match(/\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)\/token$/);
    if (tunnelToken && method === 'GET') {
      const tunnel = state.tunnels.find((entry) => entry.id === tunnelToken[1]);
      return ok(res, tunnel ? tunnel.token : TUNNEL_TOKEN);
    }
    const tunnelOne = at.match(/\/accounts\/[^/]+\/cfd_tunnel\/([^/]+)$/);
    if (tunnelOne && method === 'DELETE') {
      state.tunnels = state.tunnels.filter((entry) => entry.id !== tunnelOne[1]);
      return ok(res, { id: tunnelOne[1] });
    }
    const dnsCollection = at.match(/\/zones\/([^/]+)\/dns_records$/);
    if (dnsCollection) {
      if (method === 'GET') {
        const name = url.searchParams.get('name');
        const type = url.searchParams.get('type');
        const rows = state.dns.filter(
          (entry) => (!name || entry.name === name) && (!type || entry.type === type),
        );
        return ok(res, rows);
      }
      if (method === 'POST') {
        const record = { id: `rec-${state.nextDns}`, ...body };
        state.nextDns += 1;
        state.dns.push(record);
        return ok(res, record);
      }
    }
    const dnsOne = at.match(/\/zones\/([^/]+)\/dns_records\/([^/]+)$/);
    if (dnsOne && method === 'DELETE') {
      state.dns = state.dns.filter((entry) => entry.id !== dnsOne[2]);
      return ok(res, { id: dnsOne[2] });
    }

    json(res, 404, { success: false, errors: [{ code: 1000, message: `stub has no route ${method} ${at}` }] });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      port: server.address().port,
      baseUrl: `http://127.0.0.1:${server.address().port}/client/v4`,
      state,
      close: () => new Promise((done) => server.close(() => done())),
    }));
  });
}

async function findFreePort(start, end) {
  for (let port = start; port <= end; port += 1) {
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw new Error(`no free proxy port in ${start}-${end}`);
}

function startForwardProxy(port) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('absolute-form URL required\n');
      return;
    }
    hits.push({
      method: req.method,
      url: req.url,
      slot: req.headers['x-oc-matrix-slot'] || null,
      plane: req.headers['x-oc-routing-plane'] || null,
      proxyAuthorization: req.headers['proxy-authorization'] || null,
    });
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    headers.host = target.host;
    const upstream = http.request(
      {
        host: target.hostname,
        port: Number(target.port) || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`proxy upstream error: ${error.message}\n`);
    });
    req.pipe(upstream);
  });
  server.on('connect', (req, socket, head) => {
    hits.push({ method: 'CONNECT', url: req.url, slot: null, plane: null, proxyAuthorization: null });
    const [host, rawPort] = String(req.url).split(':');
    const upstream = net.connect(Number(rawPort) || 443, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => {
      socket.destroy();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      server,
      port,
      hits,
      close: () => new Promise((done) => server.close(() => done())),
    }));
  });
}

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function expectedControlAuth(slotId) {
  return `Basic ${Buffer.from(`${slotId}:STRICT_CONTROL`, 'utf8').toString('base64')}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const checks = [];
  const add = (id, label, status, evidence) => {
    checks.push({ id, label, status, evidence });
    const line = `${status === STATUS.PASS ? 'PASS' : 'FAIL'} ${id}  ${label}  ${evidence}`;
    console.log(line);
  };

  const cfIndex = path.join(args.cfRoot, 'index.js');
  if (!fs.existsSync(cfIndex)) {
    console.error(`harness error: ${cfIndex} not found (use --cf-root)`);
    process.exit(2);
  }
  const { createMatrix } = require(cfIndex);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-probe-'));
  let stub;
  let proxy;
  let matrix;
  let proxyPort = null;
  let exitCode = 0;

  console.log('CF provision probe (upstream=stub)');
  console.log(`  slot       ${SLOT}`);
  console.log(`  dataDir    ${dataDir}`);

  try {
    stub = await startStub();
    proxyPort = await findFreePort(PROXY_PORT_START, PROXY_PORT_END);
    proxy = await startForwardProxy(proxyPort);
    console.log(`  stub       ${stub.baseUrl}`);
    console.log(`  proxy      127.0.0.1:${proxy.port}`);

    matrix = createMatrix({
      dataDir,
      masterKey: 'probe-master-key-0123456789abcdef',
      egressBus: false,
      config: { apiBase: stub.baseUrl },
    });

    const account = await matrix.vault.add({
      id: 'probe-slot-010',
      label: 'probe-slot-010',
      authType: 'token',
      token: 'cf-probe-api-token-0001',
      cloudflareAccountId: 'c'.repeat(32),
      proxyPort,
      matrixSlotId: SLOT,
      enabled: true,
    });
    add(
      'account.add',
      'vault 接受槽位账号',
      account && account.matrixSlotId === SLOT && account.proxyPort === proxyPort ? STATUS.PASS : STATUS.FAIL,
      `matrixSlotId=${account && account.matrixSlotId} proxyPort=${account && account.proxyPort}`,
    );

    const provision = await matrix.rpc.handle('cf.tunnel.provision', {
      matrixSlotId: SLOT,
      vmInstanceId: 'probe-vm-010',
      localPort: 8080,
      domainZone: DOMAIN,
      tunnelName: TUNNEL_NAME,
      publicHostname: PUBLIC_HOSTNAME,
    });

    const contractOk =
      provision &&
      provision.tunnelId === 'tun-1' &&
      provision.tunnelToken === TUNNEL_TOKEN &&
      provision.publicHostname === PUBLIC_HOSTNAME &&
      Number(provision.egressPort) === proxyPort &&
      provision.matrixSlotId === SLOT &&
      Array.isArray(provision.dns && provision.dns.created) &&
      provision.dns.created.length === 1;
    add(
      'provision.contract',
      'provision 返回完整契约',
      contractOk ? STATUS.PASS : STATUS.FAIL,
      contractOk
        ? `tunnelId=${provision.tunnelId} egressPort=${provision.egressPort} dns.created=${provision.dns.created.length} host=${provision.publicHostname}`
        : `实际返回 ${JSON.stringify(provision)}`,
    );

    const routes = stub.state.routes;
    const routeChecks = {
      tunnelCreate: routes.some((line) => line.startsWith('POST ') && /\/cfd_tunnel(\?|$)/.test(line)),
      tunnelConfig: routes.some((line) => line.startsWith('PUT ') && /\/configurations/.test(line)),
      dnsCreate: routes.some((line) => line.startsWith('POST ') && /\/dns_records/.test(line)),
    };
    const routesOk = Object.values(routeChecks).every(Boolean);
    add(
      'provision.routes',
      'stub 收到建隧道/写配置/建 DNS',
      routesOk ? STATUS.PASS : STATUS.FAIL,
      JSON.stringify(routeChecks),
    );

    const slots = await matrix.rpc.handle('cf.matrix.slots', {});
    const slot = (slots || []).find((entry) => entry.matrixSlotId === SLOT);
    const slotsJson = JSON.stringify(slots);
    const tunnels = slot && Array.isArray(slot.tunnels) ? slot.tunnels : [];
    const redactionOk =
      slot && tunnels.some((entry) => entry.tunnelId === 'tun-1') &&
      !slotsJson.includes(TUNNEL_TOKEN) &&
      !slotsJson.includes('sealedToken') &&
      !/"tunnelToken"/.test(slotsJson);
    add(
      'provision.redaction',
      'cf.matrix.slots 不回传隧道 token',
      redactionOk ? STATUS.PASS : STATUS.FAIL,
      `tunnels=${tunnels.length} tokenInPayload=${slotsJson.includes(TUNNEL_TOKEN)}`,
    );

    const diskFiles = listFiles(dataDir);
    const leakyFiles = diskFiles.filter((file) => {
      try {
        return fs.readFileSync(file).includes(TUNNEL_TOKEN);
      } catch {
        return false;
      }
    });
    add(
      'provision.sealed',
      '数据目录明文无隧道 token',
      leakyFiles.length === 0 ? STATUS.PASS : STATUS.FAIL,
      leakyFiles.length ? `leak: ${leakyFiles.map((file) => path.basename(file)).join(', ')}` : `${diskFiles.length} 个文件无明文 token`,
    );

    const controlAuth = expectedControlAuth(SLOT);
    const controlHit = proxy.hits.find(
      (hit) => hit.slot === SLOT && hit.plane === 'STRICT_CONTROL' && hit.proxyAuthorization === controlAuth,
    );
    add(
      'provision.control',
      '出站带 STRICT_CONTROL 双平面头',
      controlHit ? STATUS.PASS : STATUS.FAIL,
      controlHit
        ? `slot=${controlHit.slot} plane=${controlHit.plane} auth=Basic <slot:STRICT_CONTROL>`
        : `proxy hits=${JSON.stringify(proxy.hits.slice(0, 3))}`,
    );

    const teardown = await matrix.rpc.handle('cf.tunnel.teardown', {
      matrixSlotId: SLOT,
      tunnelId: provision.tunnelId,
    });
    const teardownOk =
      teardown && teardown.deleted === true && teardown.dnsDeleted === 1 && teardown.tunnelId === 'tun-1';
    const stateAfter = matrix.vault.state('probe-slot-010') || {};
    const tunnelsAfter = Object.keys(stateAfter.tunnels || {}).length;
    add(
      'teardown.contract',
      'teardown 删隧道与 DNS',
      teardownOk && tunnelsAfter === 0 ? STATUS.PASS : STATUS.FAIL,
      `deleted=${teardown && teardown.deleted} dnsDeleted=${teardown && teardown.dnsDeleted} vaultTunnels=${tunnelsAfter}`,
    );

    if (args.verbose) {
      console.log('--- stub routes ---');
      for (const line of routes) console.log(`  ${line}`);
      console.log('--- proxy hits ---');
      for (const hit of proxy.hits) console.log(`  ${hit.method} ${hit.url} plane=${hit.plane}`);
    }
  } catch (error) {
    add('probe.harness', '探针执行', STATUS.FAIL, `${error && error.code ? `[${error.code}] ` : ''}${error.message}`);
  } finally {
    try {
      if (matrix && typeof matrix.close === 'function') matrix.close();
    } catch {
      /* ignore */
    }
    if (proxy) await proxy.close().catch(() => {});
    if (stub) await stub.close().catch(() => {});
    if (args.keep) console.log(`temp dir kept: ${dataDir}`);
    else fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const failed = checks.filter((check) => check.status !== STATUS.PASS);
  exitCode = failed.length ? 1 : 0;
  const result = {
    ok: failed.length === 0,
    upstream: 'stub',
    slot: SLOT,
    proxyPort,
    checkedAt: new Date().toISOString(),
    checks,
  };
  if (args.jsonOut) {
    fs.writeFileSync(path.resolve(args.jsonOut), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`json       ${path.resolve(args.jsonOut)}`);
  }
  console.log(`RESULT ${result.ok ? 'PASS' : 'FAIL'} (${checks.length - failed.length}/${checks.length})`);
  if (matrix && typeof matrix.close === 'function') {
    /* close already called; exit avoids lingering keep-alive sockets */
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error(`harness error: ${error && error.stack ? error.stack : error}`);
  process.exit(2);
});
