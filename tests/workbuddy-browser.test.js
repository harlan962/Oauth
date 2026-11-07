import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const mod = await import("../server/oauth-browser.js").catch(() => ({}));

test("dedicated browser launch passes a fixed proxy and never attaches personal profiles", async () => {
  const launches = [],
    contexts = [];
  const page = {
    async goto() {},
    url: () => "https://www.workbuddy.ai/auth",
    isClosed: () => false,
  };
  const engine = {
    executablePath: () => process.execPath,
    async launch(options) {
      launches.push(options);
      return {
        async newContext(options) {
          contexts.push(options);
          return {
            on() {},
            async newPage() {
              return page;
            },
            pages: () => [page],
            async close() {},
          };
        },
        async close() {},
      };
    },
  };
  const browser = new mod.OAuthBrowser({ chromium: engine });
  assert.equal(
    browser.chromium,
    engine,
    "use only the injected test engine before opening any page",
  );
  const proxy = {
    server: "http://127.0.0.1:7890",
    username: "u",
    password: "p",
  };
  const a = await browser.open({
    url: page.url(),
    account: { username: "one" },
    getSecrets() {},
    proxy,
  });
  const b = await browser.open({
    url: page.url(),
    account: { username: "two" },
    getSecrets() {},
  });
  assert.equal(launches.length, 2);
  assert.deepEqual(launches[0].proxy, proxy);
  assert.equal(launches[0].executablePath, process.execPath);
  assert.equal(launches[0].headless, false);
  assert.equal(launches[0].channel, undefined);
  assert.equal(launches[0].userDataDir, undefined);
  assert.equal(launches[1].proxy, undefined);
  assert.ok(launches[1].args?.includes("--no-proxy-server"), "direct mode explicitly bypasses system proxy settings");
  assert.ok(contexts.every((x) => !x.storageState));
  assert.notEqual(a.context, b.context);
  await a.close();
  await b.close();
});

test("missing project browser never falls back to installed Edge or Chrome", () => {
  const browser = new mod.OAuthBrowser({
    chromium: {
      executablePath: () =>
        join(tmpdir(), "not-installed-project-browser", "chrome.exe"),
    },
  });
  assert.throws(() => browser.assertAvailable(), /browser:install/);
});

test("provider absence and navigation failures report distinct safe reasons", async () => {
  const f = fakePage({
    url: "https://www.workbuddy.ai/auth",
    text: "邮箱登录",
  });
  const session = new mod.OAuthSession(
    { pages: () => [f.page] },
    { username: "one" },
    () => {
      throw new Error("must not read secrets");
    },
  );
  assert.equal((await session.step()).reason, "provider_missing");
  session.navigationFailure = "network";
  assert.equal((await session.step()).reason, "network");
});

test("proxy failures during provider clicks are diagnosed on the first pause", async () => {
  const f = fakePage({ url: "https://www.workbuddy.ai/auth" });
  const session = new mod.OAuthSession(
    { pages: () => [f.page] },
    { username: "one" },
    () => ({}),
  );
  f.page.getByRole = (role) => ({
    count: async () => (role === "button" ? 1 : 0),
    click: async () => {
      session.navigationFailure = "proxy";
      throw new Error("raw URL containing secret must not escape");
    },
  });
  assert.deepEqual(await session.step(), { status: "manual", reason: "proxy" });
});
test("browser rejects lookalike, credential-bearing and nonstandard-port origins", () => {
  assert.equal(
    typeof mod.trustedOrigin,
    "function",
    "browser security boundary must exist",
  );
  for (const url of [
    "http://github.com/login",
    "https://github.com.evil.test",
    "https://x@github.com",
    "https://github.com:8443/login",
    "https://www.workbuddy.ai.evil.test",
  ])
    assert.equal(mod.trustedOrigin(url), null);
  assert.equal(mod.trustedOrigin("https://github.com/login"), "github");
  assert.equal(mod.trustedOrigin("https://www.workbuddy.ai/auth"), "workbuddy");
});

function fakePage({
  url = "https://github.com/sessions/two-factor/app",
  fields = {},
  text = "",
  identity = null,
} = {}) {
  const filled = [],
    submitted = [];
  const page = {
    url: () => url,
    isClosed: () => false,
    async evaluate() {},
    async waitForTimeout() {},
    locator(selector) {
      const field = fields[selector];
      return {
        first() {
          return this;
        },
        async count() {
          return field || (selector === 'meta[name="user-login"]' && identity)
            ? 1
            : 0;
        },
        async isVisible() {
          return !!field;
        },
        async innerText() {
          return text;
        },
        async getAttribute(name) {
          return selector === 'meta[name="user-login"]'
            ? identity
            : (field?.[name] ?? null);
        },
        async scrollIntoViewIfNeeded() {},
        async evaluate() {
          const form = fields['form[action="/login/oauth/authorize"]'];
          return form ? { action: new URL(form.action, url).href, method: 'post', target: '', fields: {} } : null;
        },
        async fill(value) {
          filled.push([selector, value]);
        },
        async click(options) {
          if (options?.trial) return;
          submitted.push(selector);
        },
      };
    },
    getByRole() {
      return {
        async count() {
          return 0;
        },
      };
    },
    getByText() {
      return {
        filter() {
          return this;
        },
        async count() {
          return 0;
        },
      };
    },
  };
  return { page, filled, submitted };
}

