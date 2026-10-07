# OpenClaw WhatsApp 配对操作手册

本手册按 2026-10-07 在 Ubuntu 测试服务器上的真实操作整理。已验证环境：OpenClaw `2026.7.1-2`、官方 WhatsApp 插件 `2026.7.1`、Baileys `7.0.0-rc13`、Node.js `24.21.0`。Helper 与 Gateway 必须由同一个 Linux 用户运行。本手册不代表其他版本已兼容。

## 配对前检查

先确认 OpenClaw 和 WhatsApp 账号配置正常：

```bash
node --version
openclaw --version
openclaw channels list
openclaw channels status --channel whatsapp --probe
openclaw-wa-pair --account default --check
```

`--check` 是只读操作。确认输出的 profile、账号、配置文件、Gateway 地址和凭据目录正是目标实例。实例 profile 与 WhatsApp `accountId` 是两回事：默认实例省略 `--profile`；默认 WhatsApp 账号仍要写 `--account default`。

目标账号必须已经在 OpenClaw 配置中创建并启用。如果尚未配置，先执行：

```bash
openclaw channels add --channel whatsapp --account default
```

然后重新运行 `--check`。不要在 Helper 正在配对时从 systemd 重启 Gateway、手动启动目标账号或用其他程序修改凭据。

## 首次绑定

在服务器 SSH 终端交互运行，手机号会由 Helper 提示输入：

```bash
openclaw-wa-pair --account default
```

收到关联码后，在手机打开 **WhatsApp → 已关联设备 → 关联设备 → 改用电话号码关联**，输入终端中的代码。不要把关联码写进脚本、shell 命令或日志。等待终端依次报告“配对完成，凭据已保存”和“OpenClaw 接管完成”。

## 重新绑定或设置设备显示名称

1. 先在手机的“已关联设备”中移除旧的 OpenClaw 设备。
2. 用只读 `--check` 再核对账号和凭据目录。
3. 交互运行：

```bash
openclaw-wa-pair --account default --relink --device-name "AI Bot"
```

4. 如果 Helper 提示输入手机号，在交互提示中输入含国家码号码；不要把号码写在命令参数中。
5. 在 WhatsApp 的同一菜单中输入新关联码，并等待 Helper 报告配对和接管完成。
6. 在手机查看“已关联设备”名称，然后运行状态探测：

```bash
openclaw channels status --channel whatsapp --probe
```

本次实测手机显示为 **`Google Chrome (AI Bot)`**，而不是纯 `AI Bot`；通道状态为 `linked, running, connected, health: healthy`。目前只验证了配对和接管，Gateway 重启或账号重连后的名称持久性仍待实测。若要改名称，必须再次在手机移除现有关联设备并执行 `--relink`；没有原地改名命令。

## 重新绑定耗时与凭据备份

`--relink` 会在停止目标账号后，把完整认证目录逐文件备份，再清理目录并开始配对。测试服务器旧认证目录有 1,632 个文件，备份及清理耗时数分钟；期间 Gateway 继续运行，目标账号处于暂停状态。首次绑定没有旧凭据时不会有这段全量备份耗时。

备份保存在对应实例的 `~/.openclaw/wa-pairing-helper/<authDir-sha256>/backups/<operation-id>/`。备份包含完整 WhatsApp 登录凭据，必须保持私密；不要发送到聊天、提交 Git 或随意删除。

## 失败与恢复

- 如果配对失败，Helper 会尝试恢复本地备份和原账号运行状态；服务端已注销的手机设备不会因恢复本地文件而自动恢复授权。
- 如果命令显示存在待恢复操作，先对同一 profile/account 执行 `--recover`。`paired` 阶段的恢复会重试 OpenClaw 接管，不会生成新关联码。
- 如果 Helper 报告“配对完成”但接管失败，新凭据会保留；先修复 Gateway/WhatsApp 通道问题，再运行 `--recover`。
- 配对失败后也要检查手机“已关联设备”，清除失败尝试留下的设备。
- 不要手工删除 pending 操作记录或锁文件来绕过恢复。

## 验收边界

当前真机确认：默认实例/default 账号的关联码配对、设备子名称 `AI Bot`、OpenClaw 接管及健康状态。尚未确认：纯 `AI Bot`（无 Chrome 前缀）显示、重连和 Gateway 重启后的显示名称、外部消息收发与 Agent 回复、命名 profile、多账号并行和故障回滚。每项都应在测试账号上单独验证。

## 下次可直接给助手的操作提示

```text
请在 Ubuntu 测试服务器上，用当前系统用户检查 OpenClaw 2026.7.1-2 的 WhatsApp default 账号。
先运行 openclaw-wa-pair --account default --check 和 openclaw channels status --channel whatsapp --probe，核对实例、账号及凭据路径。
若要首次绑定，使用 openclaw-wa-pair --account default；若要设置名称，先提醒我在手机移除旧设备，再使用
openclaw-wa-pair --account default --relink --device-name "AI Bot"。
手机号只在交互提示中输入；生成关联码后停下来告诉我，并等我在手机输入。之后继续到 Helper 报告接管完成，
再运行通道状态探测。不要停止/重启整个 Gateway，不要输出或保存密码、完整手机号、关联码或凭据内容。
```
