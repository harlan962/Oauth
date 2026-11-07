import { randomUUID } from 'node:crypto';
import { encrypt, decrypt } from './crypto.js';
import { AppError } from './store.js';

const metadata = 'p.id,p.accountId,a.username,p.status,p.message,p.createdAt,p.expiresAt,p.remaining,p."limit",p.resetAt,p.retryAt,p.creationUncertain,(p.token IS NOT NULL) AS hasToken';
const statuses = new Set(['preparing', 'valid', 'cooling', 'invalid', 'manual', 'disabled', 'verifying']);
const fields = new Set(['status', 'message', 'expiresAt', 'remaining', 'limit', 'resetAt', 'retryAt', 'creationUncertain']);
const now = () => new Date().toISOString();
const safe = row => row ? { ...row, creationUncertain: !!row.creationUncertain, hasToken: !!row.hasToken } : null;
const secretPattern = /(?:github_pat_|gh[pousr]_|Bearer\s+)[A-Za-z0-9_\-.]+/gi;

export class PatStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pats (
        id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES accounts(id),
        status TEXT NOT NULL DEFAULT 'preparing', message TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL, expiresAt TEXT, token TEXT,
        remaining INTEGER, "limit" INTEGER, resetAt TEXT, retryAt TEXT,
        creationUncertain INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS pat_settings (
        id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
        targetCount INTEGER NOT NULL DEFAULT 1
      );
      INSERT OR IGNORE INTO pat_settings(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS pat_checkpoints (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pat_credential_holds (
        accountId TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, expiresAt TEXT NOT NULL
      );
    `);
    store.pats = this;
  }
  settings() {
    const row = this.db.prepare('SELECT enabled,targetCount FROM pat_settings WHERE id=1').get();
    return { enabled: !!row.enabled, targetCount: row.targetCount };
  }
  configure(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('PAT 配置无效');
    const current = this.settings();
    const enabled = body.enabled === undefined ? current.enabled : body.enabled;
    const targetCount = body.targetCount === undefined ? current.targetCount : body.targetCount;
    if (typeof enabled !== 'boolean') throw new AppError('PAT 启用设置无效');
    if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 100) throw new AppError('PAT 数量须为 1–100 的整数');
    if (enabled && !current.enabled && body.confirmed !== true) throw new AppError('请确认启用 PAT 自动维护');
    this.db.prepare('UPDATE pat_settings SET enabled=?,targetCount=? WHERE id=1').run(enabled ? 1 : 0, targetCount);
    return this.settings();
  }
  persistSettings(body) { return this.configure(body); }
  expire() {
    this.db.prepare(`UPDATE pats SET status='invalid',message='PAT 已过期'
      WHERE expiresAt IS NOT NULL AND expiresAt<=? AND creationUncertain=0 AND status NOT IN ('invalid','disabled')`).run(now());
  }
  list() {
    this.expire();
    return this.db.prepare(`SELECT ${metadata} FROM pats p JOIN accounts a ON a.id=p.accountId ORDER BY p.createdAt DESC,p.rowid DESC`).all().map(safe);
  }
  row(id) {
    const row = this.db.prepare('SELECT * FROM pats WHERE id=?').get(id);
    if (!row) throw new AppError('PAT 记录不存在', 404);
    return row;
  }
  summary(accountId) {
    this.expire();
    return safe(this.db.prepare(`SELECT ${metadata} FROM pats p JOIN accounts a ON a.id=p.accountId WHERE p.accountId=? ORDER BY p.createdAt DESC,p.rowid DESC LIMIT 1`).get(accountId));
  }
  usable() {
    this.expire();
    return this.db.prepare(`SELECT ${metadata} FROM pats p JOIN accounts a ON a.id=p.accountId
      WHERE p.status IN ('valid','cooling','verifying') AND p.token IS NOT NULL AND p.expiresAt>?
      AND a.patDedicated=1 AND a.deletedAt IS NULL ORDER BY p.createdAt ASC,p.rowid ASC`).all(now()).map(safe);
  }
  reserve() {
    return this.store.transaction(() => {
        // Share eligibility with selection and WorkBuddy; only the order differs.
        const row = this.store.candidateRow('RANDOM()');
      if (!row) return null;
      const id = randomUUID();
      this.db.prepare('UPDATE accounts SET patDedicated=1,reservedBy=? WHERE id=?').run('pat:' + id, row.id);
      this.db.prepare('INSERT INTO pats(id,accountId,createdAt) VALUES(?,?,?)').run(id, row.id, now());
      this.store.event(row, 'pat-reserve', '保留为 PAT 专用账号，临时占用浏览器');
      return this.summary(row.id);
    });
  }
  update(id, patch) {
    this.row(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new AppError('PAT 更新无效');
    const entries = Object.entries(patch);
    for (const [key, value] of entries) {
      if (!fields.has(key)) throw new AppError('PAT 元数据字段无效');
      if (key === 'status' && !statuses.has(value)) throw new AppError('PAT 状态无效');
      if (key === 'creationUncertain' && typeof value !== 'boolean') throw new AppError('PAT 未知状态无效');
      if (['remaining', 'limit'].includes(key) && value !== null && (!Number.isInteger(value) || value < 0)) throw new AppError('PAT 配额无效');
      if (['expiresAt', 'resetAt', 'retryAt'].includes(key) && value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) throw new AppError('PAT 时间无效');
      if (key === 'message' && (typeof value !== 'string' || value.length > 2000)) throw new AppError('PAT 消息无效');
    }
    if (entries.length) this.db.prepare(`UPDATE pats SET ${entries.map(([key]) => `"${key}"=?`).join(',')} WHERE id=?`)
      .run(...entries.map(([key, value]) => key === 'creationUncertain' ? Number(value) : key === 'message' ? this.redact(value)
        : ['expiresAt', 'resetAt', 'retryAt'].includes(key) && value !== null ? new Date(value).toISOString() : value), id);
    return this.list().find(row => row.id === id);
  }
  retry(id) {
    return this.store.transaction(() => {
      const row = this.row(id);
      const account = this.store.get(row.accountId);
      if (row.token || row.creationUncertain || !['manual', 'preparing'].includes(row.status) || !account.patDedicated
        || (account.reservedBy && account.reservedBy !== 'pat:' + id)) throw new AppError('此 PAT 记录不能安全重试', 409);
      this.db.prepare('UPDATE accounts SET reservedBy=? WHERE id=?').run('pat:' + id, row.accountId);
      return this.update(id, { status: 'preparing', message: '已确认旧浏览器退出，正在继续未提交的 PAT 任务' });
    });
  }
  redact(value) {
    let text = value.replace(secretPattern, '[REDACTED]');
    for (const row of this.db.prepare('SELECT token FROM pats WHERE token IS NOT NULL').all()) {
      const token = decrypt(row.token, this.store.key);
      if (token) text = text.split(token).join('[REDACTED]');
    }
    return text;
  }
  saveToken(id, token, expiresAt) {
    this.row(id);
    if (typeof token !== 'string' || !token.trim() || token.length > 16384) throw new AppError('PAT token 无效');
    if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) throw new AppError('PAT 过期时间无效');
    const ciphertext = encrypt(token, this.store.key);
    this.db.prepare("UPDATE pats SET token=?,expiresAt=?,status='verifying',creationUncertain=0 WHERE id=?").run(ciphertext, new Date(expiresAt).toISOString(), id);
    return this.list().find(row => row.id === id);
  }
  secret(id) {
    const row = this.row(id);
    return row.token ? decrypt(row.token, this.store.key) : null;
  }
  complete(id) {
    const row = this.row(id);
    this.db.prepare('UPDATE accounts SET reservedBy=NULL WHERE id=? AND reservedBy=?').run(row.accountId, 'pat:' + id);
    return this.summary(row.accountId);
  }
  markInvalid(id, message = 'PAT 已失效') { return this.update(id, { status: 'invalid', message, creationUncertain: false }); }
  disable(id) { return this.update(id, { status: 'disabled', message: '已停用本地 PAT；远端凭据未撤销' }); }
  releaseDedicated(id, { confirmed } = {}) {
    return this.releaseAccount(this.row(id).accountId, { confirmed });
  }
  releaseAccount(accountId, { confirmed } = {}) {
    if (confirmed !== true) throw new AppError('请确认释放 PAT 专用用途');
    return this.store.transaction(() => {
      this.expire();
      const account = this.store.get(accountId);
      if (account.reservedBy) throw new AppError('账号仍被占用，请先关闭浏览器并完成任务', 409);
      const hold = this.db.prepare('SELECT expiresAt FROM pat_credential_holds WHERE accountId=?').get(accountId);
      if (hold && hold.expiresAt > now()) throw new AppError('已删除的本地 PAT 在远端仍可能有效，需到期后释放专用用途',409);
      const rows = this.db.prepare('SELECT status,token,creationUncertain,expiresAt FROM pats WHERE accountId=?').all(accountId);
      if (rows.some(row => row.creationUncertain)) throw new AppError('PAT 创建结果未知，请先核对确认', 409);
      if (rows.some(row => row.token && row.status !== 'invalid' && (!row.expiresAt || row.expiresAt > now()))) throw new AppError('PAT 仍可能有效，请先确认失效或远端撤销', 409);
      this.db.prepare(`UPDATE pats SET status='disabled',message='已安全释放专用用途；未生成凭据，历史记录保留'
        WHERE accountId=? AND token IS NULL AND status IN ('manual','preparing')`).run(accountId);
      this.db.prepare('DELETE FROM pat_credential_holds WHERE accountId=?').run(accountId);
      this.db.prepare('UPDATE accounts SET patDedicated=0 WHERE id=?').run(accountId);
      this.store.event(account, 'pat-release', '用户确认后释放 PAT 专用用途；历史记录保留');
      return this.summary(accountId);
    });
  }
  remove(id, { confirmed } = {}) {
    if (confirmed !== true) throw new AppError('请确认删除 PAT 记录');
    this.store.transaction(() => {
      const row = this.row(id), account = this.store.get(row.accountId, true);
      if (account.reservedBy || row.creationUncertain || ['preparing','verifying'].includes(row.status)) throw new AppError('PAT 仍在任务中或结果未知，请先处理',409);
      if (row.status !== 'disabled' && account.patDedicated) throw new AppError('仅可删除已停用或已释放的 PAT 记录',409);
      if (row.token && row.status !== 'invalid' && (!row.expiresAt || row.expiresAt > now())) {
        // Remove the secret while retaining just the expiry needed to prevent unsafe reuse.
        this.db.prepare(`INSERT INTO pat_credential_holds(accountId,expiresAt) VALUES(?,?)
          ON CONFLICT(accountId) DO UPDATE SET expiresAt=MAX(expiresAt,excluded.expiresAt)`).run(row.accountId,row.expiresAt || '9999-12-31T23:59:59.999Z');
        this.db.prepare('UPDATE accounts SET patDedicated=1 WHERE id=?').run(row.accountId);
      }
      this.db.prepare('DELETE FROM pats WHERE id=?').run(id);
    });
    this.store.compact();
  }
  getCheckpoint(name) {
    const row = this.db.prepare('SELECT value FROM pat_checkpoints WHERE name=?').get(name);
    return row ? JSON.parse(row.value) : null;
  }
  setCheckpoint(name, value) {
    if (typeof name !== 'string' || !/^[\w:-]{1,100}$/.test(name)) throw new AppError('PAT checkpoint 名称无效');
    const json = JSON.stringify(value, (key, val) => {
      if (/(?:token|password|secret|totp|cookie|authorization|ciphertext)/i.test(key)) throw new AppError('checkpoint 不得保存凭据或 secret');
      if (typeof val === 'string' && this.redact(val) !== val) throw new AppError('checkpoint 不得保存 token 或凭据');
      return val;
    });
    if (json === undefined || json.length > 65536) throw new AppError('PAT checkpoint 数据无效');
    this.db.prepare('INSERT INTO pat_checkpoints(name,value) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value').run(name, json);
    return this.getCheckpoint(name);
  }
}
