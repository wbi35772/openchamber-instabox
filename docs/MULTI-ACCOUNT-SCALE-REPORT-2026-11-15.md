# Instabox 多账号规模化与指纹增强分析报告

> 基线：`openchamber-instabox-matrix` v1.5.0 @ `7a1037a`
> 日期：2026-11-15
> 范围：Instabox 单平台；目标 50 / 200 / 500 账号；本文取代 `docs/MULTI-ACCOUNT-ASSESSMENT.md` 中“现适配 2–5 台”的结论。
> 证据：代码审计 + 现有真机实测。当前只有 1 个账号，100 账号并发尚未做真机压测，文中涉及规模的结论均标注为“代码路径推断/待压测”。

---

## 0. 执行摘要

### 0.1 一句话结论

**账号路由本身已经原生隔离，但“能管几百个账号”还差四层基础设施：持久化与队列、全局调度、代理矩阵、指纹一致性。** 当前代码适合 5–10 个账号的轻量管理；到 50 个账号会先被状态写入、代理端口和全量 fan-out 拖住；到 200–500 个账号必须先改控制面，否则加账号只会放大 429、直连泄漏和关联风险。

### 0.2 最高优先级

| 优先级 | 事项 | 现在的问题 | 不改的后果 |
| --- | --- | --- | --- |
| P0 | 关闭账号流量直连泄漏 | 终端 WebSocket、`testCredentials`、recycle 控制面走直连；浏览器链接也直连 | 宿主真实 IP 暴露，代理隔离形同虚设 |
| P0 | 状态从单 JSON 迁到 SQLite + 队列 | `state.json` 整文件同步写；keepalive/recycle 每次 patch 都落盘 | 100+ 账号时锁竞争、写放大、崩溃恢复困难 |
| P0 | 每账号 1:1 粘性出口 | 当前只有 1 个节点；端口按 `index % 250` 分配，超过 250 会撞端口 | 多账号共用出口，平台侧直接关联 |
| P0 | 全局调度与限流 | 15s 全局 tick + 各接口 `Promise.all` 全账号扇出；recycle 串行 | 同一秒脉冲、429 风暴、单台超时拖垮整轮 |
| P0 | 指纹一致性 | UA 固定 `openchamber-instabox-matrix/1.0.0`（package 已 1.5.0）；Node TLS + HTTP/1.1；所有账号同一套头 | 账号间可被 TLS/头/时序关联；伪造浏览器 UA 反而更可疑 |
| P1 | 密钥加密与最小暴露 | API Key、代理节点 URI 在 `state.json`；`/api/bootstrap` 返回完整 settings | 本机文件/面板/日志泄露即全损 |
| P1 | 面板/MCP 分页与批量 | 面板一次性渲染全部机器；MCP 聚合列举串行 | 200 账号 UI 卡顿，Agent 操作不可用 |
| P1 | 观测与审计 | 无每账号健康分、无代理/指纹指标、无审计日志 | 出问题只能靠猜，无法定位是账号、代理还是平台限流 |

### 0.3 三档目标

| 档位 | 账号/机器 | 推荐架构 | 关键门槛 |
| --- | --- | --- | --- |
| 50 | 50 / 50 | 单进程 + SQLite + 单 sing-box（250 端口） | 关闭直连、每账号独立出口、调度去同步 |
| 200 | 200 / 200 | 单控制面 + worker 池 + 2 个 sing-box 实例（250 端口/实例） | 队列、分页、代理健康、指纹 persona |
| 500 | 500 / 500+ | 控制面 + 2–4 个 worker 分片 + 多 sing-box + 独立探测进程 | 分片、HA、审计、压测、成本 |

### 0.4 不要做

- 不要用“Chrome UA + Node TLS”伪装浏览器；TLS、HTTP/2、头顺序、`sec-ch-ua` 任何一项对不上，比稳定的 SDK 指纹更可疑。
- 不要指望 sing-box 出站的 `utls` 能改变平台看到的 JA3/JA4；它只改“插件→代理服务器”这一跳。
- 不要让多个账号共用一个出口 IP，或每次请求轮换 IP。
- 不要用固定 15s 全局 tick 同时打几百个账号；相位偏移 + 抖动 + 每账号在途 1 是底线。
- 不要把 API Key、代理 URI 放进 `/api/bootstrap`、日志或 Canvas 页面。
- 不要在未抓官方客户端真实请求前凭空编造 Persona。

---

## 1. 现状基线

### 1.1 已经具备的能力

