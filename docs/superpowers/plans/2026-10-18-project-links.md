# 项目对接：授权链接获取

**Goal:** 在现有账号工作台增加独立页面，配置 WorkBuddy2API 实例并顺序获取指定数量的授权链接。

**Scope approved in chat:** 保存名称、HTTPS 部署地址、加密 API Key；测试连接；选择 cn/global 和数量；二次确认；顺序请求 login/start；展示可复制链接、state、时间、失败原因。暂不关联 GitHub 账号，不自动打开链接，不调用 login/poll，不修改账号使用标记。

**Architecture:** 独立 IntegrationService 复用 Store 的 SQLite 连接及加密密钥，新增数据表，不改变现有账号表。Express 本地受保护 API 代理已配置目标。后台串行队列持久化每一步，React 页面读取本地任务进度。

**Tech Stack:** Node >=22.15、Express、SQLite、React/TypeScript、现有 CSS/Lucide；无新增运行依赖。

## Task 1: 接口与任务（TDD）
- [ ] 新增 tests/integrations.test.js：通过真实本地 HTTP app 验证保存/编辑、密钥不回传及加密、地址与数量验证、请求鉴权/realm、串行执行、取消、鉴权失败停队列、响应异常和重启恢复、重复提交去重、不改变账号。
- [ ] 运行 node --test tests/integrations.test.js，确认缺少路由导致失败。
- [ ] 新增 server/integrations.js，接入 server/app.js，退出时等待任务收尾后关闭数据库。
- [ ] 仅请求 overview 和 login/start；HTTPS，禁止重定向，有限响应体及超时；不输出第三方原始错误或密钥。POST 不自动重试，网络结果不确定需提示。
- [ ] 运行测试至通过。

## Task 2: 页面（TDD + UI 验证）
- [ ] 补充 tests/ui.test.js 的实际组件渲染测试，先见失败。
- [ ] 新增 src/Integrations.tsx 与 src/integrations.css，App 导航接入；保留现有蓝灰色系、微软雅黑/Segoe UI 和等宽链接。
- [ ] 提供配置表单/项目切换、新建、保存、测试连接；cn/global、1–100 数量；确认弹窗列出目标地址/区域/数量，确认按钮明确为获取链接。
- [ ] 任务结果逐行呈现编号、状态、创建时间、可复制 URL/state。支持停止后续请求、历史任务、刷新恢复，禁止重复启动。
- [ ] 错误/空态、键盘可访问、窄屏换行、减弱动画。使用真实浏览器与模拟上游检查取消确认不发请求、串行结果、刷新和手机布局。

## Task 3: 交付
- [ ] npm test 与 npm run build 均通过；更新 README。
- [ ] 不使用真实凭证测试，不调用用户远端授权接口；单独说明真实联调待用户填写 API Key。
- [ ] 项目没有 Git 仓库，不创建提交或工作树；保留全部真实账号数据。
