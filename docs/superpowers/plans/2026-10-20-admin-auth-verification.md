# 后台鉴权验证记录

日期：2026-10-20。

- `npm run build` 与 `npx vite build --outDir output/pat-build` 均成功。
- `node --test --test-concurrency=2 tests/*.test.js`：426 项通过，0 失败、0 跳过，用时约 212 秒。日志：`output/admin-auth-full-tests.log`。
- 专项验证：初始化一次性码、密码哈希、匿名/API Key 无法读后台、CSRF、登出、改密撤销旧会话、12 小时过期、重启持久化、登录限流、上传途中撤销、并发初始化/改密、HTTPS Cookie 与 Host/Origin 校验、重置保留业务数据。
- 浏览器验证：首次设置、登录/退出、改密、失效后关闭受保护页面、使用说明入口移除；已检查桌面与手机登录截图、桌面顶栏布局。截图：`output/playwright/admin-auth/`。
- 独立只读审查未发现阻止交付的问题，并补充验证 reset 与异步认证竞态、HTTPS Host/Origin、Cookie 分离和会话跨重启保留。
- 测试替身均位于 tests：旧功能集成测试使用真实会话；PAT 独立 UI fixture 返回合成登录状态。生产服务没有测试鉴权绕过选项。
- 确认无运行中业务任务后停止旧 PID 13468；备份至 `output/backups/admin-auth-20261020`，再隐藏启动新 PID 428。
- 实际服务验证：后台首页 200，匿名 `/api/accounts` 401，初始化状态为 false/false；API 端口首页 404、无密钥 groups 401。
- 重启前后原有 24 张业务表行数一致，账号保持 102 个。记录：`output/admin-auth-live-verification.json`。
- 真实数据尚未设置管理员，用户自行读取 `data/admin-setup-code.txt` 并在页面设置账号密码；未输出设置码或代设密码。
- 已提供同域名 Caddy 模板和环境变量说明；未实际配置服务器 DNS、TLS 或防火墙。
