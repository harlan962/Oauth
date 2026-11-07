# PAT 中断恢复排查与验证（2026-10-19）

## 发现

实际记录处于 manual，未保存 Token，creationUncertain=false，仍保留 pat: 前缀的账号占用。运行中的服务没有 active PAT 浏览器任务。

原构造函数把中断任务统一标记为人工处理；start/credential 又拒绝所有 manual 记录，而 resume 必须有当前进程内的浏览器对象，因此重启后的未提交任务没有恢复入口。

## 修复范围

- 启动时识别保留占用、未提交、无 Token 的中断记录，不触发登录。
- 在用户发起补充或检查后，读取 Windows 浏览器进程路径，确认项目浏览器（包括旧版本）已退出。
- 继续原账号和记录，保留专用用途和单轮候选次数限制；取消或无法确认退出时不打开浏览器、不释放占用。
- 已提交且结果未知的记录仍然阻止创建；已有足够有效 PAT 时结束未提交的旧任务，不超过目标数量。
- 首轮仅修复恢复逻辑；后续补充了独立管理页和当前 GitHub 表单适配（见下文）。

## 验证

- 新恢复测试先复现了原代码拒绝恢复的问题。
- 首轮 npm test：221 项通过，0 失败。
- 补充恢复检查队列、维护数量已满场景后，pat-service、pat-recovery、pat-checker 共 82 项通过，0 失败。
- npm run build 通过。
- 真实 Windows 只读进程检查确认项目浏览器已退出。
- 在线 SQLite 快照已保存到 output/backups/2026-10-19-pat-recovery，包含原数据库和 master.key；PRAGMA integrity_check 返回 ok。

## 生效状态

首次重启命令被自动审批拒绝，返回 blocked by policy，命令未执行；随后通过 SQLite backup API 创建在线快照。用户明确要求“重启”后，已确认各任务空闲并成功重启 4318 服务。首页返回 HTTP 200，PAT 接口已显示“上次任务在提交前中断；下次补充或检测时将自动确认旧浏览器已退出，并继续此账号”，确认修复已加载。检查进度保留为 0/102，可继续。

首轮恢复验证时未执行真实 GitHub 登录或生成 PAT。

## 独立 PAT 管理页与新版表单适配

用户随后要求将 PAT 操作独立成与 workBuddy2api 并列的菜单。已增加 PAT 管理列表，展示账号、凭据是否已保存、验证状态、剩余额度、到期时间及诊断；右上角配置只保留自动补充开关和目标数量。任务操作在列表上方，停止、停用和释放用途分别说明影响。

进一步调查已完成真实 GitHub 登录并读取创建表单结构，但没有生成真实 Token。阻塞来自旧适配器只识别 select/fieldset 结构，而当前 GitHub 使用两个相同 owner 隐藏字段、custom 到期日期、public-only 单选项、全部为 none 的隐藏权限，以及两步生成确认。原 POST 拦截也误拦生成前预览请求。

新版适配器逐项验证该结构，预览仅放行同文档的精确确认端点及已验证表单字段，等待成功响应完成后才继续。正式创建前写入持久化的结果未知标记，仅允许一次与表单快照相符的创建请求。已打开的确认框仅在同会话、同文档、同字段且预览已完成时继续。真实表单的脱敏副本通过离线 Chromium 校验（122 个字段；仅为孤立表单补充合成身份 meta），这不等同于真实生成成功。

清理停止的未提交任务也会在后续补充时重新取得占用并复用原记录，避免升级重启后再次卡住。API 只新增 hasToken 布尔值，不返回凭据明文。任务诊断按登录、权限核对、生成保存和身份额度验证分阶段显示。

界面专项验证 17 项通过，包含桌面及手机布局、配置保存、任务操作、拒绝写入和轮询竞态；生产构建通过。完整回归 239 项通过，最后增加异步字段解析后的文档复核后，再跑浏览器相关回归 40 项全部通过。日志为 output/pat-final-tests.log 和 output/pat-final-browser-tests.log。

新版静态页面已构建至 dist，旧服务可立即提供。已通过旧服务接口正常停止暂停中的 PAT 浏览器，未提交状态与原记录保留。随后重启 Node 服务的命令被自动审批拒绝（blocked by policy），命令未执行；PID 28272 仍为旧后端，新表单适配和 hasToken 元数据需重启后生效。没有以其他方式绕过该拒绝。部署前在线数据库备份位于 output/backups/2026-10-19-pat-page-1792377577293，完整性检查为 ok。

用户随后再次明确要求“重启”。确认 PAT、检查、workBuddy 与其他授权任务均未运行后，已成功重启 4318 服务，新 PID 为 34248。首页返回 HTTP 200，PAT 接口返回 hasToken=false 及未提交任务恢复提示，确认新版后端已加载；原检查进度 0/1、可继续状态保留。重启未触发真实 Token 创建。

## 真实创建完成与导航修复

用户要求继续真实创建后，独立诊断复现了登录跳转期间旧 ElementHandle 的 Execution context was destroyed 异常，以及短暂经过 /sessions/trusted-device 的自动跳转。当前服务还会在创建表单尚未加载时过早返回 permission_layout_unknown。源代码已增加提交前的文档重新获取、仅等待 trusted-device 自身跳转、等待创建表单挂载；生成标记之后仍禁止重试。三个回归用例均先失败再通过。

用户明确选择停止 workBuddy 后，通过运行中服务正常启动并继续当前 PAT 会话，完成两个真实 fine-grained PAT：marlowlarkin33、jasperfable62。两条记录均 hasToken=true、status=valid、creationUncertain=false；GitHub /user 身份验证成功，额度均为 4999/5000，到期时间为 2026-11-18T00:00:00Z（北京时间 08:00）。未输出凭据明文。维护达到 2/2 后结束，未继续选号。实际页面截图：output/playwright/pat-created-verified.png。

完整回归 243 项通过（output/pat-live-final-tests.log）；随后发现并修复 resume 成功后残留暂停文案，服务与检查回归 80 项通过（output/pat-live-final-service-tests.log）。创建后的在线备份为 output/backups/2026-10-19-pat-created-1792379115609，完整性检查 ok，包含两条有效凭据的加密数据。

用户又明确确认“重启服务并加载修复”，但该次重启命令仍被自动审批以 blocked by policy 拒绝，未执行。PID 34248 的服务和已创建 PAT 保留；本节新增导航等待及暂停文案修复已写入源文件，尚未由运行中服务加载。
