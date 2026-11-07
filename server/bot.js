import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from './store.js';
import { decrypt, encrypt } from './crypto.js';

// A read-only chat bot for the desk. Two directions:
//
//   outbound — a daily patrol that optionally runs a health check first, then
//              pushes one short report to the notification channels;
//   inbound  — you type "状态" in a group and it answers, so checking on the
//              shelf does not require opening the workbench.
//
// Hard rule: this module never returns a password or a TOTP seed. Every reply
// is built from counts and statuses only, because a chat message is forwarded,
// screenshotted and archived in places this service does not control.

const digestOf = (value) => createHash('sha256').update(String(value)).digest('hex');
const sameText = (left, right) => {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};
const BEIJING = 8 * 3600000;
const hookTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const messageRetention = 2000;
const perMinutePerBot = 20;
const perMinuteGlobal = 120;
const checkCooldownMs = 5 * 60000;
const reportTimeoutMs = 4 * 3600000;

export const platforms = [
  {
    id: 'dingtalk',
    label: '钉钉',
    hint: '群设置 → 智能群助手 → 添加机器人 → 自定义，在「消息接收」里填下面的回调地址，并把加签密钥（SEC 开头）填进来。',
    fields: [{ key: 'appSecret', label: '加签密钥', secret: true, hint: '填写后每条回调都会验签；不填则任何人都能向这个地址发指令。' }],
  },
  {
    id: 'feishu',
    label: '飞书',
    hint: '开放平台创建自建应用，开启「接收消息」事件并把回调地址填进去；填上 App ID / Secret 后，机器人可以在群里直接回复。',
    fields: [
      { key: 'verificationToken', label: 'Verification Token', secret: true, hint: '事件订阅页的校验令牌，用于确认回调来自飞书。' },
      { key: 'encryptKey', label: 'Encrypt Key', secret: true, hint: '填了就校验签名；不填则只按 Token 校验。加密推送暂不支持。' },
      { key: 'appId', label: 'App ID', secret: false, hint: '用于换取 tenant_access_token 后回复消息。' },
      { key: 'appSecret', label: 'App Secret', secret: true },
    ],
  },
  {
    id: 'generic',
    label: '通用 Webhook',
    hint: '自建脚本或自动化平台调用：POST {"text":"状态"}，带 Authorization: Bearer <密钥>，返回 {"reply":"..."}。',
    fields: [{ key: 'secret', label: '调用密钥', secret: true, hint: '必填。没有它，这个地址就是公开的指令入口。' }],
  },
];

const platformFields = Object.fromEntries(
  platforms.map((item) => [item.id, new Set(item.fields.map((field) => field.key))]),
);
const secretFields = new Set(['appSecret', 'verificationToken', 'encryptKey', 'secret']);
const text = (value, label, max = 40) => {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result) throw new AppError(`请填写${label}`);
  if (result.length > max) throw new AppError(`${label}不能超过 ${max} 个字符`);
  return result;
};
const optional = (value, max = 200) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function normalize(platform, input, previous = {}) {
  if (!platformFields[platform]) throw new AppError('机器人类型无效');
  const source = input && typeof input === 'object' ? input : {};
  const config = {};
  for (const key of platformFields[platform]) {
    const value = source[key];
    // An empty secret on edit means "keep the stored one", the same rule the
    // push channels use; an empty non-secret simply clears.
    config[key] = secretFields.has(key) && value === '' ? previous[key] || '' : optional(value, 400);
  }
  if (platform === 'generic' && !config.secret) throw new AppError('通用 Webhook 必须设置调用密钥');
  return config;
}

function masked(platform, config) {
  const output = { ...config };
  for (const field of platformFields[platform] || []) if (secretFields.has(field)) output[field] = config[field] ? '••••••' : '';
  return output;
}

const helpText = [
  '【账号工作台】可用指令',
  '状态 —— 账号数量、两步验证、近 24 小时安全事件',
  '检活 —— 检查超过 7 天没检查的账号（加「全部」检查所有）',
  '报告 —— 立刻把一份巡检报告推到订阅了「巡检与播报」的通道',
  '待办 —— 列出需要处理的事（未检测、缺两步验证、推送失败）',
  '账号 关键词 —— 搜账号状态，不会返回密码',
  '帮助 —— 显示这份清单',
].join('\n');

