# 网易云音乐自动签到 - Egern 模块

自动抓取网易云音乐登录请求中的 `MUSIC_U` Cookie，在 Egern 本地保存。每天 00:10 分别执行安卓端和 Web 端签到，并显示系统通知结果。

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
- `每日自动签到`：默认开启。
- `CronExp`：默认 `10 0 * * *`，即每天 00:10。

Cookie 仅保存在 Egern 本地存储中，不会上传至 GitHub 或其他服务器。

## 验证状态

YAML 与 JavaScript 已通过静态语法校验。Cookie 捕获和签到结果需要在实际 Egern 设备上运行一次验证。
