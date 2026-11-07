import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Store } from "../server/store.js";
import { createApp } from "./authenticated-app.js";

const config = { name: "Connection", baseUrl: "https://example.test", apiKey: "api-secret-never-return" };
const proxy = { server: "http://127.0.0.1:7890", username: "proxy-user", password: "proxy-secret-never-return" };

function fakeChromium({ status = 200, error, launchError, contextError, gate } = {}) {
  const calls = { launches: [], contexts: [], visits: [], closed: 0, routes: [] };
  return {
    calls,
    executablePath: () => process.execPath,
    async launch(options) {
      calls.launches.push(options);
      if (launchError) throw launchError;
      return {
        async newContext(options) {
          calls.contexts.push(options);
          if (contextError) throw contextError;
          return {
            async route(pattern, handler) { calls.routes.push({ pattern, handler }); },
            async newPage() {
              return {
                async goto(url, options) {
                  calls.visits.push({ url, options });
                  if (gate) await gate;
                  if (error) throw error;
                  return { status: () => status, url: () => url };
                },
              };
            },
          };
        },
        async close() { calls.closed++; },
      };
    },
  };
}

async function fixture(t, { chromium = fakeChromium(), fetcher, exists = () => true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "workbuddy-connection-"));
  const store = new Store(dir);
  const requests = [];
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const app = createApp(store, {
    allowedHosts: [new URL(base).host],
    integrationChromium: chromium,
    integrationBrowserExists: exists,
    integrationFetcher: async (url, options) => {
      requests.push({ url, options });
      return fetcher ? fetcher(url, options) : Response.json({ accounts: [], total: 7 });
    },
  });
  server.on("request", app.app);
  t.after(async () => {
    await app.integrations.stop();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function call(path, method = "POST", body) {
    const response = await fetch(base + "/api/integrations" + path, {
      method, headers: { "X-Local-Client": "account-desk", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  return { ...app, store, chromium, requests, call };
}

test("only the first target can be created while existing and historical targets remain editable", async t => {
  const { call, store, integrations } = await fixture(t);
  const first = await call("/targets", "POST", config);
  assert.equal(first.status, 201);
  assert.equal((await call("/targets", "POST", { ...config, name: "Second" })).status, 409);
  assert.equal((await call(`/targets/${first.data.id}`, "PUT", { ...config, name: "Changed", apiKey: "" })).status, 200);
  store.db.prepare("INSERT INTO integration_targets SELECT 'historical',name,baseUrl,apiKey,createdAt,updatedAt,revision,browserProxy FROM integration_targets WHERE id=?").run(first.data.id);
  assert.equal((await call("/targets", "POST", config)).status, 409);
  assert.equal((await call("/targets/historical", "PUT", { ...config, name: "Preserved", apiKey: "" })).status, 200);
  assert.equal(integrations.targets().length, 2);
});

test("diagnostics separately authenticate overview and visit fixed GitHub URL in a fresh headless proxy browser", async t => {
  const { call, chromium, requests, integrations } = await fixture(t);
  const target = integrations.save({ ...config, browserProxy: proxy });
  const response = await call(`/targets/${target.id}/diagnostics`);
  assert.equal(response.status, 200);
  assert.equal(response.data.ok, true);
  assert.equal(response.data.api.ok, true);
  assert.equal(response.data.api.total, 7);
  assert.equal(response.data.browser.ok, true);
  assert.equal(response.data.browser.mode, "proxy");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.test/panel/api/overview");
  assert.equal(requests[0].options.headers.Authorization, "Bearer api-secret-never-return");
  assert.deepEqual(chromium.calls.launches[0].proxy, proxy);
  assert.equal(chromium.calls.launches[0].headless, true);
  assert.ok(chromium.calls.launches[0].timeout > 0 && chromium.calls.launches[0].timeout <= 30000);
  assert.equal(chromium.calls.contexts.length, 1);
  assert.equal(chromium.calls.contexts[0].javaScriptEnabled, false);
  assert.doesNotMatch(JSON.stringify(chromium.calls.contexts), /storageState|api-secret|proxy-secret/);
  assert.equal(chromium.calls.visits[0].url, "https://github.com/login");
  assert.ok(chromium.calls.visits[0].options.timeout > 0 && chromium.calls.visits[0].options.timeout <= 30000);
  assert.equal(chromium.calls.closed, 1);
  assert.doesNotMatch(JSON.stringify(response.data), /api-secret|proxy-secret|proxy-user/);
  const legacy = await call(`/targets/${target.id}/test`);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.total, 7);
  assert.equal(chromium.calls.launches.length, 1);
});

test("API failure still checks system browser network and never exposes upstream secrets", async t => {
  const { call, integrations, chromium } = await fixture(t, {
    fetcher: async () => { throw new Error("api-secret-never-return raw upstream body"); },
  });
  const target = integrations.save(config);
  const { status, data } = await call(`/targets/${target.id}/diagnostics`);
  assert.equal(status, 200);
  assert.equal(data.ok, false);
  assert.equal(data.api.ok, false);
  assert.equal(data.browser.ok, true);
  assert.equal(data.browser.mode, "direct");
  assert.equal(chromium.calls.launches[0].proxy, undefined);
  assert.equal(chromium.calls.closed, 1);
  assert.doesNotMatch(JSON.stringify(data), /api-secret|upstream body/);
});

for (const status of [403, 407, 429, 500]) {
  test(`browser HTTP ${status} fails independently of API and always closes the browser`, async t => {
    const chromium = fakeChromium({ status });
    const { call, integrations } = await fixture(t, { chromium });
    const target = integrations.save({ ...config, browserProxy: proxy });
    const { data } = await call(`/targets/${target.id}/diagnostics`);
    assert.equal(data.ok, false);
    assert.equal(data.api.ok, true);
    assert.equal(data.browser.ok, false);
    assert.match(data.browser.message, new RegExp(String(status)));
    assert.equal(chromium.calls.closed, 1);
  });
}

for (const failure of ["navigation", "context", "launch", "missing"]) {
  test(`${failure} failures are redacted and all launched browsers are closed`, async t => {
    const error = new Error("proxy-secret-never-return api-secret-never-return raw-error");
    error.name = "TimeoutError";
    const chromium = fakeChromium({ error: failure === "navigation" ? error : undefined, contextError: failure === "context" ? error : undefined, launchError: failure === "launch" ? error : undefined });
    const { call, integrations } = await fixture(t, { chromium, exists: () => failure !== "missing" });
    const target = integrations.save(config);
    const { data } = await call(`/targets/${target.id}/diagnostics`);
    assert.equal(data.api.ok, true);
    assert.equal(data.browser.ok, false);
    assert.doesNotMatch(JSON.stringify(data), /proxy-secret|api-secret|raw-error/);
    assert.equal(chromium.calls.closed, ["navigation", "context"].includes(failure) ? 1 : 0);
    if (failure === "missing") assert.match(data.browser.message, /Chromium/);
    else assert.match(data.browser.message, /超时/);
  });
}

test("concurrent diagnostics share one browser and release the slot after completion", async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const chromium = fakeChromium({ gate });
  const { integrations } = await fixture(t, { chromium });
  const target = integrations.save(config);
  assert.equal(typeof integrations.diagnostics, "function");
  const first = integrations.diagnostics(target.id);
  const second = integrations.diagnostics(target.id);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(chromium.calls.launches.length, 1);
  assert.equal(chromium.calls.closed, 1);
  await integrations.diagnostics(target.id);
  assert.equal(chromium.calls.launches.length, 2);
});

test("diagnostics never submit forms or load other entrypoints", async t => {
  const { integrations, chromium } = await fixture(t);
  const target = integrations.save(config);
  await integrations.diagnostics(target.id);
  const handler = chromium.calls.routes[0].handler;
  for (const [url, method, expected] of [
    ["https://github.com/login", "GET", "continue"],
    ["https://github.com/login", "POST", "abort"],
    ["https://github.com/login/oauth/authorize?client_id=secret", "GET", "abort"],
    ["https://example.test/", "GET", "abort"],
  ]) {
    let action;
    await handler({ request: () => ({ url: () => url, method: () => method }),
      async continue() { action = "continue"; }, async abort() { action = "abort"; } });
    assert.equal(action, expected);
  }
});

test("diagnostics preserve running task state and saving still respects the task lock", async t => {
  const { integrations, store } = await fixture(t);
  const target = integrations.save({ ...config, browserProxy: proxy });
  const active = { id: "running-task", targetId: target.id, cancelled: false };
  store.workbuddy.active = active;
  try {
    assert.throws(() => integrations.save({ ...config, apiKey: "" }, target.id), error => error.status === 409);
    const result = await integrations.diagnostics(target.id);
    assert.equal(result.ok, true);
    assert.equal(store.workbuddy.active, active);
    assert.equal(active.cancelled, false);
    assert.equal(integrations.target(target.id).revision, target.revision);
  } finally { store.workbuddy.active = null; }
});

test("incompatible overview still reports successful browser network independently", async t => {
  const { integrations } = await fixture(t, { fetcher: async () => Response.json({ total: "7", error: "api-secret-never-return" }) });
  const target = integrations.save(config);
  const result = await integrations.diagnostics(target.id);
  assert.equal(result.ok, false);
  assert.equal(result.api.ok, false);
  assert.equal(result.browser.ok, true);
  assert.doesNotMatch(JSON.stringify(result), /api-secret/);
});