// The panel renders this list instead of keeping its own copy, so a command can
// never exist in the bot and be missing from the instructions.
export const commandList = [
  { command: '状态', argv: '', hint: '账号数量、两步验证、近 24 小时安全事件' },
  { command: '检活', argv: '[全部]', hint: '检查超过 7 天未检查的账号，结束后推送结果' },
  { command: '报告', argv: '', hint: '立刻把巡检报告推到订阅了「巡检与播报」的通道' },
  { command: '待办', argv: '', hint: '未检测、缺两步验证、推送失败等需要处理的事' },
  { command: '账号', argv: '<关键词>', hint: '按邮箱或用户名搜索状态，不返回密码' },
  { command: '帮助', argv: '', hint: '显示指令清单' },
];

const aliases = {
  help: ['帮助', 'help', '?', '？', '菜单'],
  status: ['状态', 'status', '概览'],
  report: ['报告', 'report', '播报'],
  check: ['检活', 'check', '检查', '体检'],
  todo: ['待办', 'todo'],
  find: ['账号', 'find', '搜索', '查询'],
};

function commandOf(input) {
  const body = String(input || '').trim();
  if (!body) return { name: 'help', argument: '' };
  const [head, ...rest] = body.split(/\s+/);
  const argument = rest.join(' ').trim();
  for (const [name, words] of Object.entries(aliases))
    if (words.some((word) => head.toLowerCase() === word.toLowerCase())) return { name, argument };
  // "账号 alpha" and "alpha 怎么样" both land on the search command.
  return { name: 'unknown', argument: body };
}

const statusLabels = { reachable: '可访问', missing: '失联', unknown: '待确认', unchecked: '未检测' };

