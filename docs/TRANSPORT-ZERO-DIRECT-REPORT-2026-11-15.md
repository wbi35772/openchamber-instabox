# Instabox 零直连传输层改造分析报告（P0-1）

> 基线：`openchamber-instabox-matrix` v1.5.0 @ `6616db9`
> 日期：2026-11-15
> 范围：Node 侧全部出站路径（REST、凭证测试、回收控制面、keepalive 租约、终端 WebSocket）
> 证据：207 条自动化测试 + 本机 sing-box `127.0.0.1:24001` 真机实测。尚未覆盖：OpenChamber 重启后的运行时 fail-closed 断网验证。

---

## 0. 执行摘要

### 0.1 一句话结论

**代理开启时，Node 侧已经没有“悄悄直连”的路径。** 账号 REST 请求、新建账号前的凭证测试、回收链路、keepalive 租约释放、终端 `wss` 全部绑定到该 alias 的本地代理端口；端口不存在时抛 `ERR_PROXY_REQUIRED_FAIL_CLOSED`（HTTP 503），而不是回退 `globalThis.fetch`。

### 0.2 改造前泄漏点

| 路径 | 改造前行为 | 泄漏后果 |
| --- | --- | --- |
| `service/main.js` `clientForAccount` | `proxies.fetchFor(alias)` 返回 `undefined` 时，`InstaboxClient` 回退全局 `fetch` | 面板/MCP 的全部 API 调用直连 |
| `testCredentials`（`/api/test`、新建账号） | 固定用全局 `fetch` | 校验请求直连，且发生在账号入库前 |
| recycle `directClientFor` / `proxyClientFor` | 两条链路都直接 `new InstaboxClient`，只有 verify 用代理 | 列表、快照、关机、代理验证存在直连 |
| `scripts/recycle.js` | `proxiedClientFor` 在 `fetchFor` 为空时静默直连 | cron/CLI 回收直连 |
| `scripts/keepalive-tick.js` | 未接入 `AccountProxy` | 租约续期直连 |
| `lib/keepalive.js` `release()` | 未走调用方注入的客户端 | 面板“解除租约”直连 |
| `lib/terminal.js` → `lib/ws.js` | `https.request` 无 `agent` 选项 | 终端 WebSocket 直连 |
| `mcp/server.js` | `proxies.fetchFor(alias)` 为空即直连 | Agent 工具调用直连 |

这些路径的共同点是：`fetchFor()` 的语义是“有端口就用”，不是“必须有端口”。代理配置存在但端口缺失（alias 未分配、端口池耗尽、显式端口被删）时，失败被静默降级成直连。

### 0.3 改造成果

- 新增 `lib/account-transport.js`：一个 alias 一个 transport，统一持有 `fetch` 与 WebSocket 隧道 Agent，生命周期与代理端口绑定。
- `lib/proxy-fetch.js` 增加 `createTunnelAgent()`：把现有 CONNECT + TLS 升级逻辑复用到 HTTP/WS 的 `Agent.createConnection`，不再复制代理代码。
- `lib/ws.js` 把 `agent` 透传给 `https.request`，终端 `ws://` / `wss://` 都走同一代理端口。
- 所有消费方改为 **fail-closed**：端口缺失即拒绝，不再回退直连。代理关闭（`settings.proxy.enabled !== true`）时保持原有直连语义，这是显式选择退出，不是泄漏。
- 面板新建账号的“测试连接”会带上表单里的 alias，以 `candidate` 模式参与端口分配，保证“保存前测试”也走代理。

---

## 1. 设计

### 1.1 分层

```text
消费方（service / mcp / scripts / keepalive）
        │  alias
        ▼
lib/account-proxy.js     端口解析 + 实例注册表 + status/probe
        │  port
        ▼
lib/account-transport.js 每 alias 的 fetch + WS Agent + 销毁
        │
        ├── lib/proxy-fetch.js   HTTP：CONNECT → TLS → 配额/隔离
        └── lib/ws.js            WS：CONNECT → (TLS) → WebSocket 握手
```

职责边界：

- `account-proxy` 只回答“这个 alias 用哪个端口”，不关心请求内容。
- `account-transport` 不依赖 `InstaboxClient`，可以独立测试；构造时无端口直接抛错。
- `proxy-fetch` 继续负责代理健康（fail-closed、冷却、半开探测），传输层不重复实现。

### 1.2 fail-closed 契约

