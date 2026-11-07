# 多规则自动检测验证记录

实施约定见 `docs/superpowers/plans/2026-10-20-multi-rule-checks.md`。

## 本次范围

固定间隔与分阶段规则共存，独立筛选、启停，合并去重。分阶段按北京时间的导入日期或指定日期计算，错过节点合并补查，手动确认覆盖已过节点。每账号只保存最近确认与重试状态，不增加操作历史。

## 数据保护

- 开始时自动检测关闭，原设置为 7 天、可用/未知/未检测、全部分组与标签。
- 开始时共 102 个账号。实施期间观察到原服务退出，4318 无监听；未在测试期间重启旧版本。
- 停服备份：`output/backups/multi-rule-checks-20261020`，包含 accounts.sqlite 与 master.key。
- 所有调度及上游请求测试使用临时数据库、模拟 GitHub 响应，不消费真实额度。

## 验证结果

- 新增规则、日历节点、多规则并集与确认时间测试均先运行失败再实现。回归覆盖迁移、旧客户端覆盖保护、重命名、永久删除、跨规则退避、重启恢复和单次补查。
- `npm run build` 通过，日志 `output/multi-rule-build.log`。
- `node --test --test-concurrency=2 tests/*.test.js`：403/403 通过，日志 `output/multi-rule-full-tests.log`。
- 补充隐藏字段焦点与手机滚动断言后，再用生产构建运行 `node --test tests/check-settings-browser.test.js`：1/1 通过，日志 `output/multi-rule-browser-final.log`。该重跑不额外计入全量数量。
- 独立复核与浏览器联调发现并修复三处问题：同次预览读取不同时间导致未检测账号漏算到期；旧格式请求覆盖已修改的规则名；窄屏规则切换栏被压缩。均有失败复现与修复后的回归证据，复核无剩余重要问题。
- 桌面、320px、390px 截图已检查；320px 可切换规则并滚动查看日期、范围和预览，底部操作保持可用。

## 上线核对

- 新服务启动 PID 6904，监听 `http://127.0.0.1:4318/`。服务日志 `output/multi-rule-server.log` 和 `output/multi-rule-server-error.log`。
- 原单条配置迁移为 v2“默认规则”：全局关闭，规则启用，固定间隔 7 天，原状态/分组/标签筛选不变。没有自动创建新分组、标签或检测任务。
- 102 个账号、2 条 PAT 及配置/归属/分组标签关联共 11 张表内容与停服备份逐行摘要一致。外键检查通过。验证输出 `output/multi-rule-live-verification.json`，可复核脚本 `output/multi-rule-live-audit.mjs`。
- 实际页面核对匹配 32 个、到期 0 个。独立临时标签页查看分阶段草稿后关闭，未保存草稿或更改自动开关。
- 实际界面截图 `output/playwright/check-settings/multi-rule-live.png`；完整测试界面 `staged-desktop.png`、`staged-mobile-320.png`、`staged-mobile-320-scope.png`。实际截图显示的是分阶段编辑预览，持久化配置仍为原固定间隔模式。

## 使用说明

账号管理 → 检测设置 → 新增规则 → 选择固定间隔或分阶段 → 按分组、标签、状态确定范围 → 启用所需规则与自动检测 → 保存。阶段默认按导入日的北京时间零点起算，导入日不是 GitHub 注册日；如果需要从指定观察日期开始，选择“指定日期”。
