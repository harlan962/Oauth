/**
 * Shared vocabulary for security events.
 *
 * The same log rows are read in three places — the security centre tabs, the
 * push page's delivery history, and the notification body itself — so the
 * labels live here once instead of drifting apart between files.
 */

export const eventLabels: Record<string, string> = {
  admin_initialized: "初始化管理员",
  admin_reset: "重置管理员",
  login_succeeded: "登录成功",
  login_failed: "登录失败",
  login_locked: "登录已锁定",
  password_changed: "修改登录密码",
  admin_unlocked: "解除登录锁定",
  sessions_revoked: "撤销其他会话",
  session_revoked: "下线单个会话",
  sessions_pruned: "自动清理旧会话",
  reauth_failed: "身份验证失败",
  totp_enabled: "启用两步验证",
  totp_disabled: "关闭两步验证",
  totp_failed: "两步验证码错误",
  recovery_code_used: "使用恢复码",
  credential_read: "读取账号凭据",
  credential_export: "导出账号明文",
  host_rejected: "拒绝异常域名",
  origin_rejected: "拒绝跨站来源",
  api_key_rejected: "API 密钥被拒",
  api_key_scope_denied: "API 权限不足",
  api_write_throttled: "API 写入超限",
  integration_private_target: "对接目标是内网地址",
  ip_rejected: "来源地址不在白名单",
  ip_allow_changed: "修改访问白名单",
  bot_report: "巡检报告",
  bot_check_started: "机器人发起检活",
};

// How the caller proved who they are. This is the field that turns a log line
// into an answer to "how did they get in?".
export const methodLabels: Record<string, string> = {
  password: "密码",
  "password+totp": "密码 + 动态码",
  "password+recovery": "密码 + 恢复码",
  session: "已登录会话",
  setup: "首次初始化",
  none: "未认证",
};

/** Someone probing the service, rather than the operator's own routine work. */
export const alertKinds = new Set([
  "login_failed",
  "login_locked",
  "reauth_failed",
  "totp_failed",
  "host_rejected",
  "origin_rejected",
  "api_key_rejected",
  "api_key_scope_denied",
  "api_write_throttled",
  "integration_private_target",
  "ip_rejected",
  "credential_export",
]);

/** Sign-in, sign-out and changes to the login itself. */
export const loginKinds = new Set([
  "admin_initialized",
  "admin_reset",
  "admin_unlocked",
  "login_succeeded",
  "login_failed",
  "login_locked",
  "password_changed",
  "sessions_revoked",
  "session_revoked",
]);

/** Entries that mean "it worked"; everything else in a tab renders neutral. */
export const goodKinds = new Set([
  "login_succeeded",
  "admin_unlocked",
  "password_changed",
  "totp_enabled",
  "sessions_revoked",
  "session_revoked",
  "admin_initialized",
]);

/**
 * Credential reads are mirrored into the detailed audit table, so the event
 * stream must not repeat them or the page shows every read twice.
 */
export const credentialKinds = new Set(["credential_read", "credential_export"]);

export function eventLabel(kind: string): string {
  return eventLabels[kind] || kind;
}

export function methodLabel(method: string | null): string {
  if (!method) return "";
  return methodLabels[method] || method;
}

/** A loopback address is not useful as a number; what matters is "this machine". */
export function ipLabel(ip: string | null): string {
  if (!ip) return "未知来源";
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return "本机 · 127.0.0.1";
  return ip;
}