| 能力 | 现状 | 评价 |
| --- | --- | --- |
| 多账号路由 | `accounts[]`；每次请求按 alias 构造客户端，无全局“当前账号”单例 | 隔离方向正确，可保留 |
| 按账号代理 | `lib/account-proxy.js` + `lib/proxy-fetch.js`；每 alias 一个本地 mixed 端口 | 单账号可用，规模化不足 |
| 账号级限流 | `lib/ratelimit.js` 令牌桶 + 429 `retryAfterSeconds` | 有基础，缺全局准入与优先级 |
| keepalive | 15s tick、并发 4、按 key 相位错开 | 小规模可用，缺持久化 nextAt 与分片 |
| 自动回收 | `lib/recycle.js` 双入口；lead = maxRun 10%（clamp 10–30 分钟）；verify 5 容器 + healthz | 逻辑完整，串行循环不适合 100+ |
| 机器元数据/批量 | `machineMeta`、`matrix_tag`、`matrix_exec_batch`、`matrix_inventory_summary` | 已有多账号运营雏形 |
| Canvas | 机器详情生成 artifact，含应用/账号/密码/网络/端口 | 运营可视化已可用 |
| 自更新 | 设置内检查/更新，支持系统/直连/自定义代理 | 运维便利 |
| 测试 | `node --test` 203 pass | 基线可信 |

### 1.2 当前实测配置

| 项 | 值 |
| --- | --- |
| 账号 | 1 个：`wbi35772`（free org） |
| 机器 | `proxygate` / `m_agq4uw3nnf2ckra45gcrdcoyf4`，4 vCPU / 8 GiB / 20 GiB |
| maxRunMinutes | 120 → recycle lead 12 分钟 |
| 免费计划 | 1 机器 / 1 同时运行 / 3 启动每分钟 |
| 代理 | enabled，basePort 24001，size 250，1 个节点 |
| 限流 | 5 rps / concurrency 2 |
| keepalive / recycle | 各 1 条配置 |
| 状态文件 | `~/.openchamber-instabox-matrix/state.json`（600） |
| 出口实测 | `35.91.188.19`（经 24001）；机器内 `35.88.80.47`（历史固定节点复测） |

### 1.3 关键代码路径

| 主题 | 文件 |
| --- | --- |
| Instabox 客户端/UA/头 | `lib/instabox.js` |
| 代理注入 | `lib/proxy-fetch.js`、`lib/account-proxy.js` |
| 账号限流 | `lib/ratelimit.js` |
| 调度/保活 | `lib/scheduler.js`、`lib/keepalive.js`、`lib/leases.js` |
| 回收 | `lib/recycle.js`、`scripts/recycle.js` |
| 状态 | `lib/store.js`、`lib/store-lock.js` |
| 服务 API | `service/main.js` |
| 面板 | `panel/main.js` |
| MCP | `mcp/server.js` |
| sing-box 配置 | `scripts/singbox-up.js`、`lib/sub2port.js` |

---

## 2. 规模化差距总表

| # | 差距 | 严重度 | 证据 | 影响 |
| --- | --- | --- | --- | --- |
| G1 | 单 JSON 整文件写 | P0 | `store.save` 同步写；keepalive/recycle 每 patch 落盘 | 100+ 账号锁竞争、写放大、崩溃丢状态 |
| G2 | 无全局队列/准入 | P0 | 各接口 `Promise.all` 全账号；keepalive 并发 4；recycle 串行 | 429 风暴、单点超时拖垮整轮 |
| G3 | 代理端口取模 | P0 | `basePort + index % size`，size 默认 250 | 251+ 账号撞端口，串出口 |
| G4 | 单节点/无健康 | P0 | 每 alias 1 个 URI；无节点池/健康/地理 | 无法为 100 账号分配独立出口 |
| G5 | 直连泄漏 | P0 | 终端 WS、`testCredentials`、recycle 控制面直连 | 宿主 IP 暴露，账号可被关联 |
| G6 | 固定 UA/头 | P0 | UA `.../1.0.0`（package 1.5.0）；头固定 | 所有账号同一 HTTP 指纹 |
| G7 | Node TLS + HTTP/1.1 | P0 | `proxy-fetch` ALPN 固定 `http/1.1` | 平台看到的 JA3/JA4 全账号一致 |
| G8 | 无 Persona | P0 | 无 `account.persona`；无语言/时区/头顺序 | 无法做账号级差异化 |
| G9 | 无每账号出口校验 | P0 | 无 IP/ASN/geo 探针；代理故障只 quarantine | 不知道某账号是否已串出口 |
| G10 | 无密钥加密 | P1 | `state.json` 明文 API Key/节点 URI | 文件/备份/日志泄露即全损 |
| G11 | bootstrap 过度暴露 | P1 | `/api/bootstrap` 返回完整 settings + 全部 keepalive | 面板/扩展上下文可读节点凭据 |
| G12 | 无分页/虚拟列表 | P1 | 面板一次性渲染全部机器 | 200+ 账号 UI 卡顿 |
| G13 | MCP 聚合串行 | P1 | `list_machines("all")` 串行 | 账号多时 Agent 调用慢 |
| G14 | 无审计/指标 | P1 | 无 per-account health、无代理/指纹指标 | 故障无法定位 |
| G15 | 机器身份复用 | P1 | 同一部署栈/端口名/命名模式；SSH key 策略需审计 | 平台侧可跨账号关联 |
| G16 | 无账号生命周期 | P2 | 无 import/warmup/quota/rotation 状态机 | 批量开户/迁移靠手工 |
| G17 | 多终端单例 | P2 | 面板 `stopTerminal()` 单例 | 运营效率低，但不阻塞 Agent 批量 |
| G18 | 浏览器直连 | P2 | 桌面/SSH 链接由用户浏览器直连 | 多账号网页登录共用宿主 IP/Cookie |

