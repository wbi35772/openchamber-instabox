'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const page = require('../lib/canvas-page');

const machine = {
  id: 'm_agq4uw3nnf2ckra45gcrdcoyf4',
  name: 'proxygate',
  account: 'wbi35772',
  state: 'running',
  vcpus: 2,
  memMiB: 2048,
  free: true,
  createdAt: '2026-11-10T08:00:00.000Z',
};

const connection = { host: 'ssh.instabox.example', port: 2222, username: 'ubuntu' };

const inventory = {
  host: {
    hostname: 'proxygate',
    os: 'Ubuntu 24.04',
    kernel: '6.8.0',
    arch: 'x86_64',
    cpuCount: 2,
    memoryTotalBytes: 2147483648,
    disk: { totalBytes: 42949672960, usedBytes: 21474836480, availableBytes: 21474836480, usedPct: 50 },
  },
  listeningPorts: [
    { protocol: 'tcp', address: '0.0.0.0', port: 8443, process: 'docker-proxy', pid: 4242 },
  ],
  containers: [
    { id: 'abc123def456', name: 'o2a-gateway', image: 'o2a/gateway:latest', state: 'running', ports: [{ hostPort: 8443, containerPort: 8443, protocol: 'tcp' }], project: 'o2a', service: 'gateway' },
  ],
  services: [
    { unit: 'docker.service', load: 'loaded', active: 'active', sub: 'running', description: 'Docker Engine' },
  ],
  packageCount: 412,
  manifestPath: '/etc/instabox-apps.json',
  apps: [
    {
      name: 'ProxyGate 控制台',
      url: 'https://panel.example.com/login',
      username: 'admin',
      password: 'p@ss<&>',
      notes: '代理池控制台',
    },
    {
      name: '<script>alert(1)</script>',
      url: 'javascript:alert(1)',
      username: 'u',
      password: 'secret',
      notes: '',
    },
  ],
  publicPorts: [
    { port: 8443, protocol: 'https', name: 'gateway', access: 'public', url: 'https://8443-abc.instabox.example/healthz', tokenUrl: '' },
  ],
  warnings: [],
};

const keepalive = { enabled: true, mode: 'lease', expiresAt: '2026-11-14T18:30:00.000Z', autoWake: true, lastOk: true };
const recycle = { enabled: true, status: { status: 'idle', nextAt: '2026-11-14T20:00:00.000Z' } };

function render(overrides) {
  return page.buildMachineCanvasHtml(Object.assign({
    machine,
    account: 'wbi35772',
    connection,
    ports: inventory.publicPorts,
    inventory,
    keepalive,
    recycle,
    generatedAt: '2026-11-14T12:00:00.000Z',
  }, overrides));
}

test('machine canvas renders machine, ssh and app credentials', () => {
  const html = render();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('proxygate'));
  assert.ok(html.includes('m_agq4uw3nnf2ckra45gcrdcoyf4'));
  assert.ok(html.includes('wbi35772'));
  assert.ok(html.includes('ssh -p 2222 ubuntu@ssh.instabox.example'));
  assert.ok(html.includes('ProxyGate 控制台'));
  assert.ok(html.includes('https://panel.example.com/login'));
  assert.ok(html.includes('admin'));
  assert.ok(html.includes('data-secret="p@ss&lt;&amp;&gt;"'));
  assert.ok(html.includes('代理池控制台'));
});

test('machine canvas opens links inside the sandboxed frame instead of target=_blank', () => {
  const html = render();
  assert.ok(!html.includes('target="_blank"'));
  assert.ok(html.includes('data-open="https://panel.example.com/login"'));
  assert.ok(html.includes("window.location.href = href"));
});

test('machine canvas renders ports, listeners, containers and services', () => {
  const html = render();
  assert.ok(html.includes('8443'));
  assert.ok(html.includes('https://8443-abc.instabox.example/healthz'));
  assert.ok(html.includes('docker-proxy'));
  assert.ok(html.includes('o2a-gateway'));
  assert.ok(html.includes('docker.service'));
  assert.ok(html.includes('412'));
});

test('machine canvas escapes untrusted values and refuses javascript urls', () => {
  const html = render();
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('href="javascript:alert(1)"'));
  assert.equal(page.safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(page.safeHttpUrl('https://ok.example/a'), 'https://ok.example/a');
  assert.equal(page.escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
});

test('machine canvas covers a suspended machine without inventory', () => {
  const html = page.buildMachineCanvasHtml({
    machine: Object.assign({}, machine, { state: 'suspended' }),
    account: 'wbi35772',
    inventory: null,
    ports: [],
    connection: null,
  });
  assert.ok(html.includes('机器当前未运行'));
  assert.ok(html.includes('SSH 连接信息不可用'));
  assert.ok(html.includes('没有读到应用清单'));
  assert.ok(!html.includes('undefined'));
});

test('machine canvas includes keepalive, recycle and generated time', () => {
  const html = render();
  assert.ok(html.includes('保活'));
  assert.ok(html.includes('回收'));
  assert.ok(html.includes(page.formatTime('2026-11-14T12:00:00.000Z')));
  assert.ok(html.includes(page.formatTime('2026-11-14T18:30:00.000Z')));
  assert.ok(html.includes(page.formatTime('2026-11-14T20:00:00.000Z')));
});
