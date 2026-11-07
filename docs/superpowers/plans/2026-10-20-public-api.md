# 对外账号导入 API 实现计划

**目标：** 外部程序用独立 API Key 导入账号；私有工作台管理密钥，公网入口只提供白名单接口。

**已确认设计：** 新增 API 管理页；Bearer 密钥、权限、有效期、停用与删除；JSON/文本批量导入、分组标签、重复跳过、幂等重试；不增加操作历史页面。

**架构：** 同一 Node 进程、同一 SQLite，两个仅监听 loopback 的 HTTP 服务。4318 保留工作台，4319 只挂载公共 API。HTTPS 代理只连接 4319，后端也不挂载私有路由，避免代理 Host 重写暴露后台。ACCOUNT_DESK_API_ORIGIN 指定公开 HTTPS 域名；缺省为本机 API 地址。

**技术：** Express 5、node:crypto、node:sqlite、React、现有 Modal/CSS，不增加依赖。

## 约束与接口

- 公共白名单：POST /api/v1/accounts/import；GET /api/v1/groups；GET /api/v1/tags。
- 私有管理：GET /api/access；POST /api/access/keys；PATCH、DELETE /api/access/keys/:id。
- 密钥 32 字节随机，SHA-256 摘要保存，仅创建返回明文；最多 100 把，默认 import + organization:read 权限。
- 每把密钥每分钟 60 次（SQLite 保留窗口），公网服务全局每分钟 600 次预认证限制；代理再做来源限流。不信任客户端 X-Forwarded-*。
- JSON {accounts:[{email,username,password,totp?,notes?}],notes?}；或 {text,notes?}，二选一。最多 1000 条、JSON 请求 2 MB、文本 1 MB。
- 用户追加确认：分组和标签绑定 API 密钥；创建/编辑密钥选择一个分组及多个标签，不选默认未分组/无标签。导入请求禁止覆盖归属，配置变更只影响新账号；分组删除后密钥 SET NULL，标签删除级联解除关联。
- 不覆盖重复账号，不自动恢复回收站，不赋予任务归属；错误响应不回显敏感输入。
- 可选 Idempotency-Key 8–128 字符；同密钥、同请求返回原结果，异请求 409；和导入在同一事务提交。凭证内容 HMAC 指纹，结果保留 24 小时，每把密钥最多 100 条收据，不存正文。
- 只保存密钥元数据/累计调用计数和有界短期幂等收据，无请求历史。
- 前端沿用 --surface/--text/--muted/--line/--blue 色板、Segoe UI/微软雅黑、Consolas 示例；紧凑列表与折叠文档，复用 Modal，鼠标安静焦点、键盘可见焦点，移动端卡片排列。

## 执行与验证

- [x] 添加 tests/public-api.test.js：鉴权、权限、失效/撤销、后台隔离、导入加密与重复处理、原子幂等、限额、输入边界。先运行确认缺少功能导致失败。
- [x] server/api-access.js 管理 SQLite 密钥与导入收据，server/public-api.js 管理公共路由；server/store.js 抽取事务内新增 helper，保持现有 create 行为。
- [x] server/app.js 接入私有管理接口及公共应用，server/index.js 启动/关闭两监听器，验证端口和 origin。
- [x] src/ApiAccess.tsx + src/api-access.css，App/main 接入；创建后仅一次显示密钥，复制反馈、编辑/停用/删除、密钥归属配置、文档和参数示例。
- [x] tests/api-access-browser.test.js 用临时数据库验证创建、复制失败反馈、编辑、停用、删除、桌面/移动布局，无生产数据写入。
- [x] docs/public-api.md 与 deploy/Caddyfile.api 提供 HTTPS 白名单代理和 SSH 后台访问步骤。
- [x] 构建、接口/现有核心与列表回归测试、浏览器截图审查；备份后重启项目，两端口只读验证。当前目录不是 Git 仓库，不创建提交。