---

## 3. 指纹专题

### 3.1 平台可能看到什么

| 层 | 信号 | 当前状态 | 风险 |
| --- | --- | --- | --- |
| 网络 | 源 IP、ASN、国家、IP 信誉 | 每 alias 一个端口，但只有 1 节点 | 多账号可能同出口 |
| TLS | JA3/JA4、ALPN、SNI、证书 | Node OpenSSL；ALPN `http/1.1` | 全账号同一 TLS 指纹 |
| HTTP | 头顺序/大小写、UA、Accept-Language、`sec-ch-ua`、HTTP/2 设置 | 固定小写头；无语言；无 CH；无 h2 | 全账号同一 HTTP 指纹 |
| 行为 | 请求时序、连接复用、重试、idempotency | 15s tick + 各接口并发扇出 | 同秒脉冲、可预测 |
| 账号 | 邮箱、org、plan、API Key、创建时间 | 手工/少量账号 | 邮箱/命名/时序可关联 |
| 机器 | 主机名、SSH 公钥、容器名、端口、部署路径 | 同一套部署栈 | 跨账号关联 |
| 浏览器 | JS/Canvas/WebGL/字体/时区/WebRTC | 扩展不自动化；用户浏览器直连 | 网页登录共用宿主指纹 |

### 3.2 当前指纹问题（按严重度）

1. **UA 与版本不一致**：`lib/instabox.js` 固定 `openchamber-instabox-matrix/1.0.0`，package 已 1.5.0；所有账号完全相同。
2. **头集合固定**：只有 `accept`、`user-agent`、`x-api-key`、`content-type`；没有 `accept-language`、`accept-encoding` 的账号级差异；头顺序/大小写未做抓包对齐。
3. **TLS 是 Node**：`proxy-fetch.js` 用 `https.Agent` + `ALPNProtocols: ['http/1.1']`；平台看到的是 Node/OpenSSL，不是浏览器。
4. **sing-box uTLS 不解决平台侧**：`sub2port` 的 `utls chrome` 只作用于“插件→节点”这一跳；平台看到的是端到端 Node TLS。
5. **出口未 1:1**：当前 1 个节点；多账号没有节点池/健康/地理/ASN 约束；端口取模会复用。
6. **时序同步**：keepalive 有相位偏移，但 overview/recycle/批量 exec 仍可能同时扇出；无请求级抖动。
7. **直连泄漏**：终端 WebSocket、`testCredentials`、recycle 控制面直连；网页/SSH 链接由用户浏览器直连。
8. **机器身份复用**：同一部署栈、容器名、端口、命名模式；SSH key 是否每账号独立需审计。
9. **无一致性校验**：没有“UA vs TLS vs h2 vs 头 vs IP/ASN/geo”的校验，错了也不知道。
10. **无官方基线**：尚未抓官方 Web/桌面客户端真实请求，Persona 没有依据。

### 3.3 两条路线：API Persona 与 Browser Persona

| 维度 | API Persona | Browser Persona |
| --- | --- | --- |
| 用途 | REST API、keepalive、recycle、MCP | 登录、注册、网页操作、需要 JS 的接口 |
| 默认策略 | 贴合官方客户端/稳定 SDK，不伪造浏览器 | 真实浏览器 + 每账号持久化 profile |
| TLS | Node TLS（SDK 风格）或 curl-impersonate（需要时） | 浏览器自身 TLS，天然一致 |
| 头 | 抓包对齐；账号级语言/版本；头顺序固定 | 浏览器自动生成，不手工伪造 |
| 风险 | 若官方是浏览器，Node TLS 可能被 Cloudflare 标记 | 代理/DNS/WebRTC/IPv6 泄漏是主要风险 |
| 建议 | **先做这个**；稳定、可测试、低成本 | 只在登录/注册/必要页面使用 |