```js
class ProxyRequiredError extends Error {
  code = 'ERR_PROXY_REQUIRED_FAIL_CLOSED';
  status = 503;
}
```

判定表：

| `proxy.enabled` | 端口可解析 | 行为 |
| --- | --- | --- |
| `true` | 是 | 走该端口 |
| `true` | 否 | 抛 `ProxyRequiredError`；服务层返回 503，回收/MCP 记日志并返回 `null` |
| `false` / 未配置 | — | 直连（用户显式关闭代理） |

服务层 `failure()` 已识别 `error.status`，因此 503 原样返回面板，不再被包装成 500。

### 1.3 端口解析与 candidate 模式

`resolveProxyPort(state, alias, { candidate })` 的顺序：

1. `settings.proxy.ports[alias]` 显式端口优先。
2. 否则按启用账号 alias 排序，`basePort + (index % size)`。
3. `candidate: true` 时，把尚未入库的 alias 插入排序列表再计算，用于“保存前测试连接”。

candidate 只影响本次解析，不写状态；账号保存后由正常路径重新计算。

### 1.4 WebSocket 隧道

`createTunnelSocketFactory(proxy, sockets, { secure })` 原本只支持 TLS 升级；本次增加 `secure: false` 分支，CONNECT 成功后直接回调原始 socket。`createTunnelAgent()` 据此生成：

- `https.Agent`（`wss://`）：CONNECT → `tls.connect`（显式 SNI、ALPN `http/1.1`）。
- `http.Agent`（`ws://`）：CONNECT → 原始 socket。

`lib/ws.js` 只在调用方传入 `agent` 时把它放进 `https.request` 选项；不传时行为与旧版完全一致，因此 `lib/ws.js` 仍是通用模块。

`destroy()` 顺序：关闭 fetch 客户端 → 销毁两个 Agent → 清空残留 socket，避免 keep-alive 隧道把进程或测试挂住。

---

## 2. 改动清单

| 文件 | 改动 | 作用 |
| --- | --- | --- |
| `lib/account-transport.js` | 新增 | 每 alias 的 `fetch` / `connectWebSocket` / `destroy` / `quarantine` / `release` / `state`；无端口抛 `ProxyRequiredError` |
| `lib/proxy-fetch.js` | 修改 | `createTunnelSocketFactory` 支持明文 CONNECT；新增并导出 `createTunnelAgent` |
| `lib/account-proxy.js` | 修改 | 注册表存 `transport`；新增 `requireFetchFor`、`connectWebSocket`；`resolveProxyPort` 支持 candidate；导出 `ProxyRequiredError` |
| `lib/ws.js` | 修改 | 透传 `options.agent` |
| `lib/terminal.js` | 修改 | `create({ connect })` 支持每次调用注入连接器 |
| `service/main.js` | 修改 | `proxyRequired` / `failClosedFetch` / `controlClientFor`；`testCredentials(apiKey, gatewayUrl, alias)`；新建、重测、`/api/test` 传 alias；终端路由走 `proxies.connectWebSocket` |
| `mcp/server.js` | 修改 | `client()` 在代理开启时用 `requireFetchFor`；recycle 两个 client 工厂在 503 时返回 `null` 并记日志 |
| `scripts/recycle.js` | 修改 | 合并 `clientFor` / `proxiedClientFor`，代理开启且无端口时 fail-closed |
| `scripts/keepalive-tick.js` | 修改 | 构建 `AccountProxy`，`clientFor` 走 `requireFetchFor`，结束时 `closeAll()` |
| `lib/keepalive.js` | 修改 | `release()` 优先使用注入的 `clientFor`，关闭直连旁路 |
| `panel/main.js` | 修改 | `/api/test` 请求体带 `alias`（表单值优先） |
| `tests/account-transport.test.js` | 新增 | 无端口 fail-closed、无槽位拒绝直连、WS 经本地 CONNECT 代理回显 |
| `tests/recycle-keepalive.test.js` | 修改 | 租约释放走注入客户端 |

无新增依赖；无状态 schema 变更；无需迁移 `state.json`。

---

## 3. 请求路径对比

| 场景 | 改造前 | 改造后 |
| --- | --- | --- |
| 面板/MCP 调平台 API | 无端口 → 全局 fetch | 无端口 → 503 |
| 新建账号测试连接 | 全局 fetch | 按表单 alias 取 candidate 端口 |
| 账号保存后重测 | 全局 fetch | 该 alias 端口 |
| recycle 列表/快照/电源 | 直连 | 同 alias 端口 |
| recycle 验证 | 代理（可为空则直连） | 同 alias 端口，空则跳过并记录 |
| keepalive tick 续期 | 直连 | 同 alias 端口 |
| keepalive 解除租约 | 直连 | 注入的代理客户端 |
| 终端 `wss` | 直连 | CONNECT 隧道 |
| 代理关闭 | 直连 | 直连（显式退出） |

