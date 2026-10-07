# 自定义设备名称：实验功能

`--device-name` 目前可用于显式重新绑定，已在真实测试账号上验证关联成功和 OpenClaw 接管，但仍是实验功能。

补丁将 Baileys 注册时的 `DeviceProps.os` 从 `config.browser[0]` 改为 `config.helperDeviceName ?? config.browser[0]`。保持 `browser: Browsers.ubuntu('Chrome')`，从而不改变手机号关联请求使用的标准平台标识。用户显式提供名称时，Helper 在导入 Baileys socket 前，对 Helper 自己的依赖应用固定哈希补丁；不修改 OpenClaw 的 Baileys。补丁不匹配则命令失败关闭。

`patches/baileys-7.0.0-rc13-device-name.patch` 提供可审查的差异。需要 `--relink`，并应先在手机端删除旧设备：

```bash
openclaw-wa-pair --account default --relink --device-name "AI Bot"
```

输入限 1–32 个 Unicode 字符，拒绝控制字符。命令会先对 Helper 自己的 Baileys 应用实验补丁，再生成关联码。2026-10-07 验收结果：传入 `AI Bot`，WhatsApp 手机端显示 `Google Chrome (AI Bot)`；配对、凭据保存、OpenClaw 接管与健康探测均成功。`AI Bot` 是设备名称字段，`Google Chrome` 是客户端平台类别产生的前缀，因此当前结果不是无前缀的纯 `AI Bot`。

仍需验证目标账号重连及 Gateway 重启后名称是否保持。若想只显示 `AI Bot`，候选方案是让注册信息使用 `DESKTOP` 平台类型，同时保留关联码请求的标准 Chrome 标识；尚未在该 Helper/账号上验证。若配对失败，按现有 `--relink` 备份恢复流程处理；手机端可能仍需删除失败尝试生成的关联设备。已绑定设备更名需移除旧设备并重新绑定，不提供原地改名接口。