**原则：API 与浏览器不要互相伪装。** 一个 Chrome UA + Node TLS + 缺 `sec-ch-ua` 的组合，是最差解。

### 3.4 API Persona 设计

#### 3.4.1 先抓包，后生成

开工第一步：用 mitmproxy/浏览器抓一次官方 Web 端真实请求，记录：

- 方法/路径/查询参数；
- 头顺序、大小写、UA、`accept-language`、`sec-ch-ua`、`origin/referer`、Cookie 形态；
- HTTP 版本、HTTP/2 设置、连接复用；
- TLS ClientHello（JA3/JA4）、ALPN、SNI；
- 请求间隔与重试行为。

产出 `docs/OFFICIAL-CLIENT-FINGERPRINT.md`，Persona 以此为准。**没有抓包就不编造。**

#### 3.4.2 确定性 Persona

```text
seed = sha256(account.alias + persona.salt)
persona = {
  userAgent, acceptLanguage, headerOrder, httpVersion,
  tlsProfile, timing: {baseMs, jitter, burst}, idempotency: "uuid-v4"
}
```

- 同一账号重启后画像不变；不同账号稳定不同。
- 版本号跟 package 走，不写死；UA 模板可配置。
- 不按请求随机 UA；随机只在“账号创建时”发生一次。

#### 3.4.3 头与协议

- 头顺序/大小写按抓包结果固定；Node `https.request` 可保留 insertion order，需用 `rawHeaders` 回归测试。
- `accept-language` 跟出口国家一致；不要给所有账号 `en-US`。
- `sec-ch-ua` 只在真实 Chromium TLS/浏览器上下文使用；Node TLS 不发。
- HTTP/2：官方用 h2 就上 h2（Node `http2` 或 curl-impersonate）；官方是 h1 就保持 h1。不要“为了现代”强行 h2。
- 连接复用：每账号独立 Agent；代理切换/熔断时 `destroy()`，避免旧出口长连接复用。
- `idempotency` 用 UUIDv4；不要加可关联前缀。

#### 3.4.4 TLS 与 impersonation

- 默认：Node TLS + 稳定 API Persona；先验证平台是否真的拦 Node TLS。
- 若探针显示 JA3/JA4 被 Cloudflare 重点照顾：上 `curl-impersonate` sidecar（`--impersonate chrome124`），Node 通过本地 HTTP 调 sidecar；sidecar 再走每账号代理。
- 备选：真实浏览器执行关键请求，导出 token/cookie 给 Node；但 cookie 与 TLS 的绑定要验证。
- **不要把 sing-box 出站 uTLS 当成平台侧伪装。**

#### 3.4.5 时序

- 每账号 `nextAt` + 相位偏移 + 抖动；不要全局 15s tick。
- 每账号最多 1 个在途请求；全局并发池 16–32。
- 批量操作按优先级排队：用户操作 > keepalive > recycle > 扫描。
- 429 指数退避 + 抖动；单账号熔断，不影响其他账号。

### 3.5 Browser Persona 设计（仅在需要浏览器时）

- 使用 Camoufox/Playwright，每账号一个持久化 profile 目录；Cookie/LocalStorage 不共享。
- 画像字段：UA、platform、locale、timezone（按出口 geo）、screen、deviceScaleFactor、hardwareConcurrency、deviceMemory、WebGL vendor/renderer、canvas/audio noise、fonts、languages、DNT、WebRTC policy。
- 代理：`--proxy-server` 指向该账号 mixed 端口；禁用 QUIC（若代理不支持 UDP）；DNS 走代理；IPv6 不支持就禁用，避免泄漏。
- WebRTC：确保 public IP = 代理出口；否则禁用/限制。
- 验证：`browserleaks.com/webrtc`、`creepjs`、`dnsleaktest.com`；记录指纹 hash。
- 不要过度 patch；保持画像内部一致，比“每个字段都随机”更重要。

### 3.6 出口 IP / ASN / 地理

| 规则 | 建议 |
| --- | --- |
| 账号:出口 | 1:1 粘性；同一账号生命周期尽量不变 |
| 每 IP 账号数 | 默认 1；最多 2–3，且必须不同 Persona、不共享 Cookie |
| 登录/注册 | 住宅/移动 IP，国家与邮箱/手机一致；不要用机房 IP |
| API | 与登录同出口，避免“不可能的旅行”；换 IP 时同国家/同 ASN、渐进 |
| 节点池 | 记录 country/region/ASN/ISP/IP 类型/信誉/延迟/容量 |
| 故障 | 同国同 ASN 优先热替换；无则 quarantine（kill switch），绝不直连 |
| 轮换 | 只在被 block/延迟异常时换；不要每请求轮换 |
| DNS | 通过代理远端解析；本地 DNS 0 命中 |
| IPv6 | 支持则走代理；不支持则禁用，避免宿主 IPv6 泄漏 |

