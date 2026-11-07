# PAT 随机接续与自动检测 Implementation Plan

> **For agentic workers:** Use subagent-driven-development for isolated UI implementation and review; backend dependencies are implemented sequentially by the primary agent.

**Goal:** 每次任务随机使用 PAT 并按账号额度接续；提供持久化筛选与按最近检测时间调度。
**Architecture:** 保留 checker 检查点，拆分 PAT 单账号冷却与全局退避；独立 CheckSchedule 处理配置、范围、到期和重试。生产入口启动调度，测试注入时钟并手动 tick。
**Tech Stack:** Node 22 / SQLite / Express / React / TypeScript / node:test / Playwright。
**Spec:** docs/superpowers/specs/2026-10-19-check-scheduling-design.md

## Global constraints
- 自动检测默认关闭；周期 1–365 整数天；默认排除失效；不恢复通用操作历史。
- 不在真实数据上执行检测/删除/授权来验证；使用临时数据库和模拟响应。
- 当前目录没有 Git 仓库，直接编辑已授权工作区；不创建 worktree、不提交。
- 复用紧凑弹窗和 UI token；保存成功关闭，失败保留内容，键盘可达，移动端无溢出。

## 1. PAT 轮换与 checker 接续
- [x] 新增 tests/check-scheduling.test.js，真实 PatService+Store 夹具以固定 random/clock 断言选择与耗尽接续。
- [x] 跑新测试，确认当前固定顺序、全局配额等待不符合预期。
- [x] PatService 注入 random/clock；credential(signal,{preferredId}) 随机选独立账号，支持恢复；普通额度仅更新同账号，二级限制保留全局等待。
- [x] checker 使用新报告 cooldownScope 区分接续与等待；保存 patId/patUsername，当前行重试不重复完成结果。
- [x] 跑 PAT/checker 回归；更新仅因旧全局配额策略而失效的测试。

## 2. CheckSchedule
- [x] 测试组合筛选、到期边界、失败退避、零匹配、冲突、重启和取消。
- [x] 新建 server/check-schedule.js。settings={enabled:false,intervalDays:7,statuses:['reachable','unknown','unchecked'],groupIds:null,tagIds:null}；null 表示全部，'none' 表示未分组/无标签，数组空表示匹配零个。状态维度至少一个。
- [x] GET /api/checks/config 与 PUT /api/checks/config 返回 {settings,matched,due,nextDueAt,invalidFilters,message}；POST /api/checks/preview 接收完整设置，返回相同形状；POST /api/checks/range 接收完整设置，仅立即检查该范围，返回 Job。
- [x] 新增 SQLite 单行配置及按 accountId 外键级联的重试记录，不无限增长；每分钟 tick，默认 createApp 不启用计时器，server/index.js 显式 start/stop。
- [x] checker.setSchedule(schedule) 绑定自动范围资格、尝试与结果钩子；自动网络失败保留旧结果，有限重试后继续下一账号，通过持久化重试时间调度失败账号。
- [x] scheduler tick 不覆盖 running/canResume 或授权/验证任务；启动后补查到期集合。

## 3. 紧凑前端（委派独立子任务）
- [x] 新建 src/CheckSettings.tsx 与局部 CSS，消费上述接口；组织维度多选、周期快捷值、预览数量、保存与检测此范围。
- [x] src/App.tsx 新增检测设置和检测筛选结果入口；闲时低频读取任务以发现自动运行任务。
- [x] src/CheckProgress.tsx 与 src/types.ts 支持 scope=scheduled/filtered、patId/patUsername。
- [x] 浏览器测试配置保存/重新打开、错误校验、筛选检测跨页、移动布局和自动刷新，不调用真实上游。

## 4. 集成验证与上线
- [x] 运行新增及现有相关测试、构建；独立审查并修复实际问题。
- [x] 启用本地服务之前停止旧进程并备份数据；重启验证默认关闭和账户归属保持不变。
- [x] 文档记录证据和限制，返回用户操作入口。

## Ledger
- 用户已确认设计，可连续实施，无需再次方案审批。
- 使用 subagent-driven-development 委派前端与审查；当前主代理负责顺序依赖的后端。

- 完成：全量 385/385；最新相关 98/98；构建通过；独立审查问题已修复。已备份、重启并确认真实账号/PAT/归属数据不变。证据见 docs/check-scheduling-verification.md。
