# 任务占用与历史 WorkBuddy 归属修正（2026-10-19）

## 问题与处理

原「待选择」混合当前任务占用和普通历史选用标记。改为「任务占用」，仅按尚未释放的任务占用字段筛选，包含等待人工处理的任务；默认展示任务状态列，列偏好独立保存。

截图中的四个 WorkBuddy 账号只有 lamont-roan82 有自动授权 UID 关联。nilesboone32、silas-cormac68、caden-flow21 的历史记录已经明确登记「WorkBuddy 国际版：远端账号池已存在（用户确认）」，但旧分类未识别。

本次增加只读兼容识别：必须同时匹配当前选用时间、用途、账号 ID、用户名与历史选用事件，且没有更新的选用/释放事件。三个账号展示为「外部已登记」，保留实际登记时间及防重复选用标记；不新建 UID 映射、不伪造授权成功结果。没有对应自动任务时打开登记详情。

yorickyates43 与 jarencedric67 只有旧的人工「PAT」选用标记，没有 PAT 记录。用户明确确认清除后，通过现有释放接口清除了这两条标记，并产生两条正常操作记录。

## 实际结果

- 总账号 102。
- WorkBuddy 4：1 个自动关联，3 个历史外部登记。
- PAT 专用 2：jasperfable62、marlowlarkin33，均为有效记录。
- 当前任务占用 0；已使用账号合计 6。
- SHA-256 核验确认仅获准的两个账号 selectedAt/purpose 字段发生预期修改；其他账号字段、WorkBuddy/PAT 任务表、分组标签表保持一致，操作日志恰好新增两条释放记录。
- 备份：`output/backups/ownership-fix-20261019/`。
- 数据核验：`output/ownership-verification.json`；实际服务浏览器验收：`output/ownership-live-smoke.json`。

## 验证范围

覆盖历史登记识别、缺少证据、时间/用户名不匹配、后续释放、候选保护、任务占用与手动选用区分、列设置及手机布局。真实服务仅执行用户确认的两条本地释放操作；浏览器验收不发写请求、不启动授权任务。

- TypeScript/Vite 构建通过：`output/ownership-final-build.log`。
- 完整回归 339 项通过，0 失败、0 跳过：`output/ownership-final-regression.log`。
- 首轮发现新增测试在手机布局中等待桌面表头；改为验证手机实际任务状态单元格后重新运行完整回归。
- 实际页面截图已检查：`output/playwright/ownership-workbuddy.png`；320px 页面无横向溢出。
