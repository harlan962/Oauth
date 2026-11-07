# WorkBuddy 访问受限实测与流程修复

## 真实请求结果

用户明确要求重新获取授权链接，对原受限账号进行浏览器操作和请求诊断。使用项目专用 Chromium、隔离会话、现有账号凭据与动态 TOTP；未更换账号、代理或伪装设备特征。

- 2026-10-19 12:32（北京时间）：GitHub `/session` 和 `/sessions/two-factor` 提交均返回 302，随后到达 GitHub OAuth 页面及 WorkBuddy GitHub 回调。
- WorkBuddy `/auth/realms/copilot/broker/github/endpoint` 返回 302。
- WorkBuddy `/auth/realms/copilot/login-actions/first-broker-login` 返回 **403**。
- 页面明确显示：**账号访问受限**；**您的账号因安全策略限制，暂无法访问，如有疑问请联系腾讯云官方客服获取支持。**
- 应用的浏览器代理配置为空，浏览器使用 `--no-proxy-server`。此项只能确认浏览器代理配置，不能排除操作系统 VPN/TUN 或网络出口影响。
- 因此可定位到 WorkBuddy 服务端的账号安全策略拒绝；没有证据能进一步区分账号历史、出口 IP、设备特征在策略中的作用。不是成功登录，也不能声称完整 OAuth/远端入池成功。
- 本次没有调用 `login/poll`，没有进行入池、激活或领取试用。诊断浏览器已经关闭。
- 诊断脚本初始的日志接口错误导致前两次 start 返回后未打开浏览器；修正后执行了一次实际浏览器登录。没有重复提交 GitHub 登录或远端 poll。

证据：`output/playwright/workbuddy-diagnostic/network.json`、`page.json`、`page.png`。网络记录仅保留方法、无查询参数的路径、状态码及数字错误码；不保存 Cookie、密码、TOTP、授权码、请求体或响应原文。

## 修复内容

- 可选 GitHub passkey 页面仅点击唯一的 **Ask me later**，不会选择添加 passkey 或不再询问。
- GitHub 身份及回调证据成立后，继续处理匹配设备 state 的官方 WorkBuddy 账号选择确认；只有匹配设备 state 的 CLI 成功页出现成功文案后才可进入远端 poll。
- 跳转中断 GitHub 页面读取时，重新检查已落地的官方 WorkBuddy 页面，避免明确受限仍要求手动继续。
- 受限后保存独立的永久排除记录、关闭当前浏览器并停止队列；未执行账号释放占用，不继续尝试其他账号。
- 新任务候选及服务端提交校验均排除受限账号。GitHub 通用状态不因 WorkBuddy 限制被修改。
- 启动时迁移旧 restricted 状态和旧版已确实记录的受限日志，处理旧版停止操作将状态改成 unknown 的情况。
- WorkBuddy 受限标签下显示“已标记 · 自动跳过”，避免表格窄列截断关键信息；受限计入已结束进度。

## 验证范围

浏览器回归覆盖有/无 passkey、WorkBuddy 确认后才成功、错误设备 state、成功页仍在处理中、跳转中断后识别受限、拒绝仿冒域名。服务测试覆盖受限停止、不 poll、不继续下一账号、释放占用、重启保留排除、旧版取消后恢复受限标记。真实受限账号无法验证后续 WorkBuddy 成功确认页面，其流程使用官方公开页面结构和隔离浏览器测试验证。

- `npm test`：264 通过，0 失败。
- `npm run build`：通过。
- 重启前确认 WorkBuddy、旧授权链接队列、PAT、公开检查任务均空闲。
- 数据备份：`output/backups/workbuddy-restriction-20261019`。
- 工作台已重启，首页 HTTP 200；原账号返回 `workbuddyResult.status=restricted`、`reservedBy=null`，不在 WorkBuddy 候选列表；所有任务停止。
- 本机浏览器验证原账号的受限标签与自动跳过提示可见；截图 `output/playwright/workbuddy-restriction-ui.png`。
