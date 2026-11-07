# 后台鉴权与移除使用说明

用户已授权添加服务器后台鉴权并删除使用说明；同域名将 /api/v1/* 代理至 4319，其余至 4318。

## 设计
- 单管理员，本机也强制登录。首次设置需数据目录中的一次性设置码，不允许公开抢注，无默认账号/密码。
- node:crypto scrypt 加盐密码哈希，随机 HttpOnly SameSite=Strict 会话 Cookie；配置 HTTPS 后 Secure。会话摘要存 SQLite，绝对 12 小时有效，最多 20 个会话。
- CSRF token 与会话绑定，仅内存保存；私有 API 在正文解析前后鉴权，写请求校验 token。公共 API 原有 Bearer 鉴权独立。
- 登录/初始化/改密共享持久化每分钟 10 次限额、最多 2 个并行 KDF；登录错误统一，异步校验后复核版本避免重置竞态。
- ACCOUNT_DESK_ADMIN_ORIGIN 指定后台 HTTPS 域名，精确校验 Host/Origin，不信任 X-Forwarded-*。回环 HTTP 用于本机/SSH，HTTPS 域名请求使用 Secure Cookie。
- 登录页首次设置、登录、过期退回；顶栏管理员入口支持改密和退出。改密使全部旧会话失效并创建当前新会话。不把密码或会话放进 localStorage。
- 本机 CLI npm run admin:reset 要求停止服务并持有 runtime lock，生成新一次性码、撤销后台会话，保留账号及 API 密钥。
- 移除桌面/手机使用说明入口、help View 与页面，仅保留 API 内的调用文档。

## 实现与验证
- [x] tests/admin-auth.test.js 先覆盖未初始化/匿名保护、设置码、Cookie、CSRF、限流、重启/退出/改密/过期、上传中撤销、域名与伪造转发头。
- [x] server/admin-auth.js 实现凭证、会话、路由中间件；server/app.js 默认强制使用；server/index.js 读取 origin；Store 记录目录；scripts/reset-admin.mjs 恢复。
- [x] tests/authenticated-app.js 用真实测试会话包装旧集成测试，仅在 tests 下，不新增生产绕过。
- [x] src/AuthGate.tsx / auth-context.ts / AdminSession.tsx / auth.css；main、api、App 接入并删除 help。
- [x] 新浏览器测试临时库端到端验证设置、登录、退出、改密与无使用说明；更新 runtime test 匿名 401，保持公共 API 兼容。
- [x] docs/admin-auth.md、同域名 Caddy 模板，更新 API 文档和 README。
- [x] 构建、完整回归、独立审查、桌面与手机截图；备份后重启，匿名只读验证。本地管理员密码由用户在新页面设置，不代设或在对话中收集密码。
