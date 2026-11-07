import { createHmac, randomUUID } from 'node:crypto';
import { createTransport } from 'nodemailer';
import { AppError } from './store.js';
import { encrypt, decrypt } from './crypto.js';
import { describeAgent } from './user-agent.js';

// Delivery is best effort by design: a notification that cannot be sent must
// never turn a successful login into a failed one. Every failure is recorded on
// the channel so the operator can see it in the UI instead of losing it in a log.
const requestTimeoutMs = 12000;
const channelRetention = 20;
const perMinuteCeiling = 20;
const duplicateWindowMs = 60000;
const deliveryLogLimit = 2000;

// Categories keep the UI to a handful of understandable switches while still
// letting each kind be routed exactly once.
export const eventCategories = {
  login_succeeded: 'login',
  login_failed: 'login',
  login_locked: 'login',
  admin_unlocked: 'login',
  admin_initialized: 'account',
  admin_reset: 'account',
  password_changed: 'account',
  sessions_revoked: 'account',
  session_revoked: 'account',
  sessions_pruned: 'quiet',
  credential_read: 'secret',
  credential_export: 'secret',
  totp_enabled: 'secret',
  totp_disabled: 'secret',
  recovery_code_used: 'secret',
  totp_failed: 'intrusion',
  reauth_failed: 'intrusion',
  host_rejected: 'intrusion',
  origin_rejected: 'intrusion',
  api_key_rejected: 'intrusion',
  api_key_scope_denied: 'intrusion',
  api_write_throttled: 'intrusion',
  integration_private_target: 'intrusion',
  ip_rejected: 'intrusion',
  ip_allow_changed: 'account',
  bot_report: 'report',
  bot_check_started: 'report',
};

export const categories = [
  { id: 'login', label: '登录与解锁', hint: '成功登录、密码错误、来源被锁、解除锁定' },
  { id: 'account', label: '账号与安全设置', hint: '初始化、改密、下线会话、访问白名单变更' },
  { id: 'secret', label: '凭据读取与两步验证', hint: '查看密码、导出明文、开关两步验证' },
  { id: 'intrusion', label: '异常与渗透迹象', hint: '伪造域名、错误密钥、验证码失败、来源被拒' },
  { id: 'report', label: '巡检与播报', hint: '每日巡检报告、机器人主动播报' },
];

// `quiet` never leaves the machine: pruning old sessions happens on every login
// and would otherwise bury real events in noise.
const urgentKinds = new Set([
  'login_failed', 'login_locked', 'api_key_rejected', 'api_key_scope_denied',
  'host_rejected', 'origin_rejected', 'totp_failed', 'reauth_failed',
  'credential_export', 'recovery_code_used', 'session_revoked', 'admin_unlocked',
  'ip_rejected',
]);

const titles = {
  login_succeeded: '登录成功',
  login_failed: '登录失败',
  login_locked: '登录来源被锁定',
  admin_unlocked: '已解除登录锁定',
  admin_initialized: '管理员已初始化',
  admin_reset: '管理员已被重置',
  password_changed: '登录密码已修改',
  sessions_revoked: '其他会话已全部下线',
  session_revoked: '单个会话被下线',
  credential_read: '凭据被读取',
  credential_export: '账号明文被导出',
  totp_enabled: '两步验证已启用',
  totp_disabled: '两步验证已关闭',
  recovery_code_used: '使用了恢复码',
  totp_failed: '两步验证码错误',
  reauth_failed: '身份再验证失败',
  host_rejected: '拒绝异常域名访问',
  origin_rejected: '拒绝跨站来源',
  api_key_rejected: 'API 密钥被拒',
  api_key_scope_denied: 'API 密钥权限不足',
  api_write_throttled: 'API 写入超限',
  integration_private_target: '对接地址指向内网',
  ip_rejected: '来源地址不在白名单',
  ip_allow_changed: '访问白名单已修改',
  bot_report: '巡检报告',
  bot_check_started: '机器人发起检活',
};

const methodLabels = {
  password: '账号密码',
  'password+totp': '密码 + 动态码',
  'password+recovery': '密码 + 恢复码',
  session: '已登录会话',
  setup: '首次初始化',
  none: '未认证请求',
};

function httpsOnly(value, label) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new AppError(`${label}不是有效地址`);
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new AppError(`${label}必须是 https 地址`);
  if (url.username || url.password) throw new AppError(`${label}不能包含账号密码`);
  return url.href;
}

function text(value, label, max = 200) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) throw new AppError(`请填写${label}`);
  if (result.length > max) throw new AppError(`${label}不能超过 ${max} 个字符`);
  return result;
}

