# PAT 管理与回收站清理验证

日期：2026-10-19

## 行为

- PAT 页面保留紧凑状态条，移除空闲维护任务卡片；自动只读刷新，不因打开页面创建凭据。
- 支持新增补足、搜索账号/邮箱/备注、状态筛选、详情、编辑备注、停用、释放、删除已停用或已释放记录。
- 目标数量允许 1–100 整数，维护执行预算随目标增长，保持每轮有界。配置成功保存自动关闭，错误留在弹窗。
- 删除本地凭据不会撤销远端 Token。必要的远端有效期保护独立保存，不保存 Token；无记录的专用账号仍可从页面释放。
- 通用操作记录页、接口及 events 表移除。先迁移严格匹配当前账号/选用时间/用途的 WorkBuddy 归属，再清理旧日志。
- 回收站支持选中永久删除及清空全部；使用确认快照，事务内重新校验，只删除仍在回收站且无活动任务/未知凭据的账号。
- 永久删除清理账号凭据、分组标签关联、PAT、WorkBuddy 关联/对应条目日志，以及检测队列中的账号。检测进度与账号删除共用事务，其他待检测账号仍可恢复。提交后尝试 VACUUM 与 WAL 截断。

## 验证证据

- `npm run build`：通过，`output/pat-cleanup-build.log`。
- 首轮全量回归 366 项：364 通过，两项浏览器测试依赖旧操作记录入口/旧说明文案；更新导航与等待方式后在下面的浏览器回归中通过。
- `node --test --test-concurrency=2 tests/cleanup-browser.test.js tests/pat-ui-browser.test.js`：13/13 通过，`output/pat-cleanup-browser-tests.log`。
- `node --test --test-concurrency=2 tests/cleanup.test.js tests/pat-store.test.js tests/pat-service.test.js tests/pat-checker.test.js tests/account-tasks.test.js`：112/112 通过，`output/pat-cleanup-backend-tests.log`。
- 新增测试覆盖目标为 5 实际生成 5 条模拟凭据；删除条件、验证任务保护、已删除凭据的远端有效期保护跨重启；回收站事务回滚、关联清理、暂停检查队列保留与重启；配置保存、自动刷新、搜索、备注编辑、确认取消、永久清空；桌面及 375px 布局。
- 所有破坏性浏览器流程仅操作临时测试数据库。没有在用户数据库执行 PAT 删除或回收站清空。

## 本地服务迁移

- 已确认任务空闲，停止旧服务；备份到 `output/backups/pat-cleanup-20261019`，再启动新版服务（端口 4318）。
- 迁移前后账号公开投影和 PAT 状态完全一致；数据库账号、PAT、PAT 设置、部署配置、WorkBuddy 映射和限制逐行一致。
- 102 个账号、4 条 PAT 保留；归属仍为 WorkBuddy 4 / PAT 2 / 未分配 96。
- 清理 734 条通用日志，保留 3 条必要的历史 WorkBuddy 归属；events 接口返回 404。
- 数据库主文件 557056 → 417792 字节（544 → 408 KiB）。外键检查通过。
- `output/pat-cleanup-migration-verification.json` 保存迁移核对结果。
- 实际浏览器已确认新版 PAT 页面、数量输入、两条已释放记录的删除入口和回收站清空入口；未修改原用户标签页内未保存配置。
- 截图：`output/playwright/cleanup/pat-live.png`、`pat-desktop.png`、`pat-mobile.png`。
