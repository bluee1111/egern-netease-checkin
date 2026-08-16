# 网易云音乐自动签到 - Egern 模块

自动抓取网易云音乐登录请求中的 `MUSIC_U` Cookie，在 Egern 本地保存。每天 00:10 分别执行积分签到、云贝签到和 VIP 成长值（黑胶乐签）打卡，并显示系统通知结果。

## 导入

在 Egern 添加模块订阅：

```text
https://raw.githubusercontent.com/buleeee1111/egern-netease-checkin/main/netease-checkin.yaml
```

## 使用

1. 添加并启用模块。
2. 信任并启用 `music.163.com` 的 MITM。
3. 打开网易云音乐 App，进入任意已登录页面。
4. 收到"Cookie 已保存"通知后，模块会在每日 00:10 自动签到。

## 设置

- `自动获取 Cookie`：默认开启。
- `CronExp`：默认 `10 0 * * *`，即每天 00:10。

Cookie 仅保存在 Egern 本地存储中，不会上传至 GitHub 或其他服务器。

## 验证状态

- 2026-08-17 v14：VIP 成长值（黑胶乐签）改用新接口 `vip-center-bff/task/sign` + `checkin/history/detail` + `task/reward/getall`（有效 cookie 实测 code=200 通过）；旧 `task/list+reward/get` 已不产出打卡任务，不再使用。
- YAML 与 JavaScript 已通过静态语法校验。Cookie 捕获和签到结果需要在实际 Egern 设备上运行一次验证。