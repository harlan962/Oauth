import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Store } from "../server/store.js";
import { createApp } from "./authenticated-app.js";
import { createChecker } from "../server/checker.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "account-management-"));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}
const record = (name) => ({
  email: `${name}@example.com`,
  username: name,
  password: "test----password",
  totp: "",
});
async function finished(checker) {
  const end = Date.now() + 10000;
  while (checker.status().running) {
    if (Date.now() > end) throw new Error("Check job did not finish");
    await new Promise((r) => setTimeout(r, 5));
  }
  return checker.status();
}

test("individual create validates duplicates and edits all four fields without exposing secrets", (t) => {
  const store = fixture(t);
  const a = store.create({ ...record("alpha"), notes: "note" });
  assert.equal(a.username, "alpha");
  assert.equal(a.password, undefined);
  assert.equal(store.secrets(a.id).password, "test----password");
  assert.throws(() => store.create(record("ALPHA")), { status: 409 });
  assert.throws(() => store.create({ ...record("beta"), password: "" }), {
    status: 400,
  });
  assert.throws(
    () => store.create({ ...record("beta"), notes: "x".repeat(2001) }),
    { status: 400 },
  );
  store.update(a.id, {
    email: "new@example.com",
    username: "renamed",
    password: "new-secret",
    totp: "JBSWY3DPEHPK3PXP",
  });
  assert.equal(store.get(a.id).email, "new@example.com");
  assert.equal(store.get(a.id).hasTotp, 1);
  assert.equal(store.secrets(a.id).password, "new-secret");
  store.update(a.id, { totp: "" });
  assert.equal(store.get(a.id).hasTotp, 0);
  assert.equal(store.secrets(a.id).password, "new-secret");
});

test("batch trash is all-or-nothing, deduplicates IDs, and restores selection metadata", (t) => {
  const store = fixture(t);
  const a = store.create({ ...record("alpha"), totp: "JBSWY3DPEHPK3PXP" }),
    b = store.create(record("beta"));
  store.setCheck(a.id, a.username, { status: "reachable", message: "test" });
  store.select(a.id, "keep me");
  assert.throws(() => store.batchTrash([a.id, "missing"], false), {
    status: 404,
  });
  assert.equal(store.get(a.id).deletedAt, null);
  assert.equal(store.batchTrash([a.id, a.id, b.id], false).changed, 2);
  assert.equal(store.batchTrash([a.id, b.id], true).changed, 2);
  assert.equal(store.get(a.id).purpose, "keep me");
  assert.ok(store.get(a.id).selectedAt);
  assert.equal(store.batchTrash([a.id, b.id], true).changed, 0);
});

test("check all covers more than 1000 active records and reports accurate per-result counts", async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => ({
    id: String(i),
    username: `qa-${i}`,
    deletedAt: null,
  }));
  rows.push({ id: "trash", username: "trash", deletedAt: "2026-10-18" });
  const saved = [];
  const store = {
    list: () => rows,
    get: (id) => rows.find((r) => r.id === id),
    setCheck: (id, name, result) => {
      saved.push(id);
      return true;
    },
  };
  const checker = createChecker(
    store,
    async (url) =>
      new Response(
        JSON.stringify({ login: url.split("/").pop(), type: "User" }),
      ),
    0,
  );
  checker.startAll();
  const result = await finished(checker);
  assert.equal(result.total, 1001);
  assert.equal(result.scope, 'all');
  assert.equal(result.done, 1001);
  assert.equal(result.counts.reachable, 1001);
  assert.equal(saved.includes("trash"), false);
});

test("a single rate-limited request retains its stop reason and summary", async (t) => {
  const store = fixture(t),
    row = store.create(record("alpha"));
  const checker = createChecker(
    store,
    async () => new Response("{}", { status: 429 }),
    0,
  );
  checker.start([row.id]);
  const result = await finished(checker);
  assert.equal(result.counts.limited, 0);
  assert.equal(result.done, 0);
  assert.equal(result.phase, 'manual');
  assert.equal(result.canResume, true);
  assert.match(result.message, /限流|拒绝/);
  assert.notEqual(result.message, "检查完成");
});

test("HTTP create, explicit all scope, single check and batch deletion", async (t) => {
  const store = fixture(t);
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { app, checker } = createApp(store, {
    allowedHosts: [new URL(base).host],
    delayMs: 0,
    fetcher: async (url) =>
      new Response(
        JSON.stringify({ login: url.split("/").pop(), type: "User" }),
      ),
  });
  server.on("request", app);
  const post = (path, body) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "X-Local-Client": "account-desk",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const created = await post("/api/accounts", record("alpha"));
  assert.equal(created.status, 201);
  const a = await created.json();
  const b = await (await post("/api/accounts", record("beta"))).json();
  assert.equal((await post("/api/checks", { scope: "all" })).status, 200);
  assert.equal((await finished(checker)).done, 2);
  assert.equal(
    (await post("/api/accounts/" + a.id + "/check", {})).status,
    200,
  );
  assert.equal((await finished(checker)).done, 1);
  assert.equal(
    (await post("/api/accounts/batch", { action: "erase", ids: [a.id] }))
      .status,
    400,
  );
  assert.equal(
    (await post("/api/accounts/batch", { action: "trash", ids: [b.id] }))
      .status,
    200,
  );
  await post("/api/checks", { scope: "all" });
  assert.equal((await finished(checker)).total, 1);
});
