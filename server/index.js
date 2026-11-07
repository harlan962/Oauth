import { resolve } from "node:path";
import { Store } from "./store.js";
import { createApp } from "./app.js";
import { acquireRuntimeLock } from "./runtime-lock.js";
import { apiOrigin } from './public-api.js';

const port = Number(process.env.ACCOUNT_DESK_PORT || 4318);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("ACCOUNT_DESK_PORT 必须为 1024–65535 的整数");
const apiPort = Number(process.env.ACCOUNT_DESK_API_PORT || 4319);
if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535 || apiPort===port)
  throw new Error('ACCOUNT_DESK_API_PORT 须为 1024–65535 的整数，且不能与工作台端口相同');
const publicOrigin = apiOrigin(process.env.ACCOUNT_DESK_API_ORIGIN, apiPort);
const adminOrigin = process.env.ACCOUNT_DESK_ADMIN_ORIGIN ? apiOrigin(process.env.ACCOUNT_DESK_ADMIN_ORIGIN) : undefined;
const directory = resolve(process.env.ACCOUNT_DESK_DATA_DIR || "data");
// `npm run dev` sets npm_lifecycle_event; a production start (or a process
// manager running node directly) does not. Only the dev path accepts the Vite
// host name, so a production service is reachable under one name only.
const devMode = process.env.npm_lifecycle_event === "dev" || process.env.ACCOUNT_DESK_DEV === "1";
const trustProxy = process.env.ACCOUNT_DESK_TRUST_PROXY === "1";
// Seeds the address allowlist on the first run only; after that the security
// page owns the list so a deleted entry cannot reappear on restart.
const adminAllow = process.env.ACCOUNT_DESK_ADMIN_ALLOW || "";
const writeBudget = Number(process.env.ACCOUNT_DESK_API_WRITE_PER_MINUTE || 12000);
if (!Number.isInteger(writeBudget) || writeBudget < 100 || writeBudget > 1000000)
  throw new Error('ACCOUNT_DESK_API_WRITE_PER_MINUTE 须为 100–1000000 的整数（每分钟可写入的账号条数）');
const releaseLock = acquireRuntimeLock(directory);
const store = new Store(directory);
const { app, publicApp, access, auth, checker, integrations, workbuddy, pat, schedule, bot } = createApp(store, {
  allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
  devHosts: devMode,
  trustProxy,
  adminAllow,
  apiPort, apiOrigin: publicOrigin,
  adminOrigin,
  writeBudgetPerMinute: writeBudget,
});
const receiptCleanup = setInterval(()=>{try {access.cleanup();auth.cleanup();} catch { /* Retry on the next interval. */ }},3600000);
receiptCleanup.unref();
let listening = 0;
const ready = () => { if (++listening===2) { schedule.start(); bot.start(); } };
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`GitHub 账号工作台：http://127.0.0.1:${port}`);
  ready();
});
const publicServer = publicApp.listen(apiPort,'127.0.0.1',()=>{
  console.log(`对外 API（本机监听）：http://127.0.0.1:${apiPort}/api/v1`);
  ready();
});
for (const listener of [server,publicServer]) listener.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? '工作台或 API 端口已被占用，请关闭已有服务或更换端口。'
      : "无法启动本地服务",
  );
  store.close();
  releaseLock();
  process.exit(1);
});
let stoppingServer = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (stoppingServer) return;
    stoppingServer = true;
    clearInterval(receiptCleanup);
    schedule.stop();
    bot.stop();
    // Start cancelling immediately, before waiting for HTTP connections to close.
    const stopping = Promise.all([checker.cancel({ shutdown: true }), workbuddy.stop(), pat.stop()]);
    Promise.all([server,publicServer].map(listener=>new Promise(resolve=>listener.close(resolve)))).then(async () => {
      await stopping;
      await integrations.stop();
      store.close();
      releaseLock();
      process.exit(0);
    });
  });
