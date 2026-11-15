'use strict';

// Machine canvas page. Pure string builder: callers pass a machine snapshot
// plus its inventory and get one self-contained HTML document. No platform
// names, no network access, no secrets beyond what the snapshot already holds.

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHttpUrl(value) {
  const text = String(value == null ? '' : value).trim();
  if (!/^https?:\/\//i.test(text)) return '';
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return text;
  } catch {
    return '';
  }
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return (index === 0 ? String(Math.round(size)) : size.toFixed(size >= 10 ? 0 : 1)) + ' ' + units[index];
}

function formatDuration(totalSeconds) {
  const seconds = Number(totalSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return days + ' 天 ' + hours + ' 小时';
  if (hours > 0) return hours + ' 小时 ' + minutes + ' 分';
  return minutes + ' 分';
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTime(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
    ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

const STATE_LABELS = {
  running: '运行中',
  suspended: '已暂停',
  stopped: '已停止',
  starting: '启动中',
  stopping: '停止中',
  restarting: '重启中',
  creating: '创建中',
  provisioning: '准备中',
  error: '异常',
  failed: '失败',
  terminated: '已销毁',
  deleted: '已删除',
};

function stateLabel(state) {
  return STATE_LABELS[state] || state || '未知';
}

function stateTone(state) {
  if (state === 'running') return 'ok';
  if (state === 'suspended' || state === 'stopped' || state === 'starting' || state === 'stopping') return 'warn';
  if (state === 'error' || state === 'failed') return 'bad';
  return '';
}

function uptimeSeconds(machine) {
  const direct = Number(machine && machine.uptimeSeconds);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const started = machine && (machine.runStartedAt || machine.startedAt || machine.powerOnAt);
  if (!started) return null;
  const startedAt = Date.parse(started);
  if (!Number.isFinite(startedAt)) return null;
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

function secretCell(password) {
  const value = String(password == null ? '' : password);
  if (!value) return '<span class="muted">—</span>';
  return [
    '<span class="secret" data-secret="' + escapeHtml(value) + '" data-shown="0">',
    '<span class="secret-text" aria-hidden="true">••••••</span>',
    '<button type="button" class="mini" data-reveal>显示</button>',
    '<button type="button" class="mini" data-copy="' + escapeHtml(value) + '">复制</button>',
    '</span>',
  ].join('');
}

function copyButton(value, label) {
  const text = String(value == null ? '' : value);
  if (!text) return '';
  return '<button type="button" class="mini" data-copy="' + escapeHtml(text) + '">' + escapeHtml(label || '复制') + '</button>';
}

function openLink(href, text, className) {
  const safe = safeHttpUrl(href);
  if (!safe) return '';
  return '<a class="' + className + '" href="' + escapeHtml(safe) + '" data-open="' + escapeHtml(safe) + '" rel="noopener noreferrer">' +
    escapeHtml(text) + '</a>';
}

function openButton(url, label) {
  const href = safeHttpUrl(url);
  if (!href) return '';
  return openLink(href, (label || '打开') + ' ↗', 'btn');
}

function statCard(label, value) {
  return [
    '<div class="stat">',
    '<span class="stat-label">' + escapeHtml(label) + '</span>',
    '<strong class="stat-value">' + escapeHtml(value) + '</strong>',
    '</div>',
  ].join('');
}

function emptyRow(columns, text) {
  return '<tr><td colspan="' + columns + '" class="empty-cell">' + escapeHtml(text) + '</td></tr>';
}

function appBlock(app) {
  const url = safeHttpUrl(app.url);
  const notes = String(app.notes || '').trim();
  return [
    '<article class="app">',
    '<div class="app-head">',
    '<div class="app-title">',
    '<h3>' + escapeHtml(app.name || url || '未命名应用') + '</h3>',
    notes ? '<p class="app-notes">' + escapeHtml(notes) + '</p>' : '',
    '</div>',
    '<div class="app-actions">' + openButton(url) + '</div>',
    '</div>',
    url ? '<div class="app-url">' + openLink(url, url, '') + copyButton(url, '复制链接') + '</div>' : '<div class="app-url muted">未提供地址</div>',
    '<div class="cred-row">',
    '<div class="cred"><span class="cred-label">账号</span><code>' + escapeHtml(app.username || '—') + '</code>' + copyButton(app.username) + '</div>',
    '<div class="cred"><span class="cred-label">密码</span>' + secretCell(app.password) + '</div>',
    '</div>',
    '</article>',
  ].join('');
}

function renderApps(inventory, machine) {
  const apps = inventory && Array.isArray(inventory.apps) ? inventory.apps : [];
  const header = [
    '<div class="section-head">',
    '<h2>应用与登录信息</h2>',
    '<div class="section-tools"><button type="button" class="mini" data-reveal-all data-on="0">显示全部密码</button></div>',
    '</div>',
    '<p class="section-hint">本页包含机器内应用的登录信息，链接自带访问令牌，请勿外发。链接在当前画布内打开；若目标应用禁止嵌入，复制地址到浏览器。</p>',
  ].join('');
  if (!apps.length) {
    return header + [
      '<div class="empty-box">',
      '<p><strong>没有读到应用清单。</strong>在机器里写入 <code>' + escapeHtml((inventory && inventory.manifestPath) || '/etc/instabox-apps.json') + '</code> 后重新生成画布。</p>',
      '<details><summary>清单格式（只读示例）</summary><pre>' + escapeHtml(JSON.stringify({
        apps: [
          {
            name: 'ProxyGate',
            url: 'https://panel.example.com',
            username: 'admin',
            password: 'change-me',
            notes: '代理池控制台',
          },
        ],
      }, null, 2)) + '</pre></details>',
      '</div>',
    ].join('');
  }
  return header + '<div class="app-grid">' + apps.map(appBlock).join('') + '</div>';
}

function renderPublicPorts(ports) {
  const list = Array.isArray(ports) ? ports.filter((entry) => entry && entry.port) : [];
  if (!list.length) return '<div class="empty-box"><p>还没有发布公网端口。到「端口」里发布后刷新本页。</p></div>';
  const rows = list.map((entry) => {
    const url = safeHttpUrl(entry.tokenUrl) ? entry.tokenUrl : entry.url;
    const href = safeHttpUrl(url);
    return [
      '<tr>',
      '<td>' + escapeHtml(entry.name || '—') + '</td>',
      '<td class="mono">' + escapeHtml(entry.port) + '</td>',
      '<td>' + escapeHtml(entry.protocol || 'http') + '</td>',
      '<td>' + escapeHtml(entry.access || 'public') + '</td>',
      '<td class="url-cell">' + (href
        ? openLink(href, href, '')
        : escapeHtml(entry.url || '—')) + '</td>',
      '<td class="actions">' + openButton(href) + copyButton(href, '复制') + '</td>',
      '</tr>',
    ].join('');
  });
  return [
    '<div class="table-wrap"><table>',
    '<thead><tr><th>名称</th><th>端口</th><th>协议</th><th>访问</th><th>地址</th><th>操作</th></tr></thead>',
    '<tbody>' + rows.join('') + '</tbody>',
    '</table></div>',
  ].join('');
}

function renderListeners(inventory) {
  const list = inventory && Array.isArray(inventory.listeningPorts) ? inventory.listeningPorts.slice(0, 80) : [];
  if (!list.length) return '<div class="empty-box"><p>没有采集到监听端口（机器未运行，或扫描时没有权限）。</p></div>';
  const rows = list.map((entry) => [
    '<tr>',
    '<td class="mono">' + escapeHtml(entry.port) + '</td>',
    '<td>' + escapeHtml(entry.protocol || '—') + '</td>',
    '<td class="mono">' + escapeHtml(entry.address || '*') + '</td>',
    '<td>' + escapeHtml(entry.process || '—') + '</td>',
    '<td class="mono">' + escapeHtml(entry.pid == null ? '—' : entry.pid) + '</td>',
    '</tr>',
  ].join(''));
  return [
    '<div class="table-wrap"><table>',
    '<thead><tr><th>端口</th><th>协议</th><th>监听地址</th><th>进程</th><th>PID</th></tr></thead>',
    '<tbody>' + rows.join('') + '</tbody>',
    '</table></div>',
    list.length >= 80 ? '<p class="section-hint">只显示前 80 个监听端口。</p>' : '',
  ].join('');
}

function portMapping(container) {
  const ports = container && Array.isArray(container.ports) ? container.ports : [];
  if (!ports.length) return '—';
  return ports.map((entry) => {
    return (entry.hostPort ? escapeHtml(entry.hostPort) + '→' : '') + escapeHtml(entry.containerPort) + '/' + escapeHtml(entry.protocol || 'tcp');
  }).join('<br>');
}

function renderContainers(inventory) {
  const list = inventory && Array.isArray(inventory.containers) ? inventory.containers : [];
  if (!list.length) return '<div class="empty-box"><p>没有容器（机器未安装 Docker/Podman，或没有运行中的容器）。</p></div>';
  const rows = list.map((entry) => [
    '<tr>',
    '<td>' + escapeHtml(entry.name || entry.id || '—') + '</td>',
    '<td class="mono">' + escapeHtml(entry.image || '—') + '</td>',
    '<td>' + escapeHtml(entry.state || '—') + (entry.status ? '<span class="muted"> · ' + escapeHtml(entry.status) + '</span>' : '') + '</td>',
    '<td class="mono">' + portMapping(entry) + '</td>',
    '<td>' + escapeHtml([entry.project, entry.service].filter(Boolean).join(' / ') || '—') + '</td>',
    '</tr>',
  ].join(''));
  return [
    '<div class="table-wrap"><table>',
    '<thead><tr><th>名称</th><th>镜像</th><th>状态</th><th>端口</th><th>项目 / 服务</th></tr></thead>',
    '<tbody>' + rows.join('') + '</tbody>',
    '</table></div>',
  ].join('');
}

function renderServices(inventory) {
  const list = inventory && Array.isArray(inventory.services) ? inventory.services : [];
  if (!list.length) return '<div class="empty-box"><p>没有采集到运行中的 systemd 服务。</p></div>';
  const rows = list.map((entry) => [
    '<tr>',
    '<td class="mono">' + escapeHtml(entry.unit || '—') + '</td>',
    '<td>' + escapeHtml([entry.active, entry.sub].filter(Boolean).join(' / ') || '—') + '</td>',
    '<td>' + escapeHtml(entry.description || '—') + '</td>',
    '</tr>',
  ].join(''));
  return [
    '<div class="table-wrap"><table>',
    '<thead><tr><th>单元</th><th>状态</th><th>描述</th></tr></thead>',
    '<tbody>' + rows.join('') + '</tbody>',
    '</table></div>',
  ].join('');
}

function renderHost(inventory) {
  const host = (inventory && inventory.host) || {};
  const disk = host.disk || {};
  const rows = [
    ['主机名', host.hostname || '—'],
    ['系统', [host.os, host.arch].filter(Boolean).join(' · ') || '—'],
    ['内核', host.kernel || '—'],
    ['CPU', host.cpuCount ? host.cpuCount + ' vCPU' : '—'],
    ['内存', host.memoryTotalBytes ? formatBytes(host.memoryTotalBytes) : '—'],
    ['磁盘', disk.totalBytes ? formatBytes(disk.usedBytes) + ' / ' + formatBytes(disk.totalBytes) + (disk.usedPct ? '（' + disk.usedPct + '%）' : '') : '—'],
    ['负载', Array.isArray(host.loadAverage) ? host.loadAverage.map((n) => Number(n).toFixed(2)).join(' ') : (host.loadAverage || '—')],
    ['已装软件包', inventory && inventory.packageCount ? String(inventory.packageCount) : '—'],
  ];
  return '<div class="kv-grid">' + rows.map((pair) => [
    '<div class="kv">',
    '<span class="kv-label">' + escapeHtml(pair[0]) + '</span>',
    '<span class="kv-value">' + escapeHtml(pair[1]) + '</span>',
    '</div>',
  ].join('')).join('') + '</div>';
}

function renderConnection(connection, machine) {
  if (!connection || !connection.host) {
    return '<div class="empty-box"><p>机器未运行，SSH 连接信息不可用。</p></div>';
  }
  const command = 'ssh -p ' + connection.port + ' ' + connection.username + '@' + connection.host;
  return [
    '<div class="kv-grid">',
    '<div class="kv"><span class="kv-label">主机</span><span class="kv-value mono">' + escapeHtml(connection.host) + '</span></div>',
    '<div class="kv"><span class="kv-label">端口</span><span class="kv-value mono">' + escapeHtml(connection.port) + '</span></div>',
    '<div class="kv"><span class="kv-label">用户</span><span class="kv-value mono">' + escapeHtml(connection.username) + '</span></div>',
    '<div class="kv"><span class="kv-label">机器 ID</span><span class="kv-value mono">' + escapeHtml(machine.id) + '</span></div>',
    '</div>',
    '<div class="cmd-row"><code>' + escapeHtml(command) + '</code>' + copyButton(command, '复制命令') + '</div>',
  ].join('');
}

function renderLifecycle(machine, keepalive, recycle) {
  const uptime = uptimeSeconds(machine);
  const ka = keepalive || null;
  const status = recycle && recycle.status ? recycle.status : null;
  const rows = [
    ['状态', stateLabel(machine.state)],
    ['连续运行', uptime == null ? '—' : formatDuration(uptime)],
    ['最长运行', machine.maxRunMinutes ? machine.maxRunMinutes + ' 分钟' : '—'],
    ['空闲暂停', machine.autoSuspendAfterSeconds ? formatDuration(machine.autoSuspendAfterSeconds) : '—'],
    ['保活', ka && ka.enabled ? (ka.mode || 'lease') : '关闭'],
    ['租约至', ka && ka.expiresAt ? formatTime(ka.expiresAt) : '—'],
    ['冷却唤醒', ka && ka.autoWake ? '开' : '关'],
    ['上次唤醒', ka && ka.lastWakeAt ? formatTime(ka.lastWakeAt) + (ka.lastWakeAction ? '（' + ka.lastWakeAction + '）' : '') : '—'],
    ['回收状态', status ? (status.status || '—') : '—'],
    ['下次回收', status && status.nextAt ? formatTime(status.nextAt) : '—'],
    ['上次回收', status && status.lastRecycleAt ? formatTime(status.lastRecycleAt) : '—'],
    ['最近错误', (status && status.lastError) || (ka && ka.lastError) || '无'],
  ];
  return '<div class="kv-grid">' + rows.map((pair) => [
    '<div class="kv">',
    '<span class="kv-label">' + escapeHtml(pair[0]) + '</span>',
    '<span class="kv-value' + (pair[0] === '最近错误' && pair[1] !== '无' ? ' bad-text' : '') + '">' + escapeHtml(pair[1]) + '</span>',
    '</div>',
  ].join('')).join('') + '</div>';
}

function buildMachineCanvasHtml(input) {
  const data = input || {};
  const machine = data.machine || {};
  const inventory = data.inventory || null;
  const connection = data.connection || null;
  const ports = Array.isArray(data.ports) ? data.ports : (inventory && Array.isArray(inventory.publicPorts) ? inventory.publicPorts : []);
  const account = data.account || machine.account || '';
  const generatedAt = data.generatedAt || new Date().toISOString();
  const warnings = Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : [];
  if (inventory && Array.isArray(inventory.warnings)) warnings.push(...inventory.warnings);
  const counts = {
    apps: inventory && Array.isArray(inventory.apps) ? inventory.apps.length : 0,
    publicPorts: ports.length,
    listeners: inventory && Array.isArray(inventory.listeningPorts) ? inventory.listeningPorts.length : 0,
    containers: inventory && Array.isArray(inventory.containers) ? inventory.containers.length : 0,
    services: inventory && Array.isArray(inventory.services) ? inventory.services.length : 0,
  };
  const spec = [
    machine.vcpus ? machine.vcpus + ' vCPU' : '',
    machine.memMiB ? machine.memMiB + ' MiB' : '',
  ].filter(Boolean).join(' · ');
  const template = machine.template ? String(machine.template.id || '') + (machine.template.version ? '@' + machine.template.version : '') : '';
  const title = (machine.name || machine.id || 'Instabox 机器') + ' · 机器画布';
  const notRunning = machine.state && machine.state !== 'running';

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<title>' + escapeHtml(title) + '</title>',
    '<style>',
    CSS,
    '</style>',
    '</head>',
    '<body>',
    '<main class="page">',

    '<header class="hero">',
    '<div>',
    '<p class="eyebrow">Instabox Matrix · ' + escapeHtml(account || '账号') + '</p>',
    '<h1>' + escapeHtml(machine.name || machine.id || '机器') + '</h1>',
    '<p class="mono subtle">' + escapeHtml(machine.id || '') + '</p>',
    '</div>',
    '<div class="hero-side">',
    '<span class="pill ' + stateTone(machine.state) + '">' + escapeHtml(stateLabel(machine.state)) + '</span>',
    machine.free ? '<span class="pill">免费计划</span>' : '',
    spec ? '<span class="pill">' + escapeHtml(spec) + '</span>' : '',
    template ? '<span class="pill mono">' + escapeHtml(template) + '</span>' : '',
    '</div>',
    '</header>',

    notRunning ? '<div class="banner warn">机器当前未运行：网络与清单来自上次扫描缓存，SSH 与公网入口可能不可用。</div>' : '',

    '<section class="stats">',
    statCard('应用', String(counts.apps)),
    statCard('公网入口', String(counts.publicPorts)),
    statCard('监听端口', String(counts.listeners)),
    statCard('容器', String(counts.containers)),
    statCard('系统服务', String(counts.services)),
    statCard('连续运行', uptimeSeconds(machine) == null ? '—' : formatDuration(uptimeSeconds(machine))),
    '</section>',

    '<section>',
    '<div class="section-head"><h2>应用与登录信息</h2></div>',
    '</section>',

    renderApps(inventory, machine),

    '<section>',
    '<div class="section-head"><h2>公网入口</h2><div class="section-tools"><span class="muted">已发布端口</span></div></div>',
    renderPublicPorts(ports),
    '</section>',

    '<section>',
    '<div class="section-head"><h2>网络配置</h2></div>',
    renderConnection(connection, machine),
    '</section>',

    '<section>',
    '<div class="section-head"><h2>监听端口</h2><span class="muted">来自机器内 ss/netstat</span></div>',
    renderListeners(inventory),
    '</section>',

    '<section>',
    '<div class="section-head"><h2>容器</h2></div>',
    renderContainers(inventory),
    '</section>',

    '<section>',
    '<div class="section-head"><h2>主机</h2></div>',
    renderHost(inventory),
    '</section>',

    '<section>',
    '<div class="section-head"><h2>运行中的系统服务</h2></div>',
    renderServices(inventory),
    '</section>',

    '<section>',
    '<div class="section-head"><h2>保活与回收</h2></div>',
    renderLifecycle(machine, data.keepalive, data.recycle),
    '</section>',

    warnings.length ? '<section><div class="section-head"><h2>提示</h2></div><ul class="warnings">' +
      warnings.map((warning) => '<li>' + escapeHtml(warning) + '</li>').join('') + '</ul></section>' : '',

    '<footer class="foot">',
    '<span>生成于 ' + escapeHtml(formatTime(generatedAt)) + '</span>',
    inventory && inventory.scannedAt ? '<span>清单扫描于 ' + escapeHtml(formatTime(inventory.scannedAt)) + '</span>' : '<span>清单未扫描</span>',
    inventory && inventory.manifestPath ? '<span>清单路径 <code>' + escapeHtml(inventory.manifestPath) + '</code></span>' : '',
    '<span>账号 <code>' + escapeHtml(account || '—') + '</code></span>',
    '</footer>',

    '</main>',
    '<script>',
    SCRIPT,
    '</script>',
    '</body>',
    '</html>',
  ].join('\n');
}

const CSS = String.raw`
:root {
  color-scheme: light dark;
  --bg: #f5f6f8;
  --panel: #ffffff;
  --text: #14181f;
  --muted: #667085;
  --line: #e3e6ec;
  --accent: #0f766e;
  --accent-soft: #e6f4f1;
  --warn: #b45309;
  --warn-soft: #fef3c7;
  --bad: #b91c1c;
  --bad-soft: #fee2e2;
  --ok: #047857;
  --ok-soft: #d1fae5;
  --mono: ui-monospace, SFMono-Regular, "Cascadia Code", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --panel: #151b23;
    --text: #e6edf3;
    --muted: #8b98a9;
    --line: #26303b;
    --accent: #2dd4bf;
    --accent-soft: #10312e;
    --warn: #fbbf24;
    --warn-soft: #3a2a0c;
    --bad: #f87171;
    --bad-soft: #3a1414;
    --ok: #34d399;
    --ok-soft: #0d2f24;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
body { font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif; }
.page { max-width: 1080px; margin: 0 auto; padding: 28px 20px 48px; display: flex; flex-direction: column; gap: 26px; }
.hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.eyebrow { margin: 0 0 4px; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--accent); font-weight: 600; }
h1 { margin: 0; font-size: 26px; letter-spacing: -0.01em; }
h2 { margin: 0; font-size: 15px; letter-spacing: 0.01em; }
h3 { margin: 0; font-size: 14.5px; }
.subtle { color: var(--muted); margin: 4px 0 0; font-size: 12px; }
.mono, code, pre { font-family: var(--mono); }
.hero-side { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.pill { border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 3px 10px; font-size: 11.5px; color: var(--muted); }
.pill.ok { color: var(--ok); border-color: var(--ok); background: var(--ok-soft); }
.pill.warn { color: var(--warn); border-color: var(--warn); background: var(--warn-soft); }
.pill.bad { color: var(--bad); border-color: var(--bad); background: var(--bad-soft); }
.banner { border-radius: 10px; padding: 10px 14px; font-size: 12.5px; border: 1px solid var(--line); background: var(--panel); }
.banner.warn { border-color: var(--warn); background: var(--warn-soft); color: var(--warn); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 10px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; }
.stat-label { font-size: 11px; color: var(--muted); letter-spacing: 0.04em; }
.stat-value { font-size: 19px; font-weight: 650; }
section { display: flex; flex-direction: column; gap: 10px; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.section-hint { margin: 0; color: var(--muted); font-size: 12px; }
.section-tools { display: flex; gap: 8px; }
.app-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.app { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.app-head { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
.app-notes { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
.app-url { font-size: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.app-url a { color: var(--accent); text-decoration: none; word-break: break-all; }
.cred-row { display: flex; gap: 14px; flex-wrap: wrap; }
.cred { display: flex; align-items: center; gap: 6px; min-width: 0; }
.cred-label { font-size: 11px; color: var(--muted); }
.cred code { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; font-size: 12px; }
.secret { display: inline-flex; align-items: center; gap: 6px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; }
.secret-text { font-family: var(--mono); font-size: 12px; word-break: break-all; }
.secret[data-shown="1"] .secret-text { color: var(--accent); }
.mini, .btn { border: 1px solid var(--line); background: var(--panel); color: var(--text); border-radius: 7px; padding: 3px 8px; font-size: 11.5px; cursor: pointer; text-decoration: none; line-height: 1.5; }
.mini:hover, .btn:hover { border-color: var(--accent); color: var(--accent); }
.btn { display: inline-block; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 11px; letter-spacing: 0.04em; color: var(--muted); font-weight: 600; background: var(--bg); }
tr:last-child td { border-bottom: 0; }
td.actions { display: flex; gap: 6px; }
td.url-cell { word-break: break-all; }
td.url-cell a, .cmd-row code { color: var(--accent); }
.empty-cell { color: var(--muted); text-align: center; padding: 22px; }
.empty-box { border: 1px dashed var(--line); border-radius: 12px; padding: 16px; color: var(--muted); background: var(--panel); }
.empty-box p { margin: 0 0 8px; }
.empty-box code, .foot code { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 1px 5px; color: var(--text); }
details summary { cursor: pointer; font-size: 12px; }
pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 11.5px; }
.kv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.kv { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.kv-label { font-size: 11px; color: var(--muted); }
.kv-value { font-size: 12.5px; word-break: break-all; }
.kv-value.bad-text { color: var(--bad); }
.cmd-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cmd-row code { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; font-size: 12px; word-break: break-all; }
.muted { color: var(--muted); }
.warnings { margin: 0; padding-left: 18px; color: var(--warn); font-size: 12.5px; }
.foot { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--muted); font-size: 11.5px; border-top: 1px solid var(--line); padding-top: 14px; }
`;

const SCRIPT = String.raw`
(function () {
  function copyText(value, button) {
    function done() {
      var label = button.textContent;
      button.textContent = '已复制';
      setTimeout(function () { button.textContent = label; }, 1400);
    }
    function fallback() {
      var area = document.createElement('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); done(); } catch (error) { button.textContent = '复制失败'; }
      area.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done, fallback);
    } else {
      fallback();
    }
  }
  function setSecret(box, shown) {
    box.setAttribute('data-shown', shown ? '1' : '0');
    var text = box.querySelector('.secret-text');
    if (text) text.textContent = shown ? box.getAttribute('data-secret') : '••••••';
    var button = box.querySelector('[data-reveal]');
    if (button) button.textContent = shown ? '隐藏' : '显示';
  }
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var open = target.closest('[data-open]');
    if (open) {
      event.preventDefault();
      var href = open.getAttribute('data-open');
      if (href) window.location.href = href;
      return;
    }
    var copy = target.closest('[data-copy]');
    if (copy) {
      copyText(copy.getAttribute('data-copy') || '', copy);
      return;
    }
    var reveal = target.closest('[data-reveal]');
    if (reveal) {
      var box = reveal.closest('.secret');
      if (box) setSecret(box, box.getAttribute('data-shown') !== '1');
      return;
    }
    var all = target.closest('[data-reveal-all]');
    if (all) {
      var show = all.getAttribute('data-on') !== '1';
      all.setAttribute('data-on', show ? '1' : '0');
      all.textContent = show ? '隐藏全部密码' : '显示全部密码';
      Array.prototype.forEach.call(document.querySelectorAll('.secret'), function (entry) {
        setSecret(entry, show);
      });
    }
  });
})();
`;

module.exports = {
  buildMachineCanvasHtml,
  escapeHtml,
  safeHttpUrl,
  formatBytes,
  formatDuration,
  formatTime,
  stateLabel,
};
