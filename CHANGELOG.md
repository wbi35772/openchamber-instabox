# 变更记录

## 1.6.0 — 2026-11-15

零直连传输层，仓库迁移为私有的 `openchamber-instabox`。

- 新增 `lib/account-transport.js`：每 alias 一个 transport，持有 `fetch`、`connectWebSocket`、`destroy`；无代理端口时构造即抛 `ProxyRequiredError`。
- fail-closed：`ERR_PROXY_REQUIRED_FAIL_CLOSED` / HTTP 503，`service/main.js`、MCP、recycle、keepalive、终端全部关闭直连回退。
- `lib/proxy-fetch.js` 新增 `createTunnelSocketFactory` 与 `createTunnelAgent`；`lib/ws.js` 支持 `agent`，REST 与 WSS 共用 CONNECT 隧道。
- `lib/account-proxy.js` 注册表改存 transport，新增 `requireFetchFor`、`connectWebSocket`、`resolveProxyPort(..., { candidate })`。
- 服务 `/api/test` 支持候选 alias（保存前也走代理）；终端 WSS 经账号代理。
- 仓库改名 `openchamber-instabox`（私有）；扩展 ID `instabox-matrix`、状态目录 `~/.openchamber-instabox-matrix` 不变。
- 版本号统一由 `package.json` 注入（`lib/instabox.js` UA、MCP server、服务）。
- 新增 `docs/canvas/openchamber-instabox-docs.html` 全景文档与 `scripts/docs-canvas.js` 发布脚本。
- 测试 207 条通过。

## 1.5.0 — 2026-11-12

- 机器 Canvas：状态、SSH、公网入口、应用凭据、端口与服务发布为版本化 artifact，同一机器复用并追加版本。
- 自更新：git 通道 `system` / `direct` / `custom`，版本比较、克隆后执行 `sync.mjs`。
- 多账号规模化与指纹分析报告。

## 1.4.0 — 2026-11-11

- 多账号矩阵：alias 路由、机器元数据、批量执行、聚合 overview。
- MCP 工具扩展为 15 个（后续 1.6.0 增至 17）。

## 1.3.0 — 2026-11-07

- 活动租约与 keepalive tick、knock、autoWake、相位错开。
- 自动回收：lead 计算、suspend → resume → verify、bootstrap 与降级。
- 计划任务安装脚本 `scripts/install-recycle-task.ps1`。

## 1.2.0 — 2026-11-06

- SSH Token、桌面访客链接、轮询式 Web 终端。

## 1.1.0 — 2026-11-05

- 服务清单：监听端口、Docker、systemd、`/etc/instabox-apps.json`。
- 文件浏览、预览、下载与上传链接。

## 1.0.0 — 2026-11-04

- 首个版本：多账号面板、机器生命周期、同步 exec、快照与公网端口、本地服务代理与 MCP。
