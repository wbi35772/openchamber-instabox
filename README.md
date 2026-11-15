# OpenChamber Instabox

> 私有仓库：`wbi35772/openchamber-instabox` · 扩展 ID：`instabox-matrix` · v1.6.0
>
> 仓库名是 `openchamber-instabox`；为保持已安装扩展、状态目录和 MCP 配置兼容，扩展 ID 与 `~/.openchamber-instabox-matrix` 数据目录保持不变。

OpenChamber 的多账号 Instabox 机器矩阵扩展：一个面板管理多个账号下的沙盒机器，Node 侧出站统一走每账号代理端口，代理缺失时 fail-closed；同样的能力通过 MCP 暴露给 Agent。API Key 只保存在本机状态文件中，不进入面板页面或浏览器存储。

## 核心特性

- **零直连出口**：REST、凭证测试、回收控制面、keepalive 租约与终端 WebSocket 全部绑定 per-alias 代理；无端口抛 `ERR_PROXY_REQUIRED_FAIL_CLOSED`（503），不回退 `globalThis.fetch`。
- **多账号矩阵**：每账号一行，按 alias 路由；机器卡片展示状态、规格、数据盘、uptime、最长运行与冷却时间。
- **机器操作**：启动、停止、暂停、恢复、重启、删除（名称确认）、从模板创建与克隆（等待 operation）。
- **活动租约**：自动续租；空闲暂停后由 exec / 终端流量唤醒；可选冷却唤醒 `wake → resume → start`。
- **自动回收**：lead = maxRun 10%（clamp 10–30 分钟），`suspend → resume → verify`，失败 bootstrap 一次后降级。
- **命令执行**：同步 exec，30 秒以上转异步 job；8 MB 响应上限。
- **文件**：列目录、读写文本、预览、≤5 MiB 下载、大文件上传/下载链接。
- **快照与端口**：创建 / 恢复 / 删除快照；列出与开放公网端口。
- **SSH Token**：1 小时 / 24 小时 / 7 天 / 永久；列表与撤销。
- **桌面**：安装 / 启动 / 接管 / 交还；只读、可过期的访客链接。
- **Web 终端**：xterm 轮询、输入/缩放、持久 shell、重连回放；WSS 经账号代理。
- **服务清单**：监听端口、Docker、systemd，以及 `/etc/instabox-apps.json` 应用地址与凭据。
- **机器 Canvas**：把机器状态、SSH、公网入口、应用凭据、端口与服务发布为版本化 artifact。
- **MCP**：17 个工具，覆盖机器、执行、文件、快照、网络、SSH、桌面、代理与回收。

## 安装

无构建、无运行时依赖，Node 22+：

```powershell
git clone https://github.com/wbi35772/openchamber-instabox.git
cd openchamber-instabox
node scripts/sync.mjs
```

默认安装到 `%USERPROFILE%\.config\openchamber\extensions\instabox-matrix`，并更新 `extensions.json`。自定义位置或只检查：

```powershell
node scripts/sync.mjs --install-dir "D:\OpenChamber\extensions\instabox-matrix" --registry "D:\OpenChamber\extensions.json"
node scripts/sync.mjs --check
```

然后**重启 OpenChamber**。首次使用：打开 Instabox Matrix 面板 → 添加账号（别名 + `ibk_...` Key，可选自定义 Gateway）→ 机器进入矩阵。

### 代理与状态

```text
settings.proxy.enabled = true    # 必须配置端口，否则 fail-closed
settings.proxy.basePort = 24001  # port = basePort + aliasIndex % size
settings.proxy.size = 250
settings.proxy.ports[alias]      # 显式端口优先
```

```powershell
node scripts/singbox-up.js       # 按 alias 生成 sing-box 配置并启动
node scripts/recycle.js --dry-run
node scripts/keepalive-tick.js
```

状态文件：`~/.openchamber-instabox-matrix/state.json`（0600，含 API Key，不要提交）；`INSTABOX_MATRIX_DATA_DIR` 可覆盖目录。

## 文档

完整可视化文档（Canvas artifact，含架构图、时序、状态机、测试分布、路线图与运维手册）：

