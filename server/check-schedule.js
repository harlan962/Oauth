import { AppError } from './store.js';

const DAY = 86400000;
const BEIJING_OFFSET = 8 * 3600000;
const defaultRule = { id: 'legacy-default', name: '默认规则', enabled: true, mode: 'interval', intervalDays: 7,
  stageDays: [1, 3, 7, 15, 30], baseline: 'imported', baselineDate: null, repeatDays: 30,
  statuses: ['reachable', 'unknown', 'unchecked'], groupIds: null, tagIds: null };
const defaults = { version: 2, enabled: false, rules: [defaultRule] };
const states = new Set(['reachable', 'missing', 'unknown', 'unchecked']);
const iso = value => new Date(value).toISOString();
const dayValue = value => Number.isInteger(value) && value >= 1 && value <= 365;
const calendarDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number(value.slice(0, 4)) >= 2000 && Number(value.slice(0, 4)) <= 9998
  && Number.isFinite(Date.parse(value)) && iso(Date.parse(value)).slice(0, 10) === value;
const legacySettings = body => ({ version: 2, enabled: body.enabled, rules: [{ ...defaultRule,
  intervalDays: body.intervalDays, statuses: body.statuses, groupIds: body.groupIds, tagIds: body.tagIds }] });

export class CheckSchedule {
  constructor(store, checker, { clock = Date.now, pat, workbuddy, integrations } = {}) {
    Object.assign(this, { store, checker, clock, pat, workbuddy, integrations });
    this.timer = null;
    this.message = '';
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS check_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS check_attempts (
        accountId TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        username TEXT NOT NULL, checkedAt TEXT, attempts INTEGER NOT NULL,
        lastAttemptAt TEXT NOT NULL, retryAt TEXT NOT NULL
      );
    `);
    store.db.prepare('INSERT OR IGNORE INTO check_settings(id,value) VALUES(1,?)').run(JSON.stringify(defaults));
    const saved = this.settings();
    if (saved.version === undefined && !('rules' in saved)) {
      const migrated = this.validate(legacySettings(saved));
      store.db.prepare('UPDATE check_settings SET value=? WHERE id=1').run(JSON.stringify(migrated));
    } else this.validate(saved);
    checker.setSchedule(this);
  }
  settings() { return JSON.parse(this.store.db.prepare('SELECT value FROM check_settings WHERE id=1').get().value); }
  validate(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('检测配置无效');
    if (body.version === undefined && !('rules' in body)) {
      const saved = this.settings(), only = saved.rules?.[0];
      if (saved.version !== 2 || saved.rules.length !== 1 || only.id !== 'legacy-default' || only.name !== defaultRule.name || !only.enabled || only.mode !== 'interval'
        || only.baseline !== 'imported' || only.baselineDate !== null || only.repeatDays !== 30 || JSON.stringify(only.stageDays) !== JSON.stringify(defaultRule.stageDays))
        throw new AppError('检测规则已更新，请刷新页面后重试', 409);
      body = legacySettings(body);
    }
    if (body.version !== 2 || typeof body.enabled !== 'boolean' || !Array.isArray(body.rules) || body.rules.length > 30)
      throw new AppError('检测配置无效（最多 30 条规则）');
    const ids = new Set();
    const rules = body.rules.map((rule, index) => {
      const fail = message => { throw new AppError(`规则 ${index + 1}：${message}`); };
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail('配置无效');
      const { id, name, enabled, mode, intervalDays, stageDays, baseline, baselineDate, repeatDays, statuses, groupIds, tagIds } = rule;
      if (typeof id !== 'string' || !id.trim() || id.length > 128 || ids.has(id)) fail('标识无效或重复');
      ids.add(id);
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 40) fail('名称须为 1–40 字符');
      if (typeof enabled !== 'boolean' || !['interval', 'staged'].includes(mode)) fail('开关或模式无效');
      if (!dayValue(intervalDays) || !dayValue(repeatDays)) fail('间隔须为 1–365 的整数天');
      if (!Array.isArray(stageDays) || !stageDays.length || stageDays.length > 30 || stageDays.some((day, i) => !dayValue(day) || (i > 0 && day <= stageDays[i - 1]))) fail('阶段须为严格递增的 1–365 整数天，最多 30 个');
      if (!['imported', 'date'].includes(baseline) || (baseline === 'date' ? !calendarDate(baselineDate) : baselineDate !== null && !calendarDate(baselineDate))) fail('基准日期无效，须为 2000–9998 年的有效日期');
      if (!Array.isArray(statuses) || !statuses.length || statuses.length > 4 || statuses.some(s => !states.has(s))) fail('请选择有效的检测状态');
      for (const filter of [groupIds, tagIds]) if (filter !== null && (!Array.isArray(filter) || filter.length > 500 || filter.some(value => typeof value !== 'string' || !value || value.length > 128))) fail('分组或标签筛选无效');
      return { id, name: name.trim(), enabled, mode, intervalDays, stageDays: [...stageDays], baseline, baselineDate, repeatDays,
        statuses: [...new Set(statuses)], groupIds: groupIds === null ? null : [...new Set(groupIds)], tagIds: tagIds === null ? null : [...new Set(tagIds)] };
    });
    return { version: 2, enabled: body.enabled, rules };
  }
  invalidFilters(rule, org = this.store.organization.list()) {
    return [['groupIds', 'groups'], ['tagIds', 'tags']].flatMap(([field, kind]) => (rule[field] || []).filter(id => id !== 'none' && !org[kind].some(item => item.id === id)).map(id => `${kind}:${id}`));
  }
  matches(row, rule) {
    const status = ['error', 'limited'].includes(row.publicStatus) ? 'unknown' : row.publicStatus;
    return !row.deletedAt && rule.statuses.includes(status)
      && (rule.groupIds === null || rule.groupIds.includes(row.groupId || 'none'))
      && (rule.tagIds === null || (row.tagIds?.length ? row.tagIds.some(id => rule.tagIds.includes(id)) : rule.tagIds.includes('none')));
  }
  nextAt(row, rule, confirmation, attempt, now = this.clock()) {
    let due;
    if (rule.mode === 'staged') {
      const created = Date.parse(row.createdAt);
      const base = rule.baseline === 'date' ? Date.parse(rule.baselineDate + 'T00:00:00+08:00')
        : Math.floor((created + BEIJING_OFFSET) / DAY) * DAY - BEIJING_OFFSET;
      const confirmed = confirmation?.username.toLowerCase() === row.username.toLowerCase() ? Date.parse(confirmation.confirmedAt) : NaN;
      const firstUncovered = rule.stageDays.find(day => !Number.isFinite(confirmed) || base + day * DAY > confirmed);
      if (firstUncovered !== undefined) due = base + firstUncovered * DAY;
      else {
        const last = base + rule.stageDays.at(-1) * DAY;
        due = last + (Math.floor((confirmed - last) / (rule.repeatDays * DAY)) + 1) * rule.repeatDays * DAY;
      }
      // Corrupt historic import dates must not abort all other valid accounts.
      if (!Number.isFinite(due)) due = now;
    } else {
      const last = Date.parse(row.checkedAt);
      due = Number.isFinite(last) ? last + rule.intervalDays * DAY : now;
    }
    return attempt && attempt.username === row.username && attempt.checkedAt === row.checkedAt ? Math.max(due, Date.parse(attempt.retryAt)) : due;
  }
  evaluate(settings) {
    const now = this.clock(), rows = this.store.list(), org = this.store.organization.list();
    const confirmations = new Map(this.store.db.prepare('SELECT * FROM check_confirmations').all().map(row => [row.accountId, row]));
    const attempts = new Map(this.store.db.prepare('SELECT * FROM check_attempts').all().map(row => [row.accountId, row]));
    const union = new Map(), invalidFilters = new Set();
    const summarize = entries => {
      let due = 0, next = Infinity;
      for (const { time } of entries) { if (time <= now) due++; next = Math.min(next, time); }
      return { matched: entries.length, due, nextDueAt: Number.isFinite(next) ? iso(Math.max(now, next)) : null };
    };
    const rules = settings.rules.map(rule => {
      const invalid = this.invalidFilters(rule, org), entries = [];
      if (!invalid.length) for (const row of rows) if (this.matches(row, rule)) {
        const time = this.nextAt(row, rule, confirmations.get(row.id), attempts.get(row.id), now);
        entries.push({ row, time });
        if (rule.enabled && (!union.has(row.id) || time < union.get(row.id).time)) union.set(row.id, { row, time });
      }
      if (rule.enabled) invalid.forEach(value => invalidFilters.add(value));
      return { id: rule.id, ...summarize(entries), invalidFilters: invalid };
    });
    const entries = [...union.values()];
    return { entries, rules, ...summarize(entries), invalidFilters: [...invalidFilters] };
  }
  select(settings, dueOnly = false) {
    return this.evaluate(settings).entries.filter(({ time }) => !dueOnly || time <= this.clock()).map(({ row }) => row);
  }
  preview(body) {
    const settings = this.validate(body), { entries, ...preview } = this.evaluate(settings);
    return { settings, ...preview, message: preview.invalidFilters.length ? '选定的分组或标签已删除，请重新设置检测范围' : this.message };
  }
  status() { return this.preview(this.settings()); }
  configure(body) {
    const settings = this.validate(body);
    this.store.db.prepare('UPDATE check_settings SET value=? WHERE id=1').run(JSON.stringify(settings));
    this.message = '';
    return this.status();
  }
  startRange(body) {
    const settings = this.validate(body), evaluated = this.evaluate(settings);
    if (evaluated.invalidFilters.length) throw new AppError('选定的分组或标签已删除，请重新设置检测范围');
    return this.checker.start(evaluated.entries.map(({ row }) => row.id), 'filtered');
  }
  shouldCheck(row) {
    const org = this.store.organization.list();
    // The global switch does not cancel an active batch; individual rules still take effect.
    return this.settings().rules.some(rule => rule.enabled && !this.invalidFilters(rule, org).length && this.matches(row, rule));
  }
  attempted(row) {
    const previous = this.store.db.prepare('SELECT * FROM check_attempts WHERE accountId=?').get(row.id);
    const attempts = previous?.username === row.username && previous.checkedAt === row.checkedAt ? Math.min(previous.attempts + 1, 3) : 1;
    const delay = [30 * 60000, 2 * 3600000, 6 * 3600000][attempts - 1];
    this.store.db.prepare(`INSERT INTO check_attempts(accountId,username,checkedAt,attempts,lastAttemptAt,retryAt) VALUES(?,?,?,?,?,?)
      ON CONFLICT(accountId) DO UPDATE SET username=excluded.username,checkedAt=excluded.checkedAt,attempts=excluded.attempts,lastAttemptAt=excluded.lastAttemptAt,retryAt=excluded.retryAt`)
      .run(row.id, row.username, row.checkedAt, attempts, iso(this.clock()), iso(this.clock() + delay));
  }
  completed(id) { this.store.db.prepare('DELETE FROM check_attempts WHERE accountId=?').run(id); }
  tick() {
    if (!this.settings().enabled) return;
    const job = this.checker.status();
    if (job.running || this.pat?.active || this.pat?.verifications.size || this.workbuddy?.active || this.integrations?.active) return;
    if (job.canResume) {
      if (job.autoResume && !job.cancelled) this.checker.resume();
      return;
    }
    const rows = this.select(this.settings(), true);
    if (!rows.length) return;
    this.checker.start(rows.map(row => row.id), 'scheduled');
    this.message = '';
  }
  start() {
    if (this.timer) return;
    const tick = () => { try { this.tick(); } catch { this.message = '自动检测暂未启动，将稍后重试；也可手动检测'; } };
    this.timer = setInterval(tick, 60000);
    this.timer.unref?.();
    tick();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
