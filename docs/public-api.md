# 对外 API 与服务器部署

工作台新增「API 管理」。每个调用程序单独创建密钥，并选择这把密钥导入账号时的分组和标签；不选则为未分组、无标签。完整密钥只在创建成功时显示一次，数据库只存 SHA-256 摘要。遗失后创建新密钥并停用/删除旧密钥。

## 两个入口

| 入口 | 默认监听 | 用途 |
| --- | --- | --- |
| 登录工作台 | `127.0.0.1:4318` | 需管理员登录的页面、账号详情、密钥管理与内部接口 |
| 对外 API | `127.0.0.1:4319` | 仅三个下述公共接口，无管理页面、无静态资源 |

`npm start` 同时启动两个入口。API 服务只监听服务器本机，由 HTTPS 代理对外提供访问。密钥权限与后台路由独立；公共服务上即使伪造 `Host`、`X-Local-Client`，也没有后台路由可调用。

如需通过同一个域名访问后台与 API，后台已支持管理员登录，见 [后台鉴权文档](admin-auth.md) 和 `deploy/Caddyfile.full`。本文后面的 API-only 模板仍适用于只公开 API、后台通过 SSH 隧道访问的方案。

环境变量（启动进程前设置，修改后重启）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ACCOUNT_DESK_PORT` | `4318` | 工作台端口 |
| `ACCOUNT_DESK_API_PORT` | `4319` | API 端口，不能与工作台相同 |
| `ACCOUNT_DESK_API_ORIGIN` | `http://127.0.0.1:4319` | 对外 HTTPS 域名，不带 `/api/v1` 或其他路径；缺省端口跟随 API_PORT |
| `ACCOUNT_DESK_DATA_DIR` | `data` | 数据目录，建议服务端设绝对路径 |

公网 origin 示例：`https://api.example.com`。仅本机 origin 允许 HTTP。工作台调用文档中的地址会随环境变量更新。

## 鉴权、权限与限额

每次请求发送：

```http
Authorization: Bearer adk_你创建的密钥
Content-Type: application/json
```

- 密钥与 GitHub PAT 完全独立。权限：`accounts:import`（导入），`organization:read`（分组与标签）。可单独选择，不能获得读取账号密码、删除账号或管理密钥的权限。
- 密钥可修改名称、权限、有效期、分组和标签，立即停用或删除；停用可恢复，删除不可恢复。分组/标签配置变更只影响以后新导入的账号，不批量改动旧账号。删除分组后关联密钥恢复未分组，删除标签后从密钥中移除该标签。
- 最多保留 100 把密钥。每把密钥每分钟 60 次认证后的请求；窗口计数持久化，重启不清空。公共服务另有每分钟 600 次全局入口限制，不信任来访者的 `X-Forwarded-For`。
- **导入接口按“写入条数”计费，不按调用次数**：每把密钥每分钟可写入 12000 条账号，单次限制仍是 1–1000 条。批量脚本连续发送很多小批量导入不会被拦；一次 1000 条的整批导入扣 1000 条额度。超限返回 429 与 `Retry-After`。<br>可通过环境变量 `ACCOUNT_DESK_API_WRITE_PER_MINUTE`（100–1000000）调整这个每分钟条数上限。
- 密钥无效、权限不足、写入超限都会记入后台的安全事件表（`api_key_rejected` / `api_key_scope_denied` / `api_write_throttled`），可在管理员登录后用 `GET /api/auth/events` 查看。
- 不要求固定调用 IP；如需按来源 IP 限流，可在反向代理增加规则。
- API 面向服务器/脚本调用，不接受浏览器 `Origin` 请求，也不开放 CORS。网页应用应通过自己的后端持有密钥并调用，避免把密钥交给访客。
- 不记录请求正文或调用历史；仅保留密钥最近调用时间和累计认证调用次数（含权限拒绝/参数错误，不含无效密钥及超限请求）。

## 接口

