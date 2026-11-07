# API 管理验证记录 · 2026-10-20

## 最终行为

- 独立 loopback 4318 工作台与 4319 API-only 服务，外部代理只连接 4319。
- 密钥摘要持久化、权限、有效期、停用/启用、删除；编辑后弹窗关闭，完整密钥只创建时展示。
- 分组/标签绑定密钥；默认未分组/无标签，导入请求不允许覆盖；变更不改旧账号，删除分类自动解除绑定。
- JSON/文本导入、重复跳过、加密存储、安全逐条错误、原子幂等重试、容量与频率限制。
- JSON 上传完成后复核密钥有效性及权限，防止上传途中撤销仍成功提交。

## 验证

- `npm run build` 通过：output/public-api-build.log。
- 全量回归 416/416 通过：output/public-api-full-tests.log（在最后一轮密钥归属变更前开始运行）。
- 最终定向回归 25/25 通过：`node --test --test-concurrency=2 tests/public-api.test.js tests/public-api-runtime.test.js tests/api-access-browser.test.js tests/account-list-browser.test.js tests/core.test.js tests/organization.test.js`，日志 output/public-api-final-tests.log，覆盖最终密钥归属变更。
- 最后补充手机弹窗检查，浏览器测试 1/1 通过：output/public-api-ui-final.log。
- 审查发现的上传中撤销竞态已先复现失败再修复；独立审查确认修复与密钥归属增量无剩余实质问题。
- 截图检查：output/playwright/api-access/desktop.png、mobile.png、key-editor.png、key-editor-mobile.png。
- 测试均使用临时数据库和合成账号，不调用 GitHub，不创建生产密钥或导入测试账号。

## 本地运行

- 停服务备份：output/backups/public-api-20261020，包含数据库及 master.key。
- 新服务 PID 13468，4318/4319 均仅监听 127.0.0.1。
- 工作台首页 HTTP 200；私有 API 管理数据读取成功，初始密钥 0 把；升级前后账号数均 102。
- API-only 入口 `/`、`/api/access` 返回 404；未鉴权 `/api/v1/groups` 返回 401。
- 公网域名/TLS/防火墙未在真实服务器部署或验证；提供 docs/public-api.md 和 deploy/Caddyfile.api 供部署。
