# 实施计划

目标：交付本机可运行、数据持久化的第一阶段账号工作台。设计依据：`docs/design.md`。

- [x] `server/parser.js`：实现独立导入校验函数 `parseImport(text)`，返回有效记录和不含原文的错误；编写缺少密钥、非法格式、重复和密码空格测试。
- [x] `server/store.js`：SQLite 表与事件日志、AES-GCM、CRUD、导入、原子选用；`tests/core.test.js` 使用临时目录验证持久化/加密/重复选用/恢复。
- [x] `server/checker.js`：可注入 fetch 的状态判断和单队列检查服务，限流停止、取消、进度；测试 200/404/403/429/网络异常。
- [x] `server/app.js`、`server/index.js`：本机 HTTP 服务、参数校验、静态文件、安全请求边界；测试接口与敏感字段隔离。
- [x] `src/`：中文工作台、导入预览、详情与编辑、筛选、检查进度、使用日志及回收站。每次写操作提供进行中/结果反馈。
- [x] 执行 `npm test`、`npm run build`，浏览器交互验证和响应式检查，结果见 `docs/verification.md`；提供启动脚本和 README。
