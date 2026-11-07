# workBuddy2api OAuth 实施计划

> 按测试驱动开发逐项执行；后端交由隔离上下文的实现代理，完成后独立审查。当前不是 Git 仓库，不创建提交或删除现有数据。

## 已确认的设计

只支持国际版 Global。页面改名 workBuddy2api，六个统计格（目标、成功、失败、进度、开始时间、耗时），操作栏（固定国际版、数量、开始、停止、账号列表），日志区域（自动滚动、清空显示）。右上角配置打开居中弹窗，保存部署地址和 API Key，不写死部署域名。保留多个已保存目标，密钥加密保存，不回传。

顺序执行：预览候选账号并二次确认 → 临时占用账号 → login/start → 独立可见浏览器打开受信任的 WorkBuddy 国际版链接 → 选择 GitHub，自动填写本人账号密码和可用 TOTP → 人工处理验证码/邮箱验证/未知页面 → 核验 GitHub 身份及授权回调 → login/poll → 验证 done=true、global 和 UID → 本地事务保存远端 UID 映射并标记已使用。

不得根据昵称猜测身份。禁止把取链接当成功；禁止代理轮换、指纹规避、绕过风控。WorkBuddy 访问受限单独记录并暂停全队列，不修改 GitHub 公开检查结果。不确定结果保留占用；不会自动重新发送 start 或重试可能已入池的 poll。停止不能撤销已经发生的远端授权。

上游 poll 是有副作用的 GET，会凭证落盘、热加载账号池、Global 注册激活（可能补地区）和 trial 领取。确认弹窗、README 披露此上游行为。本地不新增促销/奖励操作。

## 接口契约

复用 `/api/integrations/targets` CRUD/test 和加密密钥。新接口前缀 `/api/workbuddy`：

- GET `/candidates` → `{accounts:[{id,username,email,hasTotp}],reserved:number}`，24h 内 reachable、未 selected、未占用、未映射到成功。
- POST `/preview` body `{targetId,targetRevision,count,realm:'global'}` → `{target:{id,name,baseUrl,revision},accounts:[...],count}`；无外部副作用。
- POST `/jobs` body 同上加 `{accountIds:[...],requestId}` → job；重验候选、配置 revision，事务占用，requestId 幂等。
- GET `/jobs` → JobSummary[]，最近30条。GET `/jobs/:id` → job。
- POST `/jobs/:id/cancel` → job，停止请求并关闭任务浏览器，保留不确定项占用。
- POST `/jobs/:id/resume` → job，从人工暂停继续检查当前账号，禁止跳过受限账号换号。
- POST `/jobs/:id/items/:position/release` body `{acknowledge:true}` → job，仅任务结束后释放未成功占用，保留审计和未知状态，必须二次确认。远端结果仍需用户自行核对，不作成功推断。

JobSummary：`id,targetId,targetName,baseUrl,total,status,running,createdAt,finishedAt,message`。
Job：以上加 `items,logs`。
Item：`position,accountId,username,email,status,message,createdAt,finishedAt,uid?,url?,reserved:boolean`。
状态：queued, linking, browser, manual, restricted, polling, success, failed, unknown, skipped。
Job.status：running, paused, completed, stopped；running 在 paused 时仍 true。Log：`id,createdAt,level,message,position?`，绝不含密码、TOTP、API Key、完整授权 URL/state。

浏览器适配器接口由后端实现者定义并单测；真浏览器仅官方 https://github.com、workbuddy.ai / www.workbuddy.ai 上自动交互。每账号独立会话；不复用用户默认浏览器 profile。没有足够身份/回调证据时不 poll，不假称成功，转人工提示。

## Task 1 后端与浏览器