### 3.7 机器与账号身份

- **SSH**：每账号独立 keypair；不要复用公钥；平台能看到公钥。
- **命名**：机器名不要顺序/可预测；用随机词 + 账号短 hash；容器/部署路径加账号前缀（在不破坏业务的前提下）。
- **时间**：创建/启动/部署/回收全部错峰；不要 1 小时内创建 100 台。
- **部署**：Git author/email、提交信息、部署脚本参数按账号区分；避免同一套指纹。
- **快照/模板**：不要所有账号用同一个快照 ID；按账号克隆后改 hostname/timezone/SSH key。
- **配额**：记录 machines/snapshots/concurrent/maxRun；3 启动/分钟；冷却 5–20 / 60–75 / 120–135 分钟；不要撞 abuse 锁。

### 3.8 指纹验收

新增 `scripts/fingerprint-probe.js`（或服务端点），对每个账号经其代理执行：

```text
GET https://tls.peet.ws/api/all      -> JA3/JA4、HTTP2、头、IP
GET https://api.ipify.org?format=json -> 出口 IP
GET https://ipinfo.io/json            -> ASN/国家
DNS leak / WebRTC（浏览器时）          -> 泄漏检查
```

记录：

```text
fingerprint_hash = sha256(ja3 + ja4 + h2 + header_order + ua + accept_language + egress_ip + asn)
```

验收线：

- 同一账号 24h 内指纹稳定；不同账号 fingerprint_hash 不重复。
- 0 个“UA 浏览器 + TLS Node”矛盾组合。
- 0 个 DNS/WebRTC/IPv6 泄漏。
- 每账号出口 IP/ASN/geo 与 Persona 一致；默认 1 账号 1 IP。
- 100 账号 keepalive 时间戳在一个周期内近似均匀，无同秒脉冲。

---

## 4. 目标架构

### 4.1 控制面 / 执行面

```text
OpenChamber panel / MCP
        │
        ▼
本地 HTTP 控制面（单进程，先做到 200 账号）
  ├─ Account service（增删改查/导入/密钥）
  ├─ Job queue + scheduler（优先级/相位/抖动）
  ├─ Proxy manager（sing-box supervisor/节点池/端口注册）
  ├─ Health prober（API/代理/出口/指纹）
  ├─ SQLite（配置 + 运行态 + 审计）
  └─ Worker pool（全局并发 16–32）
        │
        ├─ sing-box #1 :24001-24250
        ├─ sing-box #2 :24251-24500（200+ 账号）
        └─ curl-impersonate sidecar（可选，高风险接口）
```

- 50–200 账号：单进程足够；以事件循环延迟 >100ms 或 CPU >60% 作为分片信号。
- 500 账号：按 `hash(alias) % N` 分片到 2–4 个 worker；控制面只做路由/聚合；每 shard 独立 SQLite 或共享 WAL。

### 4.2 数据模型（SQLite）

```sql
accounts(id, alias, api_key_cipher, gateway, enabled, org, plan,
         country, state, persona_json, created_at, last_seen_at)
proxy_nodes(id, uri_cipher, protocol, host, port, country, asn, isp,
            ip_type, reputation, latency_ms, health, max_accounts, last_checked_at)
proxy_assignments(account_id, node_id, slot_port, sticky,
                  assigned_at, last_egress_ip, last_egress_country)
machines(account_id, machine_id, name, state, plan, max_run_minutes,
         run_started_at, cooldown_until, meta_json, last_seen_at)
keepalive_leases(account_id, machine_id, next_at, last_ok, last_error, attempts)
recycle_runs(id, account_id, machine_id, run_started_at, phase,
             result, started_at, finished_at)
jobs(id, type, account_id, machine_id, payload_json, state, priority,
     attempts, created_at, started_at, finished_at, error)
job_events(id, job_id, at, level, message)
health_samples(id, account_id, machine_id, at, api_latency_ms, proxy_ok,
               egress_ip, egress_country, egress_asn, fingerprint_hash)
audit_log(id, at, actor, action, account_id, machine_id, detail_json)
personas(account_id, seed, api_persona_json, browser_persona_json,
         created_at, updated_at)
settings(key, value_json)
```

- `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;`
- 索引：`accounts(state)`、`machines(account_id,state)`、`keepalive_leases(next_at)`、`jobs(state,priority,created_at)`、`health_samples(account_id,at)`。
- 配置仍可导出 JSON 兼容；运行态不再写 `state.json`。