test("diagnostics distinguish official rejection without retaining URL secrets or page text", () => {
  const url = "https://www.workbuddy.ai/auth/realms/copilot/login-actions/first-broker-login?code=secret-code&state=secret-state";
  const f = fakePage({ url, text: "private account details" });
  const session = new mod.OAuthSession({ pages: () => [f.page] }, { username: "private-user" }, () => ({}));
  session.observeResponse(url, 403, f.page);
  const diagnostic = session.diagnostic();
  assert.match(diagnostic, /WorkBuddy 首次关联/);
  assert.match(diagnostic, /HTTP=403/);
  assert.doesNotMatch(diagnostic, /secret|private|https|\?/);
  f.page.url = () => "https://untrusted.test/private-token";
  assert.match(session.diagnostic(), /HTTP=未记录/);
  assert.doesNotMatch(session.diagnostic(), /untrusted|private-token|403/);
});

test("successful WorkBuddy page without GitHub identity stays unverified with an explicit reason", async () => {
  const f = fakePage({ url: "https://www.workbuddy.ai/login/started?platform=CLI&state=device", text: "登录成功 请返回 CLI 继续" });
  const session = new mod.OAuthSession({ pages: () => [f.page] }, { username: "one" }, () => ({}));
  session.flow = {};
  session.providerAttempted = true;
  session.callbackVerified = true;
  session.callbackEvidence = { flow: session.flow, page: f.page };
  assert.deepEqual(await session.step(), { status: "manual", reason: "github_identity_missing" });
});

test("evidence invalidated during a step is not reduced to an unspecified retry", async () => {
  const f = fakePage();
  const session = new mod.OAuthSession({ pages: () => [f.page] }, { username: "one" }, () => ({}));
  session.advance = async () => { session.invalidateEvidence(); return { status: "manual" }; };
  assert.deepEqual(await session.step(), { status: "manual", reason: "oauth_changed" });
});

test("a late GitHub redirect to an official restriction is terminal without another manual resume", async () => {
  for (const host of ['www.workbuddy.ai', 'workbuddy.ai.example.com']) {
    const f=fakePage({url:'https://github.com/login',text:'账号访问受限 您的账号因安全策略限制，暂无法访问'});
    let current='https://github.com/login';
    f.page.url=()=>current;
    const locator=f.page.locator.bind(f.page);
    f.page.locator=selector=>{
      if(selector==='meta[name="user-login"]') return {async count(){current=`https://${host}/auth/realms/copilot/login-actions/first-broker-login`;throw new Error('Execution context destroyed by navigation');}};
      return locator(selector);
    };
    const session=new mod.OAuthSession({pages:()=>[f.page]},{username:'one'},()=>{throw new Error('No credentials should be requested');});
    const result=await session.step();
    assert.equal(result.status,host==='www.workbuddy.ai'?'restricted':'manual');
    if(result.status==='restricted') assert.equal(result.reason,'account_security');
  }
});

test("official GitHub signup and login labels are selected in Chinese and English", async () => {
  for (const label of [
    "使用 GitHub 注册",
    "使用 GitHub 登录",
    "使用GitHub注册",
    "Sign up with GitHub",
    "Continue with GitHub",
  ]) {
    const f = fakePage({ url: "https://workbuddy.ai/login/" });
    let clicks = 0;
    f.page.getByRole = (role, options) => ({
      count: async () =>
        role === "button" && options.name.test(label) ? 1 : 0,
      click: async () => {
        clicks++;
      },
    });
    const session = new mod.OAuthSession(
      { pages: () => [f.page] },
      { username: "one" },
      () => {
        throw new Error("Must not fill credentials on WorkBuddy");
      },
    );
    await session.step();
    assert.equal(clicks, 1, label);
  }
});

test("GitHub provider text fallback supports custom controls but rejects unrelated or ambiguous text", async () => {
  for (const [label, count, expected] of [
    ["使用 GitHub 注册", 1, 1],
    ["使用 Google 注册", 1, 0],
    ["GitHub 帮助", 1, 0],
    ["使用 GitHub 注册", 2, 0],
  ]) {
    const f = fakePage({ url: "https://workbuddy.ai/login/" });
    let clicks = 0;
    f.page.getByText = (name) => ({
      filter() {
        return this;
      },
      count: async () => (name.test(label) ? count : 0),
      click: async () => {
        clicks++;
      },
    });
    const session = new mod.OAuthSession(
      { pages: () => [f.page] },
      { username: "one" },
      () => ({}),
    );
    await session.step();
    assert.equal(clicks, expected, label + " count=" + count);
  }
});

