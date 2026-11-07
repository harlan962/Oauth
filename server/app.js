import express from "express";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { AppError } from "./store.js";
import { createChecker } from "./checker.js";
import { IntegrationService, registerIntegrations } from "./integrations.js";
import { WorkBuddyService, registerWorkBuddy } from "./workbuddy.js";
import { PatService, registerPat } from "./pat-service.js";
import { CheckSchedule } from './check-schedule.js';
import { ApiAccess } from './api-access.js';
import { apiOrigin, createPublicApi } from './public-api.js';
import { AdminAuth } from './admin-auth.js';
import { Notifier, categories as notifyCategories } from './notify.js';
import { IpAllow } from './ip-allow.js';
import { BotService, platforms as botPlatforms, commandList as botCommands } from './bot.js';

export function createApp(store, options = {}) {
  const app = express();
  const adminOrigin=options.adminOrigin?apiOrigin(options.adminOrigin):undefined;
  const trustProxy=options.trustProxy===true;
  // Only a browser talking to the Vite dev server needs these names. Keeping
  // them in production would leave a second accepted Host for no reason.
  if(trustProxy)app.set('trust proxy',1);
  const auth=new AdminAuth(store,{...options,adminOrigin,trustProxy});
  // Channels are told about events from the same write that records them, so a
  // notification can never fire for something the audit trail did not see.
  const notifier=new Notifier(store,{clock:options.clock||Date.now});
  auth.subscribe(event=>notifier.handle(event));
  const access = new ApiAccess(store, {...options, onEvent:(kind,detail,meta)=>auth.event(kind,detail,false,meta)});
  const publicOrigin = apiOrigin(options.apiOrigin, options.apiPort);
  const integrations = new IntegrationService(store, {...options, onEvent:(kind,detail,meta)=>auth.event(kind,detail,false,meta)});
  const workbuddy = new WorkBuddyService(store, integrations, options);
  const pat = new PatService(store, options);
  pat.integrations = integrations;
  const checker = createChecker(store, options.fetcher, options.delayMs, {
    pat, clock: options.clock, wait: options.wait,
  });
  pat.checker = checker;
  const schedule = new CheckSchedule(store, checker, { ...options, pat, workbuddy, integrations });
  const ipAllow = new IpAllow(store, { env: options.adminAllow || '', clock: options.clock || Date.now });
  const bot = new BotService(store, {
    checker, notifier, auth, clock: options.clock || Date.now,
    fetcher: options.botFetcher || fetch, staleDays: options.botStaleDays,
  });
  const publicApp = createPublicApi(access, { origin: publicOrigin, port: options.apiPort, bot });
  const allowedHosts = new Set([
    // Development server only, and only when the process was started through
    // `npm run dev`; a production start must answer to its own name alone.
    ...(options.devHosts===true?["127.0.0.1:5173","localhost:5173"]:[]),
    ...(options.allowedHosts || []),
    ...(adminOrigin?[new URL(adminOrigin).host]:[]),
  ]);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), interest-cohort=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Permitted-Cross-Domain-Policies": "none",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-src 'none'; media-src 'self'; worker-src 'none'; manifest-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
    });
    // Only meaningful over the configured HTTPS admin origin; on plain loopback
    // HTTP a Strict-Transport-Security header would be ignored or harmful.
    if (adminOrigin?.startsWith("https:") && req.headers.host === new URL(adminOrigin).host)
      res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    // The address gate runs before anything that costs work: a rejected source
    // should not be able to reach the host check, the body parser or scrypt.
    if (!ipAllow.permits(req)) {
      ipAllow.recordBlocked(req, (kind, detail, urgent, meta) => auth.event(kind, detail, urgent, meta));
      return res.status(403).json({ error: "当前来源地址不在白名单内" });
    }
    if (!allowedHosts.has(req.headers.host)) {
      auth.event("host_rejected", req.headers.host || "missing", false, {req, method:"none"});
      return res.status(403).json({ error: "后台访问域名不匹配" });
    }
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        const expected=adminOrigin && req.headers.host===new URL(adminOrigin).host?adminOrigin:`http://${req.headers.host}`;
        if (origin.origin !== expected || req.headers.origin !== origin.origin) {
          auth.event("origin_rejected", origin.origin, false, {req, method:"none"});
          return res.status(403).json({ error: "不允许跨站请求" });
        }
      } catch {
        auth.event("origin_rejected", "invalid", false, {req, method:"none"});
        return res.status(403).json({ error: "请求来源无效" });
      }
    }
    if (
      req.path.toLowerCase().startsWith("/api") &&
      (req.headers["x-local-client"] !== "account-desk" ||
        req.headers["sec-fetch-site"] === "cross-site")
    )
      return res.status(403).json({ error: "请通过本地账号工作台操作" });
    next();
  });
  app.use('/api/auth',auth.routes());
  app.use('/api',(req,res,next)=>{auth.require(req);next();});
  app.use(express.json({ limit: "2mb" }));
  app.use('/api',(req,res,next)=>{auth.require(req);next();});
  app.get('/api/access', (req,res)=>res.json({keys:access.list(),baseUrl:`${publicOrigin}/api/v1`,rateLimit:60}));
  app.post('/api/access/keys', (req,res)=>res.status(201).json(access.create(req.body)));
  app.patch('/api/access/keys/:id', (req,res)=>res.json(access.update(req.params.id,req.body)));
  app.delete('/api/access/keys/:id', (req,res)=>res.json(access.delete(req.params.id)));
  app.get('/api/notify', (req,res)=>res.json({
    channels:notifier.list(),categories:notifyCategories,deliveries:notifier.deliveries(req.query.deliveries),
  }));
  app.post('/api/notify', (req,res)=>res.status(201).json(notifier.create(req.body)));
  app.patch('/api/notify/:id', (req,res)=>res.json(notifier.update(req.params.id,req.body)));
  app.delete('/api/notify/:id', (req,res)=>res.json(notifier.remove(req.params.id)));
  // A test send is the only way to know a webhook token or SMTP password works
  // before the day it matters, so it is a first-class action rather than a CLI flag.
  app.post('/api/notify/:id/test', async(req,res)=>res.json(await notifier.test(req.params.id)));
  // ---- access allowlist ----
  app.get('/api/security/ip-allow', (req,res)=>res.json({
    ...ipAllow.state(),
    current: ipAllow.clientAddress(req) || null,
  }));
  app.put('/api/security/ip-allow', (req,res)=>res.json(ipAllow.save(req.body, req,
    (kind,detail,urgent,meta)=>auth.event(kind,detail,urgent,meta))));
  // ---- bot ----
  app.get('/api/bot', (req,res)=>res.json({
    bots: bot.list(),
    settings: bot.settings(),
    nextRunAt: bot.nextRunAt(),
    messages: bot.messages(req.query.messages),
    platforms: botPlatforms,
    commands: botCommands,
    hookBase: `${publicOrigin}/bot/hook`,
    publicOrigin,
    stale: bot.staleRows().length,
  }));
  app.post('/api/bot', (req,res)=>res.status(201).json(bot.create(req.body)));
  app.put('/api/bot/settings', (req,res)=>res.json({settings:bot.configure(req.body),nextRunAt:bot.nextRunAt()}));
  app.post('/api/bot/report', (req,res)=>res.json(bot.pushReport('手动播报')));
  app.post('/api/bot/check', (req,res)=>res.json(bot.runCheck({all:req.body?.all===true})));
  app.post('/api/bot/:id/rotate', (req,res)=>res.json(bot.rotate(req.params.id)));
  app.patch('/api/bot/:id', (req,res)=>res.json(bot.update(req.params.id,req.body)));
  app.delete('/api/bot/:id', (req,res)=>res.json(bot.remove(req.params.id)));
  app.get("/api/accounts", (req, res) => res.json(store.list()));
  // Both endpoints below hand out plaintext passwords and TOTP seeds, so they
  // require a fresh password check (5 min grant) and leave an audit row behind.
  app.post('/api/accounts/export', (req,res) => {
    auth.requireGrant(req);
    const {labels,...result}=store.exportAccounts(req.body?.ids);
    auth.consumeGrant(req);
    // "how many rows left the machine" is not enough to investigate a leak;
    // record which accounts went out, capped so the row stays readable.
    const detail=labels.length>20
      ?`${labels.slice(0,20).join(', ')} 等 ${labels.length} 个`
      :labels.join(', ');
    auth.auditCredential('export',{count:result.count,accountLabel:detail.slice(0,500),req});
    res.json(result);
  });
  app.get('/api/organization', (req,res) => res.json(store.organization.list()));
  app.post('/api/organization/assign', (req,res) => res.json(store.organization.assign(req.body?.ids, req.body)));
  app.post('/api/organization/:kind', (req,res) => res.status(201).json(store.organization.save(req.params.kind,req.body)));
  app.patch('/api/organization/:kind/:id', (req,res) => res.json(store.organization.save(req.params.kind,req.body,req.params.id)));
  app.delete('/api/organization/:kind/:id', (req,res) => res.json(store.organization.delete(req.params.kind,req.params.id)));
  app.post("/api/accounts", (req, res) =>
    res.status(201).json(store.create(req.body)),
  );
  app.post("/api/accounts/batch", (req, res) => {
    if (!["trash", "restore"].includes(req.body?.action))
      throw new AppError("批量操作无效");
    res.json(store.batchTrash(req.body.ids, req.body.action === "restore"));
  });
  app.delete('/api/accounts/trash', (req,res) => {
    if (pat.active || pat.verifications.size || workbuddy.active || integrations.active) throw new AppError('请等待当前任务完成后清空回收站',409);
    const ids=req.body?.ids;
    if (!Array.isArray(ids) || !ids.length || ids.some(id=>typeof id!=='string')) throw new AppError('请选择回收站账号');
    const change=checker.prepareRemoval(ids);
    const result=store.purge(ids,{confirmed:req.body?.confirmed,beforeCommit:change.persist});
    change.commit();
    res.json(result);
  });
  app.get("/api/checks", (req, res) => res.json(checker.status()));
  app.get('/api/checks/config', (req,res) => res.json(schedule.status()));
  app.put('/api/checks/config', (req,res) => res.json(schedule.configure(req.body)));
  app.post('/api/checks/preview', (req,res) => res.json(schedule.preview(req.body)));
  app.post('/api/checks/range', (req,res) => res.json(schedule.startRange(req.body)));
  app.post("/api/import/preview", (req, res) => {
    const result = store.preview(req.body?.text);
    res.json({
      errors: result.errors,
      records: result.records.map(
        ({ line, email, username, totp, duplicate }) => ({
          line,
          email,
          username,
          hasTotp: !!totp,
          duplicate,
        }),
      ),
    });
  });
  app.post("/api/import", (req, res) => res.json(store.import(req.body?.text, req.body)));
  app.patch("/api/accounts/:id", (req, res) => {
    if (!req.body || typeof req.body !== "object")
      throw new AppError("请求数据无效");
    res.json(store.update(req.params.id, req.body));
  });
  app.post("/api/accounts/:id/secrets", (req, res) => {
    auth.requireGrant(req);
    const account = store.get(req.params.id);
    const result = store.secrets(req.params.id);
    auth.consumeGrant(req);
    auth.auditCredential('secrets',{
      accountId:account.id,
      accountLabel:account.email || account.username || null,
      req,
    });
    res.json(result);
  });
  app.post("/api/select", (req, res) =>
    res.json(store.select(undefined, req.body?.purpose)),
  );
  app.post("/api/accounts/:id/select", (req, res) =>
    res.json(store.select(req.params.id, req.body?.purpose)),
  );
  app.post("/api/accounts/:id/release", (req, res) => {
    store.release(req.params.id);
    res.json({ ok: true });
  });
  app.post("/api/accounts/:id/trash", (req, res) => {
    store.trash(req.params.id);
    res.json({ ok: true });
  });
  app.post("/api/accounts/:id/restore", (req, res) => {
    store.trash(req.params.id, true);
    res.json({ ok: true });
  });
  app.post("/api/checks", (req, res) => {
    if (req.body?.scope === "all") return res.json(checker.startAll());
    if (
      !Array.isArray(req.body?.ids) ||
      req.body.ids.some((id) => typeof id !== "string")
    )
      throw new AppError("账号列表无效");
    res.json(checker.start(req.body.ids, req.body?.scope === 'filtered' ? 'filtered' : 'selected'));
  });
  app.post("/api/accounts/:id/check", (req, res) =>
    res.json(checker.start([req.params.id])),
  );
  app.post("/api/checks/cancel", async (req, res) => {
    await checker.cancel();
    res.json(checker.status());
  });
  app.post("/api/checks/resume", (req, res) => res.json(checker.resume()));
  registerIntegrations(app, integrations);
  registerWorkBuddy(app, workbuddy);
  registerPat(app, pat);
  app.use("/api", (req, res) => res.status(404).json({ error: "接口不存在" }));
  const dist = resolve("dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get("/", (req, res) => res.sendFile(resolve(dist, "index.html")));
  } else
    app.get("/", (req, res) =>
      res
        .type("text")
        .send(
          "请运行 npm run build 后刷新，或在开发模式访问 http://127.0.0.1:5173",
        ),
    );
  app.use((error, req, res, next) => {
    const status = error.status || (error instanceof SyntaxError ? 400 : 500);
    const expected =
      error instanceof AppError || /导入内容|每次最多/.test(error.message);
    if (status===429) res.set('Retry-After',String(error.retryAfter || 60));
    res.status(expected ? error.status || 400 : status).json({
      // Machine-readable markers the UI reacts to (CSRF retry, step-up prompt).
      // Only codes set by this server are forwarded; no upstream value leaks.
      ...(error.code?{code:error.code}:{}),
      error: expected
        ? error.message
        : status === 413
          ? "请求内容过大"
          : status === 400
            ? "请求格式无效"
            : "操作失败，请检查本地服务后重试",
    });
  });
  return { app, publicApp, auth, access, notifier, checker, integrations, workbuddy, pat, schedule, ipAllow, bot };
}
