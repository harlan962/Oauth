import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { encrypt, decrypt, totpCode } from "./crypto.js";
import { parseImport, validateAccount, normalizeSecret } from "./parser.js";
import { Organization } from "./organization.js";
import { accountTaskMetadata } from "./account-tasks.js";
import { retireActivity, updateRegistration } from "./activity-retirement.js";

const columns =
  "id,email,username,hasTotp,notes,publicStatus,checkMessage,checkedAt,selectedAt,purpose,createdAt,deletedAt,reservedBy,patDedicated";
export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export class Store {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
    const keyPath = join(directory, "master.key");
    const dbPath = join(directory, "accounts.sqlite");
    if (!existsSync(keyPath)) {
      if (existsSync(dbPath))
        throw new Error(
          "数据库存在但 master.key 丢失，请恢复原密钥，不能生成新密钥。",
        );
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
    }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error("master.key 文件无效");
    this.db = new DatabaseSync(dbPath);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE, password TEXT NOT NULL,
        totp TEXT NOT NULL, hasTotp INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '',
        risk TEXT NOT NULL DEFAULT 'unknown', publicStatus TEXT NOT NULL DEFAULT 'unchecked',
        checkMessage TEXT NOT NULL DEFAULT '', checkedAt TEXT, selectedAt TEXT, purpose TEXT NOT NULL DEFAULT '',
        createdAt TEXT NOT NULL, deletedAt TEXT
      );`);
    if (
      !this.db
        .prepare("PRAGMA table_info(accounts)")
        .all()
        .some((c) => c.name === "reservedBy")
    )
      this.db.exec("ALTER TABLE accounts ADD COLUMN reservedBy TEXT");
    if (!this.db.prepare("PRAGMA table_info(accounts)").all().some((c) => c.name === "patDedicated"))
      this.db.exec("ALTER TABLE accounts ADD COLUMN patDedicated INTEGER NOT NULL DEFAULT 0");
    this.db.exec(`CREATE TABLE IF NOT EXISTS check_confirmations (
      accountId TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      username TEXT NOT NULL, confirmedAt TEXT NOT NULL
    );
    INSERT OR IGNORE INTO check_confirmations(accountId,username,confirmedAt)
      SELECT id,username,checkedAt FROM accounts
      WHERE publicStatus IN ('reachable','missing') AND checkedAt IS NOT NULL
        AND julianday(checkedAt) IS NOT NULL;`);
    retireActivity(this);
    this.organization = new Organization(this);
  }
  close() {
    this.db.close();
  }
  transaction(fn) {
    // BEGIN IMMEDIATE cannot nest in SQLite; a nested call previously surfaced
    // as an opaque "cannot start a transaction within a transaction" error from
    // deep inside a caller. Detect it here so the misuse is reported at the
    // call site that caused it.
    if (this.inTransaction) throw new Error("store.transaction 不允许嵌套调用；请在最外层调用者处包一次事务");
    this.inTransaction = true;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // A rollback after a failed BEGIN (or an already-closed db) is a no-op;
        // the original error matters more than the cleanup failure.
      }
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }
  event(account, action, detail) {
    updateRegistration(this, account, action, detail);
  }
  list() {
    const outcomes = this.workbuddy?.accountResults();
    const rows = this.db
      .prepare(
        `SELECT ${columns} FROM accounts ORDER BY createdAt DESC,rowid DESC`,
      )
      .all();
    const metadata = accountTaskMetadata(this, rows);
    return this.organization.decorate(rows
      .map((row) => ({ ...row, ...metadata.get(row.id),
        ...(outcomes ? { workbuddyResult: outcomes.get(row.id) || null } : {}) })));
  }
  get(id, includeDeleted = false) {
    const row = this.db
      .prepare(
        `SELECT ${columns} FROM accounts WHERE id=? ${includeDeleted ? "" : "AND deletedAt IS NULL"}`,
      )
      .get(id);
    if (!row) throw new AppError("账号不存在或已移入回收站", 404);
    Object.assign(row, this.organization.metadata(id));
    Object.assign(row, accountTaskMetadata(this, [row]).get(row.id));
    return this.workbuddy
      ? {
          ...row,
          workbuddyResult: this.workbuddy.accountResults(id).get(id) || null,
        }
      : row;
  }
  compact() {
    // A failed compaction must not turn an already committed deletion into an error.
    try { this.db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)'); return true; }
    catch { return false; }
  }
  purge(ids, { confirmed, beforeCommit = () => {} } = {}) {
    if (confirmed !== true) throw new AppError('请确认永久删除，删除后无法恢复');
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string')) throw new AppError('请选择回收站账号');
    const changed = this.transaction(() => {
      const rows = [...new Set(ids)].map(id => this.get(id, true));
      const tables = new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
      const affectedJobs = new Set();
      for (const row of rows) {
        if (!row.deletedAt) throw new AppError('只能永久删除回收站内的账号', 409);
        this.assertUnreserved(row);
        if (tables.has('pat_credential_holds') && this.db.prepare('SELECT 1 FROM pat_credential_holds WHERE accountId=? AND expiresAt>?').get(row.id,new Date().toISOString())) throw new AppError('账号仍有可能有效的远端 PAT',409);
        if (tables.has('pats') && this.db.prepare(`SELECT 1 FROM pats WHERE accountId=? AND (creationUncertain=1 OR status IN ('preparing','verifying') OR (token IS NOT NULL AND status<>'invalid' AND (expiresAt IS NULL OR expiresAt>?)))`).get(row.id, new Date().toISOString())) throw new AppError('账号仍有待处理或可能有效的 PAT', 409);
        if (tables.has('workbuddy_items') && this.db.prepare(`SELECT 1 FROM workbuddy_items i JOIN workbuddy_jobs j ON j.id=i.jobId WHERE i.accountId=? AND j.running=1`).get(row.id)) throw new AppError('账号仍在 WorkBuddy 任务中',409);
      }
      for (const row of rows) {
        if (tables.has('workbuddy_items')) {
          for (const item of this.db.prepare('SELECT jobId FROM workbuddy_items WHERE accountId=?').all(row.id)) affectedJobs.add(item.jobId);
          this.db.prepare('DELETE FROM workbuddy_logs WHERE EXISTS (SELECT 1 FROM workbuddy_items i WHERE i.jobId=workbuddy_logs.jobId AND i.position=workbuddy_logs.position AND i.accountId=?)').run(row.id);
        }
        for (const table of ['pats','pat_credential_holds','workbuddy_items','workbuddy_mappings','workbuddy_restrictions']) {
          if (tables.has(table)) this.db.prepare(`DELETE FROM ${table} WHERE accountId=?`).run(row.id);
        }
        this.db.prepare('DELETE FROM accounts WHERE id=?').run(row.id);
      }
      if (tables.has('workbuddy_jobs')) {
        for (const jobId of affectedJobs) {
          if (this.db.prepare('SELECT 1 FROM workbuddy_items WHERE jobId=?').get(jobId)) continue;
          this.db.prepare('DELETE FROM workbuddy_logs WHERE jobId=?').run(jobId);
          this.db.prepare('DELETE FROM workbuddy_jobs WHERE id=? AND running=0').run(jobId);
        }
      }
      beforeCommit();
      return rows.length;
    });
    return { changed, compacted: this.compact() };
  }
  create(body) {
    return this.transaction(() => this.get(this.insertAccount(body)));
  }
  // Shared by manual creation and atomic API imports. The caller owns the transaction.
  insertAccount(body) {
    if (!this.inTransaction) throw new Error('insertAccount 需要事务');
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new AppError("账号资料无效");
    const email =
      typeof body.email === "string" ? body.email.trim() : body.email;
    const username =
      typeof body.username === "string" ? body.username.trim() : body.username;
    const password = body.password;
    const totp =
      typeof body.totp === "string"
        ? normalizeSecret(body.totp)
        : body.totp === undefined
          ? ""
          : null;
    const error = validateAccount({ email, username, password, totp });
    if (error) throw new AppError(error);
    const notes = body.notes ?? "";
    if (typeof notes !== "string" || notes.length > 2000)
      throw new AppError("备注不得超过 2000 字");
      this.organization.validate(body);
      if (
        this.db
          .prepare("SELECT id FROM accounts WHERE email=? OR username=?")
          .get(email, username)
      )
        throw new AppError("邮箱或用户名已存在（含回收站）", 409);
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO accounts(id,email,username,password,totp,hasTotp,notes,createdAt) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          email,
          username,
          encrypt(password, this.key),
          encrypt(totp, this.key),
          totp ? 1 : 0,
          notes,
          new Date().toISOString(),
        );
      this.organization.apply(id, body);
      this.event({ id, username }, "create", "手动新增账号");
      return id;
  }
  preview(text) {
    const { records, errors } = parseImport(text);
    const emails = new Set(),
      usernames = new Set();
    const rows = records.map((record) => {
      const email = record.email.toLowerCase(),
        username = record.username.toLowerCase();
      const duplicate =
        emails.has(email) ||
        usernames.has(username) ||
        !!this.db
          .prepare("SELECT id FROM accounts WHERE email=? OR username=?")
          .get(email, username);
      if (!duplicate) {
        emails.add(email);
        usernames.add(username);
      }
      return { ...record, duplicate };
    });
    return { records: rows, errors };
  }
  import(text, organization = {}) {
    return this.transaction(() => {
      this.organization.validate(organization);
      const { records, errors } = this.preview(text);
      let imported = 0;
      for (const record of records) {
        if (record.duplicate) continue;
        const id = randomUUID();
        this.db
          .prepare(
            "INSERT INTO accounts(id,email,username,password,totp,hasTotp,createdAt) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            id,
            record.email,
            record.username,
            encrypt(record.password, this.key),
            encrypt(record.totp, this.key),
            record.totp ? 1 : 0,
            new Date().toISOString(),
          );
        this.organization.apply(id, organization);
        this.event({ id, username: record.username }, "import", "导入账号");
        imported++;
      }
      return {
        imported,
        duplicates: records.filter((r) => r.duplicate).length,
        errors,
      };
    });
  }
  update(id, body) {
    if (Object.hasOwn(body, "risk"))
      throw new AppError("人工风控标记已移除，请使用自动活性检查");
    const row = this.get(id);
    if (row.patDedicated) {
      if (Object.keys(body).some((key) => key !== "notes"))
        throw new AppError("PAT 专用账号仅可修改备注，请先处理专用用途", 409);
      if (typeof body.notes !== "string" || body.notes.length > 2000)
        throw new AppError("备注不得超过 2000 字");
      this.db.prepare("UPDATE accounts SET notes=? WHERE id=?").run(body.notes, id);
      this.event(row, "edit", "更新 PAT 专用账号备注");
      return this.get(id);
    }
    this.assertUnreserved(row);
    const current = this.db
      .prepare("SELECT password,totp FROM accounts WHERE id=?")
      .get(id);
    const email =
      typeof body.email === "string" ? body.email.trim() : row.email;
    const username =
      typeof body.username === "string" ? body.username.trim() : row.username;
    const password =
      body.password === undefined || body.password === ""
        ? decrypt(current.password, this.key)
        : body.password;
    const totp =
      body.totp === undefined
        ? decrypt(current.totp, this.key)
        : typeof body.totp === "string"
          ? normalizeSecret(body.totp)
          : null;
    const error = validateAccount({ email, username, password, totp });
    if (error) throw new AppError(error);
    const notes = body.notes ?? row.notes;
    if (typeof notes !== "string" || notes.length > 2000)
      throw new AppError("备注不得超过 2000 字");
    if (
      this.db
        .prepare(
          "SELECT id FROM accounts WHERE (email=? OR username=?) AND id<>?",
        )
        .get(email, username, id)
    )
      throw new AppError("邮箱或用户名已存在（含回收站）", 409);
    return this.transaction(() => {
      const renamed = username.toLowerCase() !== row.username.toLowerCase();
      if (renamed) this.db.prepare('DELETE FROM check_confirmations WHERE accountId=?').run(id);
      this.db
        .prepare(
          "UPDATE accounts SET email=?,username=?,password=?,totp=?,hasTotp=?,notes=?,publicStatus=?,checkMessage=?,checkedAt=? WHERE id=?",
        )
        .run(
          email,
          username,
          encrypt(password, this.key),
          encrypt(totp, this.key),
          totp ? 1 : 0,
          notes,
          renamed ? "unchecked" : row.publicStatus,
          renamed ? "" : row.checkMessage,
          renamed ? null : row.checkedAt,
          id,
        );
      this.event({ id, username }, "edit", "更新账号资料");
      return this.get(id);
    });
  }
  secrets(id) {
    this.get(id);
    const row = this.db
      .prepare("SELECT password,totp FROM accounts WHERE id=?")
      .get(id);
    const totp = decrypt(row.totp, this.key);
    return {
      password: decrypt(row.password, this.key),
      totp,
      otp: totp ? totpCode(totp) : null,
    };
  }
  exportAccounts(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id || id.length > 128))
      throw new AppError('请选择要导出的账号');
    return this.transaction(() => {
      const read = this.db.prepare('SELECT email,username,password,totp FROM accounts WHERE id=? AND deletedAt IS NULL');
      const rows = [...new Set(ids)].map(id => read.get(id));
      if (rows.some(row => !row)) throw new AppError('部分账号已删除或移入回收站，请关闭弹窗并刷新列表后重试', 409);
      const lines = rows.map(row => {
        const fields = [row.email, decrypt(row.password, this.key), row.username, decrypt(row.totp, this.key)];
        if (fields.some(value => /\r|\n|----/.test(value)))
          throw new AppError(`账号 ${row.username} 的字段含换行或 ----，无法使用 TXT 分隔格式导出，请取消勾选该账号后重试`);
        return fields.join('----');
      });
      const stamp = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date()).replace(/[-:]/g,'').replace(' ','-');
      return {filename:`accounts-${stamp}.txt`,count:rows.length,text:'\uFEFF'+lines.join('\r\n')+'\r\n',
        // Not part of the response body; the caller turns it into an audit row.
        labels:rows.map(row=>row.email||row.username)};
    });
  }
  setCheck(id, expectedUsername, result, checkedAt = new Date().toISOString()) {
    return this.transaction(() => {
      // Re-read inside the transaction: the username guard must be evaluated
      // against the same snapshot that the UPDATE commits to, otherwise a
      // rename+rename-back between read and write could accept a stale result.
      const row = this.db
        .prepare(
          `SELECT ${columns} FROM accounts WHERE id=? AND deletedAt IS NULL`,
        )
        .get(id);
      if (!row || row.username.toLowerCase() !== expectedUsername.toLowerCase())
        return false;
      this.db
        .prepare(
          "UPDATE accounts SET publicStatus=?,checkMessage=?,checkedAt=? WHERE id=?",
        )
        .run(result.status, result.message, checkedAt, id);
      if (['reachable', 'missing'].includes(result.status)) {
        this.db.prepare(`INSERT INTO check_confirmations(accountId,username,confirmedAt) VALUES(?,?,?)
          ON CONFLICT(accountId) DO UPDATE SET username=excluded.username,confirmedAt=excluded.confirmedAt`)
          .run(id, row.username, checkedAt);
      }
      this.event(row, "check", result.message);
      return true;
    });
  }
  // The single definition of a selectable candidate account. All three
  // consumers (manual/auto selection, PAT reservation and WorkBuddy candidates)
  // must agree on the same conditions; this query is exercised by their tests.
  candidateRows(order = "checkedAt DESC,createdAt ASC,rowid ASC", limit = null) {
    const cutoff = new Date(Date.now() - 86400000).toISOString();
    const mapped = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='workbuddy_mappings'",
      )
      .get();
    return this.db
      .prepare(
        `SELECT ${columns} FROM accounts a WHERE patDedicated=0 AND deletedAt IS NULL AND hasTotp=1
        AND selectedAt IS NULL AND reservedBy IS NULL AND publicStatus='reachable' AND checkedAt>=?
        ${mapped ? "AND NOT EXISTS (SELECT 1 FROM workbuddy_mappings m WHERE m.accountId=a.id)" : ""}
        ORDER BY ${order} ${limit ? `LIMIT ${Number(limit)}` : ""}`,
      )
      .all(cutoff);
  }
  candidateRow(order) {
    return this.candidateRows(order, 1)[0];
  }
  select(id, purpose = "") {
    if (typeof purpose !== "string" || purpose.length > 200)
      throw new AppError("用途不得超过 200 字");
    return this.transaction(() => {
      const cutoff = new Date(Date.now() - 86400000).toISOString();
      const row = id ? this.get(id) : this.candidateRow();
      if (!row) throw new AppError("没有可选账号。请先保存两步验证 TOTP 密钥并检查账号公开状态。", 409);
      this.assertUnreserved(row);
      if (row.selectedAt)
        throw new AppError("这个账号已选用，请勿重复选择", 409);
      if (!row.hasTotp)
        throw new AppError("请先保存两步验证 TOTP 密钥，才能选用此账号", 409);
      if (
        row.publicStatus !== "reachable" ||
        !row.checkedAt ||
        row.checkedAt < cutoff
      )
        throw new AppError("需在 24 小时内检查为公开可访问，才能选用", 409);
      this.db
        .prepare("UPDATE accounts SET selectedAt=?,purpose=? WHERE id=?")
        .run(new Date().toISOString(), purpose.trim(), row.id);
      this.event(row, "select", purpose.trim() || "选用账号");
      return this.get(row.id);
    });
  }
  release(id) {
    const row = this.get(id);
    this.assertUnreserved(row);
    this.transaction(() => {
      this.db
        .prepare("UPDATE accounts SET selectedAt=NULL,purpose='' WHERE id=?")
        .run(id);
      this.event(row, "release", "释放选用标记");
    });
  }
  trash(id, restore = false) {
    return this.batchTrash([id], restore);
  }
  assertUnreserved(row) {
    if (row.patDedicated)
      throw new AppError("PAT 专用账号不可选用，请先处理专用用途", 409);
    if (row.reservedBy)
      throw new AppError("账号被 WorkBuddy 任务占用，请先处理该任务", 409);
  }
  batchTrash(ids, restore = false) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.some((id) => typeof id !== "string")
    )
      throw new AppError("请选择要操作的账号");
    return this.transaction(() => {
      const rows = [...new Set(ids)].map((id) => this.get(id, true));
      rows.forEach((row) => this.assertUnreserved(row));
      let changed = 0;
      for (const row of rows) {
        if (restore ? !row.deletedAt : row.deletedAt) continue;
        this.db
          .prepare("UPDATE accounts SET deletedAt=? WHERE id=?")
          .run(restore ? null : new Date().toISOString(), row.id);
        this.event(
          row,
          restore ? "restore" : "trash",
          restore ? "恢复账号" : "移入回收站",
        );
        changed++;
      }
      return { changed };
    });
  }
}