test("a slowly rendered provider is awaited in the same page without reading credentials", async () => {
  const f = fakePage({ url: "https://workbuddy.ai/login/" });
  let elapsed = 0,
    clicks = 0;
  f.page.waitForTimeout = async (ms) => {
    elapsed += ms;
  };
  f.page.getByRole = (role) => ({
    count: async () => (role === "button" && elapsed >= 12000 ? 1 : 0),
    click: async () => {
      clicks++;
    },
  });
  const session = new mod.OAuthSession(
    { pages: () => [f.page] },
    { username: "one" },
    () => {
      throw new Error("No secrets on provider page");
    },
  );
  await session.step();
  assert.equal(clicks, 1);
});

test("closing during provider loading stops the wait without clicking", async () => {
  const f = fakePage({ url: "https://workbuddy.ai/login/" });
  let waits = 0;
  const session = new mod.OAuthSession(
    { pages: () => [f.page], close: async () => {} },
    { username: "one" },
    () => ({}),
  );
  f.page.waitForTimeout = async () => {
    waits++;
    await session.close();
  };
  await session.step();
  assert.equal(waits, 1);
});

test("concurrent close calls all wait until context and browser have actually closed", async () => {
  let releaseContext, releaseBrowser;
  const contextGate = new Promise((resolve) => {
    releaseContext = resolve;
  });
  const browserGate = new Promise((resolve) => {
    releaseBrowser = resolve;
  });
  const session = new mod.OAuthSession(
    { close: () => contextGate },
    {},
    () => ({}),
    { close: () => browserGate },
  );
  const first = session.close();
  let secondDone = false;
  const second = session.close().then(() => {
    secondDone = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondDone, false);
  releaseContext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondDone, false);
  releaseBrowser();
  await Promise.all([first, second]);
  assert.equal(secondDone, true);
});

test("provider inside a visible official child frame is found but untrusted frames are ignored", async () => {
  for (const [url, want] of [
    ["https://workbuddy.ai/auth/login", 1],
    ["https://evil.test/login", 0],
  ]) {
    const f = fakePage({ url: "https://workbuddy.ai/login/" });
    const child = fakePage({ url });
    let clicks = 0;
    child.page.parentFrame = () => f.page;
    f.page.parentFrame = () => null;
    child.page.frameElement = async () => ({
      isVisible: async () => true,
      dispose: async () => {},
    });
    f.page.frames = () => [f.page, child.page];
    f.page.mainFrame = () => f.page;
    child.page.getByRole = (role) => ({
      count: async () => (role === "button" ? 1 : 0),
      click: async () => {
        clicks++;
      },
    });
    const session = new mod.OAuthSession(
      { pages: () => [f.page] },
      { username: "one" },
      () => {
        throw new Error("no secrets");
      },
    );
    await session.step();
    assert.equal(clicks, want);
  }
});

for (const initiallyChecked of [
  [false, false],
  [true, false],
  [true, true],
])
  test(`both authorized agreements are checked before GitHub: ${initiallyChecked}`, async () => {
    const f = fakePage({ url: "https://workbuddy.ai/login/" });
    const labels = [
      "本人已阅读并同意 WorkBuddy 服务协议, 数据处理安全协议",
      "本人已阅读并知悉 隐私政策 和 可接受使用政策",
      "我同意接收营销邮件",
      "我同意隐私政策并订阅优惠",
    ];
    const checked = [...initiallyChecked, false, false],
      changes = [0, 0, 0, 0];
    let clicks = 0,
      secrets = 0;
    f.page.getByRole = (role, options) => {
      const indices = labels.flatMap((label, i) =>
        options?.name.test(label) ? [i] : [],
      );
      return role === "checkbox"
        ? {
            count: async () => indices.length,
            nth: (n) => ({
              isVisible: async () => true,
              isChecked: async () => checked[indices[n]],
              check: async () => {
                changes[indices[n]]++;
                checked[indices[n]] = true;
              },
            }),
          }
        : {
            count: async () => (role === "button" ? 1 : 0),
            isEnabled: async () => checked[0] && checked[1],
            click: async () => {
              assert.deepEqual(checked, [true, true, false, false]);
              clicks++;
            },
          };
    };
    const session = new mod.OAuthSession(
      { pages: () => [f.page] },
      { username: "one" },
      () => {
        secrets++;
        return {};
      },
    );
    await session.step();
    assert.equal(clicks, 1);
    assert.equal(secrets, 0);
    assert.deepEqual(changes, [
      ...initiallyChecked.map((x) => (x ? 0 : 1)),
      0,
      0,
    ]);
  });