### 4.3 调度器

- 用最小堆/时间轮替代 15s 全局 tick；分辨率 1s。
- 每账号 `nextAt` 持久化；启动时 RECONCILE。
- 相位：`offset = hash(alias) % interval`；抖动 ±20%；每账号在途 1。
- 车道：`user`(0) / `keepalive`(1) / `recycle`(2) / `scan`(3)；防止扫描饿死保活。
- 全局并发池 16–32；按账号 bulkhead；队列有界，满时拒绝低优先级。

### 4.4 限流与队列

- 每账号令牌桶：rps、burst、concurrency；默认 5/2，可配。
- 全局令牌桶：防止 100 账号同时打满平台。
- 429/5xx：读 `retryAfterSeconds`，指数退避 + 抖动；单账号熔断；全局 429 率告警。
- 幂等：job id + 操作键；同账号同机器同操作在窗口内去重。
- 优先级：用户触发 > 保活 > 回收 > 扫描；批量操作可分片。

### 4.5 代理矩阵 v2

- 端口注册表：`basePort + slot` 显式分配；不再 `index % size`；跨扩展保留段。
- sing-box supervisor：每 250 端口一个实例；锁文件单实例所有者；配置变更先校验再 SIGHUP/重启；失败回滚。
- 节点池：country/ASN/ISP/IP 类型/信誉/延迟/容量；1 账号 1 节点粘性。
- 健康检查：TCP + HTTP trace；记录出口 IP/ASN/geo；失败同国同 ASN 热替换；无则 kill switch。
- 连接池：每账号独立 Agent；换端口/节点/熔断时 `destroy()` + AbortController。
- DNS/IPv6：远端解析；IPv6 支持或禁用；泄漏测试。
- 指标：每端口成功率、延迟、出口变化、quarantine 次数。

### 4.6 密钥与安全

- API Key、代理 URI 加密存储：Windows DPAPI/OS keychain，或 `age`/`libsodium`；密钥不落仓库。
- `state.json` 600；SQLite 600；备份加密。
- `/api/bootstrap` 只返回公开 settings；节点 URI/密钥走单独鉴权端点，面板按需拉取。
- 日志脱敏：`x-api-key`、URI userinfo、Cookie、密码。
- 审计：账号增删、密钥轮换、代理变更、批量操作、设置变更。
- 本地服务 token 保持；面板/扩展上下文最小权限。

### 4.7 观测与告警

- 每账号：请求数、延迟 p50/p95、错误率、429、代理健康、出口 IP/ASN、指纹 hash、keepalive 成功、recycle 成功。
- 全局：队列深度、事件循环延迟、内存、CPU、sing-box 实例状态、端口占用。
- 告警：429 突增、代理 down、出口变化、指纹碰撞、keepalive 连续失败、recycle degraded。
- 导出 JSON/Prometheus；面板健康页。

### 4.8 面板

- 服务端分页 + 虚拟列表；按账号/组/状态/国家/ASN/健康筛选。
- 批量选择与操作：启动/停止/保活/回收/打标签/执行命令。
- Job Center：进度、逐台结果、重试。
- 账号详情：出口 IP/ASN/geo、Persona、代理节点、配额、最近错误。
- 代理地图：节点池、分配、健康、每 IP 账号数。
- 指纹检查器：UA/TLS/HTTP2/头顺序/出口/DNS/WebRTC，一键复测。
- 导入/导出：CSV/JSON；密钥单独导入，不明文展示。
- 多终端：`Map<machineKey, session>`，可选；优先 Job Center。

### 4.9 MCP

- 列表分页：`matrix_accounts_list({page,limit,state,q})`。
- 批量：`matrix_exec_batch` 已存在；补 `matrix_jobs_list`、`matrix_job_result`。
- 健康/指纹：`matrix_health_summary`、`matrix_fingerprint_probe`。
- 代理：`matrix_proxy_nodes`、`matrix_proxy_assign`。
- 账号：`matrix_accounts_import`、`matrix_accounts_rotate`。
- 所有工具：不返回密钥；结构化错误；幂等；速率限制。

---

## 5. 迁移路线

