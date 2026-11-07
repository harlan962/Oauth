import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { parseImport } from "../server/parser.js";
import { encrypt, decrypt, totpCode } from "../server/crypto.js";
import { Store } from "../server/store.js";
import { checkGithub, createChecker } from "../server/checker.js";
import { createApp } from "./authenticated-app.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "account-desk-test-"));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, dir };
}
test("import accepts optional secrets, preserves password spaces, and reports safe errors", () => {
  const parsed = parseImport(
    "\uFEFFa@example.com---- secret ----alice\r\nb@example.com----p----bob----jbsw y3dp ehpk 3pxp\ninvalid----DO-NOT-LEAK",
  );
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.records[0].password, " secret ");
  assert.equal(parsed.records[1].totp, "JBSWY3DPEHPK3PXP");
  assert.equal(parsed.errors[0].line, 3);
  assert.ok(!JSON.stringify(parsed.errors).includes("DO-NOT-LEAK"));
  assert.equal(parseImport("a@b.com----p----bad--name").errors.length, 1);
  assert.equal(parseImport("a@b.com----p----alice----123456").errors.length, 1);
  assert.throws(() => parseImport("x".repeat(1024 * 1024 + 1)));
});
test("encryption authenticates ciphertext; TOTP matches RFC 6238 vector", () => {
  const key = randomBytes(32),
    value = encrypt("unique-sensitive-value", key);
  assert.equal(decrypt(value, key), "unique-sensitive-value");
  assert.throws(() => decrypt(value, randomBytes(32)));
  assert.equal(
    totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59000).code,
    "287082",
  );
});
test("dedup, encrypted persistence, soft deletion and restoration", (t) => {
  const { store, dir } = fixture(t);
  const result = store.import(
    "a@example.com----secret-value-123----alice\nA@example.com----other----bob\nb@example.com----p----ALICE",
  );
  assert.equal(result.imported, 1);
  assert.equal(result.duplicates, 2);
  const row = store.list()[0];
  assert.equal(row.password, undefined);
  assert.equal(store.secrets(row.id).password, "secret-value-123");
  store.trash(row.id);
  assert.throws(() => store.get(row.id));
  assert.equal(store.import("a@example.com----x----alice").duplicates, 1);
  store.trash(row.id, true);
  assert.equal(store.get(row.id).deletedAt, null);
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  assert.ok(
    !readFileSync(join(dir, "accounts.sqlite")).includes(
      Buffer.from("secret-value-123"),
    ),
  );
  const reopened = new Store(dir);
  assert.equal(reopened.secrets(row.id).password, "secret-value-123");
  reopened.close();
});
test("selection is persisted, prevents duplicates and excludes stale accounts without legacy manual gating", (t) => {
  const { store } = fixture(t);
  store.import("a@example.com----p----alice----JBSWY3DPEHPK3PXP\nb@example.com----p----bob----JBSWY3DPEHPK3PXP");
  const [a, b] = store.list();
  assert.throws(() => store.select(a.id));
  store.setCheck(a.id, a.username, { status: "reachable", message: "ok" });
  assert.equal(store.select(undefined, "测试用途").id, a.id);
  assert.throws(() => store.select(a.id));
  assert.throws(() => store.select());
  store.release(a.id);
  store.db.prepare("UPDATE accounts SET risk='flagged' WHERE id=?").run(a.id);
  assert.throws(() => store.update(a.id, { risk: "clear" }), { status: 400 });
  store.setCheck(a.id, a.username, { status: "reachable", message: "ok" });
  assert.equal(store.get(a.id).risk, undefined);
  assert.equal(store.select(a.id).id, a.id);
  store.release(a.id);
  assert.equal(store.select().id, a.id);
  store.setCheck(b.id, b.username, { status: "reachable", message: "ok" });
  store.db
    .prepare("UPDATE accounts SET checkedAt=? WHERE id=?")
    .run("2020-01-01T00:00:00.000Z", b.id);
  assert.throws(() => store.select(b.id));
  store.update(b.id, { username: "renamed" });
  assert.equal(store.get(b.id).publicStatus, "unchecked");
  store.setCheck(b.id, b.username, {
    status: "reachable",
    message: "old in-flight response",
  });
  assert.equal(store.get(b.id).publicStatus, "unchecked");
});
test("GitHub check does not conflate reachability, missing, rate limits and network failure", async () => {
  for (const [code, status] of [
    [200, "reachable"],
    [404, "missing"],
    [403, "limited"],
    [429, "limited"],
    [500, "error"],
  ]) {
    const result = await checkGithub(
      "alice",
      async () =>
        new Response(JSON.stringify({ login: "alice", type: "User" }), {
          status: code,
        }),
    );
    assert.equal(result.status, status);
  }
  assert.equal(
    (
      await checkGithub("alice", async () => {
        throw new Error("offline");
      })
    ).status,
    "error",
  );
  assert.equal(
    (
      await checkGithub(
        "alice",
        async () =>
          new Response(JSON.stringify({ login: "bob", type: "User" })),
      )
    ).status,
    "error",
  );
});
test("batch stops on rate limit and cancelled requests do not overwrite state", async (t) => {
  const { store } = fixture(t);
  store.import("a@example.com----p----alice\nb@example.com----p----bob");
  let calls = 0;
  const checker = createChecker(
    store,
    async () => {
      calls++;
      return new Response("{}", { status: 429 });
    },
    0,
  );
  checker.start(store.list().map((r) => r.id));
  assert.throws(() => checker.start([store.list()[0].id]));
  while (checker.status().running) await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 1);
  assert.equal(checker.status().done, 0);
  assert.equal(checker.status().phase, 'manual');
  assert.equal(checker.status().canResume, true);
  const cancel = createChecker(
    store,
    async (_, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        }),
      ),
    0,
  );
  const row = store.list().find((r) => r.publicStatus === "unchecked");
  cancel.start([row.id]);
  cancel.cancel();
  while (cancel.status().running) await new Promise((r) => setTimeout(r, 5));
  assert.equal(store.get(row.id).publicStatus, "unchecked");
});
test("HTTP API guards local boundaries and does not leak secrets in preview or list", async (t) => {
  const { store } = fixture(t);
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const { app } = createApp(store, {
    allowedHosts: [`127.0.0.1:${server.address().port}`],
  });
  server.on("request", app);
  const headers = {
    Host: "127.0.0.1:4318",
    "X-Local-Client": "account-desk",
    "Content-Type": "application/json",
  };
  assert.equal((await fetch(url + "/api/accounts")).status, 403);
  assert.equal(
    (await fetch(url + "/api/accounts", { headers: { Host: headers.Host } }))
      .status,
    403,
  );
  assert.equal(
    (
      await fetch(url + "/api/accounts", {
        headers: { ...headers, Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const payload = JSON.stringify({
    text: "a@example.com----never-leak-this----alice",
  });
  const preview = await fetch(url + "/api/import/preview", {
    method: "POST",
    headers,
    body: payload,
  });
  assert.equal(preview.status, 200);
  assert.ok(!(await preview.text()).includes("never-leak-this"));
  const imported = await fetch(url + "/api/import", {
    method: "POST",
    headers,
    body: payload,
  });
  assert.equal((await imported.json()).imported, 1);
  const list = await fetch(url + "/api/accounts", { headers });
  assert.ok(!(await list.text()).includes("never-leak-this"));
  assert.equal(
    (await fetch(url + "/api/import", { method: "POST", headers, body: "{}" }))
      .status,
    400,
  );
});