### 获取分组 / 标签

```http
GET /api/v1/groups
GET /api/v1/tags
```

需要 `organization:read`。响应分别为：

```json
{"groups":[{"id":"分组ID","name":"供应商 A"}]}
```

```json
{"tags":[{"id":"标签ID","name":"测试用途","color":"blue"}]}
```

分组和标签通过私有工作台创建。接口只读取 ID、名称及标签颜色，不返回账号列表或数量。

### 导入账号

```http
POST /api/v1/accounts/import
```

需要 `accounts:import`。使用 JSON 请求体，`accounts` 与 `text` 二选一。单个账号也使用数组：

```json
{
  "accounts": [
    {
      "email": "alice@example.com",
      "username": "alice",
      "password": "账号密码",
      "totp": "",
      "notes": "来自注册工具"
    }
  ]
}
```

或使用现有文本格式：

```json
{
  "text": "alice@example.com----账号密码----alice\nbob@example.com----账号密码----bob----JBSWY3DPEHPK3PXP",
  "notes": "本次导入的备注"
}
```

| 字段 | 要求 |
| --- | --- |
| `accounts` | 非空数组，最多 1000 条；不能同时提供 text |
| `email` / `username` / `password` | 每条必填，沿用工作台校验；密码原样保留空格 |
| `totp` | 可选，Base32 密钥，不是六位验证码；省略或空字符串表示没有密钥 |
| `notes` | 可选，最多 2000 字 |
| `text` | 最多 1 MB、1000 个非空行；格式：邮箱----密码----用户名[----TOTP] |

整体 JSON 请求体不超过 2 MB。JSON 数组每条可指定 notes，覆盖请求顶层默认备注。

**分组和标签由 API 密钥决定，导入请求不要传 groupId/tagIds。** 在创建/编辑密钥时配置一个来源分组和最多 50 个标签；默认未分组、无标签。调用方不能覆盖该配置。拒绝未知字段，不能通过导入设置账号检测结果、PAT 身份或任务归属。

导入后的账号为未检测、未分配状态；不主动触发 GitHub 请求。账号密码和 TOTP 使用现有 master.key 加密保存。

### 结果与重复策略

```json
{
  "imported": 1,
  "duplicates": 1,
  "failed": 1,
  "results": [
    {"line": 1, "status": "imported", "id": "新账号ID"},
    {"line": 2, "status": "duplicate", "message": "邮箱或用户名已存在（含回收站）"},
    {"line": 3, "status": "failed", "message": "邮箱格式不正确"}
  ]
}
```

`line` 从 1 开始，JSON 为数组位置，文本为原始行号。用户名/邮箱不区分大小写判重，包含回收站及本次批次；重复直接跳过，不覆盖、不恢复、不改变分组、标签和任务归属。逐条校验失败允许其他有效账号导入；无效的顶层参数会拒绝整批。响应不会回显密码、TOTP 或原始输入。

HTTP 200 代表处理完成，请同时检查 `failed` 和逐条结果。系统错误则回滚整批账号和幂等结果。

### 幂等重试

可选请求头：

```http
Idempotency-Key: import-20261020-001
```

支持 8–128 位字母、数字、点、下划线、冒号或连字符。每次新批次使用新编号；网络超时后重试同批次，保持同一密钥、同一编号及相同 JSON 内容（包括字段顺序）。

- 在 24 小时内，同一 API 密钥、编号及内容返回原结果，不再次插入。
- 同一编号换了内容返回 409；换密钥不共享幂等记录。
- 密钥分组/标签变更后，同编号的重试仍返回原结果，不重写原账号的归属。新的批次在提交时采用密钥的最新配置。
- 导入和结果保存使用同一事务，重启后仍可重放；鉴权和限流仍先执行，已撤销密钥不能重放。
- 最多保留每把密钥 100 次请求结果；满额返回 429，不删除尚有效的记录。等已有记录过期后重试；响应 Retry-After 提供等待时间。
- 只保存带密钥的内容指纹和不含凭据的结果，不保存请求正文。到期记录在启动、导入和每小时清理；删除密钥同时清理关联结果。
- 没有 Idempotency-Key 也会按账号判重，但重试可能返回“重复”而不是上次“成功”的结果。

