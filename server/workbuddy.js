import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { encrypt, decrypt } from "./crypto.js";
import { AppError } from "./store.js";
import { OAuthBrowser, trustedOrigin } from "./oauth-browser.js";
import { structuralReasons } from "./oauth-adapters.js";

const now = () => new Date().toISOString();
const summaryColumns =
  "id,targetId,targetName,baseUrl,total,status,running,createdAt,finishedAt,message";
const publicAccount = ({ id, username, email, hasTotp }) => ({
  id,
  username,
  email,
  hasTotp: !!hasTotp,
});

export class WorkBuddyService {
  constructor(store, integrations, { oauthBrowser = new OAuthBrowser(), workbuddyRetry = {} } = {}) {
    this.store = store;
    this.db = store.db;
    this.integrations = integrations;
    this.browser = oauthBrowser;
    this.retry = { attempts: 4, accountTimeoutMs: 180000, retryDelayMs: 3000, circuitThreshold: 2, ...workbuddyRetry };
    this.active = null;
    this.stopping = false;
    store.workbuddy = this;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workbuddy_jobs (
        id TEXT PRIMARY KEY, requestId TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
        targetId TEXT NOT NULL, targetName TEXT NOT NULL, baseUrl TEXT NOT NULL,
        total INTEGER NOT NULL, status TEXT NOT NULL, running INTEGER NOT NULL,
        createdAt TEXT NOT NULL, finishedAt TEXT, message TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS workbuddy_items (
        jobId TEXT NOT NULL, position INTEGER NOT NULL, accountId TEXT NOT NULL,
        username TEXT NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL,
        message TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, finishedAt TEXT,
        uid TEXT, session TEXT, reserved INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(jobId,position)
      );
      CREATE TABLE IF NOT EXISTS workbuddy_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, jobId TEXT NOT NULL,
        createdAt TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, position INTEGER
      );
      CREATE TABLE IF NOT EXISTS workbuddy_mappings (
        targetId TEXT NOT NULL, uid TEXT NOT NULL, accountId TEXT NOT NULL,
        jobId TEXT NOT NULL, createdAt TEXT NOT NULL,
        PRIMARY KEY(targetId,uid), UNIQUE(targetId,accountId)
      );
      CREATE TABLE IF NOT EXISTS workbuddy_restrictions (
        accountId TEXT PRIMARY KEY, jobId TEXT NOT NULL,
        message TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      INSERT OR IGNORE INTO workbuddy_restrictions(accountId,jobId,message,createdAt)
        SELECT accountId,jobId,'WorkBuddy 访问受限；后续 WorkBuddy 自动选择已排除',COALESCE(finishedAt,createdAt)
        FROM workbuddy_items WHERE status='restricted';
      INSERT OR IGNORE INTO workbuddy_restrictions(accountId,jobId,message,createdAt)
        SELECT i.accountId,i.jobId,'WorkBuddy 访问受限；后续 WorkBuddy 自动选择已排除',l.createdAt
        FROM workbuddy_logs l JOIN workbuddy_items i ON i.jobId=l.jobId AND i.position=l.position
        WHERE l.level='warn' AND l.message='WorkBuddy 访问受限，整个队列暂停；请在当前浏览器处理后继续';
    `);
    // A process restart loses the isolated browser and upstream in-memory sessions.
    // Never replay a potentially mutating request.
    this.store.transaction(() => {
      const interrupted = this.db
        .prepare("SELECT id FROM workbuddy_jobs WHERE running=1")
        .all();
      for (const { id } of interrupted) {
        this.skipQueued(id, "本地服务中断，尚未开始的账号已释放");
        this.db
          .prepare(
            "UPDATE workbuddy_items SET status='unknown',message='本地服务中断，远端结果未知；未成功账号自动释放',finishedAt=? WHERE jobId=? AND status NOT IN ('success','failed','unknown','skipped','restricted')",
          )
          .run(now(), id);
        this.db
          .prepare(
            "UPDATE workbuddy_jobs SET status='stopped',running=0,finishedAt=?,message='服务中断，未自动恢复；未成功账号自动释放' WHERE id=?",
          )
          .run(now(), id);
        this.log(id, "warn", "服务中断，未自动重试 start 或 poll");
      }
      // Also reconcile old finished jobs left reserved by earlier versions.
      for (const { id } of this.db
        .prepare("SELECT id FROM workbuddy_jobs WHERE running=0")
        .all())
        this.releaseUnused(id);
    });
  }
  accountResults(id) {
    const rows = this.db
      .prepare(
        `SELECT accountId,status,message,finishedAt FROM workbuddy_items
      WHERE rowid IN (SELECT MAX(rowid) FROM workbuddy_items WHERE status NOT IN ('queued','skipped') ${id ? "AND accountId=?" : ""} GROUP BY accountId)`,
      )
      .all(...(id ? [id] : []));
    const results = new Map(rows.map(({ accountId, ...result }) => [accountId, result]));
    for (const row of this.db.prepare(`SELECT accountId,message,createdAt FROM workbuddy_restrictions ${id ? "WHERE accountId=?" : ""}`).all(...(id ? [id] : []))) {
      results.set(row.accountId, { status: "restricted", message: row.message, finishedAt: row.createdAt });
    }
    return results;
  }
  releaseUnused(id, position = null) {
    const items = this.db
      .prepare(
        "SELECT accountId,username FROM workbuddy_items WHERE jobId=? AND reserved=1 AND status<>'success' AND (? IS NULL OR position=?)",
      )
      .all(id, position, position);
    for (const item of items) {
      const result = this.db
        .prepare(
          "UPDATE accounts SET reservedBy=NULL WHERE id=? AND reservedBy=? AND selectedAt IS NULL",
        )
        .run(item.accountId, id);
      if (result.changes)
        this.store.event(
          { id: item.accountId, username: item.username },
          "workbuddy-release",
          "当前账号处理结束，未成功账号自动释放；结果记录保留",
        );
    }
    this.db
      .prepare(
        "UPDATE workbuddy_items SET reserved=0,message=replace(message,'保留占用','占用已解除') || '；已自动释放占用' WHERE jobId=? AND reserved=1 AND status<>'success' AND NOT EXISTS (SELECT 1 FROM accounts WHERE accounts.id=workbuddy_items.accountId AND accounts.reservedBy=?) AND (? IS NULL OR position=?)",
      )
      .run(id, id, position, position);
  }
  candidates() {
    // Shares the store's candidate contract so selection, PAT reservation and
    // this list can never disagree about who is eligible.
    const restricted = new Set(this.db.prepare("SELECT accountId FROM workbuddy_restrictions").all().map(row => row.accountId));
    const accounts = this.store
      .candidateRows()
      .filter(account => !restricted.has(account.id))
      .map(publicAccount);
    return {
      accounts,
      reserved: this.db
        .prepare(
          "SELECT count(*) AS n FROM accounts WHERE reservedBy IS NOT NULL",
        )
        .get().n,
    };
  }
  validate(body) {
    if (!body || body.realm !== "global")
      throw new AppError("仅支持国际版 Global");
    if (!Number.isInteger(body.count) || body.count < 1 || body.count > 100)
      throw new AppError("数量须为 1–100 的整数");
    if (typeof body.targetId !== "string") throw new AppError("目标无效");
    const target = this.integrations.target(body.targetId);
    if (body.targetRevision !== target.revision)
      throw new AppError("项目配置已变更，请重新预览确认", 409);
    return target;
  }
  preview(body) {
    const target = this.validate(body);
    const accounts = this.candidates().accounts.slice(0, body.count);
    if (accounts.length !== body.count)
      throw new AppError("可用账号不足，请重新检查候选列表", 409);
    return {
      target: {
        id: target.id,
        name: target.name,
        baseUrl: target.baseUrl,
        revision: target.revision,
      },
      accounts,
      count: accounts.length,
    };
  }
  start(body) {
    if (
      !body ||
      typeof body.requestId !== "string" ||
      !/^[\w-]{8,100}$/.test(body.requestId)
    )
      throw new AppError("requestId 无效");
    if (
      !Array.isArray(body.accountIds) ||
      body.accountIds.length !== body.count ||
      new Set(body.accountIds).size !== body.count ||
      body.accountIds.some((x) => typeof x !== "string")
    )
      throw new AppError("请确认预览账号列表");
    const fingerprint = JSON.stringify([
      body.targetId,
      body.targetRevision,
      body.realm,
      body.count,
      body.accountIds,
    ]);
    const old = this.db
      .prepare("SELECT id,fingerprint FROM workbuddy_jobs WHERE requestId=?")
      .get(body.requestId);
    if (old) {
      if (old.fingerprint !== fingerprint)
        throw new AppError("重复提交参数不一致", 409);
      return this.job(old.id);
    }
    if (
      this.stopping ||
      this.active ||
      this.store.patService?.active ||
      this.integrations.active ||
      this.integrations.stopping
    )
      throw new AppError("已有授权任务正在运行，请先完成或停止", 409);
    const target = this.validate(body),
      id = randomUUID();
    this.browser.assertAvailable?.();
    this.store.transaction(() => {
      const candidates = new Map(
        this.candidates().accounts.map((a) => [a.id, a]),
      );
      const accounts = body.accountIds.map((id) => candidates.get(id));
      if (accounts.some((a) => !a))
        throw new AppError("候选账号已发生变化，请重新预览确认", 409);
      this.db
        .prepare(
          `INSERT INTO workbuddy_jobs(id,requestId,fingerprint,targetId,targetName,baseUrl,total,status,running,createdAt) VALUES(?,?,?,?,?,?,?,'running',1,?)`,
        )
        .run(
          id,
          body.requestId,
          fingerprint,
          target.id,
          target.name,
          target.baseUrl,
          body.count,
          now(),
        );
      accounts.forEach((a, i) => {
        this.db
          .prepare("UPDATE accounts SET reservedBy=? WHERE id=?")
          .run(id, a.id);
        this.db
          .prepare(
            "INSERT INTO workbuddy_items(jobId,position,accountId,username,email,status,createdAt) VALUES(?,?,?,?,?,'queued',?)",
          )
          .run(id, i + 1, a.id, a.username, a.email, now());
        this.store.event(a, "workbuddy-reserve", "WorkBuddy 授权任务临时占用");
      });
      this.log(
        id,
        "info",
        "国际版队列已开始；poll 可能在远端落盘、入池、注册激活及领取 trial",
      );
    });
    const task = {
      id,
      targetId: target.id,
      target,
      cancelled: false,
      session: null,
      position: 1,
      promise: null,
      abort: new AbortController(),
      states: new Set(),
      urls: new Set(),
      structural: null,
    };
    this.active = task;
    task.promise = this.run(task);
    return this.job(id);
  }
  jobs() {
    return this.db
      .prepare(
        `SELECT ${summaryColumns} FROM workbuddy_jobs ORDER BY createdAt DESC,rowid DESC LIMIT 30`,
      )
      .all()
      .map((r) => ({ ...r, running: !!r.running }));
  }
  job(id) {
    const row = this.db
      .prepare(`SELECT ${summaryColumns} FROM workbuddy_jobs WHERE id=?`)
      .get(id);
    if (!row) throw new AppError("WorkBuddy 任务不存在", 404);
    const items = this.db
      .prepare(
        "SELECT position,accountId,username,email,status,message,createdAt,finishedAt,uid,reserved FROM workbuddy_items WHERE jobId=? ORDER BY position",
      )
      .all(id)
      .map((r) => ({ ...r, reserved: !!r.reserved }));
    return {
      ...row,
      running: !!row.running,
      items,
      logs: this.db
        .prepare(
          "SELECT id,createdAt,level,message,position FROM workbuddy_logs WHERE jobId=? ORDER BY id",
        )
        .all(id),
    };
  }
  log(id, level, message, position = null) {
    this.db
      .prepare(
        "INSERT INTO workbuddy_logs(jobId,createdAt,level,message,position) VALUES(?,?,?,?,?)",
      )
      .run(id, now(), level, message, position);
  }
  state(task, status, message) {
    this.db
      .prepare(
        "UPDATE workbuddy_items SET status=?,message=?,finishedAt=? WHERE jobId=? AND position=?",
      )
      .run(
        status,
        message,
        ["success", "failed", "unknown", "skipped", "restricted"].includes(status)
          ? now()
          : null,
        task.id,
        task.position,
      );
    const level =
      status === "success"
        ? "success"
        : status === "failed"
          ? "error"
          : ["manual", "restricted", "unknown"].includes(status)
            ? "warn"
            : "info";
    this.log(task.id, level, message, task.position);
  }
  // Upstream page changes do not raise errors: they surface as the same structural
  // reason for every account. Counting consecutive identical reasons lets the queue
  // stop early instead of spending attempts (and minutes) on each remaining account.
  noteStructural(task, reason) {
    if (!reason || !structuralReasons.has(reason)) {
      task.structural = null;
      return;
    }
    task.structural = task.structural?.reason === reason
      ? { reason, count: task.structural.count + 1 }
      : { reason, count: 1 };
  }
  circuitBroken(task) {
    return !!task.structural && task.structural.count >= this.retry.circuitThreshold;
  }
  skipQueued(id, message) {
    this.db
      .prepare(
        "UPDATE accounts SET reservedBy=NULL WHERE reservedBy=? AND id IN (SELECT accountId FROM workbuddy_items WHERE jobId=? AND status='queued')",
      )
      .run(id, id);
    this.db
      .prepare(
        "UPDATE workbuddy_items SET status='skipped',reserved=0,message=?,finishedAt=? WHERE jobId=? AND status='queued'",
      )
      .run(message, now(), id);
  }
  async finish(task, status, message) {
    // Close the old browser before making any account selectable again.
    await this.closeSession(task);
    this.store.transaction(() => {
      this.skipQueued(task.id, "任务停止，未开始的账号已释放");
      this.db
        .prepare(
          "UPDATE workbuddy_items SET status='unknown',message='任务停止，未确认成功；已自动释放占用，远端结果仍需核对',finishedAt=? WHERE jobId=? AND status IN ('linking','browser','manual','polling')",
        )
        .run(now(), task.id);
      this.releaseUnused(task.id);
      this.db
        .prepare(
          "UPDATE workbuddy_jobs SET status=?,running=0,finishedAt=?,message=? WHERE id=?",
        )
        .run(status, now(), message, task.id);
      this.log(task.id, "info", message);
    });
    if (this.active === task) this.active = null;
  }
  async bounded(task, operation) {
    const remaining = task.deadline - Date.now();
    if (task.cancelled) throw new Error("cancelled");
    if (remaining <= 0) throw new Error("account_timeout");
    let timer, onAbort;
    const stopped = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("account_timeout"));
        task.accountAbort.abort();
      }, remaining);
      onAbort = () => reject(new Error("cancelled"));
      task.abort.signal.addEventListener("abort", onAbort, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(operation), stopped]); }
    finally {
      clearTimeout(timer);
      task.abort.signal.removeEventListener("abort", onAbort);
    }
  }
  async closeSession(task) {
    const session = task.session;
    if (!session) return;
    // OAuthSession.close marks the session closed synchronously, cancelling any late actions.
    let timer;
    try {
      await Promise.race([
        session.close(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("close_timeout")), 10000); }),
      ]);
    } catch {
      this.log(task.id, "warn", "浏览器清理异常，已终止当前自动操作并继续队列", task.position);
    } finally { clearTimeout(timer); task.session = null; }
  }
  async authorize(task, item) {
    const reasons = {
      network: "授权页面网络超时或加载失败", proxy: "授权浏览器代理连接失败",
      provider_missing: "未识别到 GitHub 登录入口", provider_loading: "授权页面仍在加载",
      provider_disabled: "GitHub 登录入口尚不可用", provider_ambiguous: "无法唯一确认 GitHub 登录入口",
      agreement: "尚未确认必需协议", provider_navigation: "GitHub 页面尚未打开",
      oauth_context: "授权上下文未确认", oauth_changed: "授权上下文或身份已变化",
      github_login: "GitHub 登录尚未完成", github_challenge: "GitHub 验证尚未完成",
      github_email_device_verification: "GitHub 要求邮箱设备验证，已保存的 TOTP 不能替代邮箱验证码",
      github_authorize_not_ready: "GitHub 授权按钮暂不可点击，正在等待按钮可用",
      github_authorize_pending: "GitHub 授权点击结果尚未确认，正在等待授权回调",
      github_authorize_unrecognized: "尚未识别到可验证的 GitHub 授权按钮，正在重新检查页面",
      github_identity_pending: "GitHub 授权页身份尚未确认，正在等待页面加载",
      github_identity_missing: "已收到 WorkBuddy 回调，但缺少 GitHub 身份证据，无法确认账号关联",
      callback_pending: "身份或授权回调尚未确认", workbuddy_confirmation: "WorkBuddy 登录确认尚未完成",
      browser_open: "浏览器启动未完成",
    };
    let evidence;
    for (let attempt = 1; attempt <= this.retry.attempts; attempt++) {
      if (attempt > 1) {
        this.state(task, "browser", `${reasons[evidence?.reason] || "页面验证尚未完成"}；自动重试 ${attempt}/${this.retry.attempts}，超时后继续下一个账号`);
        await this.bounded(task, () => delay(this.retry.retryDelayMs * (attempt - 1), undefined, { signal: task.accountAbort.signal }));
        if (["network", "proxy"].includes(evidence?.reason) && task.session)
          await this.bounded(task, () => task.session.retryNavigation?.());
      }
      if (!task.session) {
        try {
          let expired = false;
          try {
            task.session = await this.bounded(task, async () => {
              const session = await this.browser.open({ ...task.browserArgs, signal: task.accountAbort.signal });
              if (expired || task.cancelled || Date.now() >= task.deadline) {
                await session.close();
                throw new Error("account_timeout");
              }
              return session;
            });
          } finally { expired = true; }
        } catch (error) {
          if (task.cancelled || Date.now() >= task.deadline) throw error;
          evidence = { reason: "browser_open" };
          continue;
        }
      }
      evidence = await this.bounded(task, () => task.session.step());
      if (!task.cancelled && evidence?.status !== "verified" && task.session.diagnostic) {
        try { this.log(task.id, "info", `浏览器诊断 ${attempt}/${this.retry.attempts}：${task.session.diagnostic()}`, task.position); }
        catch { /* Diagnostics must not prevent automatic cleanup or queue progress. */ }
      }
      if (evidence?.status === "restricted") return evidence;
      if (evidence?.status === "manual" && evidence.reason === "github_email_device_verification") {
        this.noteStructural(task, null);
        this.state(task, "unknown", "当前账号需要邮箱验证码，已自动跳过并继续下一个账号；未重复提交登录或发送验证码");
        return null;
      }
      if (evidence?.status === "verified" && evidence.callbackVerified === true &&
          typeof evidence.githubUsername === "string" && evidence.githubUsername.toLowerCase() === item.username.toLowerCase()) return evidence;
      // Identity mismatches cannot be repaired by retrying clicks in the same session.
      if (evidence?.reason === "oauth_changed" || evidence?.status === "verified") break;
    }
    const message = `${reasons[evidence?.reason] || "身份或授权回调未确认"}；最多 ${this.retry.attempts} 次尝试后未完成，自动结束当前账号并继续后续任务`;
    this.noteStructural(task, evidence?.reason);
    this.state(task, "unknown", message);
    return null;
  }
  async run(task) {
    try {
      while (task.position <= this.job(task.id).total && !task.cancelled) {
        const item = this.db.prepare("SELECT * FROM workbuddy_items WHERE jobId=? AND position=?").get(task.id, task.position);
        task.deadline = Date.now() + this.retry.accountTimeoutMs;
        task.accountAbort = new AbortController();
        task.browserArgs = null;
        try { await this.runItem(task, item); }
        catch (error) {
          if (!task.cancelled) this.state(task, "unknown",
            error.message === "account_timeout"
              ? `单账号达到 ${Math.round(this.retry.accountTimeoutMs / 1000)} 秒时限，已自动结束并继续后续账号`
              : error.message === "remote_pending"
                ? "远端尚未完成，结果记为未知；自动继续后续账号"
                : "远端或浏览器结果无法确认，已记录并继续后续账号；未重复提交远端请求");
        } finally {
          await this.closeSession(task);
          if (!task.cancelled) {
            this.store.transaction(() => {
              this.releaseUnused(task.id, task.position);
              this.db.prepare("UPDATE workbuddy_items SET session=NULL WHERE jobId=? AND position=?").run(task.id, task.position);
            });
          }
        }
        const outcome = this.db.prepare("SELECT status FROM workbuddy_items WHERE jobId=? AND position=?").get(task.id, task.position)?.status;
        if (outcome === "success") task.structural = null;
        if (!task.cancelled && this.circuitBroken(task)) {
          const { reason, count } = task.structural;
          this.log(task.id, "warn", `连续 ${count} 个账号卡在同一环节（${reason}），已停止后续账号，避免继续消耗尝试次数`, task.position);
          await this.finish(task, "stopped",
            `已停止：连续 ${count} 个账号卡在同一环节（${reason}），疑似上游授权页面改版。请人工核对授权页面，必要时更新 server/oauth-adapters.js 后重新提交`);
          return;
        }
        if (!task.cancelled) task.position++;
      }
      await this.finish(task, task.cancelled ? "stopped" : "completed", task.cancelled
        ? "已停止；未成功账号已自动释放，成功账号保持已使用"
        : "队列执行结束；未完成账号已记录并自动释放");
    } catch {
      await this.finish(task, "stopped", "本地任务异常，未成功账号已释放，结果记录保留");
    }
  }
  async runItem(task, item) {
    if (item.status === "queued") {
      this.state(task, "linking", "正在创建国际版授权会话");
      const data = await this.bounded(task, () => this.integrations.request(
        task.target, "login/start", { realm: "global" },
      ));
      if (task.cancelled) return;
      if (
        data?.ok !== true ||
        data.realm !== "global" ||
        typeof data.state !== "string" ||
        !data.state ||
        data.state.length > 8192 ||
        typeof data.url !== "string" ||
        data.url.length > 16384 ||
        trustedOrigin(data.url) !== "workbuddy"
      )
        throw new Error("invalid start");
      if (task.states.has(data.state) || task.urls.has(data.url))
        throw new Error("duplicate device session");
      task.states.add(data.state);
      task.urls.add(data.url);
      // Session/state stay encrypted and are never included in public job responses.
      this.db
        .prepare(
          "UPDATE workbuddy_items SET session=? WHERE jobId=? AND position=?",
        )
        .run(
          encrypt(
            JSON.stringify({ state: data.state, url: data.url }),
            this.store.key,
          ),
          task.id,
          task.position,
        );
      this.state(
        task,
        "browser",
        "已打开独立浏览器：先检查并勾选必需协议，再登录 GitHub、核验身份和授权回调",
      );
      task.browserArgs = {
        proxy: this.integrations.browserProxy(task.target),
        url: data.url,
        account: { id: item.accountId, username: item.username, email: item.email },
        getSecrets: () => this.store.secrets(item.accountId),
      };
    }
    if (task.cancelled) return;
    const evidence = await this.authorize(task, item);
    if (task.cancelled || !evidence) return;
    if (evidence?.status === "restricted") {
      const message = evidence.reason === "account_security"
        ? "WorkBuddy 提示账号因安全策略限制无法访问；已标记并排除自动选择，需联系官方客服核实"
        : "WorkBuddy 访问受限；已记录并排除后续 WorkBuddy 自动选择，具体原因待核实";
      this.store.transaction(() => {
        this.db.prepare("INSERT OR REPLACE INTO workbuddy_restrictions(accountId,jobId,message,createdAt) VALUES(?,?,?,?)").run(item.accountId, task.id, message, now());
        this.state(task, "restricted", message);
      });
      return;
    }
    this.state(
      task,
      "polling",
      "GitHub 身份及回调已核验；正在确认远端入池结果",
    );
    const data = await this.bounded(task, () => this.integrations.request(
      task.target,
      "login/poll?state=" +
        encodeURIComponent(
          JSON.parse(
            decrypt(
              this.db
                .prepare(
                  "SELECT session FROM workbuddy_items WHERE jobId=? AND position=?",
                )
                .get(task.id, task.position).session,
              this.store.key,
            ),
          ).state,
        ),
    ));
    if (task.cancelled) return;
    if (data?.done === false)
      throw new Error("remote_pending");
    if (
      data?.done !== true ||
      data.realm !== "global" ||
      typeof data.uid !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(data.uid)
    )
      throw new Error("invalid poll");
    this.store.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO workbuddy_mappings(targetId,uid,accountId,jobId,createdAt) VALUES(?,?,?,?,?)",
        )
        .run(task.targetId, data.uid, item.accountId, task.id, now());
      const result = this.db
        .prepare(
          "UPDATE accounts SET selectedAt=?,purpose=?,reservedBy=NULL WHERE id=? AND reservedBy=?",
        )
        .run(
          now(),
          "WorkBuddy Global: " + task.target.name,
          item.accountId,
          task.id,
        );
      if (result.changes !== 1) throw new Error("reservation lost");
      this.db
        .prepare(
          "UPDATE workbuddy_items SET status='success',uid=?,reserved=0,message='已确认国际版 UID 并保存映射，账号已标记使用',finishedAt=?,session=NULL WHERE jobId=? AND position=?",
        )
        .run(data.uid, now(), task.id, task.position);
      this.store.event(
        { id: item.accountId, username: item.username },
        "workbuddy-success",
        "国际版授权入池成功，已保存 UID 映射",
      );
      this.log(
        task.id,
        "success",
        "已确认国际版 UID，账号标记使用",
        task.position,
      );
    });
  }
  resume(id) {
    const job = this.job(id),
      task = this.active;
    if (
      job.status !== "paused" ||
      task?.id !== id ||
      task.cancelled ||
      this.store.patService?.active ||
      this.stopping
    )
      throw new AppError("任务会自动重试并继续，无需手动恢复", 409);
    this.db
      .prepare(
        "UPDATE workbuddy_jobs SET status='running',message='继续检查当前账号' WHERE id=?",
      )
      .run(id);
    task.promise = this.run(task);
    return this.job(id);
  }
  async cancel(id) {
    this.job(id);
    const task = this.active;
    if (task?.id === id) {
      task.cancelled = true;
      task.abort.abort();
      task.accountAbort?.abort();
      await task.promise;
      if (this.active === task)
        await this.finish(
          task,
          "stopped",
          "已停止；当前账号结果未知，未成功账号已自动释放",
        );
    }
    return this.job(id);
  }
  release(id, position, body) {
    const job = this.job(id);
    if (body?.acknowledge !== true)
      throw new AppError("请二次确认：远端结果仍需自行核对");
    if (job.running) throw new AppError("任务结束后才能释放占用", 409);
    if (!Number.isInteger(position) || position < 1)
      throw new AppError("账号位置无效");
    const item = job.items.find((i) => i.position === position);
    if (!item) throw new AppError("任务账号不存在", 404);
    if (item.status === "success")
      throw new AppError("成功账号不能释放任务占用", 409);
    this.store.transaction(() => {
      this.db
        .prepare(
          "UPDATE accounts SET reservedBy=NULL WHERE id=? AND reservedBy=?",
        )
        .run(item.accountId, id);
      this.db
        .prepare(
          "UPDATE workbuddy_items SET reserved=0 WHERE jobId=? AND position=?",
        )
        .run(id, position);
      this.store.event(
        { id: item.accountId, username: item.username },
        "workbuddy-release",
        "用户确认远端结果需自行核对，手动释放任务占用",
      );
      this.log(
        id,
        "warn",
        "用户确认后释放占用；保留原始结果状态，远端结果需自行核对",
        position,
      );
    });
    return this.job(id);
  }
  async stop() {
    this.stopping = true;
    if (this.active) await this.cancel(this.active.id);
  }
}

export function registerWorkBuddy(app, service) {
  const base = "/api/workbuddy";
  app.get(base + "/candidates", (req, res) => res.json(service.candidates()));
  app.post(base + "/preview", (req, res) =>
    res.json(service.preview(req.body)),
  );
  app.get(base + "/jobs", (req, res) => res.json(service.jobs()));
  app.post(base + "/jobs", (req, res) =>
    res.status(202).json(service.start(req.body)),
  );
  app.get(base + "/jobs/:id", (req, res) =>
    res.json(service.job(req.params.id)),
  );
  app.post(base + "/jobs/:id/cancel", async (req, res) =>
    res.json(await service.cancel(req.params.id)),
  );
  app.post(base + "/jobs/:id/resume", (req, res) =>
    res.json(service.resume(req.params.id)),
  );
  app.post(base + "/jobs/:id/items/:position/release", (req, res) =>
    res.json(
      service.release(req.params.id, Number(req.params.position), req.body),
    ),
  );
}
