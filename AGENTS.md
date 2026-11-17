# AGENTS.md

## 项目定位

`openchamber-instabox` 是 OpenChamber 的 Instabox 多账号机器矩阵扩展。

- 仓库：`wbi35772/openchamber-instabox`（私有）
- 扩展 ID：`instabox-matrix`（不要改，宿主 `extensions.json`、面板路由与 MCP 配置都依赖它）
- 状态目录：`~/.openchamber-instabox-matrix`（含 API Key，0600；不要提交、打印或写入 Canvas）
- Node 22+，CommonJS；无运行时 npm 依赖，安装副本没有 `node_modules`

## 常用命令

```powershell
npm test                       # node --test，全量 252 条
node scripts/sync.mjs          # 同步到 %USERPROFILE%\.config\openchamber\extensions\instabox-matrix
node scripts/sync.mjs --check  # 只比对，必须干净
node scripts/docs-canvas.js    # 重新发布 docs/canvas 全景文档到 Canvas
node scripts/recycle.js --dry-run
node scripts/keepalive-tick.js
```

改完代码后必须跑 `npm test` 与 `node scripts/sync.mjs --check`；重启 OpenChamber 才加载新扩展。

## 硬约束

1. **零直连**：`proxy.enabled === true` 时任何 Node 侧出站（REST、WSS、recycle、keepalive、凭证测试）必须走该 alias 的代理端口；无端口抛 `ProxyRequiredError`（`ERR_PROXY_REQUIRED_FAIL_CLOSED` / 503），禁止回退 `globalThis.fetch`。只有 `proxy.enabled !== true` 才允许直连。
2. **零依赖**：只用 `node:` 内置模块。`node:sqlite` 用 `DatabaseSync`，不要引 `better-sqlite3`。
3. **通用模块隔离**：`lib/canvas.js`、`lib/canvas-page.js`、`lib/proxy-fetch.js`、`lib/ws.js`、`lib/scheduler.js`、`lib/ratelimit.js` 不得 `require('./instabox')`、不得硬编码平台域名或 `ibk_` / `m_` 前缀，必须能整文件复制到其他矩阵扩展。`tests/generic-isolation.test.js` 会检查。
4. **版本单一来源**：`package.json` 的 `version` 由 `lib/instabox.js`（UA）、`mcp/server.js`、`service/main.js` 读取，不要再写死版本号。
5. **状态写入**：所有读改写走 `store.update()` / `withStateLock`，原子写；不要在业务代码里直接 `fs.writeFile` 状态文件。
6. **写操作幂等**：生命周期与快照写请求带 `Idempotency-Key`；删除需要 `X-Confirm-Delete` 与名称确认。

## 文档维护

改功能时同步更新：

- `README.md` 能力列表
- `docs/INDEX.md`
- `docs/canvas/openchamber-instabox-docs.html`（改完执行 `node scripts/docs-canvas.js` 追加 Canvas 版本）
- `CHANGELOG.md`

## 已知边界

- 浏览器 / SSH 外链由宿主打开，不经过 Node 代理，不在零直连范围内。
- 账号槽位固定 `slot-001`~`slot-250`（端口 24001–24250）；新账号优先用 `settings.proxy.slots[alias]` 固定，未固定时按排序索引 +1，超出 250 抛 `matrix_slot_exhausted`。
- 排障：面板无机器先查槽位是否 `UNKNOWN`。`settings.proxy.ports[alias]` 落在 24001–24250 会按端口反推槽位，与 bus 实际槽位不一致时所有请求 503；用 `settings.proxy.slots[alias]` 固定到 bus 上 ACTIVE 的槽位，改完刷新面板即可（服务每请求重读状态）。
- 出口与换血由 `openchamber-egress-matrix`（127.0.0.1:19880）负责，CF 隧道由 `openchamber-cloudflare`（127.0.0.1:19882）负责；两者都不可达时按 fail-closed 处理，不做直连回退。
- Canvas 访客页运行在 `sandbox allow-scripts`，链接必须用 `data-open` + `location.href` 自导航，不能用 `target=_blank`。
- 机器 Canvas 复用 artifact 追加版本；目标站点 `X-Frame-Options: DENY` 时只能复制到浏览器打开。