- 源文件：[`docs/canvas/openchamber-instabox-docs.html`](docs/canvas/openchamber-instabox-docs.html)
- 发布到 OpenChamber Canvas：`node scripts/docs-canvas.js`
- 文档索引：[`docs/INDEX.md`](docs/INDEX.md)
- 变更记录：[`CHANGELOG.md`](CHANGELOG.md)
- 零直连报告：[`docs/reports/TRANSPORT-ZERO-DIRECT-REPORT-2026-11-15.md`](docs/reports/TRANSPORT-ZERO-DIRECT-REPORT-2026-11-15.md)
- 多账号规模与指纹分析：[`docs/reports/MULTI-ACCOUNT-SCALE-REPORT-2026-11-15.md`](docs/reports/MULTI-ACCOUNT-SCALE-REPORT-2026-11-15.md)

## MCP

```json
{
  "mcp": {
    "instabox-matrix": {
      "type": "local",
      "command": ["<NODE_EXE>", "<EXTENSION_DIR>/mcp/server.js"],
      "enabled": true
    }
  }
}
```

MCP 直接读取状态文件并访问 Instabox API，不依赖面板或本地 HTTP 服务。

| 工具 | 作用 |
| --- | --- |
| `instabox_list_machines` | 列出账号下的机器 |
| `instabox_power_action` | status / start / stop / pause / resume / restart |
| `instabox_exec_command` | 同步或异步执行命令 |
| `instabox_inventory` | scan 服务清单 / scaffold 写入应用清单模板 |
| `instabox_manage_snapshot` | list / create / restore / delete |
| `instabox_expose_port` | list / expose / unexpose |
| `instabox_keepalive` | status / set / clear（set 支持 `auto_wake`） |
| `instabox_network_info` | 探测运行时 IP |
| `instabox_inspect` | metrics / logs / history / processes |
| `instabox_create_machine` | 从模板创建机器 |
| `instabox_fork_machine` | 克隆机器 |
| `instabox_list_accounts` | 列出已配置账号 |
| `instabox_proxy` | status / release / probe |
| `instabox_files` | list / read / write / download / upload_url |
| `instabox_ssh_token` | list / create / revoke / revoke_all |
| `instabox_desktop` | status / install / start / takeover / handback / stream / stream_state / stream_revoke |
| `instabox_recycle` | status / set / run |

## 面板

机器详情 9 个 tab：概览、服务、访问、文件、终端、指标、日志、历史、进程。切换或关闭会停止轮询并清理终端会话。

机器 Canvas 会把状态、SSH、公网入口、应用清单（含账号密码）、监听端口、容器、systemd、保活与回收信息发布为 artifact；同一机器复用 artifact 并追加版本，密码默认掩码。Canvas 访客页运行在沙箱中，链接改为画布内导航；目标站点返回 `X-Frame-Options: DENY` 时需复制到浏览器打开。

## 开发

```powershell
npm test                      # 207 条测试
node scripts/sync.mjs --check # 安装副本对齐
node scripts/docs-canvas.js   # 重新发布全景文档
```

```text
lib/       平台客户端与通用模块（22 个）
service/   本地 HTTP 服务（127.0.0.1）
panel/     面板（IIFE + xterm vendor）
mcp/       MCP stdio 服务（17 个工具）
scripts/   sync / singbox / recycle / keepalive / docs-canvas
tests/     node:test（35 个文件，207 条）
docs/      analysis / reports / canvas / plans / specs
```

通用模块 `canvas.js`、`canvas-page.js`、`proxy-fetch.js`、`ws.js`、`scheduler.js`、`ratelimit.js` 禁止依赖 Instabox 客户端或硬编码平台前缀，`generic-isolation.test.js` 强制检查。

## 自更新

设置里的「更新代理」只作用于扩展自身更新，与账号机器代理无关：`system` 继承 git 配置；`direct` 清空代理；`custom` 支持 `http(s)://`、`socks5://`、`socks5h://`。

默认仓库为 `wbi35772/openchamber-instabox`（私有）。自更新通过 `git clone` 拉取，首次需要本机 git 已登录 GitHub；无凭据时先手动克隆一次。

## 限制

- 免费计划 1 台机器、200 GiB 数据、5 个快照；可能返回 `429 quota_exceeded`。
- 服务响应上限 8,000,000 字节；大文件必须走链接。
- 公网 IP 只在机器运行时可见。
- 活动租约不能延长最长连续运行时间；到点进入冷却。
- 终端为轮询实现，单用户单会话，空闲 2 分钟回收。
- 浏览器链接与 SSH 链接由宿主打开，不经过 Node 代理；Node 侧 REST 与 WSS 强制走代理。
- 超过 250 个账号时端口会重叠，需要粘性端口映射（v1.7.0）。

## License

MIT