test("an agreement which never becomes checked prevents GitHub submission", async () => {
  const f = fakePage({ url: "https://workbuddy.ai/login/" });
  let clicks = 0;
  f.page.getByRole = (role) =>
    role === "checkbox"
      ? {
          count: async () => 1,
          nth: () => ({
            isVisible: async () => true,
            isChecked: async () => false,
            check: async () => {},
          }),
        }
      : {
          count: async () => (role === "button" ? 1 : 0),
          click: async () => {
            clicks++;
          },
        };
  const session = new mod.OAuthSession(
    { pages: () => [f.page] },
    { username: "one" },
    () => ({}),
  );
  assert.equal((await session.step()).reason, "agreement");
  assert.equal(clicks, 0);
});

for (const interrupt of ["close", "navigate"])
  test(`agreement selection stops on ${interrupt} before another checkbox or provider action`, async () => {
    const f = fakePage({ url: "https://workbuddy.ai/login/" });
    const session = new mod.OAuthSession(
      { pages: () => [f.page] },
      { username: "one" },
      () => ({}),
    );
    let checks = 0,
      clicks = 0;
    const checked = [false, false];
    f.page.getByRole = (role) =>
      role === "checkbox"
        ? {
            count: async () => 2,
            nth: (i) => ({
              isVisible: async () => true,
              isChecked: async () => checked[i],
              check: async () => {
                checks++;
                checked[i] = true;
                if (interrupt === "close") session.closed = true;
                else f.page.url = () => "https://evil.test/login";
              },
            }),
          }
        : {
            count: async () => (role === "button" ? 1 : 0),
            click: async () => {
              clicks++;
            },
          };
    await session.step();
    assert.equal(checks, 1);
    assert.equal(clicks, 0);
  });
test("a same-URL official iframe reload stops further agreement and provider actions", async () => {
  const main = fakePage({ url: "https://workbuddy.ai/login/" }).page;
  const child = fakePage({ url: "https://workbuddy.ai/inner" }).page;
  const handlers = {};
  const checked = [false, false];
  let clicks = 0,
    checks = 0;
  main.goto = async () => {};
  main.frames = () => [main, child];
  main.mainFrame = () => main;
  main.parentFrame = () => null;
  child.parentFrame = () => main;
  child.page = () => main;
  child.frameElement = async () => ({
    isVisible: async () => true,
    dispose: async () => {},
  });
  child.getByRole = (role) =>
    role === "checkbox"
      ? {
          count: async () => 2,
          nth: (i) => ({
            isVisible: async () => true,
            isChecked: async () => checked[i],
            check: async () => {
              checks++;
              checked[i] = true;
              if (i === 0)
                handlers.request({
                  isNavigationRequest: () => true,
                  frame: () => child,
                  url: () => child.url(),
                  method: () => "GET",
                });
            },
          }),
        }
      : {
          count: async () => (role === "button" ? 1 : 0),
          click: async () => {
            clicks++;
          },
        };
  const context = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    newPage: async () => main,
    pages: () => [main],
    close: async () => {},
  };
  const browser = new mod.OAuthBrowser({
    chromium: {
      executablePath: () => process.execPath,
      launch: async () => ({
        newContext: async () => context,
        close: async () => {},
      }),
    },
  });
  const session = await browser.open({
    url: main.url(),
    account: { username: "one" },
    getSecrets: () => ({}),
  });
  await session.step();
  assert.equal(checks, 1);
  assert.equal(checked[1], false);
  assert.equal(clicks, 0);
  await session.close();
});

test("authenticator TOTP uses freshly generated secrets and submits only the recognized app form", async () => {
  assert.equal(
    typeof mod.OAuthSession,
    "function",
    "OAuth session implementation must exist",
  );
  const f = fakePage({
    fields: {
      "input#app_totp": {},
      'form[action="/sessions/two-factor"]': { action: "/sessions/two-factor" },
      'form[action="/sessions/two-factor"] button[type="submit"]': {},
    },
  });
  let codes = 0;
  const session = new mod.OAuthSession(
    { pages: () => [f.page] },
    { username: "one" },
    () => ({
      otp: {
        code: String(++codes).padStart(6, "0"),
        expiresAt: Date.now() + 30000,
      },
    }),
  );
  session.observe(
    "https://github.com/login/oauth/authorize?state=oauth&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback",
  );
  await session.step();
  session.navigationStarted(f.page, f.page.url(), "GET");
  await session.step();
  assert.ok(f.filled.length >= 2);
  assert.equal(f.filled[0][0], "input#app_totp");
  assert.notEqual(f.filled[0][1], f.filled.at(-1)[1]);
  assert.ok(
    f.submitted.every(
      (x) => x === 'form[action="/sessions/two-factor"] button[type="submit"]',
    ),
  );
});

