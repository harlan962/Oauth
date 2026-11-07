# WorkBuddy 安全限制排查（2026-10-19）

## 结论

已定位到 WorkBuddy 服务端首次关联 GitHub 身份时拒绝，尚未获得具体风控命中条件或有效的解除办法。2026-10-19 15:30（北京时间）直接访问官方登录入口，也复现同一账号的 HTTP 403；不依赖第三方接入服务的 start/poll。

不能把 HTTP 403 等同于永久封号，也不能据此认定 IP、地区、账号年龄、邮箱或自动化浏览器是唯一原因。页面未提供这些细分原因。

## 本次对照

- 账号：thurman-rush88。执行前重新查询当前数据库：未删除、未使用、未占用、有 TOTP、不是 PAT 专用账号。没有使用回收站中的 brant-core21。
- 原路径：接入服务生成 CLI 授权链接 → GitHub → WorkBuddy 首次关联 403。证据：`output/workbuddy-bounded-1792392995083/report.json`。
- 本次路径：直接打开 `https://www.workbuddy.ai/login/` → GitHub 密码提交 → TOTP 提交 → GitHub 回调 → WorkBuddy 首次关联 403。
- 使用原有项目 Chromium、隔离上下文和现有系统代理；没有切换出口、改写指纹、修改风控请求或验证码流程。
- 本次一次尝试结束，未调用接入服务 start/poll，未修改本地账号状态。结束后关闭浏览器，服务 PID 23472 仍正常，API HTTP 200，队列空闲。
- 本次因既有 GitHub 授权路径未采集到页面上的用户名身份证据（identity=false），没有认定自动登录/入池成功。报告仅证明官方路径的实际响应链和拒绝阶段；上一轮同账号报告包含 identity=true、callback=true 和相同 403。

## 响应证据

| 阶段 | 本次响应 | 能证明什么 |
| --- | --- | --- |
| `/v2/plugin/login/entry-policy` | HTTP 200，code=0 | 登录入口策略接口可访问 |
| `/console/auth/risk-context` | HTTP 200，code=0 | 风控上下文提交成功，不等于风控放行 |
| 风控组件 `event/report`、`data/1941/forward` | HTTP 200 | 相关提交可达；不能证明服务端评分结果 |
| GitHub `/sessions/two-factor` | POST → 302 | 2FA 表单已提交并继续跳转 |
| WorkBuddy `/broker/github/endpoint` | HTTP 302 | GitHub 回调已进入 WorkBuddy |
| WorkBuddy `/login-actions/first-broker-login` | HTTP 403 | 首次关联阶段服务端拒绝 |

最终页面包含「您的账号因安全策略限制，暂无法访问，如有疑问请联系腾讯云官方客服获取支持」，没有命中本项目识别的「所在地区不支持/不可用」文案。这不排除地区因素，只表示没有明确地区错误提示。

403 的官方响应时间：`Mon, 19 Oct 2026 07:30:35 GMT`（北京时间 15:30:35）。

403 的 `x-request-id`：`60b09b4e-504f-46bf-a3c2-a4f633b4b954`。

风控上下文 `x-request-id`：`ab6b9cc9-3007-4170-8a74-7056fd1b4be1`。

本次完整脱敏记录：`output/workbuddy-security-1792395009580/report.json`。记录不保存密码、TOTP、Cookie、授权码、查询参数值或任意请求正文。

## 已缩小的范围和剩余未知

1. 滚动/点击问题不能解释该 403：已有实际 GitHub 回调，拒绝来自后续 WorkBuddy 接口。
2. 接入链接不是复现此拒绝的必要条件：本次官方入口也失败。不过，两次执行时间和登录入口参数不同，不能据此排除第三方接入可能存在的其他问题。
3. 「风控请求完全没发送/网络不通」不符合本次证据。仍无法从 HTTP 200 判断风控是否判为高风险。
4. 历史手动成功证据走 `post-broker-login`，受限证据走 `first-broker-login`。应优先请官方核查首次关联准入规则。历史记录不是同账号、同一时刻的严格对照，也不是项目自动化成功记录，不能直接推导所有新账号都会失败。
5. 本地 Node 直连公开 WorkBuddy 页面超时，而现有代理可访问登录页，说明网络路径确有差异；没有验证关闭代理能解除限制。未切换代理或反复登录测试。
6. 当前公开入口策略返回 `enable_oneid_only_login=false`，不能解释为入口统一关闭 GitHub 登录，也不能当作某账号具有登录资格的证明。