| 阶段 | 工期 | 交付 | 退出标准 |
| --- | --- | --- | --- |
| P0 止血 | 2–3 天 | 关闭终端/测试/控制面直连；UA 跟版本；账号级 `accept-language`；出口校验；指纹基线探针；回归测试 | 0 直连回退；每账号出口可验证；UA/TLS 矛盾 0 |
| P1 控制面 | 1 周 | SQLite + 迁移脚本；密钥加密；Job queue；分页；审计/指标；scheduler v2 | 100 账号 mock 压测通过；状态写 <50ms；无锁竞争 |
| P2 代理矩阵 | 1–2 周 | 端口注册表；节点池；健康/geo/ASN；failover；kill switch；多 sing-box；连接池销毁 | 100 账号 1:1 出口；代理 down 0 直连；同国热替换 |
| P3 规模 UI/MCP | 1 周 | 虚拟列表；批量操作；Job Center；MCP 分页/批量；导入/导出 | 200 账号 UI <2s；批量 100 台可观测 |
| P4 指纹深水 | 1–2 周 | 官方抓包；API Persona；可选 curl-impersonate；Browser Persona；一致性验收 | 指纹 hash 唯一/稳定；0 DNS/WebRTC 泄漏；平台探测通过 |
| P5 500 账号 | 按需 | worker 分片；多 sing-box；HA；备份/恢复；成本模型 | 500 账号 24h 稳定；故障可恢复 |

**顺序理由**：P0 先消除“直连 + 矛盾指纹”这两个会被平台直接看到的硬伤；P1/P2 解决“管得住”；P4 才做“伪装得像”。不要先做 UI 或 Persona 生成器。

---

## 6. 压测与验收

### 6.1 场景

1. 100 账号 × 1 机器：keepalive 15 分钟 TTL，持续 24h。
2. 200 账号：overview 刷新、批量 exec 50 台、recycle 集中到点。
3. 代理故障：随机 kill 一个 sing-box 实例；验证该组账号全部 fail-closed，0 直连。
4. 429 风暴：mock gateway 对 30% 请求返回 429；验证退避/队列/成功率。
5. 状态竞争：MCP + service + recycle 同时写；验证无丢失/无死锁。
6. 指纹回归：100 账号 probe；检查 hash 唯一性/稳定性/一致性。
7. 崩溃恢复：kill -9 控制面；重启后 RECONCILE，无重复回收/重复启动。

### 6.2 SLO

| 指标 | 目标（100 账号） | 目标（500 账号） |
| --- | --- | --- |
| keepalive 成功率 | ≥99.5% | ≥99% |
| API p95 | <2s | <3s |
| 429 占比 | <1% | <2% |
| 直连回退 | 0 | 0 |
| 状态写 p95 | <50ms | <100ms |
| 面板首屏 | <2s | <3s |
| 事件循环延迟 p95 | <50ms | <100ms |
| 内存 | <500MB | <1.5GB |
| 出口唯一性 | 1 账号 1 IP | 1 账号 1 IP |

### 6.3 测试矩阵

- 单元：store/SQLite、scheduler、ratelimit、proxy assignment、persona、port registry、failover。
- 集成：mock gateway + fake proxy；100 账号并发；429/5xx/超时/断连。
- 端到端：真机 2–5 账号（需第二账号）；出口 IP/ASN/geo；终端走代理；recycle 走代理。
- 指纹：tls.peet.ws、ipinfo、dnsleak、browserleaks/creepjs。
- 混沌：sing-box kill、DB lock、进程 kill、磁盘满、网络抖动。
- 安全：密钥扫描、日志脱敏、bootstrap 泄漏、权限。

### 6.4 回滚

- 迁移前备份 `state.json` + SQLite；保留旧读写路径 1 个版本。
- 代理矩阵配置版本化；失败回滚上一版 sing-box 配置。
- Persona 变更按账号灰度；保留旧 fingerprint hash 对照。
- 功能开关：`proxy.mode`、`scheduler.v2`、`persona.enabled`、`sqlite.enabled`。

---

## 7. 风险与未决问题

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 平台反滥用/套餐条款 | 账号暂停、封禁、abuse 锁 | 遵守配额；错峰；预热；不要批量开户/高频创建 |
| 免费计划限制 | 1 机/账号、3 启动/分钟、冷却 | 账号数换机器数；调度器感知 cooldown/maxRun |
| 代理池成本/质量 | 住宅/移动 IP 贵；机房 IP 易被标记 | 节点池分级；登录用住宅，API 可机房但需一致性 |
| TLS impersonation 复杂 | sidecar 维护、跨平台 | 先验证是否必要；必要时 curl-impersonate |
| Node/Electron 兼容 | 安装目录无 node_modules | 零依赖或 vendor；sync.mjs 复制范围 |
| SQLite 迁移 | 状态丢失/并发 | 备份、迁移脚本、双读写、回滚开关 |
| sing-box 多实例 | 端口/内存/配置冲突 | 端口注册表、锁、supervisor |
| 浏览器自动化可检测 | 登录失败 | 真实浏览器 + 住宅 IP + 一致画像；不要过度 patch |
| 官方客户端未抓包 | Persona 失真 | 先抓包；没有基线不生成 |
| 只有 1 个账号 | 多账号结论未压测 | 先 mock 压测；尽快加第二账号做真机 |

