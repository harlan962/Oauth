import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Store } from "../server/store.js";
import { createApp } from "./authenticated-app.js";
import { IntegrationService } from "../server/integrations.js";

const config = {
  name: "测试实例",
  baseUrl: "https://example.com/panel/",
  apiKey: "integration-test-secret",
};

test("browser proxy credentials are encrypted, preserved only for the same endpoint, and never returned", async (t) => {
  const { call, integrations } = await fixture(t);
  const proxy = {
    server: "http://127.0.0.1:7890",
    username: "proxy-user",
    password: "proxy-private-password",
  };
  const created = await call("/targets", "POST", {
    ...config,
    browserProxy: proxy,
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.browserProxy, {
    server: proxy.server,
    username: proxy.username,
    hasPassword: true,
  });
  const id = created.data.id;
  assert.ok(!JSON.stringify(integrations.target(id)).includes(proxy.password));
  assert.deepEqual(integrations.browserProxy(integrations.target(id)), proxy);
  const saved = await call("/targets/" + id, "PUT", {
    ...config,
    apiKey: "",
    browserProxy: { ...proxy, password: "" },
  });
  assert.equal(saved.status, 200);
  assert.equal(
    integrations.browserProxy(integrations.target(id)).password,
    proxy.password,
  );
  assert.notEqual(saved.data.revision, created.data.revision);
  assert.ok(
    !JSON.stringify((await call("/targets")).data).includes(proxy.password),
  );
  const changed = await call("/targets/" + id, "PUT", {
    ...config,
    browserProxy: { ...proxy, server: "http://127.0.0.1:7891", password: "" },
  });
  assert.equal(changed.status, 400);
  const omitted = await call("/targets/" + id, "PUT", { ...config });
  assert.equal(omitted.status, 200);
  assert.equal(
    integrations.browserProxy(integrations.target(id)).password,
    proxy.password,
  );
  const cleared = await call("/targets/" + id, "PUT", {
    ...config,
    browserProxy: null,
  });
  assert.equal(cleared.data.browserProxy, null);
  assert.equal(integrations.browserProxy(integrations.target(id)), null);
});

test("invalid proxy endpoints fail before saving", async (t) => {
  const { call } = await fixture(t);
  for (const browserProxy of [
    { server: "file:///etc/passwd" },
    { server: "http://localhost:7890/path" },
    { server: "http://localhost:7890?password=secret" },
    { server: "http://localhost:7890", username: "user" },
    { server: "http://localhost:7890", password: "secret" },
    "http://localhost:7890",
  ])
    assert.equal(
      (await call("/targets", "POST", { ...config, browserProxy })).status,
      400,
    );
  const valid = await call("/targets", "POST", {
    ...config,
    browserProxy: { server: "socks5://127.0.0.1:1080" },
  });
  assert.equal(valid.status, 201);
  assert.deepEqual(valid.data.browserProxy, {
    server: "socks5://127.0.0.1:1080",
    username: "",
    hasPassword: false,
  });
});
test('provider links automatically parse encoded HTTP and SOCKS5 credentials without returning passwords', async t => {
  const {call,integrations}=await fixture(t);
  const first=await call('/targets','POST',{...config,browserProxy:{server:'http://user:p%40ss%3Aword@127.0.0.1:7890'}});
  assert.equal(first.status,201);
  assert.deepEqual(integrations.browserProxy(integrations.target(first.data.id)),{server:'http://127.0.0.1:7890',username:'user',password:'p@ss:word'});
  assert.doesNotMatch(JSON.stringify(first.data),/p%40ss|p@ss/);
  const next=await call('/targets/'+first.data.id,'PUT',{...config,browserProxy:{server:'socks5://new-user:secret@proxy.example:1080'}});
  assert.equal(next.status,200);
  assert.deepEqual(integrations.browserProxy(integrations.target(first.data.id)),{server:'socks5://proxy.example:1080',username:'new-user',password:'secret'});
  const invalid=await call('/targets/'+first.data.id,'PUT',{...config,browserProxy:{server:'socks5://new-user:@proxy.example:1080'}});
  assert.equal(invalid.status,400,'incomplete inline credentials must not reuse the previous password');
  const clear=await call('/targets/'+first.data.id,'PUT',{...config,browserProxy:{server:'socks5://proxy.example:1080'}});
  assert.equal(clear.data.browserProxy.hasPassword,false);
});
async function fixture(
  t,
  fetcher = async () => Response.json({ accounts: [], total: 0 }),
) {
  const dir = mkdtempSync(join(tmpdir(), "integration-tests-"));
  const store = new Store(dir);
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = createApp(store, {
    allowedHosts: [new URL(base).host],
    integrationFetcher: fetcher,
    integrationDelayMs: 0,
  });
  server.on("request", result.app);
  t.after(async () => {
    await result.integrations?.stop();
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function call(path, method = "GET", body) {
    const response = await fetch(base + "/api/integrations" + path, {
      method,
      headers: {
        "X-Local-Client": "account-desk",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  return { ...result, store, call };
}
async function waitJob(call, id) {
  for (let i = 0; i < 300; i++) {
    const response = await call("/jobs/" + id);
    if (!response.data.running) return response.data;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("job timeout");
}

test("project configuration is normalized, encrypted, editable without exposing its API key", async (t) => {
  const { call, store } = await fixture(t);
  const response = await call("/targets", "POST", config);
  assert.equal(response.status, 201);
  const target = response.data;
  assert.equal(target.baseUrl, "https://example.com");
  assert.equal(target.hasApiKey, true);
  assert.equal(target.apiKey, undefined);
  const row = store.db
    .prepare("SELECT * FROM integration_targets WHERE id=?")
    .get(target.id);
  assert.ok(!JSON.stringify(row).includes(config.apiKey));
  assert.equal(
    (
      await call("/targets/" + target.id, "PUT", {
        name: "改名",
        baseUrl: target.baseUrl,
        apiKey: "",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/targets/" + target.id, "PUT", {
        name: "改名",
        baseUrl: "https://other.example.com",
        apiKey: "",
      })
    ).status,
    400,
  );
  assert.equal((await call("/targets")).data[0].name, "改名");
  for (const baseUrl of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com/?key=x",
    "not-a-url",
  ]) {
    assert.equal(
      (await call("/targets", "POST", { ...config, baseUrl })).status,
      400,
    );
  }
});

test("jobs call only login/start sequentially with selected realm, persist results and deduplicate submissions", async (t) => {
  let inFlight = 0,
    maxInFlight = 0;
  const requests = [];
  const { call, store } = await fixture(t, async (url, options) => {
    requests.push({ url, options });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return Response.json({
      ok: true,
      realm: "global",
      url: `https://www.workbuddy.ai/auth?state=s${requests.length}`,
      state: `s${requests.length}`,
    });
  });
  const account = store.create({
    email: "test@example.com",
    username: "test-user",
    password: "test-password",
    totp: "",
  });
  const before = store.get(account.id);
  const target = (await call("/targets", "POST", config)).data;
  const body = {
    targetId: target.id,
    targetRevision: target.revision,
    realm: "global",
    count: 3,
    requestId: "same-request-123",
  };
  const created = await call("/jobs", "POST", body);
  assert.equal(created.status, 202);
  const again = await call("/jobs", "POST", body);
  assert.equal(again.data.id, created.data.id);
  assert.equal(
    (await call("/jobs", "POST", { ...body, requestId: "different-request" }))
      .status,
    409,
  );
  const job = await waitJob(call, created.data.id);
  assert.equal(job.items.length, 3);
  assert.deepEqual(
    job.items.map((i) => i.status),
    ["success", "success", "success"],
  );
  assert.equal(job.items[2].state, "s3");
  assert.equal(maxInFlight, 1);
  assert.equal(requests.length, 3);
  for (const r of requests) {
    assert.equal(r.url, "https://example.com/panel/api/login/start");
    assert.equal(
      r.options.headers.Authorization,
      "Bearer integration-test-secret",
    );
    assert.equal(r.options.redirect, "manual");
    assert.deepEqual(JSON.parse(r.options.body), { realm: "global" });
  }
  assert.deepEqual(store.get(account.id), before);
  assert.equal((await call("/jobs")).data[0].id, job.id);
  const rows = store.db.prepare("SELECT * FROM integration_items").all();
  assert.ok(!JSON.stringify(rows).includes("https://www.workbuddy.ai/auth"));
  assert.ok(!JSON.stringify(job).includes(config.apiKey));
});

test("invalid counts and realms never start tasks; connection test authenticates read-only overview", async (t) => {
  const requests = [];
  const { call } = await fixture(t, async (url, options) => {
    requests.push({ url, options });
    return Response.json({ total: 3, accounts: [], version: "test" });
  });
  const target = (await call("/targets", "POST", config)).data;
  for (const count of [0, -1, 101, 1.5, "3", null]) {
    assert.equal(
      (
        await call("/jobs", "POST", {
          targetId: target.id,
          targetRevision: target.revision,
          realm: "cn",
          count,
          requestId: "validation-check",
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await call("/jobs", "POST", {
        targetId: target.id,
        targetRevision: target.revision,
        realm: "invalid",
        count: 1,
        requestId: "validation-check",
      })
    ).status,
    400,
  );
  assert.equal(requests.length, 0);
  const connection = await call("/targets/" + target.id + "/test", "POST", {});
  assert.equal(connection.status, 200);
  assert.equal(connection.data.total, 3);
  assert.equal(requests[0].url, "https://example.com/panel/api/overview");
  assert.equal(requests[0].options.method, "GET");
});

test("authentication failure stops remaining requests without leaking upstream secret text", async (t) => {
  let count = 0;
  const { call } = await fixture(t, async () => {
    count++;
    return new Response("integration-test-secret raw-error", { status: 401 });
  });
  const target = (await call("/targets", "POST", config)).data;
  const job = (
    await call("/jobs", "POST", {
      targetId: target.id,
      targetRevision: target.revision,
      realm: "cn",
      count: 3,
      requestId: "auth-failure-test",
    })
  ).data;
  const done = await waitJob(call, job.id);
  assert.equal(count, 1);
  assert.deepEqual(
    done.items.map((i) => i.status),
    ["failed", "skipped", "skipped"],
  );
  assert.match(done.items[0].error, /API Key/);
  assert.doesNotMatch(
    JSON.stringify(done),
    /integration-test-secret|raw-error/,
  );
});

test("malformed or ambiguous responses are not retried and never stored as successful links", async (t) => {
  let count = 0;
  const responses = [
    () =>
      Response.json({
        ok: true,
        realm: "cn",
        state: "abc",
        url: "javascript:alert(1)",
      }),
    () => {
      throw new Error("secret upstream network error");
    },
    () =>
      new Response("", {
        status: 302,
        headers: { location: "https://evil.example/" },
      }),
  ];
  const { call } = await fixture(t, async () => responses[count++]());
  const target = (await call("/targets", "POST", config)).data;
  const job = (
    await call("/jobs", "POST", {
      targetId: target.id,
      targetRevision: target.revision,
      realm: "cn",
      count: 3,
      requestId: "malformed-test",
    })
  ).data;
  const done = await waitJob(call, job.id);
  assert.equal(count, 3);
  assert.ok(done.items.every((i) => i.status === "unknown"));
  assert.ok(done.items.every((i) => !i.url));
  assert.doesNotMatch(JSON.stringify(done), /secret upstream/);
});

test("cancelling a job preserves the current result and skips unsent requests", async (t) => {
  let release, entered;
  const ready = new Promise((r) => (entered = r));
  const { call } = await fixture(t, async () => {
    entered();
    await new Promise((r) => (release = r));
    return Response.json({
      ok: true,
      realm: "cn",
      state: "first",
      url: "https://www.codebuddy.cn/auth?state=first",
    });
  });
  const target = (await call("/targets", "POST", config)).data;
  const response = await call("/jobs", "POST", {
    targetId: target.id,
    targetRevision: target.revision,
    realm: "cn",
    count: 2,
    requestId: "cancel-request",
  });
  assert.equal(response.status, 202);
  const job = response.data;
  await ready;
  assert.equal(
    (await call("/targets/" + target.id, "PUT", { ...config, name: "changed" }))
      .status,
    409,
  );
  await call("/jobs/" + job.id + "/cancel", "POST", {});
  release();
  const done = await waitJob(call, job.id);
  assert.deepEqual(
    done.items.map((i) => i.status),
    ["success", "skipped"],
  );
});

test("a duplicate upstream state is not reported as a second independent authorization link", async (t) => {
  const { call } = await fixture(t, async () =>
    Response.json({
      ok: true,
      realm: "cn",
      state: "same-state",
      url: "https://www.codebuddy.cn/auth?state=same-state",
    }),
  );
  const target = (await call("/targets", "POST", config)).data;
  const job = (
    await call("/jobs", "POST", {
      targetId: target.id,
      targetRevision: target.revision,
      realm: "cn",
      count: 2,
      requestId: "duplicate-state",
    })
  ).data;
  const done = await waitJob(call, job.id);
  assert.deepEqual(
    done.items.map((i) => i.status),
    ["success", "unknown"],
  );
  assert.equal(done.items[1].url, undefined);
});

test("restart preserves encrypted results and marks interrupted requests unknown without reissuing them", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "integration-recovery-"));
  let store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const svc = new IntegrationService(store, {
    integrationDelayMs: 0,
    integrationFetcher: async () =>
      Response.json({
        ok: true,
        realm: "global",
        state: "kept-state",
        url: "https://www.workbuddy.ai/auth?state=kept-state",
      }),
  });
  const target = svc.save(config);
  const first = svc.start({
    targetId: target.id,
    targetRevision: target.revision,
    realm: "global",
    count: 1,
    requestId: "persist-request",
  });
  await svc.active.promise;
  store.db
    .prepare("UPDATE integration_jobs SET running=1,total=3 WHERE id=?")
    .run(first.id);
  store.db
    .prepare(
      "INSERT INTO integration_items(jobId,position,status) VALUES(?,2,'running'),(?,3,'queued')",
    )
    .run(first.id, first.id);
  store.close();
  store = new Store(dir);
  let requests = 0;
  const restored = new IntegrationService(store, {
    integrationFetcher: async () => {
      requests++;
      throw new Error("must not send");
    },
  });
  const job = restored.job(first.id);
  assert.equal(job.running, false);
  assert.deepEqual(
    job.items.map((i) => i.status),
    ["success", "unknown", "skipped"],
  );
  assert.equal(job.items[0].state, "kept-state");
  assert.equal(restored.targets()[0].hasApiKey, true);
  assert.equal(requests, 0);
});

test("oversized upstream content and incompatible overview return safe bounded errors", async (t) => {
  const { call } = await fixture(t, async (url) =>
    url.endsWith("overview")
      ? Response.json({ ok: true })
      : new Response("x".repeat(70000)),
  );
  const target = (await call("/targets", "POST", config)).data;
  assert.equal(
    (await call("/targets/" + target.id + "/test", "POST", {})).status,
    502,
  );
  const created = (
    await call("/jobs", "POST", {
      targetId: target.id,
      targetRevision: target.revision,
      realm: "cn",
      count: 1,
      requestId: "oversized-response",
    })
  ).data;
  const done = await waitJob(call, created.id);
  assert.equal(done.items[0].status, "unknown");
  assert.ok(done.items[0].error.length < 200);
});

test("a stale confirmation cannot send to a target changed in another tab", async (t) => {
  let requests = 0;
  const { call } = await fixture(t, async () => {
    requests++;
    return Response.json({
      ok: true,
      realm: "cn",
      state: "s",
      url: "https://www.codebuddy.cn/auth?state=s",
    });
  });
  const target = (await call("/targets", "POST", config)).data;
  await call("/targets/" + target.id, "PUT", {
    ...config,
    baseUrl: "https://second.example.com",
  });
  const response = await call("/jobs", "POST", {
    targetId: target.id,
    targetRevision: target.revision || "missing-revision",
    realm: "cn",
    count: 1,
    requestId: "stale-confirmation",
  });
  assert.equal(response.status, 409);
  assert.equal(requests, 0);
  assert.equal((await call("/jobs")).data.length, 0);
});