## 处理方式

- 保持现有受限后跳过并继续队列的行为；不把明确安全拒绝当普通网络超时反复重试，不清空本地限制记录。
- 邮箱验证码仍直接跳过；普通网络/页面问题仍有界重试。
- 真正解除需要先确定服务端命中条件。若官方确认账号资料、资格或地区要求，应通过其支持的流程处理；若是误判，由官方复核。单纯延长超时、更换入口或改点击逻辑目前没有解除证据。
- 已备好下列支持材料，尚未发送。请求 ID 可以帮助官方查日志，避免继续用更多账号盲试。

## 官方支持材料草稿（尚未发送）

主题：WorkBuddy 国际版 GitHub 首次关联返回 403，请核查安全策略拒绝原因

您好，2026-10-19 北京时间 15:30:35，直接通过 WorkBuddy 官方登录页使用 GitHub 登录，在提交密码及 TOTP 后已回调到 WorkBuddy，但 `/auth/realms/copilot/login-actions/first-broker-login` 返回 HTTP 403，页面提示账号因安全策略限制无法访问。

该请求的 x-request-id 为 `60b09b4e-504f-46bf-a3c2-a4f633b4b954`。此前 `/console/auth/risk-context` 返回 HTTP 200 / code=0，其 x-request-id 为 `ab6b9cc9-3007-4170-8a74-7056fd1b4be1`。

复现环境是 Windows 的项目专用 Chromium 独立会话、现有系统代理，通过本地自动化提交登录。此次直接使用官方入口，未经过第三方接入的 start/poll；此前经接入链接也出现相同首次关联拒绝。

请协助确认这是账号资格/资料、首次关联准入、网络或地区要求、请求频率、客户端使用限制，还是其他安全策略；如为误判，请提供复核和恢复访问的官方途径。我们没有从页面获得具体错误子码，也不会将密码、TOTP 密钥或 Cookie 作为排查附件。

官方页面公开联系地址：`codebuddy@tencent.com`（来源为官方登录站点的 Contact Support 链接）；最终以当前官方客服入口为准。

## 16:20 补充：设备凭据与初始化时序排查

检查官方公开登录客户端，发现 `/console/auth/risk-context` 的 code=0 存在歧义：客户端可以通过 `X-Device-Token` 提交 SDK 生成的设备凭据，也可以通过 `X-Device-Token-Error` 提交 SDK 失败码。此前仅有 HTTP 状态和业务码的抓包不足以区分这两种情况。

因此进行了两个限定验证，没有修改官方脚本、伪造凭据或改写风控信号：

1. 只打开官方登录页，不输入账号：捕获 `deviceTokenPresent=true`、`deviceTokenErrorPresent=false`，接口 HTTP 200 / code=0。证据 `output/workbuddy-risk-init-report.json`。
2. 使用当前未删除、未占用且有 TOTP 的同一失败样本 thurman-rush88，捕获完整登录中的相同字段：北京时间 16:20:18 已提交设备凭据并收到 code=0；后续 GitHub 回调进入首次关联，16:20:38（官方服务器时间）仍返回 HTTP 403。没有调用 panel start/poll，也未改写本地账号状态。证据 `output/workbuddy-security-1792398012368/report.json`。

这次否定了“本次 SDK 未生成设备凭据”或“凭据尚未提交就进入 GitHub 回调”这两个具体假设。不能证明凭据在服务器评分中属于低风险，也不能推断设备凭据被接收就一定允许首次关联。

最新 403 请求 ID：`98367b3c-a589-4862-806c-0b5e90d02b4e`；风控上下文请求 ID：`f026d426-3a3c-433a-a279-ed984c01120d`。可以用两者核对服务端风险上下文和首次关联拒绝记录。

目前没有发现能解释此 403 的本地缺参或初始化顺序错误，因此没有为此修改生产逻辑或宣称限制已解除。精确命中规则仍需要 WorkBuddy 服务端依据请求 ID 查询；其结果决定应修正账号资格/资料、客户端兼容性，还是申请误判复核。
