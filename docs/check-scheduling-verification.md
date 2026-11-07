# PAT 随机接续与自动检测验证

## 已实现

- 新检测任务随机选用合格 PAT；普通账号配额耗尽自动接续另一个账号，当前未完成请求重试、已完成行不重复请求。
- HTTP 200 用尽最后额度、403/429 且明确普通额度为零均覆盖；Retry-After/二级限流仍全局等待，关闭 PAT 使用也不会跳过已保存的全局冷却。
- 按 GitHub 账号识别配额，共享账号的凭据不重复计作独立额度；全部用完等待最早可信恢复时间。
- 账号管理新增检测设置、检测筛选结果，筛选检测覆盖所有分页。弹窗配置分组、标签、状态与 1–365 天周期，支持即时范围预览和手动范围检测。
- 自动检测默认关闭，以各账号最近检测时间判断到期；每分钟调度，独立于网页。异常保留上次结果并按 30 分钟、2 小时、6 小时退避。
- 修改周期时同时遵守新的到期时间和失败退避；已删除的筛选项不会扩大范围；回收站始终排除。
- 已有任务互斥；服务正常退出或崩溃后接续自动进度，用户明确取消则保持暂停。设置、检查点和每账号最近尝试持久化，不恢复操作历史记录。

## 验证证据

- `npm run build` 通过：`output/check-scheduling-build.log`。
- 首轮全量 382 项中 380 通过，失败项为新增 CSS 组件导入影响 SSR 测试，以及并行浏览器截图超时。CSS 已归入 main.tsx 统一入口，降低并发重新运行。
- `node --test --test-concurrency=2 tests/*.test.js`：385/385 通过，`output/check-scheduling-full-tests-final.log`。
- 全量启动后补充 HTTP 429 普通配额与明确取消恢复测试；最新相关回归（轮换、调度、PAT 服务和 checker）98/98 通过，`output/check-scheduling-final-focused.log`。不将这些重复测试计入全量总数。
- 浏览器集成覆盖配置校验、保存失败保留、保存成功关闭与重开、手动范围不保存设置、30 条跨 25 条分页的范围、闲时发现自动任务、失效分组/标签、键盘焦点、320/390px 无溢出。
- 独立审查发现并修正：正常关服与用户取消混淆、增加周期未考虑旧重试记录、异常资料丢失退避、匿名任务跳过全局冷却。每项有失败复现和修复后的回归证据。
- 新功能的请求、到期与失败验证均用临时数据库、模拟响应及可注入时钟；未消耗真实 GitHub PAT 配额，未自动创建真实凭据。

## 本地上线

- 确认检测、PAT 与授权任务均空闲后停止旧进程，备份至 `output/backups/check-scheduling-20261019`，重启端口 4318 服务。
- 账号投影、PAT 状态与备份中 accounts / pats / pat_settings / integration_targets / workbuddy_mappings / workbuddy_registrations / workbuddy_restrictions 数据逐行保持一致；SQLite 外键检查通过。
- 上线时 102 个账号、2 条 PAT；归属 WorkBuddy 4、PAT 2、未分配 96。
- 初始设置：关闭自动检测，7 天，包含可用/未知/未检测，全部分组与标签。当前匹配 81 个，当前到期 0 个。
- 核对输出：`output/check-scheduling-live-verification.json`；服务日志 `output/check-scheduling-server.log`、`output/check-scheduling-server-error.log`。
- 在独立临时浏览器标签页确认了实际设置弹窗，未改动原页面未保存内容，也未提交自动检测开关。
- 截图：`output/playwright/check-settings/live.png`、`desktop.png`、`mobile-320.png`、`mobile-390.png`。

## 使用

账号管理 → 检测设置 → 选择状态/分组/标签与间隔 → 按需开启自动检测 → 保存设置。手动检测可用单行入口、勾选账号、检测筛选结果或弹窗中的检测此范围。电脑或后台服务停止时不执行；保留后台服务即可在关闭网页后继续运行。
