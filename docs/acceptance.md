# Linux 与手机验收手册

需要 Linux 测试主机、同一系统用户的 OpenClaw 2026.7.1-2、官方 WhatsApp 插件 2026.7.1 / Baileys 7.0.0-rc13，以及允许关联的 WhatsApp 测试账号。禁止将真实凭据提交到 Git。

## 已完成的真机验证（2026-10-07）

测试环境：Ubuntu 24.04，Node.js 24.21.0，OpenClaw 2026.7.1-2，官方 WhatsApp 插件 2026.7.1，Baileys 7.0.0-rc13，默认实例/default 账号。

- Helper 通过交互终端收取手机号，生成关联码；手机端选择“已关联设备 → 关联设备 → 改用电话号码关联”并输入代码。
- 已关联成功；自定义注册名称 `AI Bot` 生效，WhatsApp 手机列表显示 `Google Chrome (AI Bot)`。
- Helper 报告“配对完成”和“OpenClaw 接管完成”；`openclaw channels status --channel whatsapp --probe` 报告 linked、running、connected、health: healthy。
- `--relink` 先完整备份旧账号的 1,632 个凭据文件。此次逐文件备份与清理花费数分钟；操作期间 Gateway 保持运行，仅目标账号暂停。

未完成：外部账号发消息及 agent 回复、Gateway 重启后名称持久性、命名 profile、并发账号连续性、故障回滚、无 Chrome 前缀的纯 `AI Bot` 显示。

## 完整验收清单

1. 安装 `.tgz`，执行 `openclaw-wa-pair --help`。记录 Node、OpenClaw、插件版本。
2. 对默认实例和一个命名 profile 分别执行 `--check`；对配置与凭据目录做前后文件清单/哈希比较，确认预检没有创建或修改业务文件。
3. 两个 profile 使用相同 accountId，检查解析路径不同。再用已有自定义 authDir 验证。
4. 记录 Gateway PID，让第二个 WhatsApp 账号持续收发；对目标账号完成关联码登录。确认仅目标账号暂停、Gateway PID 不变、其他账号不断连。
5. 检查 Helper 报告“配对完成”和“OpenClaw 接管完成”。由人工发送测试消息，验证接收、agent 路由、回复。
6. 正常重启 OpenClaw，确认无需重新配对。此重启是验收操作，不由 Helper 自动执行。
7. 用测试账号执行 `--relink` 并故意等待超时，检查旧凭据文件恢复，原运行状态恢复；不假定服务端已撤销的凭据仍有效。
8. 在等待手机确认阶段发送 SIGTERM，检查清理；另一次使用 SIGKILL，再执行 `--recover`，检查崩溃恢复和备份哈希验证。
9. 在配对期间重启测试 Gateway，确认 Helper 检测监听进程 PID/启动时间变化后中止交接；手动操作账号启动或重启属于禁止的并发操作，不应在生产环境测试。重新执行 `--recover`。
10. 断开网络、模拟磁盘写入失败、同时启动第二个 Helper，确认不误报成功、不无限重试、不强制清理其他进程锁。
11. 自定义设备名称按 `device-name.md` 独立验证；记录手机端实际完整显示字符串，不把 `AI Bot` 子字段误记为整个标题。

验收报告记录：日期、系统/Node/组件版本、默认与命名 profile 结果、Gateway PID 是否保持、其他账号连续性、恢复结果、自定义名称结果。只记录脱敏信息，不收集手机号、关联码、原始认证日志或凭据内容。
