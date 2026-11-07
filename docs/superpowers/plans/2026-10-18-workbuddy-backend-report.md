# WorkBuddy 后端实现报告（2026-10-18）

## 交付范围

新增 `server/workbuddy.js`、`server/oauth-browser.js` 及 `tests/workbuddy.test.js`、`tests/workbuddy-browser.test.js`。修改 Store、IntegrationService、app/index 接线及 package/package-lock。没有修改前端文件、旧 UI 测试或真实账号数据库/主密钥；没有发起真实远端授权、读取真实凭证或创建提交。

实施前完整读取实施计划、TDD 技能及 writing-good-tests 参考。现有上游 `internal/panel/login.go` 确认 GET poll 会落盘、热加载、Global 注册激活及 trial；本地未新增独立奖励接口。

## 后端行为

- `/api/workbuddy` 实现计划中的 candidates、preview、jobs 列表/详情、start、cancel、resume、确认 release。只接受 `realm: global`。所有接口沿用本机 Host/Origin/客户端 header 保护。
- 预览没有外部副作用。创建时在 SQLite 事务内重验候选、24 小时检查、目标 revision、账号唯一性及占用。requestId 绑定完整参数，重复一致请求返回原任务，不重复请求；不同参数返回 409。
- 新增 `accounts.reservedBy` 迁移。被占用账号不能编辑、删除、选用、常规释放；批量操作仍整体事务。正常成功时 UID 映射和 selectedAt/用途/占用释放同一事务，不依赖公开检查仍然新鲜。
- WorkBuddy 和旧链接 worker 双向互斥；人工暂停也占用 worker，目标配置不能修改。历史 integration jobs 保留。
- 严格串行，每条 start 一次，浏览器身份及回调证据满足后 poll 一次。明确 done=false 进入人工暂停，只有用户继续才再次检查；超时/畸形结果/UID 冲突等不确定结果停止队列并保留当前占用，绝不自动重试。
- WorkBuddy 页面访问受限独立记录为 restricted 并暂停全队列；不更改 GitHub 公开状态。resume 检查同一账号、同一浏览器会话。
- cancel 关闭任务浏览器，等待在途请求结果；未开始账号 skipped 并释放，已开始未知结果保留占用。成功已提交后即使关闭窗口出错，也不降级成功。停止不能撤销远端授权。
- 启动恢复把在途/人工/受限项改为 unknown，保留占用；queued 释放。不会重发 start/poll。结束任务的非成功项需要 `acknowledge:true` 才能手动释放，保留原结果及审计。
- URL/state 在会话字段加密保存，成功后清除；公开 Item 不返回完整授权 URL/state，日志仅使用本地固定安全文本，不回传原始上游错误、昵称、API Key、密码或 TOTP。

## 生产浏览器

使用 `playwright-core` 查找本机 Edge/Chrome 可执行文件，以可见模式启动浏览器并为每账号创建独立 context；不复用默认 profile、不安装浏览器、不改系统设置、不使用代理或规避配置。启动任务前检查浏览器存在，缺少时返回可操作安装提示，尚未占用或访问上游。

只有精确 HTTPS `github.com`、`workbuddy.ai`、`www.workbuddy.ai` 无凭证/自定义端口/fragment 的 URL 可自动交互。官方 WorkBuddy 页面选择明确 GitHub 按钮/链接，监听主页面及弹窗导航。必须观察 GitHub authorize 中明确的官方 WorkBuddy redirect_uri 和 OAuth state 后才填写凭证。

GitHub 用户名通过认证页面 `meta[name=user-login]` 校验，绝不使用 WorkBuddy 昵称或已填的用户名当身份证据。自动填写已知 GitHub 登录表单；只在已知 authenticator app 路径和 `input#app_totp`/官方 two-factor 表单填写生成时刷新 TOTP。邮箱/设备验证码、缺少密钥、未知表单、通行密钥、人机验证都暂停人工。回调的 URL、state、code 必须匹配官方 redirect，HTTP 2xx/3xx 才形成回调证据，且当前页面需要回到官方 WorkBuddy 才允许服务 poll。

注入接口：`createApp(store, { oauthBrowser: { assertAvailable?(), async open({url, account:{id,username,email}, getSecrets}) { return {async step(), async close()}; } } })`。step 可返回 `{status:'manual'}`、`{status:'restricted'}`，或 `{status:'verified',githubUsername,callbackVerified:true}`。getSecrets 在使用时从 Store 生成最新 otp。

## TDD 与验证记录

