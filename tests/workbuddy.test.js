import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import { createApp } from "./authenticated-app.js";
import { WorkBuddyService } from "../server/workbuddy.js";
import { createServer } from "node:http";
import { OAuthSession } from "../server/oauth-browser.js";

const secret = "workbuddy-api-secret";
async function fixture(t, { fetcher, browser, allowedHosts, accountTimeoutMs = 1000, retryDelayMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "workbuddy-test-"));
  const store = new Store(dir);
  let serial = 0;
  const calls = [];
  const result = createApp(store, {
    allowedHosts,
    integrationDelayMs: 0,
    workbuddyRetry: { accountTimeoutMs, retryDelayMs },
    integrationFetcher: async (url, opts) => {
      calls.push({ url, opts });
      if (fetcher) return fetcher(url, opts);
      if (url.endsWith("login/start"))
        return Response.json({
          ok: true,
          realm: "global",
          state: "device-" + ++serial,
          url: "https://www.workbuddy.ai/auth?state=device-" + serial,
        });
      return Response.json({
        done: true,
        uid: "uid-" + serial,
        realm: "global",
        nickname: "Untrusted display name",
      });
    },
    oauthBrowser: browser || {
      async open({ account }) {
        return {
          async step() {
            return {
              status: "verified",
              githubUsername: account.username,
              callbackVerified: true,
            };
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
  assert.ok(result.workbuddy, "createApp must expose the WorkBuddy queue");
  const target = result.integrations.save({
    name: "Test",
    baseUrl: "https://example.test",
    apiKey: secret,
  });
  function account(name) {
    const a = store.create({
      username: name,
      email: name + "@example.test",
      password: "Password-very-secret",
      totp: "JBSWY3DPEHPK3PXP",
    });
    store.setCheck(a.id, name, { status: "reachable", message: "reachable" });
    return a;
  }
  function body(accounts, requestId = "request-" + Date.now()) {
    return {
      targetId: target.id,
      targetRevision: target.revision,
      count: accounts.length,
      accountIds: accounts.map((a) => a.id),
      realm: "global",
      requestId,
    };
  }
  return { ...result, store, target, account, body, calls, dir };
}
async function settle(service) {
  await service.active?.promise;
}

test("cancel keeps the account reserved until the real OAuthSession finishes closing", async (t) => {
  let releaseClose, startedClose, wakeStep;
  const closing = new Promise((resolve) => {
    startedClose = resolve;
  });
  const closeGate = new Promise((resolve) => {
    releaseClose = resolve;
  });
  const stepGate = new Promise((resolve) => {
    wakeStep = resolve;
  });
  const f = await fixture(t, {
    browser: {
      async open() {
        const session = new OAuthSession(
          {
            async close() {
              startedClose();
              wakeStep();
              await closeGate;
            },
          },
          {},
          () => ({}),
        );
        session.step = async () => {
          await stepGate;
          return { status: "manual" };
        };
        return session;
      },
    },
  });
  const a = f.account("closing-race");
  const job = f.workbuddy.start(f.body([a]));
  while (!f.workbuddy.active.session)
    await new Promise((resolve) => setImmediate(resolve));
  const stopping = f.workbuddy.cancel(job.id);
  await closing;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.store.get(a.id).reservedBy, job.id);
  assert.equal(f.workbuddy.active.id, job.id);
  assert.equal(f.workbuddy.job(job.id).running, true);
  releaseClose();
  await stopping;
  assert.equal(f.store.get(a.id).reservedBy, null);
  assert.equal(f.workbuddy.job(job.id).running, false);
});

test("queue sends decrypted proxy only to isolated browser and publishes safe diagnostic reasons", async (t) => {
  let received;
  const f = await fixture(t, {
    browser: {
      async open(args) {
        received = args.proxy;
        return {
          async step() {
            return {
              status: "manual",
              reason: "provider_missing",
              message: "unsafe-secret",
            };
          },
          async close() {},
        };
      },
    },
  });
  const proxy = {
    server: "http://127.0.0.1:7890",
    username: "test-user",
    password: "secret-proxy-password",
  };
  const target = f.integrations.save(
    { ...f.target, apiKey: "", browserProxy: proxy },
    f.target.id,
  );
  const account = f.account("proxy-one");
  const job = f.workbuddy.start({
    ...f.body([account]),
    targetRevision: target.revision,
  });
  await settle(f.workbuddy);
  assert.deepEqual(received, proxy);
  const done = f.workbuddy.job(job.id);
  assert.equal(done.status, "completed");
  assert.match(done.items[0].message, /GitHub.*入口/);
  assert.ok(!JSON.stringify(done).includes("unsafe-secret"));
  assert.ok(!JSON.stringify(done).includes(proxy.password));
  assert.ok(!JSON.stringify(f.calls).includes(proxy.password));
  assert.equal(f.calls.length, 1);
  assert.doesNotThrow(() => f.integrations.save({ ...target, browserProxy: null }, target.id));
});

test("preview has no upstream side effects and excludes stale, selected, deleted accounts", async (t) => {
  const f = await fixture(t);
  const a = f.account("one");
  f.account("selected");
  f.store.select(f.store.list().find((a) => a.username === "selected").id);
  const stale = f.account("stale");
  f.store.db
    .prepare("UPDATE accounts SET checkedAt=? WHERE id=?")
    .run("2020-01-01", stale.id);
  const deleted = f.account("deleted");
  f.store.trash(deleted.id);
  assert.deepEqual(
    f.workbuddy.candidates().accounts.map((x) => x.id),
    [a.id],
  );
  const p = f.workbuddy.preview(f.body([a]));
  assert.equal(p.count, 1);
  assert.equal(p.accounts[0].username, "one");
  assert.equal(f.calls.length, 0);
  assert.throws(
    () => f.workbuddy.preview({ ...f.body([a]), realm: "cn" }),
    /Global|国际/,
  );
  assert.throws(
    () => f.workbuddy.preview({ ...f.body([a]), targetRevision: "old" }),
    /配置/,
  );
});

test("serial successful jobs reserve accounts, map UID, mark used transactionally and deduplicate request IDs", async (t) => {
  const f = await fixture(t);
  const a = f.account("one"),
    b = f.account("two");
  const body = f.body([a, b]);
  const job = f.workbuddy.start(body);
  assert.ok(f.store.get(a.id).reservedBy);
  assert.throws(() => f.store.update(a.id, { notes: "edit" }), /占用/);
  for (const action of [
    () => f.store.select(a.id),
    () => f.store.release(a.id),
    () => f.store.trash(a.id),
  ])
    assert.throws(action, /占用/);
  assert.equal(f.workbuddy.start(body).id, job.id);
  assert.throws(
    () => f.workbuddy.start({ ...body, accountIds: [b.id, a.id] }),
    /重复/,
  );
  await settle(f.workbuddy);
  const done = f.workbuddy.job(job.id);
  assert.equal(done.status, "completed");
  assert.deepEqual(
    done.items.map((x) => x.status),
    ["success", "success"],
  );
  assert.deepEqual(
    done.items.map((x) => x.uid),
    ["uid-1", "uid-2"],
  );
  assert.ok(
    done.logs
      .filter((l) => /已确认国际版 UID/.test(l.message))
      .every((l) => l.level === "success"),
  );
  assert.ok(
    done.logs
      .filter((l) => /创建国际版|独立浏览器|正在确认/.test(l.message))
      .every((l) => l.level === "info"),
  );
  assert.ok(f.store.get(a.id).selectedAt);
  assert.equal(f.store.get(a.id).reservedBy, null);
  assert.deepEqual(
    f.calls.map((x) => (x.url.includes("poll") ? "poll" : "start")),
    ["start", "poll", "start", "poll"],
  );
  assert.doesNotMatch(
    JSON.stringify(done),
    /workbuddy-api-secret|Password-very-secret|device-/,
  );
  assert.equal(f.workbuddy.candidates().accounts.length, 0);
});

test("WorkBuddy restrictions persist and skip only the current account, continuing the batch", async (t) => {
  let closed = 0;
  const f = await fixture(t, {browser:{async open({account}){return {async step(){return account.username==='one'?{status:'restricted'}:{status:'verified',githubUsername:account.username,callbackVerified:true};},async close(){closed++;}};}}});
  const a=f.account('one'), b=f.account('two');
  const job=f.workbuddy.start(f.body([a,b]));
  await settle(f.workbuddy);
  const done=f.workbuddy.job(job.id);
  assert.equal(done.running,false);
  assert.equal(done.status,'completed');
  assert.deepEqual(done.items.map(i=>i.status),['restricted','success']);
  assert.equal(closed,2);
  assert.equal(f.calls.length,3,'first restricted account is not polled; second starts and polls');
  assert.equal(f.calls.filter(c=>c.url.includes('login/poll')).length,1);
  assert.equal(f.store.get(a.id).publicStatus,'reachable');
  assert.equal(f.store.get(a.id).selectedAt,null);
  assert.equal(f.store.get(a.id).reservedBy,null);
  assert.equal(f.store.get(a.id).workbuddyResult.status,'restricted');
  assert.deepEqual(f.workbuddy.candidates().accounts,[]);
  assert.throws(()=>f.workbuddy.start(f.body([a],'blocked-request')),/候选/);
  const restored=new WorkBuddyService(f.store,f.integrations,{oauthBrowser:{}});
  assert.deepEqual(restored.candidates().accounts,[]);
  assert.equal(f.store.get(a.id).workbuddyResult.status,'restricted');
});

test("a 60-account batch processes all entries with isolated browsers despite individual restrictions", async t => {
  let open=0,closed=0,previous=null;
  const f=await fixture(t,{browser:{async open({account}) {
    assert.equal(open,closed,'previous browser must close before next opens');
    if(previous) assert.equal(f.store.get(previous).reservedBy,null);
    assert.ok(f.store.get(account.id).reservedBy,'queued account remains reserved until its turn');
    previous=account.id;open++;
    return {async step(){return Number(account.username.split('-')[1])%3===0?{status:'restricted'}:{status:'verified',githubUsername:account.username,callbackVerified:true};},async close(){closed++;}};
  }}});
  const accounts=Array.from({length:60},(_,i)=>f.account(`batch-${i}`));
  const job=f.workbuddy.start(f.body(accounts));await settle(f.workbuddy);
  const done=f.workbuddy.job(job.id);
  assert.equal(done.status,'completed');assert.equal(done.running,false);
  assert.equal(done.items.filter(i=>i.status==='restricted').length,20);
  assert.equal(done.items.filter(i=>i.status==='success').length,40);
  assert.equal(done.items.filter(i=>i.status==='skipped').length,0);
  assert.equal(f.calls.length,100);assert.equal(closed,60);
  assert.ok(f.store.list().every(a=>!a.reservedBy));
});

test("stopping while a restricted browser closes prevents the next account from opening",async t=>{
  let signalClose,releaseClose;
  const started=new Promise(r=>signalClose=r),closing=new Promise(r=>releaseClose=r);
  let opened=0;
  const f=await fixture(t,{browser:{async open(){opened++;return {async step(){return {status:'restricted'};},async close(){signalClose();await closing;}};}}});
  const a=f.account('one'),b=f.account('two');
  const job=f.workbuddy.start(f.body([a,b]));await started;
  assert.equal(f.store.get(b.id).reservedBy,job.id);
  const cancelled=f.workbuddy.cancel(job.id);releaseClose();await cancelled;
  assert.equal(opened,1);assert.equal(f.calls.length,1);
  assert.deepEqual(f.workbuddy.job(job.id).items.map(i=>i.status),['restricted','skipped']);
  assert.equal(f.workbuddy.job(job.id).running,false);
});

test("restart migrates an old paused restriction before releasing its reservation", async (t) => {
  const f=await fixture(t,{browser:{async open(){return{async step(){return{status:'manual'};},async close(){}};}}});
  const a=f.account('old-restricted');const job=f.workbuddy.start(f.body([a]));await settle(f.workbuddy);
  f.store.db.prepare("UPDATE workbuddy_items SET status='restricted',message='WorkBuddy 访问受限' WHERE jobId=?").run(job.id);
  const restored=new WorkBuddyService(f.store,f.integrations,{oauthBrowser:{}});
  assert.equal(restored.job(job.id).running,false);
  assert.equal(restored.candidates().accounts.length,0);
  assert.equal(f.store.get(a.id).workbuddyResult.status,'restricted');
  assert.equal(f.store.get(a.id).reservedBy,null);
});

test("restart restores a restriction recorded before old cancellation overwrote the item", async (t) => {
  const f=await fixture(t,{browser:{async open(){return{async step(){return{status:'manual'};},async close(){}};}}});
  const a=f.account('cancelled-restricted'); const job=f.workbuddy.start(f.body([a])); await settle(f.workbuddy);
  f.workbuddy.log(job.id,'warn','WorkBuddy 访问受限，整个队列暂停；请在当前浏览器处理后继续',1);
  await f.workbuddy.cancel(job.id);
  assert.equal(f.workbuddy.job(job.id).items[0].status,'unknown');
  const restored=new WorkBuddyService(f.store,f.integrations,{oauthBrowser:{}});
  assert.equal(restored.candidates().accounts.length,0);
  assert.equal(f.store.get(a.id).workbuddyResult.status,'restricted');
});

test("missing identity evidence never polls and automatically releases all unused items", async (t) => {
  let closed = 0;
  const f = await fixture(t, {
    browser: {
      async open() {
        return {
          async step() {
            return {
              status: "verified",
              githubUsername: "someone-else",
              callbackVerified: true,
            };
          },
          async close() {
            closed++;
          },
        };
      },
    },
  });
  const a = f.account("one"),
    b = f.account("two");
  const job = f.workbuddy.start(f.body([a, b]));
  await settle(f.workbuddy);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(c => c.url.endsWith("login/start")));
  assert.equal(f.workbuddy.job(job.id).status, "completed");
  await f.workbuddy.cancel(job.id);
  await settle(f.workbuddy);
  const done = f.workbuddy.job(job.id);
  assert.equal(done.status, "completed");
  assert.equal(done.items[0].status, "unknown");
  assert.equal(done.items[0].reserved, false);
  assert.equal(done.items[1].reserved, false);
  assert.ok(closed);
  assert.throws(() => f.workbuddy.release(job.id, 1, {}), /确认/);
  f.workbuddy.release(job.id, 1, { acknowledge: true });
  assert.equal(f.store.get(a.id).reservedBy, null);
});

test("ambiguous mutating poll never retries and releases unused accounts with an unknown result", async (t) => {
  const f = await fixture(t, {
    fetcher: async (url) =>
      url.endsWith("login/start")
        ? Response.json({
            ok: true,
            realm: "global",
            state: "s",
            url: "https://www.workbuddy.ai/auth?state=s",
          })
        : (() => {
            throw new Error("raw confidential");
          })(),
  });
  const a = f.account("one"),
    b = f.account("two");
  const job = f.workbuddy.start(f.body([a, b]));
  await settle(f.workbuddy);
  const done = f.workbuddy.job(job.id);
  assert.equal(done.running, false);
  assert.equal(done.items[0].status, "unknown");
  assert.equal(done.items[0].reserved, false);
  assert.equal(f.store.get(a.id).reservedBy, null);
  assert.equal(f.store.get(a.id).workbuddyResult.status, "unknown");
  assert.equal(
    f.store.list().find((row) => row.id === a.id).workbuddyResult.status,
    "unknown",
  );
  assert.equal(done.items[1].reserved, false);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls.filter(c=>c.url.includes("login/poll")).length,1);
  assert.ok(done.items[0].finishedAt);
  assert.doesNotMatch(JSON.stringify(done), /raw confidential|state=s/);
});

test("duplicate device state cannot be polled for a second account", async (t) => {
  let polls = 0;
  const f = await fixture(t, {
    fetcher: async (url) =>
      url.endsWith("login/start")
        ? Response.json({
            ok: true,
            realm: "global",
            state: "same-state",
            url: "https://workbuddy.ai/auth?state=same-state",
          })
        : Response.json({ done: true, realm: "global", uid: "uid-" + ++polls }),
  });
  const a = f.account("one"),
    b = f.account("two");
  const job = f.workbuddy.start(f.body([a, b]));
  await settle(f.workbuddy);
  assert.equal(polls, 1);
  assert.deepEqual(
    f.workbuddy.job(job.id).items.map((x) => x.status),
    ["success", "unknown"],
  );
});

test("untrusted login URL cannot reach browser or mark an account used", async (t) => {
  let opened = false;
  const f = await fixture(t, {
    fetcher: async () =>
      Response.json({
        ok: true,
        realm: "global",
        state: "s",
        url: "https://workbuddy.ai.evil.test/auth",
      }),
    browser: {
      async open() {
        opened = true;
      },
    },
  });
  const a = f.account("one");
  const job = f.workbuddy.start(f.body([a]));
  await settle(f.workbuddy);
  assert.equal(opened, false);
  assert.equal(f.workbuddy.job(job.id).items[0].status, "unknown");
  assert.equal(f.store.get(a.id).selectedAt, null);
});

test("browser close failures cannot downgrade a committed success", async (t) => {
  const f = await fixture(t, {
    browser: {
      async open({ account }) {
        return {
          async step() {
            return {
              status: "verified",
              githubUsername: account.username,
              callbackVerified: true,
            };
          },
          async close() {
            throw new Error("browser gone");
          },
        };
      },
    },
  });
  const a = f.account("one");
  const job = f.workbuddy.start(f.body([a]));
  await settle(f.workbuddy);
  assert.equal(f.workbuddy.job(job.id).items[0].status, "success");
  assert.equal(f.workbuddy.job(job.id).status, "completed");
});

test("browser availability is checked before reserving accounts or starting upstream sessions", async (t) => {
  const f = await fixture(t, {
    browser: {
      assertAvailable() {
        throw new Error("Install browser");
      },
      async open() {
        throw new Error("must not open");
      },
    },
  });
  const a = f.account("one");
  assert.throws(() => f.workbuddy.start(f.body([a])), /Install browser/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.get(a.id).reservedBy, null);
});

test("recovery keeps unknown records but releases all unused accounts without requests", async (t) => {
  const f = await fixture(t, {
    browser: {
      async open() {
        return {
          async step() {
            return { status: "manual" };
          },
          async close() {},
        };
      },
    },
  });
  const a = f.account("one"),
    b = f.account("two");
  const job = f.workbuddy.start(f.body([a, b]));
  await settle(f.workbuddy);
  f.store.db.prepare("UPDATE workbuddy_jobs SET running=1,status='paused' WHERE id=?").run(job.id);
  f.store.db.prepare("UPDATE workbuddy_items SET status=CASE WHEN position=1 THEN 'manual' ELSE 'queued' END,reserved=1 WHERE jobId=?").run(job.id);
  for(const account of [a,b]) f.store.db.prepare("UPDATE accounts SET reservedBy=? WHERE id=?").run(job.id,account.id);
  const callsBeforeRecovery=f.calls.length;
  const restored = new WorkBuddyService(f.store, f.integrations, {
    oauthBrowser: {
      async open() {
        throw new Error("no restart");
      },
    },
  });
  const recovered = restored.job(job.id);
  assert.equal(recovered.running, false);
  assert.equal(recovered.status, "stopped");
  assert.deepEqual(
    recovered.items.map((x) => [x.status, x.reserved]),
    [
      ["unknown", false],
      ["skipped", false],
    ],
  );
  assert.equal(f.calls.length, callsBeforeRecovery);
});

test("old stopped reservations are reconciled with accurate messages on upgrade", async (t) => {
  const f = await fixture(t, {
    browser: {
      async open() {
        return {
          async step() {
            return { status: "manual" };
          },
          async close() {},
        };
      },
    },
  });
  const a = f.account("upgrade");
  const job = f.workbuddy.start(f.body([a]));
  await settle(f.workbuddy);
  f.store.db
    .prepare("UPDATE workbuddy_jobs SET running=0,status='stopped' WHERE id=?")
    .run(job.id);
  f.store.db
    .prepare(
      "UPDATE workbuddy_items SET reserved=1,status='unknown',message='任务停止，远端结果未知；保留占用' WHERE jobId=?",
    )
    .run(job.id);
  const restored = new WorkBuddyService(f.store, f.integrations, {
    oauthBrowser: {},
  });
  assert.equal(f.store.get(a.id).reservedBy, null);
  assert.match(restored.job(job.id).items[0].message, /已自动释放/);
  assert.doesNotMatch(f.store.get(a.id).workbuddyResult.message, /保留占用/);
});

test("successful mappings remain excluded even if the generic selection marker is manually cleared", async (t) => {
  const f = await fixture(t);
  const a = f.account("successful");
  f.workbuddy.start(f.body([a]));
  await settle(f.workbuddy);
  f.store.release(a.id);
  assert.equal(f.workbuddy.candidates().accounts.length, 0);
  assert.equal(f.store.get(a.id).workbuddyResult.status, "success");
});

test("stale public checks after reservation cannot prevent confirmed UID mapping", async (t) => {
  let f;
  f = await fixture(t, {
    browser: {
      async open({ account }) {
        return {
          async step() {
            f.store.db
              .prepare(
                "UPDATE accounts SET checkedAt='2020-01-01',publicStatus='unknown' WHERE id=?",
              )
              .run(account.id);
            return {
              status: "verified",
              githubUsername: account.username,
              callbackVerified: true,
            };
          },
          async close() {},
        };
      },
    },
  });
  const a = f.account("one");
  const job = f.workbuddy.start(f.body([a]));
  await settle(f.workbuddy);
  assert.equal(f.workbuddy.job(job.id).items[0].status, "success");
  assert.ok(f.store.get(a.id).selectedAt);
});

test("invalid poll success payloads and UID collisions never falsely select another local identity", async (t) => {
  let starts = 0;
  const f = await fixture(t, {
    fetcher: async (url) =>
      url.endsWith("login/start")
        ? Response.json({
            ok: true,
            realm: "global",
            state: "d-" + ++starts,
            url: "https://workbuddy.ai/auth?state=d-" + starts,
          })
        : Response.json({ done: true, realm: "global", uid: "same-uid" }),
  });
  const a = f.account("one"),
    b = f.account("two");
  const job = f.workbuddy.start(f.body([a, b]));
  await settle(f.workbuddy);
  assert.deepEqual(
    f.workbuddy.job(job.id).items.map((x) => x.status),
    ["success", "unknown"],
  );
  assert.equal(f.store.get(b.id).selectedAt, null);
  assert.equal(f.store.get(b.id).reservedBy, null);
});

test("cancel during login/start waits once then releases the in-flight reservation", async (t) => {
  let release, entered;
  const ready = new Promise((r) => (entered = r));
  const f = await fixture(t, {
    fetcher: async () => {
      entered();
      await new Promise((r) => (release = r));
      return Response.json({
        ok: true,
        realm: "global",
        state: "s",
        url: "https://workbuddy.ai/auth?state=s",
      });
    },
  });
  const a = f.account("one"),
    b = f.account("two");
  const job = f.workbuddy.start(f.body([a, b]));
  await ready;
  const stopping = f.workbuddy.cancel(job.id);
  assert.ok(
    f.store.get(a.id).reservedBy,
    "do not release while request is still pending",
  );
  release();
  await stopping;
  assert.equal(f.calls.length, 1);
  assert.deepEqual(
    f.workbuddy.job(job.id).items.map((x) => [x.status, x.reserved]),
    [
      ["unknown", false],
      ["skipped", false],
    ],
  );
});

test("a running legacy worker blocks new WorkBuddy jobs before any reservation", async (t) => {
  let release, entered;
  const ready = new Promise((r) => (entered = r));
  const f = await fixture(t, {
    fetcher: async () => {
      entered();
      await new Promise((r) => (release = r));
      return Response.json({
        ok: true,
        realm: "global",
        state: "s",
        url: "https://workbuddy.ai/auth?state=s",
      });
    },
  });
  const a = f.account("one");
  f.integrations.start({
    targetId: f.target.id,
    targetRevision: f.target.revision,
    count: 1,
    realm: "global",
    requestId: "legacy-before-new",
  });
  await ready;
  assert.throws(() => f.workbuddy.start(f.body([a])), /任务/);
  assert.equal(f.store.get(a.id).reservedBy, null);
  release();
  await f.integrations.active.promise;
});

test("HTTP WorkBuddy API preserves public contracts and local request protections", async (t) => {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  const f = await fixture(t, {
    allowedHosts: ["127.0.0.1:" + server.address().port],
  });
  server.on("request", f.app);
  const base = "http://127.0.0.1:" + server.address().port + "/api/workbuddy";
  const call = async (path, method = "GET", body) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        host: "127.0.0.1:4318",
        "x-local-client": "account-desk",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  const a = f.account("one");
  const candidates = await call("/candidates");
  assert.equal(candidates.status, 200, JSON.stringify(candidates));
  assert.equal(candidates.data.accounts[0].id, a.id);
  assert.equal((await call("/preview", "POST", f.body([a]))).status, 200);
  const started = await call("/jobs", "POST", f.body([a]));
  assert.equal(started.status, 202);
  await settle(f.workbuddy);
  const job = await call("/jobs/" + started.data.id);
  assert.equal(job.data.items[0].status, "success");
  assert.equal((await call("/jobs")).data[0].id, started.data.id);
  assert.equal(
    (await call("/jobs/" + started.data.id + "/resume", "POST", {})).status,
    409,
  );
  assert.equal(
    (
      await call("/jobs/" + started.data.id + "/items/1/release", "POST", {
        acknowledge: true,
      })
    ).status,
    409,
  );
  const untrusted = await fetch(base + "/candidates", {
    headers: { host: "127.0.0.1:4318" },
  });
  assert.equal(untrusted.status, 403);
});

test('automatic retries recover network failures without creating another remote session', async t => {
  let steps = 0, retries = 0;
  const f = await fixture(t, { browser: { async open({account}) { return {
    async step() { return ++steps < 3 ? {status:'manual',reason:'network'} : {status:'verified',githubUsername:account.username,callbackVerified:true}; },
    async retryNavigation() { retries++; }, async close() {},
  }; } } });
  const job=f.workbuddy.start(f.body([f.account('recover')])); await settle(f.workbuddy);
  const done=f.workbuddy.job(job.id);
  assert.equal(done.items[0].status,'success');
  assert.equal(retries,2);
  assert.equal(f.calls.filter(c=>c.url.endsWith('login/start')).length,1);
  assert.equal(done.logs.filter(l=>/自动重试/.test(l.message)).length,2);
});

test('browser diagnostics persist per account while restriction and missing identity continue automatically', async t => {
  const f = await fixture(t, { browser: { async open({ account }) { return {
    async step() {
      if (account.username === 'restricted') return { status: 'restricted', reason: 'account_security' };
      if (account.username === 'missing') return { status: 'manual', reason: 'github_identity_missing' };
      return { status: 'verified', githubUsername: account.username, callbackVerified: true };
    },
    diagnostic() { return account.username === 'restricted' ? '阶段=WorkBuddy 首次关联；HTTP=403' : '阶段=WorkBuddy 登录结果；HTTP=200；身份=false；回调=true'; },
    async close() {},
  }; } } });
  const job = f.workbuddy.start(f.body([f.account('restricted'), f.account('missing'), f.account('good')]));
  await settle(f.workbuddy);
  const done = f.workbuddy.job(job.id);
  assert.deepEqual(done.items.map(item => item.status), ['restricted', 'unknown', 'success']);
  assert.match(done.items[1].message, /已收到 WorkBuddy 回调.*缺少 GitHub 身份证据/);
  assert.equal(done.logs.filter(log => log.position === 1 && /浏览器诊断.*HTTP=403/.test(log.message)).length, 1);
  assert.equal(done.logs.filter(log => log.position === 2 && /浏览器诊断.*身份=false；回调=true/.test(log.message)).length, 4);
  assert.equal(f.calls.filter(call => call.url.includes('login/poll')).length, 1);
});

test('automatic retry exhaustion closes and releases only the failed account then processes the next', async t => {
  let steps=0, closed=0;
  const f=await fixture(t,{browser:{async open({account}){ return {
    async step(){ if(account.username==='bad'){steps++;return {status:'manual',reason:'network'};} assert.equal(closed,1);return {status:'verified',githubUsername:account.username,callbackVerified:true}; },
    async retryNavigation(){}, async close(){closed++;},
  };}}});
  const a=f.account('bad'), b=f.account('good');
  const job=f.workbuddy.start(f.body([a,b]));await settle(f.workbuddy);
  const done=f.workbuddy.job(job.id);
  assert.equal(done.status,'completed');
  assert.deepEqual(done.items.map(i=>i.status),['unknown','success']);
  assert.equal(steps,4);assert.equal(closed,2);
  assert.match(done.items[0].message,/网络.*4.*继续/);
  assert.equal(f.store.get(a.id).publicStatus,'reachable');
  assert.equal(f.store.get(a.id).reservedBy,null);
  assert.equal(f.calls.length,3);
});

test('email device verification skips immediately without retries and runs the next account', async t => {
  let emailSteps = 0, closed = 0;
  const f = await fixture(t, { browser: { async open({ account }) { return {
    async step() {
      if (account.username === 'emailchallenge') { emailSteps++; return { status: 'manual', reason: 'github_email_device_verification' }; }
      assert.equal(closed, 1);
      return { status: 'verified', githubUsername: account.username, callbackVerified: true };
    },
    async close() { closed++; },
  }; } } });
  const a = f.account('emailchallenge'), b = f.account('good');
  const job = f.workbuddy.start(f.body([a, b]));
  await settle(f.workbuddy);
  const done = f.workbuddy.job(job.id);
  assert.equal(emailSteps, 1);
  assert.equal(closed, 2);
  assert.deepEqual(done.items.map(item => item.status), ['unknown', 'success']);
  assert.match(done.items[0].message, /需要邮箱验证码.*自动跳过.*下一个账号/);
  assert.equal(done.logs.filter(log => log.position === 1 && /自动重试/.test(log.message)).length, 0);
  assert.equal(f.store.get(a.id).reservedBy, null);
  assert.equal(f.calls.filter(call => call.url.includes('login/poll')).length, 1);
});

test('automatic account deadline handles a hung step and ignores its late success', async t => {
  let late, closed=0;
  const f=await fixture(t,{accountTimeoutMs:30,browser:{async open({account}){return {
    async step(){return account.username==='hung'?new Promise(r=>late=r):{status:'verified',githubUsername:account.username,callbackVerified:true};},
    async close(){closed++;},
  };}}});
  const a=f.account('hung'), b=f.account('next');
  const job=f.workbuddy.start(f.body([a,b]));await settle(f.workbuddy);
  late({status:'verified',githubUsername:'hung',callbackVerified:true});await new Promise(r=>setImmediate(r));
  assert.deepEqual(f.workbuddy.job(job.id).items.map(i=>i.status),['unknown','success']);
  assert.equal(f.calls.length,3);assert.equal(closed,2);assert.equal(f.store.get(a.id).selectedAt,null);
});

test('automatic queue continues after an ambiguous poll without replaying it',async t=>{
  let starts=0,polls=0;
  const f=await fixture(t,{fetcher:async url=>{
    if(url.endsWith('login/start'))return Response.json({ok:true,realm:'global',state:'s'+(++starts),url:'https://www.workbuddy.ai/auth?state=s'+starts});
    if(++polls===1)throw new Error('private response');
    return Response.json({done:true,realm:'global',uid:'good-uid'});
  }});
  const job=f.workbuddy.start(f.body([f.account('first'),f.account('second')]));await settle(f.workbuddy);
  assert.deepEqual(f.workbuddy.job(job.id).items.map(i=>i.status),['unknown','success']);
  assert.equal(starts,2);assert.equal(polls,2);
  assert.doesNotMatch(JSON.stringify(f.workbuddy.job(job.id)),/private response/);
});

test('automatic retries remain cancellable during backoff without opening another account', async t=>{
  let stepped;
  const entered=new Promise(r=>stepped=r);
  const f=await fixture(t,{retryDelayMs:10000,accountTimeoutMs:20000,browser:{async open(){return {async step(){stepped();return {status:'manual',reason:'network'};},async close(){}};}}});
  const job=f.workbuddy.start(f.body([f.account('stop-first'),f.account('stop-next')]));
  await entered;await new Promise(r=>setImmediate(r));
  await f.workbuddy.cancel(job.id);
  assert.deepEqual(f.workbuddy.job(job.id).items.map(i=>i.status),['unknown','skipped']);
  assert.equal(f.calls.length,1);
});

test('automatic timeout disposes a browser that opens late and cannot use it for the next account',async t=>{
  let resolveOpen,lateClosed=0;
  const f=await fixture(t,{accountTimeoutMs:30,browser:{async open({account}){
    if(account.username==='slow-open')return new Promise(r=>resolveOpen=r);
    return {async step(){return {status:'verified',githubUsername:account.username,callbackVerified:true};},async close(){}};
  }}});
  const job=f.workbuddy.start(f.body([f.account('slow-open'),f.account('fast-open')]));await settle(f.workbuddy);
  // The account timeout can fire before the browser reports its pending open.
  // Wait for that open to register instead of racing the scheduler: without it
  // the test fails on timing alone rather than on the behaviour it asserts.
  for(let i=0;i<100&&!resolveOpen;i++) await new Promise(r=>setImmediate(r));
  assert.ok(resolveOpen,'expected the first account to be sitting in an unopened browser');
  resolveOpen({async step(){throw new Error('late browser must not run');},async close(){lateClosed++;}});
  await new Promise(r=>setImmediate(r));
  assert.equal(lateClosed,1);assert.equal(f.calls.length,3);
  assert.deepEqual(f.workbuddy.job(job.id).items.map(i=>i.status),['unknown','success']);
});

test('automatic queue continues when remote poll is not done and never replays that poll',async t=>{
  let starts=0;
  const f=await fixture(t,{fetcher:async url=>url.endsWith('login/start')
    ?Response.json({ok:true,realm:'global',state:'state'+(++starts),url:'https://www.workbuddy.ai/auth?state='+starts})
    :Response.json(starts===1?{done:false}:{done:true,realm:'global',uid:'next-uid'})});
  const job=f.workbuddy.start(f.body([f.account('pending'),f.account('next')]));await settle(f.workbuddy);
  assert.deepEqual(f.workbuddy.job(job.id).items.map(i=>i.status),['unknown','success']);
  assert.equal(f.calls.length,4);
});
