# 账号详情整理与 PAT 随机选择核对

## PAT 核对

用户确认保留每次新任务独立随机选择，允许连续重复，不改为轮流或随机不放回。

- `checker.start()` 清空新任务 patId，`PatService.credential()` 从可用 GitHub 账号去重后的候选中用 Math.random 抽取。恢复同一未完成任务可沿用既有 PAT。
- 同一批任务正常继续使用已选 PAT；普通额度耗尽排除冷却账号并随机接续其他可用账号，不重查已完成行。全局限流和全部额度冷却仍等待。
- 本次只读核对两条现有 PAT 均有 token、未过期、专用归属有效、未删除、无冷却，因此两者均为候选。未读取或输出明文凭据。
- 新增连续单个/全部/筛选任务回归，用可控随机值验证新任务重新抽取、批次内沿用。原有 HTTP 200/403/429 普通额度切换及全局等待测试保留。`tests/check-rotation.test.js` 7/7 通过，日志 `output/pat-random-detail-tests.log`。
- 额度字段是各 PAT 最近响应的快照；不记录每次历史抽选，不能从截图反推历次是否随机重复。

## 详情页目标

凭据和验证码集中，公开检测状态与时间只显示一次；分组标签、备注、任务归属紧凑排列；保留查看/复制、短时显示、验证码过期保护、检查、分类、任务跳转和编辑能力。

## 实施与验证

- 已完成 `src/AccountDetail.tsx` 重排及 `src/account-detail.css` 样式，通过 main.tsx 集中加载；编辑模式继续共用既有逻辑。
- 凭据与验证码集中；状态/检测时间不重复；有备注才显示备注栏；归属、选用/释放集中一行，保留未知占用诊断、PAT 只读信息、WorkBuddy 处理结果与链接。
- 删除重复风控说明及释放对话框中不准确的“历史记录仍会保留”文字；鼠标点击输入框不再出现蓝色光晕，键盘保留灰色焦点。
- `npm run build` 成功，日志 `output/account-detail-build.log`。PAT 浏览器夹具也重建为最新代码，日志 `output/account-detail-pat-build.log`。
- 联合验证命令：`node --test --test-concurrency=2 tests/account-detail-browser.test.js tests/account-list-browser.test.js tests/pat-ui-browser.test.js tests/ui.test.js tests/pat-ui.test.js tests/check-rotation.test.js`，40/40 通过，日志 `output/account-detail-final-tests.log`。
- 新详情浏览器测试首先在旧界面上复现常用内容被挤出可视区，改版后在 1280×800 下完整可见；390px/320px 无横向溢出。还验证查看/复制、剪贴板失败、切出页面隐藏、30 秒隐藏、验证码过期禁用、无 TOTP、键盘焦点、编辑/草稿保护/保存、选用和释放。
- 独立复核无未解决的重要问题；截图已目视检查，存于 `output/playwright/account-detail/`。
- 新构建已由原服务提供，无后端变更或服务重启。独立临时页只读打开实际账号详情验证，未请求真实凭据或发起检测，截图 `output/playwright/account-detail/live.png`，验证标签页已关闭。
