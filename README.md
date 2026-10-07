# wa-pairing-helper

独立的 WhatsApp 手机号关联码登录工具。安装后提供 `openclaw-wa-pair` 命令；正常消息收发仍由 OpenClaw 官方 WhatsApp 插件负责。

**0.1.0 已在 Ubuntu 测试服务器完成真实手机号关联码配对和 OpenClaw 接管。** 自定义名称实验功能也已配对成功，手机显示为 `Google Chrome (AI Bot)`。Gateway 状态探测为 `connected / health: healthy`。Gateway 重启后名称持久性、消息收发/路由及命名 profile 尚未完成真机验收；具体步骤见 [服务器操作手册](docs/runbook.md)。

## 环境与兼容范围

| 项目 | 当前范围 |
|---|---|
| 操作系统 | Linux，本机直接安装，与 Gateway 使用同一用户 |
| Node.js | 24.16.0 及以上的 24.x |
| OpenClaw（可执行配对） | 精确版本 2026.7.1-2 |
| 官方 WhatsApp 插件 | 精确版本 2026.7.1 |
| Baileys | 精确版本 7.0.0-rc13 |
| Gateway | 已运行的回环地址，已有 `operator.admin` 认证权限 |
| 账号 | 已在目标实例中配置并启用 |

适配器会校验关键安装文件的 SHA-256，以及 Gateway 握手版本、状态目录、配置路径和本机监听进程身份。2026.7.1-2 的握手不提供 bootId，Helper 通过 Linux `/proc` 中监听 socket 的 PID 与进程启动时间检测 Gateway 重启。源码安装、被修改过的构建及其他版本会被拒绝；工具不自动安装、升级或修改 OpenClaw。

Helper 使用 OpenClaw 官方 `channels.stop` / `channels.start` RPC 交接账号：上游先中止该账号的运行任务，等待其停止；停止超时会保留运行状态，Helper 因而不会进入配对。配对过程中，每次写入前都会复核 Gateway 启动身份与账号仍处于 stopped 状态。该版本没有跨进程凭据锁，因此运行期间不得手动重启 Gateway、启动目标账号或用其他程序改写其凭据；检测到 Gateway 重启或账号恢复运行时，Helper 会中止并转入恢复流程。此交接机制依赖 Gateway 生命周期管理，不能阻止管理员同时从系统服务管理器重启进程。

每次配对会通过继承的 OpenClaw 代理配置，从 Baileys 官方 GitHub 源获取当前 WhatsApp Web 协议版本，并将 OpenClaw 的代理 dispatcher 传给请求。获取失败或超时会停止配对并恢复原状态，不使用已过时的 Baileys 内置版本。

这些是已实现的兼容约束，不是真机稳定性承诺。详细验证记录见 [兼容与验收](docs/compatibility.md)。

## 从源码构建和安装

```bash
git clone https://github.com/MaLeon/wa-pairing-helper.git
cd wa-pairing-helper
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm pack
npm install -g ./wa-pairing-helper-0.1.0.tgz
```

代码尚未推送时，可将本地生成的 `.tgz` 复制到 Linux 主机后执行最后一条安装命令。项目目前没有发布到 npm registry。不要使用 `sudo` 切换用户运行配对，除非你的 OpenClaw 本身就属于 root。

## 使用

先运行只读检查：

```bash
openclaw-wa-pair --account default --check
openclaw-wa-pair --profile user2 --account default --check
```

默认实例不填写 `--profile`；`--account default` 指默认 WhatsApp 账号，这两个“默认”互相独立。

```bash
# 交互输入含国家码的手机号
openclaw-wa-pair --account default
openclaw-wa-pair --profile user2 --account default

# 也可显式传入，注意号码会进入 shell 历史和进程参数
openclaw-wa-pair --profile user2 --account default --phone 60123456789

# OpenClaw 不在 PATH，或需要选择特定安装
openclaw-wa-pair --openclaw-bin /path/to/openclaw --account default
```

关联码仅输出到交互终端，不能将配对输出重定向到文件。手机进入 **WhatsApp → 已关联设备 → 关联设备 → 改用电话号码关联**，输入 `XXXX-XXXX`。它不是短信验证码，也不是 OpenClaw 联系人访问审批码。

流程：暂停目标账号 → 取得共享凭据锁 → 等待配对就绪 → 请求关联码 → 手机确认 → 必要的 515 重连 → 等待全部凭据写入 → 关闭 Helper 连接 → 释放锁 → 恢复账号并检查连通状态。工具不会停止或重启整个 Gateway。

## 目录与配置

普通布局仍是：

```text
~/.openclaw/credentials/whatsapp/default/
~/.openclaw-user2/credentials/whatsapp/default/
```

目录由目标安装的 OpenClaw 和 WhatsApp 插件解析，尊重有效配置、`$include`、环境路径覆盖和已有 `authDir`。Helper 不改配置、不改 binding、不建立公共凭据目录。旧版共享凭据目录、符号链接凭据路径和混入非认证文件的目录会被拒绝。

如果继承环境中的 `OPENCLAW_PROFILE` 指向命名实例，必须显式指定 `--profile`。运行前检查输出的实例、配置与凭据路径是否符合预期。

## 重新绑定与恢复

```bash
openclaw-wa-pair --profile user2 --account default --relink
openclaw-wa-pair --profile user2 --account default --recover
```

`--relink` 在独占锁下备份完整认证文件，再尝试新配对。失败时恢复本地备份及原运行状态；成功但 OpenClaw 接管失败时保留新凭据，`--recover` 只重试接管。

操作记录和备份位于：

```text
<stateDir>/wa-pairing-helper/<authDir-sha256>/
├── pending.json
├── backups/<operation-id>/
└── history/<operation-id>.json
```

认证目录 700、认证与记录文件 600。记录不包含手机号或密钥，但备份本身是完整登录凭据，不能上传仓库或作为普通日志分享。备份不自动过期删除。

中断、Gateway 重启或无法确认连接关闭时，可能保留待恢复记录；不要手工删除锁来强行继续，使用 `--recover`。若旧设备已在手机端注销，本地备份不能恢复服务端授权。失败配对也可能留下手机端关联设备，需要在手机检查。

如果恢复仍失败，先执行对应 profile 的 `openclaw channels status --channel whatsapp --probe`。工具不会在身份校验失败时自动覆盖凭据或停止整个 Gateway。

## 设备名称

可在显式重新绑定时尝试设置设备名称：

```bash
openclaw-wa-pair --account default --relink --device-name "AI Bot"
```

该功能仍为实验性：Helper 只在用户显式传入 `--device-name` 时，按精确文件哈希修改自己安装的 Baileys `DeviceProps.os`；配对用的浏览器标识保持 `Chrome (Ubuntu)`，OpenClaw 安装目录不变。已在测试账号真机验证：`AI Bot` 配对成功，手机显示 `Google Chrome (AI Bot)`，Gateway 接管后健康。要改名必须同时使用 `--relink`，并先在手机移除旧关联设备。手机端准确标签包含 Chrome 前缀；重连或 Gateway 重启后的持久性仍待验证。若 Baileys 文件与固定补丁基线不符，命令会在暂停账号或操作凭据前退出。

见 [设备名称验证](docs/device-name.md)。已绑定设备不能原地改名。

## 开发验证

```bash
npm run check
npm test
npm run build
npm run verify:baseline -- /path/to/openclaw/package /path/to/whatsapp/package
```

基线验证使用官方 2026.7.1-2 与 WhatsApp 2026.7.1 npm 包，只创建临时测试 profile，不连接真实 Gateway。真机验收步骤见 [Linux 验收手册](docs/acceptance.md)。
