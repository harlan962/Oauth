import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { createApp } from "./authenticated-app.js";

// The driver reports the same structural reason for every account when the upstream
// consent page changes. The queue must stop instead of spending four attempts on each
// remaining account, and it must not trip on ordinary per-account failures.
async function fixture(t, plan) {
  const dir = mkdtempSync(join(tmpdir(), "workbuddy-circuit-"));
  const store = new Store(dir);
  let serial = 0;
  const opened = [];
  const calls = [];
  const result = createApp(store, {
    integrationDelayMs: 0,
    workbuddyRetry: { accountTimeoutMs: 1000, retryDelayMs: 0, circuitThreshold: 2 },
    integrationFetcher: async (url) => {
      calls.push(url);
      return url.endsWith("login/start")
        ? Response.json({ ok: true, realm: "global", state: "device-" + ++serial, url: "https://www.workbuddy.ai/auth?state=device-" + serial })
        : Response.json({ done: true, uid: "uid-" + serial, realm: "global" });
    },
    oauthBrowser: {
      async open({ account }) {
        opened.push(account.username);
        const outcome = plan[account.username] || "ok";
        return {
          async step() {
            return outcome === "ok"
              ? { status: "verified", githubUsername: account.username, callbackVerified: true }
              : { status: "manual", reason: outcome };
          },
          async close() {},
        };
      },
    },
  });
  t.after(async () => {
    await result.workbuddy?.stop();
    await result.integrations.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const target = result.integrations.save({ name: "Test", baseUrl: "https://example.test", apiKey: "workbuddy-api-secret" });
  const account = (name) => {
    const record = store.create({ username: name, email: name + "@example.test", password: "Password-very-secret", totp: "JBSWY3DPEHPK3PXP" });
    store.setCheck(record.id, name, { status: "reachable", message: "reachable" });
    return record;
  };
  const start = (records) => result.workbuddy.start({
    targetId: target.id, targetRevision: target.revision, realm: "global",
    count: records.length, accountIds: records.map((r) => r.id), requestId: "request-" + randomUUID(),
  });
  return { ...result, store, account, start, opened, calls };
}

test("repeating one structural reason stops the queue instead of draining every account", async (t) => {
  const f = await fixture(t, { one: "provider_missing", two: "provider_missing", three: "provider_missing" });
  const job = f.start([f.account("one"), f.account("two"), f.account("three")]);
  await f.workbuddy.active.promise;

  const done = f.workbuddy.job(job.id);
  assert.equal(done.status, "stopped");
  assert.match(done.message, /疑似上游授权页面改版/);
  assert.equal(done.items[0].status, "unknown");
  assert.equal(done.items[1].status, "unknown");
  assert.equal(done.items[2].status, "skipped");
  assert.deepEqual(f.opened, ["one", "two"], "third account must never open a browser");
  assert.equal(f.calls.length, 2, "third account must never call the upstream start endpoint");
});

test("a successful account resets the counter so isolated failures do not trip it", async (t) => {
  const f = await fixture(t, { one: "agreement", two: "ok", three: "agreement", four: "agreement", five: "ok" });
  const records = ["one", "two", "three", "four", "five"].map(f.account);
  const job = f.start(records);
  await f.workbuddy.active.promise;

  const done = f.workbuddy.job(job.id);
  assert.equal(done.items[0].status, "unknown");
  assert.equal(done.items[1].status, "success");
  assert.equal(done.items[2].status, "unknown");
  assert.equal(done.items[3].status, "unknown");
  assert.equal(done.status, "stopped", "the pair after the success must still trip the breaker");
  assert.equal(done.items[4].status, "skipped");
});

test("ordinary per-account failures never trip the breaker", async (t) => {
  const f = await fixture(t, { one: "github_login", two: "github_login", three: "github_login" });
  const job = f.start([f.account("one"), f.account("two"), f.account("three")]);
  await f.workbuddy.active.promise;

  const done = f.workbuddy.job(job.id);
  assert.equal(done.status, "completed");
  assert.equal(done.items.filter((i) => i.status === "unknown").length, 3);
  assert.equal(done.items.filter((i) => i.status === "skipped").length, 0);
});