function optionalText(value, max = 200) {
  const result = typeof value === 'string' ? value.trim() : '';
  return result ? result.slice(0, max) : '';
}

// Only these fields are kept per channel type; anything else in the payload is
// dropped rather than persisted, so a typo cannot smuggle data into the config.
const fields = {
  email: ['host', 'port', 'secure', 'user', 'pass', 'from', 'to'],
  dingtalk: ['webhook', 'secret'],
  feishu: ['webhook', 'secret'],
  webhook: ['url', 'token'],
};

const secretFields = new Set(['pass', 'secret', 'token']);

function normalize(type, input, previous = {}) {
  if (!fields[type]) throw new AppError('推送通道类型无效');
  const source = input && typeof input === 'object' ? input : {};
  if (type === 'email') {
    const recipients = String(source.to || '')
      .split(/[,;\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (!recipients.length) throw new AppError('请填写收件邮箱');
    if (recipients.length > 10) throw new AppError('收件人最多 10 个');
    for (const address of recipients)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new AppError(`邮箱地址无效：${address}`);
    const port = Number(source.port || 465);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError('SMTP 端口无效');
    const from = text(source.from || source.user, '发件人', 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) throw new AppError('发件人邮箱无效');
    return {
      host: text(source.host, 'SMTP 服务器', 200),
      port,
      secure: port === 465 ? true : source.secure === true,
      user: optionalText(source.user, 200),
      // An empty password on edit means "keep the stored one".
      pass: source.pass === '' ? previous.pass || '' : optionalText(source.pass, 400),
      from,
      to: recipients.join(','),
    };
  }
  if (type === 'dingtalk' || type === 'feishu') {
    return {
      webhook: httpsOnly(source.webhook, '机器人地址'),
      secret: source.secret === '' ? previous.secret || '' : optionalText(source.secret, 200),
    };
  }
  return {
    url: httpsOnly(source.url, '回调地址'),
    token: source.token === '' ? previous.token || '' : optionalText(source.token, 400),
  };
}

function masked(type, config) {
  const output = { ...config };
  for (const field of secretFields) {
    if (!(field in output)) continue;
    output[field] = output[field] ? '••••••' : '';
  }
  if (type === 'email' && config.pass) output.hasPassword = true;
  if ((type === 'dingtalk' || type === 'feishu') && config.secret) output.hasSecret = true;
  if (type === 'webhook' && config.token) output.hasToken = true;
  return output;
}

function ipLabel(ip) {
  if (!ip) return '未知';
  if (ip === '127.0.0.1' || ip === '::1') return `${ip}（本机）`;
  return ip;
}

export class Notifier {
  constructor(store, { clock = Date.now, fetcher = fetch } = {}) {
    this.store = store;
    this.db = store.db;
    this.clock = clock;
    this.fetcher = fetcher;
    this.sent = new Map();
    this.minute = new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS notify_channels (
      id TEXT PRIMARY KEY,type TEXT NOT NULL,name TEXT NOT NULL,config TEXT NOT NULL,
      events TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,createdAt INTEGER NOT NULL,
      lastSentAt INTEGER,lastError TEXT,lastErrorAt INTEGER);
      CREATE TABLE IF NOT EXISTS notify_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,channelId TEXT NOT NULL,
        kind TEXT NOT NULL,ok INTEGER NOT NULL,detail TEXT);
      CREATE INDEX IF NOT EXISTS notify_deliveries_at ON notify_deliveries(at);`);
  }
  list() {
    return this.db.prepare('SELECT * FROM notify_channels ORDER BY createdAt').all().map((row) => ({
      id: row.id,
      type: row.type,
      name: row.name,
      config: masked(row.type, this.#config(row)),
      events: JSON.parse(row.events),
      enabled: !!row.enabled,
      createdAt: new Date(row.createdAt).toISOString(),
      lastSentAt: row.lastSentAt ? new Date(row.lastSentAt).toISOString() : null,
      lastError: row.lastError || null,
      lastErrorAt: row.lastErrorAt ? new Date(row.lastErrorAt).toISOString() : null,
    }));
  }
  #config(row) {
    try {
      return JSON.parse(decrypt(row.config, this.store.key));
    } catch {
      return {};
    }
  }
  #row(id) {
    const row = this.db.prepare('SELECT * FROM notify_channels WHERE id=?').get(id);
    if (!row) throw new AppError('推送通道不存在', 404);
    return row;
  }
  #events(value) {
    if (!Array.isArray(value)) return categories.map((item) => item.id);
    const allowed = new Set([...categories.map((item) => item.id), 'quiet']);
    const picked = value.filter((item) => allowed.has(item));
    return picked.length ? picked : [];
  }
  #prune() {
    this.db.prepare(`DELETE FROM notify_channels WHERE id NOT IN (
      SELECT id FROM notify_channels ORDER BY createdAt DESC LIMIT ?)`).run(channelRetention);
  }
  create(body) {
    const type = String(body?.type || '');
    const config = normalize(type, body?.config);
    const id = randomUUID();
    this.db.prepare('INSERT INTO notify_channels(id,type,name,config,events,enabled,createdAt) VALUES(?,?,?,?,?,?,?)')
      .run(id, type, text(body?.name || type, '通道名称', 40), encrypt(JSON.stringify(config), this.store.key),
        JSON.stringify(this.#events(body?.events)), body?.enabled === false ? 0 : 1, this.clock());
    this.#prune();
    return this.list().find((item) => item.id === id);
  }
  update(id, body) {
    const row = this.#row(id);
    const type = fields[body?.type] ? body.type : row.type;
    const previous = this.#config(row);
    const config = normalize(type, body?.config ?? previous, previous);
    this.db.prepare('UPDATE notify_channels SET type=?,name=?,config=?,events=?,enabled=? WHERE id=?')
      .run(type, text(body?.name || row.name, '通道名称', 40), encrypt(JSON.stringify(config), this.store.key),
        JSON.stringify(this.#events(body?.events ?? JSON.parse(row.events))),
        body?.enabled === undefined ? row.enabled : body.enabled ? 1 : 0, id);
    return this.list().find((item) => item.id === id);
  }
  remove(id) {
    this.#row(id);
    this.db.prepare('DELETE FROM notify_channels WHERE id=?').run(id);
    return { ok: true };
  }
  deliveries(limit = 50) {
    const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return this.db.prepare('SELECT at,channelId,kind,ok,detail FROM notify_deliveries ORDER BY id DESC LIMIT ?').all(size)
      .map((row) => ({
        at: new Date(row.at).toISOString(), channelId: row.channelId, kind: row.kind,
        ok: !!row.ok, detail: row.detail,
      }));
  }
  // ---- message rendering ----
  #message(event) {
    const title = titles[event.kind] || event.kind;
    const lines = [`时间：${new Date(event.at).toLocaleString('zh-CN', { hour12: false })}`];
    if (event.method) lines.push(`方式：${methodLabels[event.method] || event.method}`);
    if (event.ip) lines.push(`来源：${ipLabel(event.ip)}`);
    if (event.ua) lines.push(`设备：${describeAgent(event.ua)}`);
    if (event.target) lines.push(`对象：${event.target}`);
    if (event.detail) lines.push(`详情：${event.detail}`);
    const alert = urgentKinds.has(event.kind);
    return {
      alert,
      title: `${alert ? '⚠️ ' : ''}【账号工作台】${title}`,
      text: lines.join('\n'),
    };
  }
  // ---- delivery ----
  async #send(channel, subject, body) {
    const config = this.#config(channel);
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    if (channel.type === 'email') {
      const transport = createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user ? { user: config.user, pass: config.pass } : undefined,
        connectionTimeout: requestTimeoutMs,
        greetingTimeout: requestTimeoutMs,
        socketTimeout: requestTimeoutMs,
      });
      try {
        await transport.sendMail({ from: config.from, to: config.to, subject, text: body });
      } finally {
        transport.close();
      }
      return 'smtp ok';
    }
    if (channel.type === 'dingtalk') {
      const url = new URL(config.webhook);
      if (config.secret) {
        // DingTalk: sign = base64(HMAC-SHA256(secret, `${timestamp}\n${secret}`)).
        const timestamp = String(Date.now());
        const sign = createHmac('sha256', config.secret).update(`${timestamp}\n${config.secret}`).digest('base64');
        url.searchParams.set('timestamp', timestamp);
        url.searchParams.set('sign', sign);
      }
      const response = await this.fetcher(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { title: subject, text: `### ${subject}\n\n${body}` } }),
        signal: timeout,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || (payload.errcode && payload.errcode !== 0))
        throw new Error(payload.errmsg || `钉钉返回 ${response.status}`);
      return 'dingtalk ok';
    }
    if (channel.type === 'feishu') {
      const payload = { msg_type: 'text', content: { text: `${subject}\n\n${body}` } };
      if (config.secret) {
        // Feishu signs the empty string with `${timestamp}\n${secret}` as the key.
        const timestamp = String(Math.floor(Date.now() / 1000));
        payload.timestamp = timestamp;
        payload.sign = createHmac('sha256', `${timestamp}\n${config.secret}`).update('').digest('base64');
      }
      const response = await this.fetcher(config.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: timeout,
      });
      const result = await response.json().catch(() => ({}));
      // Feishu answers 200 with a non-zero code on a signature or keyword mismatch.
      const code = result.StatusCode ?? result.code;
      if (!response.ok || (code !== undefined && code !== 0))
        throw new Error(result.StatusMessage || result.msg || `飞书返回 ${response.status}`);
      return 'feishu ok';
    }
    const headers = { 'content-type': 'application/json' };
    if (config.token) headers.authorization = `Bearer ${config.token}`;
    const response = await this.fetcher(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: subject, text: body }),
      signal: timeout,
    });
    if (!response.ok) throw new Error(`回调返回 ${response.status}`);
    return 'webhook ok';
  }
  #record(channel, kind, ok, detail) {
    const now = this.clock();
    this.db.prepare('INSERT INTO notify_deliveries(at,channelId,kind,ok,detail) VALUES(?,?,?,?,?)')
      .run(now, channel.id, kind, ok ? 1 : 0, detail ? String(detail).slice(0, 300) : null);
    this.db.prepare('DELETE FROM notify_deliveries WHERE id NOT IN (SELECT id FROM notify_deliveries ORDER BY id DESC LIMIT ?)')
      .run(deliveryLogLimit);
    if (ok) this.db.prepare('UPDATE notify_channels SET lastSentAt=?,lastError=NULL WHERE id=?').run(now, channel.id);
    else this.db.prepare('UPDATE notify_channels SET lastError=?,lastErrorAt=? WHERE id=?')
      .run(String(detail).slice(0, 300), now, channel.id);
  }
  async deliver(channel, kind, subject, body) {
    try {
      await this.#send(channel, subject, body);
      this.#record(channel, kind, true, null);
      return { ok: true };
    } catch (error) {
      this.#record(channel, kind, false, error?.message || error);
      return { ok: false, error: error?.message || String(error) };
    }
  }
  async test(id) {
    const channel = this.#row(id);
    const sample = {
      kind: 'login_succeeded', at: this.clock(), method: 'password', ip: '203.0.113.7',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36',
      target: null, detail: '这是一条测试通知，收到说明通道配置正确。',
    };
    const message = this.#message(sample);
    const result = await this.deliver(channel, 'test', `${message.title}（测试）`, message.text);
    if (!result.ok) throw new AppError(`发送失败：${result.error}`, 400);
    return { ok: true };
  }
  /**
   * Send one composed message (a patrol report) to every channel that
   * subscribed to the matching category. No duplicate window: two reports an
   * hour apart are two separate deliveries, not a repeated event.
   */
  broadcast(kind, subject, body) {
    const category = eventCategories[kind];
    if (!category) return { channels: 0 };
    const channels = this.db.prepare('SELECT * FROM notify_channels WHERE enabled=1').all();
    const now = this.clock();
    const minute = Math.floor(now / 60000);
    let sent = 0;
    for (const channel of channels) {
      if (!JSON.parse(channel.events).includes(category)) continue;
      const budget = this.minute.get(channel.id);
      const used = budget?.window === minute ? budget.count : 0;
      if (used >= perMinuteCeiling) continue;
      this.minute.set(channel.id, { window: minute, count: used + 1 });
      sent += 1;
      void this.deliver(channel, kind, subject, body);
    }
    return { channels: sent };
  }
  // Called for every security event. Collapses repeats so a brute-force burst
  // cannot turn into a thousand messages, and never blocks the caller.
  handle(event) {
    const category = eventCategories[event.kind];
    if (!category) return;
    const channels = this.db.prepare('SELECT * FROM notify_channels WHERE enabled=1').all();
    if (!channels.length) return;
    const now = this.clock();
    const minute = Math.floor(now / 60000);
    const message = this.#message(event);
    for (const channel of channels) {
      const selected = JSON.parse(channel.events);
      if (!selected.includes(category)) continue;
      const key = `${channel.id}:${event.kind}`;
      if (now - (this.sent.get(key) || 0) < duplicateWindowMs) continue;
      const budget = this.minute.get(channel.id);
      const used = budget?.window === minute ? budget.count : 0;
      if (used >= perMinuteCeiling) continue;
      this.minute.set(channel.id, { window: minute, count: used + 1 });
      this.sent.set(key, now);
      void this.deliver(channel, event.kind, message.title, message.text);
    }
  }
}
