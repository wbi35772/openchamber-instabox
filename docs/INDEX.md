# 文档索引

> 仓库：`wbi35772/openchamber-instabox`（私有） · 扩展 ID：`instabox-matrix` · 当前版本 v1.6.0

## 全景文档（推荐先看）

| 文档 | 内容 |
| --- | --- |
| [`canvas/openchamber-instabox-docs.html`](canvas/openchamber-instabox-docs.html) | 9 个章节的可视化全景文档：总览、架构、零直连、生命周期、面板/MCP/API、数据与安全、质量与验证、路线图、运维手册。内嵌 SVG 架构图、请求时序、回收状态机、租约时间轴、测试分布条形图，支持主题切换、表格搜索、复制与打印。 |

发布到 OpenChamber Canvas（按内容去重，每次变更追加一个版本）：

```powershell
node scripts/docs-canvas.js            # 发布并输出访客 URL
node scripts/docs-canvas.js --no-viewer # 只写 artifact
```

## 分析

| 文档 | 内容 |
| --- | --- |
| [`analysis/MULTI-ACCOUNT-ASSESSMENT.md`](analysis/MULTI-ACCOUNT-ASSESSMENT.md) | 多账号能力评估：账号路由、并发、隔离与局限。 |
| [`analysis/CLOUD-MATRIX-V2-TASK.md`](analysis/CLOUD-MATRIX-V2-TASK.md) | Cloud-Matrix v2 目标与任务拆解。 |
| [`analysis/CLOUD-MATRIX-V2-REVIEW.md`](analysis/CLOUD-MATRIX-V2-REVIEW.md) | Cloud-Matrix v2 设计评审。 |
| [`analysis/CLOUD-MATRIX-V2-PROGRESS-2026-11-12.md`](analysis/CLOUD-MATRIX-V2-PROGRESS-2026-11-12.md) | Cloud-Matrix v2 阶段进展记录。 |

## 报告

| 文档 | 内容 |
| --- | --- |
| [`reports/MULTI-ACCOUNT-SCALE-REPORT-2026-11-15.md`](reports/MULTI-ACCOUNT-SCALE-REPORT-2026-11-15.md) | 50–500 账号规模化：现状基线、P0/P1 差距、指纹专题、目标架构、迁移路线、压测验收。 |
| [`reports/TRANSPORT-ZERO-DIRECT-REPORT-2026-11-15.md`](reports/TRANSPORT-ZERO-DIRECT-REPORT-2026-11-15.md) | 零直连传输改造：8 条泄漏路径、per-alias transport、WS 隧道、fail-closed 语义与验证证据。 |

## 过程记录

| 文档 | 内容 |
| --- | --- |
| [`VERIFICATION.md`](VERIFICATION.md) | v1.3.0 功能验收清单（历史基线）。 |
| [`superpowers/specs/2026-11-13-recycle-design.md`](superpowers/specs/2026-11-13-recycle-design.md) | 自动回收设计规格。 |
| [`superpowers/plans/2026-11-13-recycle.md`](superpowers/plans/2026-11-13-recycle.md) | 自动回收实施计划与任务拆分。 |

## 代码入口

| 路径 | 作用 |
| --- | --- |
| `lib/instabox.js` | Instabox REST 客户端：错误映射、幂等键、限流、超时。 |
| `lib/account-proxy.js` | alias → 端口解析、transport 注册表、status/probe/release。 |
| `lib/account-transport.js` | 每账号的 fetch 与 WebSocket 隧道；无端口 fail-closed。 |
| `lib/proxy-fetch.js` | CONNECT、TLS 升级、配额、隔离、半开探测、隧道 Agent。 |
| `lib/ws.js` | 自实现 WebSocket 客户端。 |
| `lib/terminal.js` | 终端会话：轮询、环形缓冲、输入/缩放、空闲回收。 |
| `lib/keepalive.js` / `lib/leases.js` | 租约续期、knock、autoWake、取消。 |
| `lib/recycle.js` | suspend → resume → verify → bootstrap 回收链。 |
| `lib/store.js` / `lib/store-lock.js` | state.json 默认值、归一化、跨进程锁与原子写。 |
| `lib/canvas.js` / `lib/canvas-page.js` | 机器页 artifact 发布与 HTML 渲染。 |
| `service/main.js` | 本地 HTTP 服务（127.0.0.1），12 组路由。 |
| `mcp/server.js` | MCP stdio 服务，17 个工具。 |
| `scripts/sync.mjs` | 幂等安装与 `--check` 对齐检查。 |

## 维护约定

- 改功能必须同时更新：`README.md` 能力列表、本索引、Canvas 全景文档。
- 发布前：`npm test` 全绿、`node scripts/sync.mjs --check` 干净、版本号与 `package.json` 一致。
- 通用模块（`canvas.js`、`canvas-page.js`、`proxy-fetch.js`、`ws.js`、`scheduler.js`、`ratelimit.js`）禁止依赖 Instabox 客户端或硬编码平台域名/前缀。
