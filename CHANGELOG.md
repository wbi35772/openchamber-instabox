# 变更记录

## 1.7.1 — 2026-11-17

与 cloudflare 契约补齐：provision / teardown 载荷带 `vmInstanceId`，并支持沙箱内服务端口。

- `lib/cf-bridge.js`：`normalizeProvisionBody` 输出 `vmInstanceId` + `machineId`，接受 `internalPort` / `servicePort` / `targetPort`（1-65535，非法抛 `invalid_internal_port`）；`teardown` 载荷同样带 `vmInstanceId`。
- `service/main.js`：自动 provision 读取 `settings.proxy.tunnels[machineId].internalPort` 并转发。
- `mcp/server.js`：`instabox_provision_cf_tunnel` 新增 `internal_port` 参数，持久化到隧道配置后透传。
- `panel/style.css`：变量收敛为三方统一的 `--oc-*` 矩阵调色板（页面行为不变）。
- 测试同步载荷断言并新增 internalPort 用例；合约对齐测试改为指向真实参考文件，253 条全部通过。

## 1.7.0 — 2026-11-16

Egress Matrix T0：出口管理移交 `openchamber-egress-matrix`（127.0.0.1:19880），实例打通 `openchamber-cloudflare` Argo Tunnel（127.0.0.1:19882）。

- 新增 `core/contract.js`：与 egress / cloudflare 扩展字段 100% 对齐（slot-001~250、24001~24250、STRICT_CONTROL/ELASTIC_DATA、healthState、egressFingerprint、`BLOCKED_HEALTH_STATES`）。
- 新增 `lib/egress-client.js`：19880 HTTP/WS 客户端，租约绑定、槽位探测、换血冻结 ACK、重连与状态缓存。
- 槽位固定：`settings.proxy.slots[alias]` → 矩阵端口推导 → 排序索引+1；>250 抛 `matrix_slot_exhausted`。
- 双平面路由：控制面请求注入 `X-OC-Routing-Plane: STRICT_CONTROL` 与 `Proxy-Authorization: Basic base64("<slot>:STRICT_CONTROL")`。
- 发包前核验槽位实时状态；`QUARANTINED` / `WARP_OVERFLOW` / `ROTATING` fail-closed，零直连。
- 订阅 egress WS：`PRE_ROTATION_FREEZE` 暂停槽位 keepalive/jobs、销毁连接池并 `ack-freeze`；`POST_ROTATION_RESUME` 刷新指纹并恢复。
- `lib/sub2port.js`、`scripts/singbox-up.js`、`scripts/sub2port-serve.js` 默认委托 19880 租约，仅 `--standalone-fallback` 启用本地 sing-box。
- 新增 `lib/cf-bridge.js`：实例 RUNNING 后 `POST /api/v1/cf/tunnel/provision` 并在实例内拉起 `cloudflared tunnel run --token`；销毁时 `teardown`。token 不进入状态、日志或响应。
- MCP 新增 `instabox_provision_cf_tunnel`、`instabox_matrix_slot_status`（共 19 个工具）。
- 面板：顶栏 `OC // INSTABOX-MATRIX`、EGRESS / CLOUDFLARE 状态灯、实例计数、批量保活/回收/同步 Egress；卡片显示槽位/端口、exitIp+/64、publicHostname、双轨进度条。
- 新增 44 条测试（合约、egress client、门禁、CF 桥接、sub2port 委托），总计 252 条通过。

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