- [x] 新增 tests/workbuddy.test.js 和浏览器安全边界测试，验证先红后绿。
- [x] 新增 server/workbuddy.js、server/oauth-browser.js，复用 IntegrationService.request；按上游流程区分网络/鉴权/WorkBuddy 受限/身份不匹配。
- [x] server/store.js 新增持久占用，编辑、删除、select、release 拦截被占用的账号，列表返回 reservedBy；成功标记事务不依赖仍新鲜的公开检查。
- [x] app.js/index.js 接入路由和 graceful stop；legacy link worker 与新 worker 互斥、目标配置不可在运行时修改。
- [x] 中断恢复保留未知占用、释放未开始项；敏感数据加密、日志脱敏；不覆盖历史 link jobs。
- [x] 添加 playwright-core 依赖，使用本机 Edge/Chrome 可见浏览器，缺失时给可操作错误；不隐式安装浏览器或改系统设置。
- [x] 测试覆盖单个/批量顺序、成功标记、受限暂停、取消、重复提交、旧 revision、重启恢复、未知 poll、并发互斥、凭证不泄露、URL/身份校验。

## Task 2 界面

- [x] 新组件 WorkBuddy.tsx、WorkBuddyConfig.tsx，复用 Modal/useDiscardConfirmation；旧 Integrations 保留历史数据兼容，不再做主导航页面。
- [x] App.tsx 导航更名和切页刷新账号；types.ts 支持 reservedBy，eligible 排除占用。
- [x] CSS 沿用浅灰蓝工作台，白色统计格，日志以紧凑等宽时间列为特征；Segoe UI/Microsoft YaHei 正文、Consolas 数字，44px 控件、可见焦点、375px两列统计和换行操作栏。
- [x] SSR 测试确认目标/数量/后果/账号预览，状态不能误称成功；浏览器验证配置/放弃编辑/开始确认/停止确认、桌面移动端。

## Task 3 核验与交付

- [x] npm test 与 npm run build，独立审查修复重要问题。
- [x] README 记录设置、鉴权机制、访问受限边界、人工接管、停止和未知结果的处理。
- [x] 临时数据库及 mock 远端跑 UI，不触碰真实账号。没有用户填写 API Key 不进行真实授权，并明确未完成真实端到端验证。
- [x] 本地正式服务切换至新后端：用户明确要求重启后已完成，4318 端口新进程为 24796。

## 执行记录

- 当前接口鉴权已用上游源码及部署实例公开 JS 交叉核验：localStorage 保存 API Key，每次 Bearer；密钥自身无内建过期。
- 采用当前目录原地实现：没有 Git 仓库，worktree 和 git review-package 不适用，以命名文件和测试报告审查。

## 最终核验（2026-10-18）

- 最新完整 `npm test`：63/63 通过，0 失败；`npm run build` 成功，均 exit 0。
- 独立审查发现的 OAuth 身份/回调证据跨流程复用已修复，增加 8 项回归测试，复核通过。刷新同步错误恢复后残留提示已修复，并完成浏览器失败→恢复验证。
- 临时数据库及 mock 远端已验证配置保存、开始/停止/释放二次确认及取消、人工接管继续、成功标记、受限暂停、刷新恢复、375px 移动端、812px 横屏和减少动效设置。
- 真实服务只读核验：4318 端口仍由旧进程 26140 提供，2 个账号、0 个已使用，活性检查未运行。停止/备份/重启的组合命令被执行环境整体拒绝，未完成备份或服务更新，不能宣称新后端已上线。
- 未使用真实账号登录，未请求受保护的远端接口。真实端到端流程需配置 API Key 后先测试 1 个账号；官方页面字段或跳转与适配器不符时会暂停，需要据实际页面调整。

## 重启补充（2026-10-18）

- 用户明确要求重启后，停止已核实的旧进程 26140，离线复制完整 data 目录至 `output/backups/before-workbuddy-1792330218`，4 个文件逐一 SHA-256 校验一致。
- 新后端已在 127.0.0.1:4318 启动，进程 24796。首页 HTTP 200 且引用最新构建；workbuddy/jobs 与 integrations/targets 均可读取。
- 现有 2 个账号保留，已使用数量仍为 0；未启动真实 OAuth 任务。