1. 首轮 `node --test tests/workbuddy*.test.js`：7 项失败，原因是 createApp 未提供 WorkBuddy queue 和浏览器 trust 边界不存在；随后实现最小服务与边界。
2. 添加浏览器 TOTP/邮箱/身份回调测试后，`node --test tests/workbuddy-browser.test.js`：4 项预期失败（OAuthSession 不存在），再实现真实适配器。
3. 回归测试先捕获两项真实失败：关闭浏览器异常把已提交 success 错改为 unknown；缺失浏览器预检仍请求上游。修复后全部转绿。
4. 回调请求已观察但当前仍在 GitHub 的测试先失败（错误 verified），修复为等待官方 WorkBuddy 页面及有效 HTTP 回调。
5. 不确定项 finishedAt 缺失、重复 device state 第二次 poll 的测试各先失败，再修复终态时间和每任务会话去重。
6. 新增回调 HTTP 状态处理测试先失败（observeResponse 未实现），实现后允许正常 302 并拒绝 403。
7. 父代理检查发现首轮 OTP double 未镜像真实 Store `{code,expiresAt}` 结构，导致生产 OTP 会转人工。将测试改为真实 Store.secrets() 并加入固定时钟临近过期场景，先观察两项 TOTP 失败，修复为读取 otp.code、距过期不足 2 秒等待新窗口并重新获取；同时先红后绿修正 info/warn/error/success 日志级别。
8. 最终 `node --test tests/workbuddy*.test.js`：22/22 通过。覆盖预览、单个/批量成功、加密/脱敏、占用拦截、幂等、旧 revision、身份不匹配、受限暂停/恢复、取消、restart 恢复、未知 poll、重复 state、UID 碰撞、检查过期后提交、legacy 双向互斥、HTTP 契约及本机保护、真实 Store TOTP 自动填写和临近过期刷新、邮箱安全边界。
9. 最终 `npm test`：55/55 通过，退出码 0（包含父代理的新前端测试）。Node SQLite、MockTimers experimental warnings 及用户 npm 旧配置 warnings 保留，未更改用户配置。
10. `npm run build`：TypeScript 与 Vite 生产构建通过，退出码 0。

## 实际限制与后续核验

没有有效 API Key，没有进行真实账号 OAuth 端到端验证。浏览器页面采用严格的已知表单/角色识别，未假称线上选择器已全部实测。若线上 GitHub flow 省略 redirect_uri、未提供可靠用户 meta、使用不同回调或表单，适配器会暂停人工；不会用昵称补齐证据或自动 poll。人工继续仍必须满足同样身份及回调证据；不能满足时需要停止并自行核对远端，随后确认释放。

目前自动步骤在点击后等待页面短暂导航，慢页面可能先转人工继续。已知安全边界优先保留账号占用。真实流程兼容性需要由用户配置有效目标后，在本人授权账号和人工在场条件下进一步核验。

## 独立审查 P1 修复：OAuth 身份证据不能跨 flow/page 复用

审查发现的复现有效：s1 的 GitHub 用户 one 被保留；observe 替换为 s2 后，不匹配的用户 meta 仅返回 manual，旧 identity/callbackVerified 仍存在，随后 s2 回调会错误得到 verified one。

依 receiving-code-review 与 systematic-debugging，先增加回归并观察失败：切换 flow + 不匹配账号、同 flow 身份不匹配后再显示预期账号、读取 meta 期间 flow 改变，以及另一个 page 回调，四项均错误返回 verified。修复为单浏览器会话只接受一个冻结的 state/完整 redirect/clientId/page flow 对象。identity 和 callback 的证据显式绑定同一 flow；新 flow、不同 OAuth page 或身份不匹配会永久锁定人工并清空旧证据，不允许后续回调重新激活。

主文档导航使用 page epoch 计数。读取 meta、填写用户名/密码/TOTP、点击授权和读取最终 WorkBuddy 页面后，校验 flow 对象、page URL 与 epoch 都未变化，避免异步读取跨文档形成证据。新增最终 WorkBuddy 页面读取期间导航测试先观察错误 verified，再修复；同 URL 新文档读取期间导航也有回归覆盖。该会话锁定后必须停止并核对结果，不能继续自动切换身份。

另增加同 URL/state 新 GitHub authorize GET 导航后直接回调的测试，先观察旧 identity 仍被复用，再修复为只有已采样文档发出的 consent POST 可把绑定身份带至回调；新 GET、登录/切号导航永久失效旧证据。正常 consent POST 保留身份也有正向测试。

按父代理要求运行 `npx --yes prettier@3.6.2 --write server/workbuddy.js server/oauth-browser.js server/store.js server/integrations.js server/app.js server/index.js tests/workbuddy.test.js tests/workbuddy-browser.test.js`，统一格式，未修改前端。

格式化后 `node --test tests/workbuddy*.test.js` 30/30 通过；`npm test` 63/63 通过，两个命令退出码均为 0。没有更改前端或触发真实 OAuth。原先无有效 API Key、真实布局兼容性未验证的限制仍然成立。