test("authenticator fills real Store-generated OTP objects and refreshes a nearly expired token", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 30000005 });
  const dir = mkdtempSync(join(tmpdir(), "workbuddy-totp-"));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const account = store.create({
    username: "one",
    email: "one@example.test",
    password: "private-password",
    totp: "JBSWY3DPEHPK3PXP",
  });
  const f = fakePage({
    fields: {
      "input#app_totp": {},
      'form[action="/sessions/two-factor"]': { action: "/sessions/two-factor" },
      'form[action="/sessions/two-factor"] button[type="submit"]': {},
    },
  });
  let reads = 0;
  const waits = [];
  f.page.waitForTimeout = async (ms) => waits.push(ms);
  const session = new mod.OAuthSession(
    { pages: () => [f.page] },
    account,
    () => {
      reads++;
      return reads === 1
        ? { otp: { code: "000000", expiresAt: Date.now() + 100 } }
        : store.secrets(account.id);
    },
  );
  session.observe(
    "https://github.com/login/oauth/authorize?state=s&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback",
  );
  await session.step();
  assert.equal(f.filled.length, 1);
  assert.match(f.filled[0][1], /^\d{6}$/);
  assert.notEqual(f.filled[0][1], "000000");
  assert.ok(reads >= 2);
  assert.ok(waits.some((ms) => ms >= 100 && ms <= 2100));
});
test("email challenges, missing TOTP keys and untrusted pages never receive automatic codes", async () => {
  assert.equal(
    typeof mod.OAuthSession,
    "function",
    "OAuth session implementation must exist",
  );
  for (const fixture of [
    {
      url: "https://github.com/sessions/verified-device",
      fields: { "input#otp": {} },
    },
    {
      url: "https://github.com/sessions/two-factor/app",
      fields: { "input#app_totp": {} },
    },
    {
      url: "https://github.com.evil.test/sessions/two-factor/app",
      fields: { "input#app_totp": {} },
    },
  ]) {
    const f = fakePage(fixture);
    const session = new mod.OAuthSession(
      { pages: () => [f.page] },
      { username: "one" },
      () => ({ otp: null }),
    );
    session.observe(
      "https://github.com/login/oauth/authorize?state=oauth&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback",
    );
    assert.equal((await session.step()).status, "manual");
    assert.equal(f.filled.length, 0);
  }
});

test("configured TOTP does not conceal GitHub email device verification", async () => {
  const f = fakePage({ url: 'https://github.com/sessions/verified-device', fields: { 'input#otp': {} } });
  const session = new mod.OAuthSession({ pages: () => [f.page] }, { username: 'one' }, () => { throw new Error('Email challenge must not read or submit TOTP'); });
  session.observe('https://github.com/login/oauth/authorize?state=oauth&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback');
  const result = await session.step();
  assert.deepEqual(result, { status: 'manual', reason: 'github_email_device_verification' });
  assert.match(session.diagnostic(), /GitHub 邮箱设备验证/);
  assert.deepEqual(f.filled, []);
  assert.deepEqual(f.submitted, []);
});

test("password automation requires the official GitHub login form and an observed official WorkBuddy redirect", async () => {
  for (const trusted of [true, false]) {
    const f = fakePage({
      url: "https://github.com/login",
      fields: {
        "input#login_field": {},
        "input#password": {},
        'form[action="/session"]': { action: "/session" },
      },
    });
    const session = new mod.OAuthSession(
      { pages: () => [f.page] },
      { username: "one" },
      () => ({ password: "private-password" }),
    );
    if (trusted)
      session.observe(
        "https://github.com/login/oauth/authorize?state=s&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback",
      );
    await session.step();
    assert.deepEqual(
      f.filled,
      trusted
        ? [
            ["input#login_field", "one"],
            ["input#password", "private-password"],
          ]
        : [],
    );
  }
});
test("OAuth callback proof requires official redirect, matching state and exact authenticated GitHub login", async () => {
  assert.equal(
    typeof mod.OAuthSession,
    "function",
    "OAuth session implementation must exist",
  );
  const f = fakePage({
    url: "https://github.com/login/oauth/authorize?state=s&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback",
    identity: "one",
  });
  const session = new mod.OAuthSession(
    { pages: () => [f.page] },
    { username: "one" },
    () => ({}),
  );
  session.observe(f.page.url());
  await session.step();
  session.observe("https://www.workbuddy.ai/callback?code=c&state=WRONG");
  assert.equal((await session.step()).status, "manual");
  session.observe("https://www.workbuddy.ai/callback?code=c&state=s");
  assert.equal(
    (await session.step()).status,
    "manual",
    "a callback request alone must not complete while GitHub is still the current page",
  );
  f.page.url = () => "https://www.workbuddy.ai/callback?code=c&state=s";
  const result = await session.step();
  assert.equal(result.status, "verified");
  assert.equal(result.githubUsername, "one");
});

test("callback HTTP errors cannot authorize polling while standard HTTP redirects retain callback proof", () => {
  const f = fakePage();
  const session = new mod.OAuthSession(
    { pages: () => [f.page] },
    { username: "one" },
    () => ({}),
  );
  session.observe(
    "https://github.com/login/oauth/authorize?state=s&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback",
  );
  assert.equal(
    typeof session.observeResponse,
    "function",
    "callback response status must be verified",
  );
  session.observeResponse(
    "https://www.workbuddy.ai/callback?code=c&state=s",
    403,
  );
  assert.equal(session.callbackVerified, false);
  session.observeResponse(
    "https://www.workbuddy.ai/callback?code=c&state=s",
    302,
  );
  assert.equal(session.callbackVerified, true);
});

