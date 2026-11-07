# 账号列表与任务分类验收（2026-10-19）

## 已交付行为

- 默认列为账号信息、来源分组、标签、TOTP、检测状态、入库时间和操作；勾选列固定保留。移除原先混合的「用途与任务」。
- 「显示列」提供复选框、即时生效、恢复默认、Esc 关闭与焦点恢复。全部账号、WorkBuddy、PAT、回收站分别保存本机浏览器偏好，异常存储自动回退，不修改账号数据。
- 可选时间包括最近检测、选用、WorkBuddy 处理结束、成功关联、PAT 到期及回收站移除。列表和账号详情统一北京时间，空值为「—」；入库时间不冒充 GitHub 注册时间。
- 分类为全部账号、未分配、WorkBuddy2api、PAT 专用、其他已分配。后台按真实占用、关联和专用标记生成只读摘要，不以用途文本推断任务归属。
- 历史失败且已释放的账号回到未分配；已有成功关联不会被之后的失败覆盖。任务状态与公开检测分开，保留冲突和未知占用提示。
- WorkBuddy/PAT 分类有独立二级筛选，未分配分类可筛选候选条件。运行中的 WorkBuddy 批次实时刷新列表及计数。
- 详情与列表提供对应任务入口；WorkBuddy 结果可按成功、失败、待核对、跳过筛选。分组、标签、导入及批量整理保持可用。

## 验证证据

- `npm run build` 通过：`output/columns-final-build.log`。
- 全量回归 335 项通过，0 失败、0 跳过：`output/columns-regression.log`。
- 独立审查补修状态自动刷新和详情时区后，重新构建实际页面及 PAT 测试资产，受影响回归 49 项通过：`output/columns-final-regression.log`。
- 状态自动刷新回归先复现 queued→running 不更新，再验证修复后 queued→running→释放全过程：`output/columns-polling-red.log`、`output/columns-polling-green.log`。
- 浏览器使用临时数据库与合成账号；覆盖列偏好、恢复默认、筛选清理勾选、空时间排序、隐藏排序列、标签展开、任务导航、洛杉矶时区下的北京时间显示。未执行真实 OAuth/PAT 操作。
- 桌面 1440px、手机 390px 截图已检查：`output/playwright/columns/`。320px 实际页面无横向溢出。
- 本地新版服务启动后通过只读浏览器检查，0 脚本错误、0 写请求：`output/columns-live-smoke.json`。

## 数据与运行状态

- 账号 102 个，当前分类：未分配 94、WorkBuddy 1、PAT 专用 2、其他已分配 5。分类数量来自实际数据，没有硬编码。
- 升级前后对账号、WorkBuddy 批次/子项/关联、PAT、分组、标签和标签关联表全部字段计算 SHA-256，全部一致：`output/columns-data-verification.json`。
- 备份位置：`output/backups/account-columns-20261019/`。
- 本地地址：`http://127.0.0.1:4318/`。

公开检测只代表公开资料可访问性，不能直接判断封号或能否登录。时间列只展示实际已存储的时间，不新增或推算不存在的注册时间、修改时间。
