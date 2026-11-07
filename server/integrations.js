import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { encrypt, decrypt } from "./crypto.js";
import { AppError } from "./store.js";
import { normalizeBrowserProxy, publicBrowserProxy } from "./browser-proxy.js";
import { ConnectionBrowser } from "./connection-browser.js";

function httpsURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error();
    return url;
  } catch {
    throw new AppError("请输入不含用户名、密码或片段的有效 HTTPS 地址");
  }
}
function normalizeBase(value) {
  if (typeof value !== "string" || value.length > 2000)
    throw new AppError("部署地址无效");
  const url = httpsURL(value.trim());
  if (url.search) throw new AppError("部署地址不能包含查询参数");
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/panel$/, "");
  return url.href.replace(/\/+$/, "");
}
// A self-hosted deployment is a legitimate reason to point at an internal
// address, so this does not block the save. It does leave a trail: an
// administrator who was tricked into pasting an attacker-supplied address would
// otherwise send the API key to an unknown host with nothing recorded.
export function privateTarget(value) {
  let host;
  try { host = new URL(value).hostname.replace(/^\[|\]$/g, "").toLowerCase(); }
  catch { return false; }
  if (!host) return false;
  if (host === "localhost" || /\.(localhost|local|internal|lan|home\.arpa)$/.test(host))
    return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  return host === "::1" || /^(fc|fd|fe80)/.test(host);
}
class RemoteError extends AppError {
  constructor(message, { stop = false, unknown = false } = {}) {
    super(message, 502);
    this.stopQueue = stop;
    this.unknown = unknown;
  }
}