test("a changed OAuth flow and mismatched account can never reuse prior identity or callback evidence", async () => {
  let identity = "one";
  const f = fakePage({
    url: "https://github.com/login/oauth/authorize?state=s1&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback",
    identity: "one",
  });
  const locator = f.page.locator;
  f.page.locator = (selector) => {
    const l = locator(selector);
    if (selector === 'meta[name="user-login"]')
      l.getAttribute = async () => identity;
    return l;
  };
  const session = new mod.OAuthSession(
    { pages: () => [f.page] },
    { username: "one" },
    () => ({}),
  );
  session.observe(f.page.url());
  await session.step();
  session.observeResponse(
    "https://www.workbuddy.ai/callback?code=c1&state=s1",
    302,
  );
  f.page.url = () =>
    "https://github.com/login/oauth/authorize?state=s2&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback";
  identity = "different-account";
  session.observe(f.page.url());
  assert.equal((await session.step()).status, "manual");
  session.observeResponse(
    "https://www.workbuddy.ai/callback?code=c2&state=s2",
    302,
  );
  f.page.url = () => "https://www.workbuddy.ai/callback?code=c2&state=s2";
  assert.equal((await session.step()).status, "manual");
  assert.equal(session.identity, null);
  assert.equal(session.callbackVerified, false);
});

test("identity mismatch remains latched even when a later page reports the expected login", async () => {
  let identity = "different-account";
  const f = fakePage({
    url: "https://github.com/login/oauth/authorize?state=s&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback",
    identity: "one",
  });
  const locator = f.page.locator;
  f.page.locator = (selector) => {
    const l = locator(selector);
    if (selector === 'meta[name="user-login"]')
      l.getAttribute = async () => identity;
    return l;
  };
  const session = new mod.OAuthSession(
    { pages: () => [f.page] },
    { username: "one" },
    () => ({}),
  );
  session.observe(f.page.url());
  assert.equal((await session.step()).status, "manual");
  identity = "one";
  await session.step();
  session.observeResponse(
    "https://www.workbuddy.ai/callback?code=c&state=s",
    302,
  );
  f.page.url = () => "https://www.workbuddy.ai/callback?code=c&state=s";
  assert.equal((await session.step()).status, "manual");
});

test("identity sampled while OAuth flow changes cannot become evidence for the new flow", async () => {
  const f = fakePage({
    url: "https://github.com/login/oauth/authorize?state=s1&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback",
    identity: "one",
  });
  let session;
  const locator = f.page.locator;
  f.page.locator = (selector) => {
    const l = locator(selector);
    if (selector === 'meta[name="user-login"]')
      l.getAttribute = async () => {
        session.observe(
          "https://github.com/login/oauth/authorize?state=s2&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback",
        );
        return "one";
      };
    return l;
  };
  session = new mod.OAuthSession(
    { pages: () => [f.page] },
    { username: "one" },
    () => ({}),
  );
  session.observe(f.page.url());
  await session.step();
  session.observeResponse(
    "https://www.workbuddy.ai/callback?code=c&state=s2",
    302,
  );
  f.page.url = () => "https://www.workbuddy.ai/callback?code=c&state=s2";
  assert.equal((await session.step()).status, "manual");
});

test("a callback from another page cannot reuse the authenticated OAuth page identity", async () => {
  const first = fakePage({
    url: "https://github.com/login/oauth/authorize?state=s&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback",
    identity: "one",
  });
  const second = fakePage({
    url: "https://www.workbuddy.ai/callback?code=c&state=s",
  });
  let pages = [first.page];
  const session = new mod.OAuthSession(
    { pages: () => pages },
    { username: "one" },
    () => ({}),
  );
  session.observe(first.page.url(), first.page);
  await session.step();
  session.observeResponse(second.page.url(), 302, second.page);
  pages = [first.page, second.page];
  assert.equal((await session.step()).status, "manual");
});

test("navigation while reading the final WorkBuddy page cannot return stale verified evidence", async () => {
  const authorization =
    "https://github.com/login/oauth/authorize?state=s&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback";
  const f = fakePage({ url: authorization, identity: "one" });
  const session = new mod.OAuthSession(
    { pages: () => [f.page] },
    { username: "one" },
    () => ({}),
  );
  session.observe(authorization);
  await session.step();
  session.observeResponse(
    "https://www.workbuddy.ai/callback?code=c&state=s",
    302,
  );
  f.page.url = () => "https://www.workbuddy.ai/";
  const locator = f.page.locator;
  f.page.locator = (selector) => {
    const l = locator(selector);
    if (selector === "body")
      l.innerText = async () => {
        session.navigationStarted(f.page, authorization);
        f.page.url = () => authorization;
        return "";
      };
    return l;
  };
  assert.equal((await session.step()).status, "manual");
});

