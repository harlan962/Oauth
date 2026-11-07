# 账号管理导出验证

日期：2026-10-20（北京时间）。

## 行为

- 入口只在账号管理：顶部「导出账号」与勾选操作栏「导出选中」。
- 弹窗可切换已勾选账号与当前筛选结果，显示各自数量。
- 打开弹窗时固定本次账号 ID 范围；导出顺序与列表排序一致，范围包含其他分页。
- 后台仅接受明确的账号 ID 列表，去重、排除回收站，并对失效范围整体报错。
- UTF-8 BOM / CRLF TXT，可按原有四短横线格式重新导入，保留密码首尾空格及空 TOTP。
- 换行或分隔符无法无损表示时，整体报错且错误不含凭据。
- 接口继承管理员会话、CSRF、Host、Origin 与 no-store 检查；API Key 不可导出。
- 服务器不创建导出文件；浏览器临时 Blob 下载后释放 URL，页面不预览或持久化凭据。

## 验证

- `node --test tests/account-export.test.js tests/admin-auth.test.js tests/management.test.js tests/ui.test.js`：29 项通过。
- `node --test tests/account-export-browser.test.js`：实际浏览器下载通过；覆盖跨页选择、32 条完整组合筛选、导入往返、空范围、加载互斥、错误重试、焦点恢复、375px 竖屏及 812px 横屏、减少动画设置。
- `tests/account-list-browser.test.js`：已有账号分类、筛选、显示列及任务导航回归通过。
- `npm run build`：TypeScript 与 Vite 生产构建通过。
- 截图位于 `output/playwright/account-export/`，全部为合成数据。

## 本机生效状态

用户明确要求重启后，已停止旧进程并重新启动项目，4318/4319 均由新进程监听。已验证生产页面加载新版脚本，真实管理员会话跨重启保持有效，新增 `/api/accounts/export` 接口实际返回 HTTP 200。验证导出仅在内存处理，未生成真实账号导出文件，随后清理了临时验证会话。

现有业务数据库包含 102 条账号，管理员已初始化。重启前后完整账号表摘要一致。开发与浏览器测试均使用独立临时数据库。
