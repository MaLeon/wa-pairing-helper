# 自定义设备名称：实验功能

`--device-name` 目前可用于显式重新绑定，但设备端显示和后续重连持久性仍未验证，因此仍是实验功能。

补丁将 Baileys 注册时的 `DeviceProps.os` 从 `config.browser[0]` 改为 `config.helperDeviceName ?? config.browser[0]`。保持 `browser: Browsers.ubuntu('Chrome')`，从而不改变手机号关联请求使用的标准平台标识。用户显式提供名称时，Helper 在导入 Baileys socket 前，对 Helper 自己的依赖应用固定哈希补丁；不修改 OpenClaw 的 Baileys。补丁不匹配则命令失败关闭。

`patches/baileys-7.0.0-rc13-device-name.patch` 提供可审查的差异。需要 `--relink`，并应先在手机端删除旧设备：

```bash
openclaw-wa-pair --account default --relink --device-name "AI Bot"
```

输入限 1–32 个 Unicode 字符，拒绝控制字符。命令会先对 Helper 自己的 Baileys 应用实验补丁，再生成关联码。必须检查：手机关联设备名称、OpenClaw 接管、目标账号断线重连、Gateway 重启后名称是否仍保持。若配对失败，按现有 `--relink` 备份恢复流程处理；手机端可能仍需删除失败尝试生成的关联设备。已绑定设备更名需移除旧设备并重新绑定，不提供原地改名接口。
