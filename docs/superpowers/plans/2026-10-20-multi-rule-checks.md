# 多规则自动检测实施与接口约定

用户已批准实施。保留紧凑的检测设置弹窗，支持多条独立启停、命名、编辑、删除规则，固定间隔与分阶段两种模式共存。

## 数据约定

Settings = {version:2, enabled:boolean, rules:Rule[]}，最多 30 条。enabled 是全局开关。

Rule = {id:string, name:string, enabled:boolean, mode:'interval'|'staged', intervalDays:number, stageDays:number[], baseline:'imported'|'date', baselineDate:string|null, repeatDays:number, statuses:CheckStatus[], groupIds:string[]|null, tagIds:string[]|null}。

默认规则：id='legacy-default', name='默认规则', enabled=true, mode='interval', intervalDays=7, stageDays=[1,3,7,15,30], baseline='imported', baselineDate=null, repeatDays=30, statuses=['reachable','unknown','unchecked'], groupIds=null, tagIds=null。全局默认关闭。旧设置完整迁移为这条规则，不更改 enabled、intervalDays、筛选数据。新规则 ID 使用 UUID。

规则名 1–40 字符，ID 唯一 1–128 字符。所有天数为 1–365 的整数；stageDays 严格升序且不重复，1–30 个节点。baselineDate 在 date 模式为合法 YYYY-MM-DD（2000–9998 年）。数组筛选语义沿用原实现，空数组匹配零个，null 表示全部。

Preview = {settings,matched,due,nextDueAt,invalidFilters,message,rules:[{id,matched,due,nextDueAt,invalidFilters}]}。逐规则预览提供自身范围；全局计数是启用规则的去重并集，全局开关关闭也可预览/手动执行。关闭的规则不加入并集。无规则或全关闭可保存，预览为零。

已有端点不变。POST /checks/range 对启用规则并集立即检测，忽略到期时间、不保存草稿。已删除筛选项只阻止其所属规则，其余有效规则继续；范围检测拒绝存在启用且失效筛选的草稿，避免误解执行范围。GET 配置始终返回 v2。兼容旧请求仅限尚未切换多规则的 legacy-default 单条规则，避免旧网页覆盖新配置。

## 到期语义

- 固定间隔沿用最近 checkedAt + intervalDays，未检测立即到期。
- 分阶段基准为账号本地导入日期（createdAt，非 GitHub 注册日）或自定义日期，统一北京时间零点。第一天指次日零点。
- 阶段节点相对基准日期，第 1、3、7、15、30 天；最后节点之后每 repeatDays 天延续固定时间轴（如第 60、90 天）。
- 用最近确认可用/失效的检测时间判定已覆盖节点；手动确认同样覆盖。网络失败、限流不推进节点。记录每账号最近一次确认（不存操作历史），首次迁移从现有确定结果初始化；未知结果不可当作确认。
- 超过多个节点只补查一次，完成时间覆盖所有过去节点；同一账号命中多条规则，采用最早到期时间，账号 ID 去重。重试退避是账号级下限，不因另一规则绕过。
- 删除分组/标签不扩大范围；规则启停或编辑立即影响后续启动。总开关关闭不取消已经运行的任务。
- 保留 PAT 随机选择、正常额度耗尽换账号、全局限流等待、任务互斥、取消与重启恢复。

## 实施及验证

1. 后端：迁移/校验、日期算法、多规则并集、确认状态持久化，新增模拟时钟集成测试并保留原调度回归测试。
2. 前端：紧凑规则切换列表＋单条编辑区，新增/删除/启停、模式与日期配置，预览及校验，保存关闭，草稿保护；更新类型与浏览器测试。CSS 仍由 main.tsx 集中引入。
3. 独立复核、构建、全量测试、截图检查。测试使用临时数据库与模拟上游，不执行真实检测。
4. 当前任务空闲时备份、重启服务，核对配置迁移和账号归属不变，更新 README 和验证文档。

## 进度

- 后端实现完成：v2 迁移、双模式调度、并集去重、确认记录与重试保护；16 项新增后端测试和 12 项原调度回归通过。
- 前端实现完成：多规则紧凑编辑、草稿/隐藏字段校验、预览竞态保护及手机适配，实际浏览器验证通过。
- 独立复核完成，时间快照、旧规则名覆盖和手机规则栏压缩问题已修复并复验。
- 构建与全量 403/403 通过；最新浏览器测试单独重跑 1/1 通过。
- 停服备份、启动新版与数据对比完成：102 账号、2 PAT 及归属/分组/标签未变，自动开关保持关闭。详见 docs/multi-rule-checks-verification.md。
- 决策：默认按导入日计算，可指定日期；若账号导入很晚需用户指定实际观察起点。
- 工作区没有 Git 仓库，直接在既有目录按文件边界实施；保留文档与备份作为恢复依据。
