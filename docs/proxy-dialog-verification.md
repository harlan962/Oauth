# 代理链接与统一弹窗验收（2026-10-19）

## 改动

- WorkBuddy 连接方式为「直连 / 代理」，代理只保留一个链接输入框，移除认证开关及独立用户名、密码字段。
- 自动解析 HTTP、HTTPS、SOCKS5 链接与 URL 编码认证信息。保存后不回填密码；留空保留原代理，输入新链接整体替换，切换直连清除原配置。
- HTTP/HTTPS 认证交给独立 Chromium。带认证 SOCKS5 经 `proxy-chain` 临时 loopback 转接，域名由 SOCKS 服务解析；诊断和 OAuth 共用此处理。直连显式绕过系统代理。
- 原加密配置格式兼容，无数据库迁移。认证失败不回退直连；测试结束、浏览器关闭和启动失败均清理临时转接。
- 全局弹窗使用统一的标题、内边距、圆角、底部按钮布局，确认弹窗缩小到 420px；桌面按钮 36px，手机端保留 44px 点击区域。表单内容可滚动，底部按钮保持可见。

## 验证结果

- `npm run build` 成功。
- 完整回归：359/359，通过日志 `output/proxy-dialog-regression.log`。
- 增补 HTTP 认证后代理专项：4/4，通过日志 `output/proxy-network-final.log`。
- 最终样式微调后 UI、配置浏览器及账号列表浏览器：13/13，通过日志 `output/proxy-dialog-ui-final.log`。
- 本地模拟认证 SOCKS5 服务 + 真实 Chromium 验证 HTTP 转发、CONNECT 隧道、URL 编码密码、错误密码拒绝、端口释放；本地模拟 HTTP 代理验证 Chromium 实际发送解析后的认证信息。未使用用户账号执行 OAuth。
- 8 类弹窗（新增、导入、详情、编辑、显示列、分组、标签、PAT）在 1440px 和 320px 下检查无溢出、底部按钮可见、Escape 可关闭，统一间距。结果 `output/compact-dialog-verification.json`，截图 `output/playwright/compact-dialogs/`。配置及嵌套放弃修改弹窗截图在 `output/playwright/workbuddy-clean/`。
- 已备份并重启到进程 23836，4318 页面 HTTP 200；内置浏览器已确认新「直连 / 代理」配置生效。
- 重启后全部业务表哈希与备份相同，102 个账号、1 条部署配置。备份 `output/backups/proxy-dialogs-20261019/`，核对结果 `output/proxy-dialog-data-verification.json`。

真实服务商代理需使用其有效链接运行「测试连接」；此次联网兼容性验证使用本地模拟代理，未改动原有部署和代理数据。