### 未决问题

1. 目标账号来源：用户自有账号，还是需要自动注册/验证？后者需要浏览器/邮箱/手机资源。
2. 目标国家/地区与代理预算：决定节点池规模与 IP 类型。
3. Instabox API 是否在 Cloudflare Bot Management 后、是否校验 JA3/JA4；需实测。
4. 官方客户端是浏览器、Electron 还是纯 API SDK；决定 Persona 基线。
5. 是否需要 500 账号，还是 100–200 即可；决定是否分片。
6. 机器是长期常驻还是短周期回收；决定调度与配额策略。
7. 是否允许机房 IP 跑 API；若不允许，成本模型需重算。

---

## 8. 代码索引与草案

### 8.1 现有代码索引

| 主题 | 文件 |
| --- | --- |
| UA/头/请求 | `lib/instabox.js` |
| 代理 fetch | `lib/proxy-fetch.js` |
| 端口分配 | `lib/account-proxy.js` |
| sing-box 配置 | `scripts/singbox-up.js`、`lib/sub2port.js` |
| 限流 | `lib/ratelimit.js` |
| 调度 | `lib/scheduler.js`、`lib/keepalive.js`、`lib/leases.js` |
| 回收 | `lib/recycle.js`、`scripts/recycle.js` |
| 状态 | `lib/store.js`、`lib/store-lock.js` |
| 服务 | `service/main.js` |
| 面板 | `panel/main.js` |
| MCP | `mcp/server.js` |
| 测试 | `tests/*.test.js` |

### 8.2 配置草案

```json
{
  "proxy": {
    "enabled": true,
    "basePort": 24001,
    "size": 250,
    "instances": 2,
    "nodes": {
      "ROLE_A": "vless://UUID@HOST_A:443?type=ws&path=/PATH&security=tls&sni=SNI_A#A"
    },
    "assignments": {
      "ROLE_A": { "port": 24001, "node": "node-a", "sticky": true }
    },
    "health": {
      "intervalSeconds": 300,
      "traceUrl": "https://tls.peet.ws/api/all",
      "failover": "same-country-same-asn",
      "failClosed": true
    }
  },
  "persona": {
    "enabled": true,
    "mode": "api",
    "salt": "CHANGE_ME",
    "tlsProfile": "node",
    "uaTemplate": "openchamber-instabox-matrix/{version}",
    "languageFromEgress": true
  },
  "scheduler": {
    "globalConcurrency": 24,
    "perAccountInFlight": 1,
    "jitter": 0.2,
    "lanes": { "user": 0, "keepalive": 1, "recycle": 2, "scan": 3 }
  },
  "rateLimit": { "rps": 5, "concurrency": 2, "burst": 10 },
  "storage": { "driver": "sqlite", "path": "data/runtime.db", "wal": true }
}
```

### 8.3 新增 API 草案

```text
GET  /api/accounts?page=&limit=&q=&state=
POST /api/accounts/import
POST /api/accounts/:alias/rotate
GET  /api/jobs?state=&account=
GET  /api/jobs/:id
POST /api/jobs/:id/retry
GET  /api/health/summary
GET  /api/proxy/nodes
POST /api/proxy/nodes
POST /api/proxy/assign
POST /api/fingerprint/:alias/probe
GET  /api/audit?account=&from=&to=
```

### 8.4 新增 MCP 工具草案

```text
matrix_accounts_list({page,limit,state,q})
matrix_accounts_import({file|rows, dry_run})
matrix_accounts_rotate({account})
matrix_jobs_list({state,account,limit})
matrix_job_result({job_id})
matrix_health_summary({account?})
matrix_fingerprint_probe({account, browser?})
matrix_proxy_nodes({action:"list|add|assign"})
matrix_audit({account?,from?,to?})
```

---

## 9. 最终建议

1. **先做 P0 止血，不要先做 UI 或 Persona 生成器。** 直连泄漏和固定 UA/TLS 是平台一眼能看到的硬伤。
2. **把“1 账号 1 出口”作为硬约束**，端口显式注册，不再取模；没有健康节点就 fail-closed。
3. **状态与调度先升级**：SQLite + Job queue + 全局并发 + 每账号在途 1；这是 100 账号的地基。
4. **指纹先抓包再设计**：API Persona 稳定、可验证；Browser Persona 只在登录/注册/必要页面使用；TLS impersonation 按实测决定。
5. **用 100 账号 mock 压测做门槛**，再上真机 2–5 账号；500 账号分片放到最后。
6. **所有改动带验收线**：0 直连、出口可验证、指纹 hash 唯一/稳定、429 可控、崩溃可恢复。