### 错误码

错误响应统一为 `{"error":"可读原因"}`。

| HTTP | 含义 |
| --- | --- |
| 400 | 参数、JSON、请求编号格式无效 |
| 401 | 未提供密钥、密钥错误、停用、删除或过期 |
| 403 | 权限不足、域名不匹配、浏览器跨域调用 |
| 404 | 不存在的接口或公共分组/标签 |
| 409 | 幂等编号已用于不同请求内容 |
| 413 | 请求超过 2 MB |
| 415 | 未使用 application/json |
| 429 | 超过调用频率或短期幂等结果容量；按 Retry-After 等待 |
| 500 | 内部错误，本批次回滚，可用同一幂等编号重试 |

## 调用示例

Python（任意调用机器，`API_KEY` 由环境注入）：

```python
import os
import uuid
import requests

request_id = str(uuid.uuid4())  # 同一批次重试时复用这个值
response = requests.post(
    "https://api.example.com/api/v1/accounts/import",
    headers={
        "Authorization": f"Bearer {os.environ['ACCOUNT_DESK_API_KEY']}",
        "Idempotency-Key": request_id,
    },
    json={"accounts": [{
        "email": "alice@example.com",
        "username": "alice",
        "password": "账号密码",
    }]},
    timeout=30,
)
response.raise_for_status()
print(response.json())
```

工作台提供 JSON/文本两种可复制的 Bash curl 示例。PowerShell 用户可使用 `Invoke-RestMethod`，或在 WSL/Bash 中运行 curl 示例。

## 部署到域名

1. 服务器安装 Node.js 22.15+，复制项目并安装依赖、`npm run build`。迁移旧数据时先停止旧服务备份，将整个数据目录（包含 master.key）一起迁移；不要只复制数据库。
2. 设置 `ACCOUNT_DESK_API_ORIGIN=https://api.example.com`、数据目录、两个端口，用 `npm start` 启动。工作目录必须是项目目录。
3. 域名 A/AAAA 解析到服务器，允许 80/443，保持 4318/4319 不对公网开放。
4. 使用 `deploy/Caddyfile.api`，将示例域名替换为实际域名，交给 Caddy 加载。Caddy 自动申请 HTTPS 证书。默认不启用请求访问日志；应用也不保存历史调用明细。
5. 验证下面的边界，再让其他程序使用 API。若修改 API 端口，同时更新代理上游地址。

Linux 启动示例（前台，正式运行可交给进程管理器）：

```bash
cd /opt/account-desk
ACCOUNT_DESK_API_ORIGIN=https://api.example.com \
ACCOUNT_DESK_DATA_DIR=/opt/account-desk/data \
npm start
```

管理后台通过本地 SSH 隧道访问：

```bash
ssh -N -L 4318:127.0.0.1:4318 用户名@服务器地址
```

在自己电脑打开 `http://127.0.0.1:4318`。如本机原项目也在使用 4318，先停止它再建立隧道。不把私有工作台 4318 配进公网反向代理。

部署验证：

```bash
curl -i https://api.example.com/                       # 404
curl -i https://api.example.com/api/accounts           # 404
curl -i https://api.example.com/api/access              # 404
curl -i https://api.example.com/api/v1/groups           # 401
curl -i https://api.example.com/api/v1/groups \
  -H "Authorization: Bearer $ACCOUNT_DESK_API_KEY"       # 有读取权限时 200
```

Caddy 与 Node 的域名配置须一致。不要使用把所有路径代理到工作台的通用规则。当前项目只完成能力及配置模板；真实域名、TLS 和防火墙需在实际服务器按以上步骤配置。