test("a new document at the same GitHub URL invalidates an in-flight identity sample", async () => {
  const authorization =
    "https://github.com/login/oauth/authorize?state=s&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback";
  const f = fakePage({ url: authorization, identity: "one" });
  const session = new mod.OAuthSession(
    { pages: () => [f.page] },
    { username: "one" },
    () => ({}),
  );
  session.observe(authorization);
  const locator = f.page.locator;
  f.page.locator = (selector) => {
    const l = locator(selector);
    if (selector === 'meta[name="user-login"]')
      l.getAttribute = async () => {
        session.navigationStarted(f.page, authorization);
        return "one";
      };
    return l;
  };
  await session.step();
  session.observeResponse(
    "https://www.workbuddy.ai/callback?code=c&state=s",
    302,
  );
  f.page.url = () => "https://www.workbuddy.ai/";
  assert.equal((await session.step()).status, "manual");
});

test("new GitHub authorize GET cannot carry identity evidence from its prior document", async () => {
  const authorization =
    "https://github.com/login/oauth/authorize?state=s&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback";
  const f = fakePage({ url: authorization, identity: "one" });
  const session = new mod.OAuthSession(
    { pages: () => [f.page] },
    { username: "one" },
    () => ({}),
  );
  session.observe(authorization);
  await session.step();
  session.navigationStarted(f.page, authorization, "GET");
  session.observe(authorization, f.page);
  session.observeResponse(
    "https://www.workbuddy.ai/callback?code=c&state=s",
    302,
  );
  f.page.url = () => "https://www.workbuddy.ai/";
  assert.equal((await session.step()).status, "manual");
});

test("consent POST from the sampled OAuth document retains its bound identity until callback", async () => {
  const authorization =
    "https://github.com/login/oauth/authorize?state=s&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback";
  const f = fakePage({ url: authorization, identity: "one" });
  const session = new mod.OAuthSession(
    { pages: () => [f.page] },
    { username: "one" },
    () => ({}),
  );
  session.observe(authorization);
  await session.step();
  session.navigationStarted(
    f.page,
    "https://github.com/login/oauth/authorize",
    "POST",
  );
  session.observeResponse(
    "https://www.workbuddy.ai/callback?code=c&state=s",
    302,
  );
  f.page.url = () => "https://www.workbuddy.ai/";
  assert.equal((await session.step()).status, "verified");
});

for (const [returnTo, outerClient, expected] of [
  ['/login/oauth/authorize?client_id=fixture&state=s&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback', 'fixture', true],
  ['https://github.com.evil.test/login/oauth/authorize?state=s&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback', '', false],
  ['/login/oauth/authorize?client_id=fixture&state=s&redirect_uri=https%3A%2F%2Fevil.test%2Fcallback', 'fixture', false],
  ['/login/oauth/authorize?client_id=fixture&state=s&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback', 'different', false],
  ['/login/oauth/authorize?client_id=fixture&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback', 'fixture', false],
]) test(`resume login reconstructs only a matching official OAuth return_to: ${expected} ${returnTo}`, async () => {
  const f = fakePage({ url: 'https://github.com/login?client_id='+outerClient+'&return_to='+encodeURIComponent(returnTo), fields: {
    'input#login_field': {}, 'input#password': {}, 'form[action="/session"]': {action:'/session'},
  }});
  const session = new mod.OAuthSession({pages:()=>[f.page]}, {username:'one'}, ()=>({password:'fixture-password'}));
  session.providerAttempted = true;
  const result = await session.step();
  assert.equal(f.filled.length, expected ? 2 : 0);
  assert.equal(result.status, 'manual', 'credentials alone never establish callback or authenticated identity');
});

test('network recovery retries only the failed trusted GET document',async()=>{
  const calls=[];
  const page={url:()=> 'chrome-error://chromewebdata/',isClosed:()=>false,async goto(url){calls.push(url);}};
  const session=new mod.OAuthSession({pages:()=>[page]}, {},()=>{});
  const url='https://github.com/login?return_to=%2Flogin%2Foauth%2Fauthorize';
  session.navigationStarted(page,url,'GET');session.navigationFailure='network';
  assert.equal(await session.retryNavigation(),true);
  assert.deepEqual(calls,[url]);assert.equal(session.navigationFailure,null);
  session.navigationStarted(page,'https://github.com/session','POST');session.navigationFailure='network';
  assert.equal(await session.retryNavigation(),false);assert.equal(calls.length,1);
  session.navigationStarted(page,'https://www.workbuddy.ai/callback?code=private&state=s','GET');session.navigationFailure='network';
  assert.equal(await session.retryNavigation(),false);assert.equal(calls.length,1);
  session.navigationStarted(page,'https://other.test/login','GET');session.navigationFailure='network';
  assert.equal(await session.retryNavigation(),false);assert.equal(calls.length,1);
  session.closed=true;
  session.navigationStarted(page,url,'GET');session.navigationFailure='network';
  assert.equal(await session.retryNavigation(),false);
});