export class IntegrationService {
  constructor(
    store,
    { integrationFetcher = fetch, integrationDelayMs = 250,
      integrationChromium, integrationBrowserExists, onEvent } = {},
  ) {
    this.store = store;
    this.db = store.db;
    this.key = store.key;
    this.fetcher = integrationFetcher;
    this.onEvent = onEvent || (() => {});
    this.delayMs = integrationDelayMs;
    this.connectionBrowser = new ConnectionBrowser({
      chromium: integrationChromium, exists: integrationBrowserExists,
    });
    this.diagnosticTasks = new Map();
    this.active = null;
    this.stopping = false;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS integration_targets (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, baseUrl TEXT NOT NULL, apiKey TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, revision TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS integration_jobs (
        id TEXT PRIMARY KEY, requestId TEXT NOT NULL UNIQUE, targetId TEXT NOT NULL,
        targetName TEXT NOT NULL, baseUrl TEXT NOT NULL, realm TEXT NOT NULL,
        total INTEGER NOT NULL, running INTEGER NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL, finishedAt TEXT, message TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS integration_items (
        jobId TEXT NOT NULL REFERENCES integration_jobs(id), position INTEGER NOT NULL,
        status TEXT NOT NULL, payload TEXT, createdAt TEXT, error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(jobId, position)
      );
      UPDATE integration_items SET status='unknown', error='本地服务中断，无法确认该次请求结果；未自动重试'
        WHERE status='running';
      UPDATE integration_items SET status='skipped', error='本地服务中断，未发送请求' WHERE status='queued';
      UPDATE integration_jobs SET running=0, message='本地服务中断，保留已获取的链接，未自动恢复请求',
        finishedAt=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE running=1;
    `);
    if (
      !this.db
        .prepare("PRAGMA table_info(integration_targets)")
        .all()
        .some((column) => column.name === "revision")
    )
      this.db.exec(
        "ALTER TABLE integration_targets ADD COLUMN revision TEXT NOT NULL DEFAULT ''",
      );
    if (
      !this.db
        .prepare("PRAGMA table_info(integration_targets)")
        .all()
        .some((column) => column.name === "browserProxy")
    )
      this.db.exec(
        "ALTER TABLE integration_targets ADD COLUMN browserProxy TEXT",
      );
    for (const row of this.db
      .prepare("SELECT id FROM integration_targets WHERE revision=''")
      .all())
      this.db
        .prepare("UPDATE integration_targets SET revision=? WHERE id=?")
        .run(randomUUID(), row.id);
  }
  targets() {
    return this.db
      .prepare(
        "SELECT id,name,baseUrl,createdAt,updatedAt,revision,browserProxy,1 AS hasApiKey FROM integration_targets ORDER BY createdAt,rowid",
      )
      .all()
      .map((row) => ({
        ...row,
        browserProxy: publicBrowserProxy(this.browserProxy(row)),
        hasApiKey: true,
      }));
  }
  browserProxy(target) {
    return target?.browserProxy
      ? JSON.parse(decrypt(target.browserProxy, this.key))
      : null;
  }
  target(id) {
    const row = this.db
      .prepare("SELECT * FROM integration_targets WHERE id=?")
      .get(id);
    if (!row) throw new AppError("对接项目不存在", 404);
    return row;
  }
  save(body, id) {
    if (!body || typeof body !== "object") throw new AppError("项目配置无效");
    const old = id ? this.target(id) : null;
    if (
      id &&
      (this.active?.targetId === id ||
        this.store.workbuddy?.active?.targetId === id)
    )
      throw new AppError("该项目正在获取链接，请完成或停止任务后再修改", 409);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80)
      throw new AppError("项目名称须为 1–80 个字符");
    const baseUrl = normalizeBase(body.baseUrl);
    if (privateTarget(baseUrl)) this.onEvent("integration_private_target", baseUrl);
    if (body.apiKey != null && typeof body.apiKey !== "string")
      throw new AppError("API Key 格式无效");
    const key = body.apiKey?.trim() || "";
    if (key.length > 4096 || /[\x00-\x20\x7f]/.test(key))
      throw new AppError("API Key 不能包含空白或控制字符，长度不能超过 4096");
    if (!key && (!old || old.baseUrl !== baseUrl))
      throw new AppError("请输入 API Key；更换部署地址时需要重新填写");
    const now = new Date().toISOString();
    const proxy =
      body.browserProxy === undefined
        ? this.browserProxy(old)
        : normalizeBrowserProxy(body.browserProxy, this.browserProxy(old));
    if (!old && this.db.prepare("SELECT 1 FROM integration_targets LIMIT 1").get())
      throw new AppError("连接配置已存在，请修改已有配置", 409);
    const targetId = old?.id || randomUUID();
    this.db
      .prepare(
        `INSERT INTO integration_targets(id,name,baseUrl,apiKey,createdAt,updatedAt,revision,browserProxy) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,baseUrl=excluded.baseUrl,apiKey=excluded.apiKey,updatedAt=excluded.updatedAt,revision=excluded.revision,browserProxy=excluded.browserProxy`,
      )
      .run(
        targetId,
        name,
        baseUrl,
        key ? encrypt(key, this.key) : old.apiKey,
        old?.createdAt || now,
        now,
        randomUUID(),
        proxy ? encrypt(JSON.stringify(proxy), this.key) : null,
      );
    return this.targets().find((t) => t.id === targetId);
  }
  async request(target, path, body) {
    let response;
    try {
      response = await this.fetcher(target.baseUrl + "/panel/api/" + path, {
        method: body === undefined ? "GET" : "POST",
        redirect: "manual",
        headers: {
          Authorization: "Bearer " + decrypt(target.apiKey, this.key),
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status))
          throw new RemoteError("鉴权失败，请检查 API Key 或服务访问权限", {
            stop: true,
          });
        if (response.status === 429)
          throw new RemoteError("远端请求受限，已停止后续请求，请稍后再试", {
            stop: true,
          });
        if (response.status >= 300 && response.status < 400)
          throw new RemoteError(
            "服务返回重定向，为保护 API Key 未跟随跳转，请检查部署地址",
            { unknown: true },
          );
        throw new RemoteError(
          `远端返回 HTTP ${response.status}，请检查服务配置和运行状态`,
          { unknown: body !== undefined },
        );
      }
      // Bound even chunked responses; never include raw upstream content in errors/logs.
      const chunks = [];
      let size = 0;
      if (!response.body) throw new Error("empty response");
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 65536) throw new Error("response too large");
        chunks.push(Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof RemoteError) throw error;
      throw new RemoteError(
        "请求超时、网络异常或响应格式无效；未自动重试，请检查服务后重新操作",
        { unknown: body !== undefined },
      );
    }
  }
  async test(id) {
    return this.testTarget(this.target(id));
  }
  async testTarget(target) {
    const data = await this.request(target, "overview");
    if (
      !data ||
      !Array.isArray(data.accounts) ||
      !Number.isInteger(data.total) ||
      data.total < 0
    )
      throw new AppError(
        "服务响应与 WorkBuddy2API 不兼容，请检查部署地址和版本",
        502,
      );
    return { ok: true, total: data.total, checkedAt: new Date().toISOString() };
  }
  diagnostics(id) {
    if (this.stopping) throw new AppError("服务正在停止，请稍后再试", 409);
    if (this.diagnosticTasks.has(id)) return this.diagnosticTasks.get(id);
    // Snapshot the saved connection; diagnostics never alter a running task.
    const target = this.target(id);
    const task = Promise.all([
      (async () => {
        try {
          const result = await this.testTarget(target);
          return { ok: true, message: "API Key 验证通过，已读取 WorkBuddy 概览", total: result.total };
        } catch (error) {
          return { ok: false, message: error instanceof RemoteError
            ? error.message
            : "服务响应与 WorkBuddy2API 不兼容，请检查部署地址和版本" };
        }
      })(),
      (async () => {
        try { return await this.connectionBrowser.check(this.browserProxy(target)); }
        catch { return { ok: false, mode: target.browserProxy ? "proxy" : "direct", message: "无法读取浏览器网络配置，请重新保存连接配置" }; }
      })(),
    ]).then(([api, browser]) => ({ ok: api.ok && browser.ok, api, browser }))
      .finally(() => this.diagnosticTasks.delete(id));
    this.diagnosticTasks.set(id, task);
    return task;
  }
  job(id) {
    const row = this.db
      .prepare("SELECT * FROM integration_jobs WHERE id=?")
      .get(id);
    if (!row) throw new AppError("授权链接任务不存在", 404);
    const items = this.db
      .prepare(
        "SELECT * FROM integration_items WHERE jobId=? ORDER BY position",
      )
      .all(id)
      .map(({ payload, ...item }) => ({
        ...item,
        ...(payload ? JSON.parse(decrypt(payload, this.key)) : {}),
      }));
    return {
      ...row,
      running: !!row.running,
      cancelled: !!row.cancelled,
      items,
    };
  }
  jobs() {
    return this.db
      .prepare(
        "SELECT * FROM integration_jobs ORDER BY createdAt DESC,rowid DESC LIMIT 30",
      )
      .all()
      .map((row) => ({
        ...row,
        running: !!row.running,
        cancelled: !!row.cancelled,
      }));
  }
  start(body) {
    if (
      !body ||
      !Number.isInteger(body.count) ||
      body.count < 1 ||
      body.count > 100
    )
      throw new AppError("数量须为 1–100 的整数");
    if (!["cn", "global"].includes(body.realm))
      throw new AppError("请选择国内版或国际版");
    if (
      typeof body.targetId !== "string" ||
      typeof body.requestId !== "string" ||
      !/^[\w-]{8,100}$/.test(body.requestId)
    )
      throw new AppError("任务参数无效");
    const existing = this.db
      .prepare("SELECT * FROM integration_jobs WHERE requestId=?")
      .get(body.requestId);
    if (existing) {
      if (
        existing.targetId !== body.targetId ||
        existing.realm !== body.realm ||
        existing.total !== body.count
      )
        throw new AppError("重复提交参数不一致", 409);
      return this.job(existing.id);
    }
    if (this.stopping || this.active || this.store.workbuddy?.active || this.store.patService?.active)
      throw new AppError("已有任务正在获取链接，请等待完成或停止后再试", 409);
    const target = this.target(body.targetId);
    if (
      typeof body.targetRevision !== "string" ||
      body.targetRevision !== target.revision
    )
      throw new AppError(
        "项目配置已变更，请重新加载配置并核对目标后再确认",
        409,
      );
    const id = randomUUID();
    this.store.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO integration_jobs(id,requestId,targetId,targetName,baseUrl,realm,total,running,createdAt) VALUES(?,?,?,?,?,?,?,1,?)`,
        )
        .run(
          id,
          body.requestId,
          target.id,
          target.name,
          target.baseUrl,
          body.realm,
          body.count,
          new Date().toISOString(),
        );
      const add = this.db.prepare(
        "INSERT INTO integration_items(jobId,position,status) VALUES(?,?,?)",
      );
      for (let n = 1; n <= body.count; n++) add.run(id, n, "queued");
    });
    const task = { id, targetId: target.id, cancelled: false, promise: null };
    this.active = task;
    task.promise = this.run(task, target, body.realm, body.count);
    return this.job(id);
  }
  async run(task, target, realm, total) {
    let message = "获取结束，请查看每条结果";
    const states = new Set();
    const urls = new Set();
    try {
      for (let n = 1; n <= total; n++) {
        if (task.cancelled) {
          message = "已停止后续请求，已获取的链接保留";
          break;
        }
        this.db
          .prepare(
            "UPDATE integration_items SET status='running' WHERE jobId=? AND position=?",
          )
          .run(task.id, n);
        try {
          const data = await this.request(target, "login/start", { realm });
          let valid =
            data?.ok === true &&
            data.realm === realm &&
            typeof data.state === "string" &&
            data.state.length > 0 &&
            data.state.length <= 8192 &&
            typeof data.url === "string" &&
            data.url.length <= 16384;
          try {
            if (valid) httpsURL(data.url);
          } catch {
            valid = false;
          }
          if (!valid)
            throw new RemoteError(
              "返回内容缺少有效的授权链接、state 或区域不匹配；未自动重试",
              { unknown: true },
            );
          if (states.has(data.state) || urls.has(data.url))
            throw new RemoteError(
              "远端返回了本任务已有的授权会话，未计为独立链接；请检查服务",
              { unknown: true },
            );
          states.add(data.state);
          urls.add(data.url);
          this.db
            .prepare(
              "UPDATE integration_items SET status='success',payload=?,createdAt=? WHERE jobId=? AND position=?",
            )
            .run(
              encrypt(
                JSON.stringify({ url: data.url, state: data.state }),
                this.key,
              ),
              new Date().toISOString(),
              task.id,
              n,
            );
        } catch (error) {
          const detail =
            error instanceof RemoteError
              ? error.message
              : "处理结果失败，无法确认该次请求结果；未自动重试";
          this.db
            .prepare(
              "UPDATE integration_items SET status=?,error=?,createdAt=? WHERE jobId=? AND position=?",
            )
            .run(
              error instanceof RemoteError && !error.unknown
                ? "failed"
                : "unknown",
              detail,
              new Date().toISOString(),
              task.id,
              n,
            );
          if (error.stopQueue) {
            message = detail;
            break;
          }
        }
        if (n < total && !task.cancelled && this.delayMs)
          await delay(this.delayMs);
      }
    } catch {
      message = "本地处理异常，任务已停止；保留已获取结果";
    } finally {
      this.db
        .prepare(
          "UPDATE integration_items SET status='skipped',error='任务停止，未发送请求' WHERE jobId=? AND status='queued'",
        )
        .run(task.id);
      this.db
        .prepare(
          "UPDATE integration_items SET status='unknown',error='处理中断，无法确认请求结果' WHERE jobId=? AND status='running'",
        )
        .run(task.id);
      this.db
        .prepare(
          "UPDATE integration_jobs SET running=0,message=?,finishedAt=? WHERE id=?",
        )
        .run(message, new Date().toISOString(), task.id);
      this.active = null;
    }
  }
  cancel(id) {
    this.job(id);
    if (this.active?.id === id) {
      this.active.cancelled = true;
      this.db
        .prepare(
          "UPDATE integration_jobs SET cancelled=1,message='正在停止：等待当前请求结束，不再发起下一次请求' WHERE id=?",
        )
        .run(id);
    }
    return this.job(id);
  }
  async stop() {
    this.stopping = true;
    await Promise.allSettled(this.diagnosticTasks.values());
    if (this.active) {
      const task = this.active;
      this.cancel(task.id);
      await task.promise;
    }
  }
}

export function registerIntegrations(app, service) {
  const base = "/api/integrations";
  app.get(base + "/targets", (req, res) => res.json(service.targets()));
  app.post(base + "/targets", (req, res) =>
    res.status(201).json(service.save(req.body)),
  );
  app.put(base + "/targets/:id", (req, res) =>
    res.json(service.save(req.body, req.params.id)),
  );
  app.post(base + "/targets/:id/test", async (req, res) =>
    res.json(await service.test(req.params.id)),
  );
  app.post(base + "/targets/:id/diagnostics", async (req, res) =>
    res.json(await service.diagnostics(req.params.id)),
  );
  app.get(base + "/jobs", (req, res) => res.json(service.jobs()));
  app.post(base + "/jobs", (req, res) =>
    res.status(202).json(service.start(req.body)),
  );
  app.get(base + "/jobs/:id", (req, res) =>
    res.json(service.job(req.params.id)),
  );
  app.post(base + "/jobs/:id/cancel", (req, res) =>
    res.json(service.cancel(req.params.id)),
  );
}