export class BotService {
  constructor(store, { checker, notifier, auth, clock = Date.now, fetcher = fetch, staleDays = 7 } = {}) {
    Object.assign(this, { store, checker, notifier, auth, clock, fetcher });
    this.db = store.db;
    this.defaultStaleDays = staleDays;
    this.pendingReport = null;
    this.lastCheckStartedAt = 0;
    this.budget = new Map();
    this.timer = null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, platform TEXT NOT NULL, config TEXT NOT NULL,
      token TEXT NOT NULL, tokenDigest TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL, lastSeenAt INTEGER, lastError TEXT, lastErrorAt INTEGER
    );
    CREATE INDEX IF NOT EXISTS bots_digest ON bots(tokenDigest);
    CREATE TABLE IF NOT EXISTS bot_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, botId TEXT NOT NULL,
      direction TEXT NOT NULL, text TEXT NOT NULL, actor TEXT, ok INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS bot_messages_at ON bot_messages(at);
    CREATE TABLE IF NOT EXISTS bot_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO bot_settings(id,value) VALUES(1,?)').run(JSON.stringify(this.defaults));
  }
  get defaults() {
    return { enabled: false, dailyAt: '09:00', checkBefore: true, staleDays: this.defaultStaleDays, lastRunAt: null };
  }
  settings() {
    try {
      const saved = JSON.parse(this.db.prepare('SELECT value FROM bot_settings WHERE id=1').get().value);
      return { ...this.defaults, ...saved };
    } catch {
      return { ...this.defaults };
    }
  }
  #saveSettings(value) {
    this.db.prepare('UPDATE bot_settings SET value=? WHERE id=1').run(JSON.stringify(value));
    return this.settings();
  }
  configure(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('巡检配置无效');
    const current = this.settings();
    const enabled = body.enabled === undefined ? current.enabled : body.enabled === true;
    const dailyAt = body.dailyAt === undefined ? current.dailyAt : String(body.dailyAt);
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(dailyAt)) throw new AppError('每日时间须为 HH:MM（北京时间）');
    const staleDays = body.staleDays === undefined ? current.staleDays : Number(body.staleDays);
    if (!Number.isInteger(staleDays) || staleDays < 1 || staleDays > 365) throw new AppError('未检测天数须为 1–365 的整数');
    const checkBefore = body.checkBefore === undefined ? current.checkBefore : body.checkBefore === true;
    return this.#saveSettings({ ...current, enabled, dailyAt, staleDays, checkBefore });
  }
  // ---- storage ----
  #config(row) {
    try {
      return JSON.parse(decrypt(row.config, this.store.key));
    } catch {
      return {};
    }
  }
  #row(id) {
    const row = this.db.prepare('SELECT * FROM bots WHERE id=?').get(id);
    if (!row) throw new AppError('机器人不存在', 404);
    return row;
  }
  list() {
    return this.db.prepare('SELECT * FROM bots ORDER BY createdAt').all().map((row) => ({
      id: row.id,
      name: row.name,
      platform: row.platform,
      config: masked(row.platform, this.#config(row)),
      enabled: !!row.enabled,
      // The token is in the callback URL, so the panel must be able to copy the
      // whole thing. It is a secret; rotating it is one click away.
      token: decrypt(row.token, this.store.key),
      createdAt: new Date(row.createdAt).toISOString(),
      lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null,
      lastError: row.lastError || null,
      lastErrorAt: row.lastErrorAt ? new Date(row.lastErrorAt).toISOString() : null,
    }));
  }
  create(body) {
    const platform = String(body?.platform || '');
    const config = normalize(platform, body?.config);
    const id = randomUUID();
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO bots(id,name,platform,config,token,tokenDigest,enabled,createdAt) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, text(body?.name || platforms.find((item) => item.id === platform)?.label, '机器人名称', 40),
        platform, encrypt(JSON.stringify(config), this.store.key), encrypt(token, this.store.key),
        digestOf(token), body?.enabled === false ? 0 : 1, this.clock());
    return this.list().find((item) => item.id === id);
  }
  update(id, body) {
    const row = this.#row(id);
    const platform = platformFields[body?.platform] ? body.platform : row.platform;
    const config = platform === row.platform
      ? normalize(platform, body?.config ?? this.#config(row), this.#config(row))
      : normalize(platform, body?.config);
    this.db.prepare('UPDATE bots SET name=?,platform=?,config=?,enabled=? WHERE id=?')
      .run(text(body?.name || row.name, '机器人名称', 40), platform,
        encrypt(JSON.stringify(config), this.store.key),
        body?.enabled === undefined ? row.enabled : body.enabled ? 1 : 0, id);
    return this.list().find((item) => item.id === id);
  }
  remove(id) {
    this.#row(id);
    this.db.prepare('DELETE FROM bots WHERE id=?').run(id);
    return { ok: true };
  }
  rotate(id) {
    const row = this.#row(id);
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('UPDATE bots SET token=?,tokenDigest=? WHERE id=?')
      .run(encrypt(token, this.store.key), digestOf(token), row.id);
    return this.list().find((item) => item.id === row.id);
  }
  messages(limit = 100) {
    const size = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.db.prepare('SELECT * FROM bot_messages ORDER BY id DESC LIMIT ?').all(size)
      .map((row) => ({
        at: new Date(row.at).toISOString(), botId: row.botId, direction: row.direction,
        text: row.text, actor: row.actor, ok: !!row.ok,
      }));
  }
  #record(botId, direction, value, actor, ok = true) {
    this.db.prepare('INSERT INTO bot_messages(at,botId,direction,text,actor,ok) VALUES(?,?,?,?,?,?)')
      .run(this.clock(), botId, direction, String(value).slice(0, 1000), actor ? String(actor).slice(0, 80) : null, ok ? 1 : 0);
    this.db.prepare('DELETE FROM bot_messages WHERE id NOT IN (SELECT id FROM bot_messages ORDER BY id DESC LIMIT ?)')
      .run(messageRetention);
  }
  // ---- the numbers behind every reply ----
  accounts() {
    return this.store.list().filter((row) => !row.deletedAt);
  }
  staleRows(staleDays = this.settings().staleDays) {
    const limit = this.clock() - staleDays * 86400000;
    return this.accounts().filter((row) => {
      const at = Date.parse(row.checkedAt || '');
      return !Number.isFinite(at) || at < limit;
    });
  }
  summary() {
    const rows = this.accounts();
    const counts = { reachable: 0, missing: 0, unknown: 0, unchecked: 0 };
    let totpMissing = 0;
    for (const row of rows) {
      const status = ['error', 'limited'].includes(row.publicStatus) ? 'unknown' : row.publicStatus;
      counts[status in counts ? status : 'unchecked'] += 1;
      if (!row.hasTotp) totpMissing += 1;
    }
    const since = this.clock() - 86400000;
    // The event table is owned by AdminAuth. A bot built without it (a script,
    // a test) should still be able to answer; the security line simply reads 0.
    let events = [];
    try {
      events = this.db.prepare('SELECT kind,COUNT(*) AS count FROM security_events WHERE at>=? GROUP BY kind').all(since);
    } catch { /* No audit table yet. */ }
    const countOf = (kinds) => events.filter((row) => kinds.includes(row.kind)).reduce((sum, row) => sum + Number(row.count), 0);
    const channels = this.notifier?.list() || [];
    const job = this.checker?.status() || { running: false };
    return {
      total: rows.length,
      counts,
      totpMissing,
      stale: this.staleRows().length,
      lastCheckedAt: rows.map((row) => row.checkedAt).filter(Boolean).sort().at(-1) || null,
      loginFailed: countOf(['login_failed', 'login_locked', 'totp_failed', 'reauth_failed']),
      rejected: countOf(['ip_rejected', 'host_rejected', 'origin_rejected', 'api_key_rejected', 'api_key_scope_denied']),
      exports: countOf(['credential_export']),
      reads: countOf(['credential_read']),
      channels: channels.length,
      channelFailures: channels.filter((item) => item.lastError).length,
      checking: !!job.running,
      checkProgress: job.running ? `${job.done}/${job.total}` : null,
    };
  }
  #stamp(at = this.clock()) {
    return new Date(at + BEIJING).toISOString().slice(0, 16).replace('T', ' ');
  }
  statusText() {
    const data = this.summary();
    const { counts } = data;
    return [
      `【账号工作台】${this.#stamp()}`,
      `账号 ${data.total} 个：可访问 ${counts.reachable} · 失联 ${counts.missing} · 待确认 ${counts.unknown} · 未检测 ${counts.unchecked}`,
      `两步验证：${data.totpMissing} 个账号未启用`,
      `近 24 小时：登录失败 ${data.loginFailed} · 来源被拒 ${data.rejected} · 凭据读取 ${data.reads} · 明文导出 ${data.exports}`,
      `推送：${data.channels} 个通道${data.channelFailures ? `，${data.channelFailures} 个最近失败` : '，全部正常'}`,
      data.checking ? `检活：进行中 ${data.checkProgress}` : `检活：${data.stale} 个账号超过 ${this.settings().staleDays} 天未检查`,
    ].join('\n');
  }
  reportText(reason = 'manual', check = null) {
    const data = this.summary();
    const { counts } = data;
    const lines = [`【账号工作台 · 巡检报告】`, `时间：${this.#stamp()}`];
    if (check) lines.push(`本次检活：检查 ${check.count} 个，可访问 ${check.reachable}，失联 ${check.missing}，未确认 ${check.other}`);
    lines.push(
      `账号 ${data.total} 个：可访问 ${counts.reachable} · 失联 ${counts.missing} · 待确认 ${counts.unknown} · 未检测 ${counts.unchecked}`,
      `上次检查：${data.lastCheckedAt ? this.#stamp(Date.parse(data.lastCheckedAt)) : '从未'}`,
      `两步验证：${data.totpMissing} 个账号未启用`,
      `近 24 小时：登录失败 ${data.loginFailed} · 来源被拒 ${data.rejected} · 凭据读取 ${data.reads} · 明文导出 ${data.exports}`,
      `推送：${data.channels} 个通道${data.channelFailures ? `，${data.channelFailures} 个最近失败` : '，全部正常'}`,
      `触发：${reason}`,
    );
    return lines.join('\n');
  }
  // ---- actions ----
  runCheck({ all = false } = {}) {
    if (!this.checker) throw new AppError('检活不可用', 503);
    const job = this.checker.status();
    if (job.running) return { started: false, running: true, done: job.done, total: job.total };
    const rows = all ? this.accounts() : this.staleRows();
    if (!rows.length) return { started: false, empty: true, staleDays: this.settings().staleDays };
    // A chat command is an easy way to hammer GitHub's API; one batch per five
    // minutes is enough for a human asking "are they alive".
    if (this.clock() - this.lastCheckStartedAt < checkCooldownMs && !all)
      return { started: false, cooldown: true };
    this.checker.start(rows.map((row) => row.id), 'bot');
    this.lastCheckStartedAt = this.clock();
    this.pendingReport = { at: this.clock(), count: rows.length, reason: all ? '机器人全量检活' : '机器人检活' };
    return { started: true, count: rows.length };
  }
  #checkOutcome() {
    const job = this.checker?.status();
    if (!job?.counts) return null;
    const counts = job.counts;
    return {
      count: job.total,
      reachable: counts.reachable || 0,
      missing: counts.missing || 0,
      other: (counts.error || 0) + (counts.skipped || 0) + (counts.limited || 0),
    };
  }
  pushReport(reason = 'manual', check = null) {
    if (!this.notifier) throw new AppError('推送未启用', 503);
    const result = this.notifier.broadcast('bot_report', '【账号工作台】巡检报告', this.reportText(reason, check));
    return result;
  }
  todoText() {
    const data = this.summary();
    const items = [];
    if (!this.accounts().length) items.push('还没有导入任何账号');
    if (data.counts.unchecked + data.counts.unknown) items.push(`${data.counts.unchecked + data.counts.unknown} 个账号还没有可靠状态，建议先「检活」`);
    if (data.counts.missing) items.push(`${data.counts.missing} 个账号公开资料不可访问，需要人工核对`);
    if (data.totpMissing) items.push(`${data.totpMissing} 个账号没有配置 TOTP`);
    if (data.channelFailures) items.push(`${data.channelFailures} 个推送通道最近发送失败`);
    if (!this.settings().enabled) items.push('每日巡检还没开启');
    if (!data.channels) items.push('还没有配置推送通道，机器人的消息没人收');
    return items.length ? `【待办】\n${items.map((item, index) => `${index + 1}. ${item}`).join('\n')}` : '【待办】\n没有需要立刻处理的事。';
  }
  findText(term) {
    const needle = String(term || '').trim().toLowerCase();
    if (!needle) return '用法：账号 <邮箱或用户名片段>，例如「账号 icloud」。';
    const matches = this.accounts()
      .filter((row) => `${row.email} ${row.username}`.toLowerCase().includes(needle))
      .slice(0, 8);
    if (!matches.length) return `没有匹配「${needle}」的账号。`;
    const lines = matches.map((row) => {
      const status = statusLabels[['error', 'limited'].includes(row.publicStatus) ? 'unknown' : row.publicStatus] || row.publicStatus;
      const at = row.checkedAt ? this.#stamp(Date.parse(row.checkedAt)).slice(5) : '未检查';
      return `${row.email} · ${status} · ${row.hasTotp ? '有 TOTP' : '无 TOTP'} · ${at}`;
    });
    const more = this.accounts().filter((row) => `${row.email} ${row.username}`.toLowerCase().includes(needle)).length - matches.length;
    return [`【搜索】${needle}`, ...lines, more > 0 ? `…还有 ${more} 个，去工作台看完整列表` : null].filter(Boolean).join('\n');
  }
  command(input) {
    const { name, argument } = commandOf(input);
    if (name === 'help') return helpText;
    if (name === 'unknown') return `没识别这条指令。\n\n${helpText}`;
    if (name === 'status') return this.statusText();
    if (name === 'report') {
      const result = this.pushReport('机器人指令');
      return result.channels
        ? `已推送巡检报告到 ${result.channels} 个通道。`
        : '没有通道订阅「巡检与播报」，请到通知推送页在通道上勾选这一类。';
    }
    if (name === 'check') {
      const all = /全部|所有|all/i.test(argument);
      const result = this.runCheck({ all });
      if (result.running) return `检活正在进行中：已完成 ${result.done}/${result.total}，结束后会推送结果。`;
      if (result.empty) return `没有超过 ${result.staleDays} 天未检查的账号。想全部检查请输入「检活 全部」。`;
      if (result.cooldown) return '刚刚才启动过一次检活，请 5 分钟后再试，避免把 GitHub 配额打满。';
      return `已开始检活：${result.count} 个账号。结束后会把结果推送到订阅了「巡检与播报」的通道；随时输入「状态」看进度。`;
    }
    if (name === 'todo') return this.todoText();
    if (name === 'find') return this.findText(argument);
    return helpText;
  }
  // ---- inbound hook ----
  #spend(key, limit, minute) {
    const current = this.budget.get(key);
    const state = current && current.minute === minute ? current : { minute, count: 0 };
    if (state.count >= limit) {
      this.budget.set(key, state);
      return false;
    }
    state.count += 1;
    this.budget.set(key, state);
    if (this.budget.size > 500)
      for (const [name, value] of this.budget) if (value.minute !== minute) this.budget.delete(name);
    return true;
  }
  #fail(bot, error) {
    this.db.prepare('UPDATE bots SET lastError=?,lastErrorAt=? WHERE id=?')
      .run(String(error?.message || error).slice(0, 300), this.clock(), bot.id);
    throw error instanceof AppError ? error : new AppError('机器人处理失败', 500);
  }
  #messageOf(bot, payload) {
    if (bot.platform === 'dingtalk') {
      const content = payload?.text?.content ?? payload?.content ?? '';
      return String(content);
    }
    if (bot.platform === 'feishu') {
      const raw = payload?.event?.message?.content;
      if (typeof raw !== 'string') return '';
      try {
        // Feishu ships the text as a JSON string and prefixes mentions.
        return String(JSON.parse(raw).text || '').replace(/@_user_\d+|@_all/g, '').trim();
      } catch {
        return raw;
      }
    }
    return String(payload?.text ?? payload?.message ?? payload?.command ?? '');
  }
  #actorOf(bot, payload) {
    if (bot.platform === 'dingtalk') return payload?.senderNick || payload?.senderStaffId || null;
    if (bot.platform === 'feishu') return payload?.event?.sender?.sender_id?.open_id || null;
    return payload?.user || null;
  }
  #verify(bot, config, req, raw) {
    if (bot.platform === 'dingtalk' && config.appSecret) {
      const timestamp = String(req.headers.timestamp || '');
      const expected = createHmac('sha256', config.appSecret).update(`${timestamp}\n${config.appSecret}`).digest('base64');
      if (!sameText(req.headers.sign, expected)) throw new AppError('签名校验失败', 401);
      // A captured request must not stay replayable forever.
      if (!/^\d{10,13}$/.test(timestamp) || Math.abs(this.clock() - Number(timestamp)) > 3600000)
        throw new AppError('请求时间戳超出允许范围', 401);
      return;
    }
    if (bot.platform === 'feishu') {
      if (config.encryptKey) {
        const timestamp = String(req.headers['x-lark-request-timestamp'] || '');
        const nonce = String(req.headers['x-lark-request-nonce'] || '');
        const expected = createHash('sha256').update(timestamp + nonce + config.encryptKey + raw).digest('hex');
        if (!sameText(req.headers['x-lark-signature'], expected)) throw new AppError('签名校验失败', 401);
      }
      return;
    }
    if (bot.platform === 'generic') {
      const header = String(req.headers.authorization || '');
      const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!sameText(supplied, config.secret)) throw new AppError('调用密钥不正确', 401);
    }
  }
  async #replyFeishu(bot, config, payload, reply) {
    if (!config.appId || !config.appSecret) return;
    const openId = payload?.event?.sender?.sender_id?.open_id;
    if (!openId) return;
    const signal = AbortSignal.timeout(8000);
    const tokenResponse = await this.fetcher('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
      signal,
    });
    const token = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || token.code !== 0 || !token.tenant_access_token) throw new Error(token.msg || '获取飞书令牌失败');
    const response = await this.fetcher('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.tenant_access_token}` },
      body: JSON.stringify({ receive_id: openId, msg_type: 'text', content: JSON.stringify({ text: reply }) }),
      signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.code) throw new Error(result.msg || `飞书返回 ${response.status}`);
  }
  /**
   * Handle one callback. Returns `{status, body}` for the caller to serialise,
   * shaped per platform: DingTalk replies inside the HTTP response, Feishu wants
   * a bare `code:0` and gets its answer through the open API.
   */
  async handleHook(token, req, raw) {
    if (!hookTokenPattern.test(String(token || ''))) throw new AppError('机器人不存在', 404);
    const row = this.db.prepare('SELECT * FROM bots WHERE tokenDigest=?').get(digestOf(token));
    if (!row || !row.enabled) throw new AppError('机器人不存在', 404);
    const minute = Math.floor(this.clock() / 60000);
    if (!this.#spend(`bot:${row.id}`, perMinutePerBot, minute) || !this.#spend('bot:global', perMinuteGlobal, minute))
      throw new AppError('指令过于频繁，请稍后再试', 429);
    let payload;
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      throw this.#fail(row, new AppError('消息格式无效', 400));
    }
    const config = this.#config(row);
    // Feishu's URL verification is the first thing it sends, before any event.
    if (row.platform === 'feishu' && payload?.type === 'url_verification') {
      if (config.verificationToken && !sameText(payload.token, config.verificationToken))
        throw this.#fail(row, new AppError('校验令牌不匹配', 401));
      this.db.prepare('UPDATE bots SET lastSeenAt=? WHERE id=?').run(this.clock(), row.id);
      return { status: 200, body: { challenge: payload.challenge } };
    }
    try {
      this.#verify(row, config, req, raw);
    } catch (error) {
      throw this.#fail(row, error);
    }
    if (row.platform === 'feishu' && config.verificationToken && payload?.header?.token && !sameText(payload.header.token, config.verificationToken))
      throw this.#fail(row, new AppError('校验令牌不匹配', 401));
    const incoming = this.#messageOf(row, payload);
    const actor = this.#actorOf(row, payload);
    let reply;
    try {
      reply = this.command(incoming);
    } catch (error) {
      reply = `出错：${error.message}`;
    }
    this.#record(row.id, 'in', incoming || '(空消息)', actor, true);
    this.#record(row.id, 'out', reply, actor, true);
    this.db.prepare('UPDATE bots SET lastSeenAt=?,lastError=NULL WHERE id=?').run(this.clock(), row.id);
    if (row.platform === 'dingtalk') return { status: 200, body: { msgtype: 'text', text: { content: reply } } };
    if (row.platform === 'feishu') {
      // Answer in the background: Feishu times out the callback quickly.
      void this.#replyFeishu(row, config, payload, reply).catch((error) => {
        this.db.prepare('UPDATE bots SET lastError=?,lastErrorAt=? WHERE id=?')
          .run(String(error?.message || error).slice(0, 300), this.clock(), row.id);
      });
      return { status: 200, body: { code: 0 } };
    }
    return { status: 200, body: { reply } };
  }
  // ---- scheduled patrol ----
  nextRunAt() {
    const settings = this.settings();
    if (!settings.enabled) return null;
    const now = this.clock();
    const beijingNow = new Date(now + BEIJING);
    const today = beijingNow.toISOString().slice(0, 10);
    const due = Date.parse(`${today}T${settings.dailyAt}:00+08:00`);
    if (due > now) return new Date(due).toISOString();
    if (settings.lastRunAt === today) return new Date(due + 86400000).toISOString();
    return new Date(now).toISOString();
  }
  tick() {
    try {
      // A batch that finished between two ticks still owes one report.
      if (this.pendingReport && !this.checker?.status().running) {
        const outcome = this.#checkOutcome();
        const expired = this.clock() - this.pendingReport.at > reportTimeoutMs;
        const settled = this.clock() - this.pendingReport.at > 3000;
        if (settled || expired) {
          const reason = this.pendingReport.reason;
          this.pendingReport = null;
          this.pushReport(reason, outcome);
        }
        return;
      }
      const settings = this.settings();
      if (!settings.enabled || this.pendingReport) return;
      const now = this.clock();
      const due = this.nextRunAt();
      if (!due || Date.parse(due) > now) return;
      const today = new Date(now + BEIJING).toISOString().slice(0, 10);
      this.#saveSettings({ ...settings, lastRunAt: today });
      if (settings.checkBefore) {
        const rows = this.staleRows(settings.staleDays);
        if (rows.length && this.checker && !this.checker.status().running) {
          this.checker.start(rows.map((row) => row.id), 'bot');
          this.lastCheckStartedAt = now;
          this.pendingReport = { at: now, count: rows.length, reason: '每日巡检' };
          return;
        }
      }
      this.pushReport('每日巡检');
    } catch {
      // A failed patrol must never take the process down; the next tick retries.
    }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 30000);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