for(const kind of ['login','totp','consent']) test(`repeated steps never resubmit the same GitHub ${kind} document`,async()=>{
 const configurations={
  login:{url:'https://github.com/login',fields:{'input#login_field':{},'input#password':{},'form[action="/session"]':{action:'/session'}}},
  totp:{url:'https://github.com/sessions/two-factor/app',fields:{'input#app_totp':{},'form[action="/sessions/two-factor"]':{action:'/sessions/two-factor'}}},
  consent:{url:'https://github.com/login/oauth/authorize',identity:'one',fields:{'form[action="/login/oauth/authorize"]':{action:'/login/oauth/authorize'},'form[action="/login/oauth/authorize"] button[name="authorize"]':{}}},
 };
 const f=fakePage(configurations[kind]);
 const session=new mod.OAuthSession({pages:()=>[f.page]}, {username:'one'},()=>({password:'fixture',otp:{code:'123456',expiresAt:Date.now()+30000}}));
 session.observe('https://github.com/login/oauth/authorize?client_id=client&state=s&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback',f.page);
 await session.step();await session.step();
 assert.equal(f.submitted.length,1);
});

test('closing a session during a username fill prevents password entry and submission',async()=>{
 const f=fakePage({url:'https://github.com/login',fields:{'input#login_field':{},'input#password':{},'form[action="/session"]':{action:'/session'}}});
 let release;
 const session=new mod.OAuthSession({pages:()=>[f.page],close:()=>new Promise(r=>release=r)}, {username:'one'},()=>({password:'fixture'}));
 session.observe('https://github.com/login/oauth/authorize?client_id=client&state=s&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback',f.page);
 const locator=f.page.locator.bind(f.page);
 f.page.locator=selector=>{const control=locator(selector);if(selector==='input#login_field')control.fill=async()=>{void session.close();};return control;};
 await session.step();release();await session.close();
 assert.equal(f.filled.length,0);assert.equal(f.submitted.length,0);
});

test('browser shutdown starts even while context close is pending',async()=>{
 let release, browserClosed=false;
 const session=new mod.OAuthSession({close:()=>new Promise(r=>release=r)}, {},()=>{}, {async close(){browserClosed=true;}});
 const closing=session.close();await new Promise(r=>setImmediate(r));
 const observed=browserClosed;release();await closing;
 assert.equal(observed,true);
});

test('late successful callback is verified when the consent click loses its execution context',async()=>{
 const callback='https://www.workbuddy.ai/callback';
 let current='https://github.com/login/oauth/authorize?client_id=client&state=oauth&redirect_uri='+encodeURIComponent(callback);
 const f=fakePage({url:current,identity:'one',text:'登录成功',fields:{'form[action="/login/oauth/authorize"]':{action:'/login/oauth/authorize'},'form[action="/login/oauth/authorize"] button[name="authorize"]':{}}});
 f.page.url=()=>current;
 const session=new mod.OAuthSession({pages:()=>[f.page]},{username:'one'},()=>{},null,'https://www.workbuddy.ai/login/?platform=CLI&state=device');
 const locator=f.page.locator.bind(f.page);
 f.page.locator=selector=>{const control=locator(selector);if(selector==='form[action="/login/oauth/authorize"] button[name="authorize"]')control.click=async(options)=>{
   if(options?.trial)return;
   session.observeResponse(callback+'?code=fixture&state=oauth',302,f.page);
   current='https://www.workbuddy.ai/login/started?platform=CLI&state=device';
   throw new Error('Execution context destroyed by navigation');
 };return control;};
 const result=await session.step();assert.equal(result.status,'verified');assert.equal(result.githubUsername,'one');assert.equal(result.callbackVerified,true);
});

test('authorization preflight failure remains retryable without recording a submission',async()=>{
 const f=fakePage({url:'https://github.com/login/oauth/authorize',identity:'one',fields:{'form[action="/login/oauth/authorize"]':{action:'/login/oauth/authorize'},'form[action="/login/oauth/authorize"] button[name="authorize"]':{}}});
 const session=new mod.OAuthSession({pages:()=>[f.page]}, {username:'one'},()=>{});
 session.observe('https://github.com/login/oauth/authorize?client_id=client&state=s&redirect_uri=https%3A%2F%2Fwww.workbuddy.ai%2Fcallback',f.page);
 let blocked=true,dispatches=0;
 const locator=f.page.locator.bind(f.page);
 f.page.locator=selector=>{const c=locator(selector);if(selector==='form[action="/login/oauth/authorize"] button[name="authorize"]')c.click=async options=>{
   if(blocked)throw new Error('Timeout: element intercepts pointer events');
   if(!options?.trial)dispatches++;
 };return c;};
 const first=await session.step();assert.equal(first.reason,'github_authorize_not_ready');
 assert.equal(session.submittedDocuments.has(f.page),false);
 blocked=false;await session.step();await session.step();assert.equal(dispatches,1);
});
