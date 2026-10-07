# 兼容性记录

2026-10-07：0.1.0 在 Ubuntu 测试服务器完成真实关联码配对与 OpenClaw 接管，实测版本为 OpenClaw 2026.7.1-2、官方 WhatsApp 2026.7.1、Baileys 7.0.0-rc13、Node.js 24.21.0。自定义名称 `AI Bot` 的设备显示为 `Google Chrome (AI Bot)`。这验证了本次账号配对/接管，不等于生产稳定性，也未验证 Gateway 重启后的名称持久性。

| 检查 | 状态 |
|---|---|
| TypeScript 构建与类型检查 | 已验证 |
| 模拟 Gateway / Baileys 故障场景 | 自动化测试 |
| npm 正式安装包关键文件 SHA-256 | 已对照 2026.7.1-2 / 插件 2026.7.1 |
| 默认 / 命名 profile 及环境覆盖 | 使用正式包的解析函数验证 |
| `$include`、账号继承、自定义 authDir | 使用正式包的配置与账号解析函数验证 |
| Helper 实例互斥锁对第二个 Helper 的排斥 | 临时目录双进程验证 |
| 配置/插件/账号路径解析 | 正式安装包函数 + 隔离临时配置验证 |
| Gateway RPC 握手及状态调用 | 官方 2026.7.1-2 RPC 客户端 + 模拟 WebSocket 服务端验证 |
| Linux 上完整 `--check` 安装定位流程 | Ubuntu 24.04 默认实例已验证 |
| 手机关联码登录与 OpenClaw 接管 | 默认账号真机验证成功 |
| WhatsApp 通道健康状态 | `linked / running / connected / health: healthy` |
| 自定义设备名称 | `AI Bot` 真机配对成功，显示 `Google Chrome (AI Bot)` |
| 外部消息收发、agent 路由与回复 | 待验证 |
| Gateway 重启/账号重连后的自定义名称 | 待验证 |
| 命名 profile、多账号并行与故障恢复 | 待验证 |

## 版本适配与凭据交接

目标版本固定为 OpenClaw `2026.7.1-2` / WhatsApp `2026.7.1` / Baileys `7.0.0-rc13`。`src/baseline.ts` 保存精确构建入口及 SHA-256；版本相同但安装文件不同也会拒绝。新增支持版本必须重新审查配置读取、Gateway 握手、RPC 与账号解析，再更新适配和测试，不能只放宽版本字符串。

Helper 通过 `channels.stop` 请求 Gateway 停止指定账号。该 tag 的 Gateway 会中止账号生命周期任务并等待任务结束；超过 5 秒会保留运行状态。Helper 只有在 RPC 返回 `stopped: true` 且实时状态为 `running: false` 后才处理凭据。上游 WhatsApp 凭据写入队列是进程内 keyed queue，没有可由 Helper 复用的跨进程凭据文件锁。

因此 Helper 将账号级 Gateway 生命周期作为正常交接机制，并在每次 RPC 写入前复核 Gateway 本机监听进程 PID/启动时间与账号停止状态；发现进程重启或账号重新运行会中止操作并保留恢复记录。2026.7.1-2 的 hello-ok 仅提供 `server.version` 和每连接变化的 `server.connId`，不提供稳定 `bootId`，故不能用 `connId` 代替进程身份。该复核不能原子阻止管理员从 systemd 等外部管理器同时重启 Gateway。配对期间必须避免此类并发操作。已在测试服务器和手机完成一次配对/接管，但其余验收项未完成，因此不把此版本标记为生产稳定。

连接在本机进程身份与 Gateway 返回的状态/配置路径双重校验下固定到单一运行实例；每次 RPC 派发前检查监听 socket 的 PID 与进程启动时间。Helper 自身的凭据目录锁可排斥第二个 Helper，但不是 OpenClaw 共享锁。配对复用目标 OpenClaw SDK 的环境代理构造器，读取 Helper 进程继承的 HTTP(S)_PROXY / NO_PROXY；代理本身的可达性需现场验证。关联码显示不等于认证完成，`started: true` 不等于 WhatsApp 已连接。

Baileys `7.0.0-rc13` 内置的 WhatsApp Web 协议版本可能已过时。Helper 在创建 socket 前会经 OpenClaw 提供的 fetch dispatcher，从 Baileys 官方 GitHub 获取最新版本，并为 HTTP 请求设置 15 秒超时；失败时不连接、不使用陈旧内置版本。

## 资料

- [Gateway channel lifecycle source](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/src/gateway/server-channels.ts)
- [Gateway channels RPC source](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/src/gateway/server-methods/channels.ts)
- [WhatsApp credential persistence source](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/extensions/whatsapp/src/creds-persistence.ts)
- [WhatsApp session source](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/extensions/whatsapp/src/session.ts)
- [WhatsApp account path source](https://github.com/openclaw/openclaw/blob/v2026.7.1-2/extensions/whatsapp/src/accounts.ts)
- [Baileys device-name issue](https://github.com/WhiskeySockets/Baileys/issues/2560)