---

## 4. 验证

### 4.1 自动化

- `npm test`：**207/207 通过**，0 失败。
- 新增用例：
  1. `createTransport` 无端口抛 `ERR_PROXY_REQUIRED_FAIL_CLOSED`，`status === 503`。
  2. `requireFetchFor('ghost')` 在代理开启时不返回直连 fetch，而是抛错；`fetchFor(..., { candidate: true })` 仍可为未入库 alias 分配端口。
  3. 本地 WS 服务 + 本地 CONNECT 代理：`transport.connectWebSocket('ws://…')` 成功握手、发送 `hello`、收到 `echo:hello`，且代理确实建立了一条隧道。
  4. keepalive `release()` 通过注入的 `clientFor` 删除租约，不再构造直连客户端。
- `node --check` 覆盖全部改动文件，无语法错误。

### 4.2 真机

通过本机 sing-box `127.0.0.1:24001`：

| 检查 | 结果 |
| --- | --- |
| 出口 IP（`api.ipify.org`） | `35.91.188.19`，非本机 IP |
| 账号 `wbi35772` `me()` | 成功 |
| 机器 `proxygate` 状态 | running |
| 终端 WebSocket | 经代理建立，回显 `TRANSPORT_OK` |

出口 IP 与回收配置里的 `proxyExitExpect`（`35.88.80.47`）不同，属于 WARP 出口轮换；回收验证按“探测成功”而非固定 IP 判定，不受影响。

### 4.3 安装副本

`node scripts/sync.mjs`：1 个新增、9 个更新、25 个未变；`--check` 干净。需重启 OpenChamber 才会加载新代码。

### 4.4 尚未验证

- 停掉 sing-box 后，面板是否稳定返回 503 而不是回退直连（属于运行时验收，代码路径已由测试覆盖）。
- 浏览器链接、SSH 链接仍由宿主浏览器/终端打开，无法强制走 Node 代理；它们不在本次“零直连”范围内。

---

## 5. 边界与残余风险

| 项 | 说明 | 建议 |
| --- | --- | --- |
| 端口稳定性 | 端口按 alias 排序计算；新增一个排序靠前的 alias 会改变其他账号的端口 | 账号首次分配时把端口写入 `proxy.ports`，做成粘性映射（下一批） |
| 250 端口上限 | 超过 `size` 后 `index % size` 会与已用端口重叠 | 扩容时按 `size` 分段或提前固定显式端口 |
| 空 alias 测试 | 代理开启且表单 alias 为空时，`/api/test` 返回 503 | 面板保存流程已阻止空 alias；如需匿名测试，可生成临时 candidate 名 |
| WS 并发 | 每 transport 每个协议 Agent `maxSockets = 4` | 单终端足够；多终端场景再调 |
| 隔离粒度 | `ProxyRequiredError` 是账号级，不区分“端口池耗尽”和“配置缺失” | 后续在错误详情里带 `reason` |
| 代理关闭 | 直连仍是合法配置 | 生产环境建议默认开启并加状态页提示 |

---

## 6. 运维与回滚

- 部署：`node scripts/sync.mjs` 后重启 OpenChamber。
- 观测：代理隔离会打印 `proxy quarantined <alias> on :<port>`；fail-closed 会打印 `blocked direct ... call for <alias>`。
- 回滚：`git revert <本次提交>` 即可；不涉及状态文件或数据库，回滚后旧版按原逻辑直连。
- 关闭代理：面板把 `proxy.enabled` 设为 false 后，Node 侧恢复直连，无需改代码。

---

## 7. 下一步

1. **SQLite 持久化**（P0-2）：`node:sqlite` 的 `DatabaseSync`，WAL 模式；accounts / machines / leases / recycle_status 分表，替换整文件 `state.json` 写入。
2. **粘性端口表**：账号创建时固定 `proxy.ports[alias]`，并纳入 SQLite，解决新增账号导致端口漂移的问题。
3. **运行时验收**：停 sing-box → 面板操作应 503；恢复后自动解除隔离。
4. **调度器**：每账号在途 1 + 相位偏移，替代 15s 全局 tick 的全量扇出。
