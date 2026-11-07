// Regression tests for the reported symptom: the PAT browser stops on the
// GitHub two-factor page and "继续 PAT 浏览器" does not get past it.
//
// These use a local HTML fixture only. No real GitHub account, password or
// TOTP secret is involved.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "../server/browser-runtime.js";

const { PatSession } = await import("../server/pat-browser.js").catch(() => ({}));

const login = `<form method="post" action="/session">
  <input id="login_field"><input id="password" type="password">
  <button type="submit">Sign in</button></form>`;

const twoFactor = `<form method="post" action="/sessions/two-factor">
  <input id="app_totp"><button type="submit">Verify</button></form>`;

// A fulfilled 3xx leaves the interception chain, so the fixture answers a POST
// with a tiny document that navigates itself to the next real URL. That mirrors
// the single navigation a real redirect produces, and keeps every request local.
const hop = (to) =>
  `<html><head></head><body><script>location.replace(${JSON.stringify(to)})</script></body></html>`;

const token = "github_pat_SYNTHETIC_2fa_fixture_0001";
const newForm = `<meta name="user-login" content="octo">
<form method="post" action="/settings/personal-access-tokens">
<label>Resource owner<select name="target_name"><option selected>octo</option></select></label>
<label>Expiration<select name="expires_in"><option value="30" selected>30 days</option></select></label>
<fieldset><legend>Repository access</legend><label><input type="radio" name="repository_access" value="public" checked>Public repositories (read-only)</label></fieldset>
<fieldset><legend>Account permissions</legend><p>No account permissions</p></fieldset>
<fieldset><legend>Repository permissions</legend><p>No repository permissions</p></fieldset>
<button type="submit">Generate token</button></form>`;

const pages = {
  "/login": login,
  "/sessions/two-factor/app": twoFactor,
  "/sessions/two-factor": twoFactor,
  "/settings/personal-access-tokens/new": newForm,
  "/settings/personal-access-tokens/12345": `<input id="new-access-token" value="${token}">`,
};

/**
 * A fixture GitHub that requires a second factor, mirroring the real flow:
 * POST /sessions/two-factor redirects (302) to the PAT form, so the document
 * URL actually changes. The delay models a slow GitHub response.
 */
async function github(t, { delayMs = 0, rejectFirst = false, rejectAll = false, redirectHome = false } = {}) {
  assert.equal(typeof PatSession, "function");
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromium.executablePath(),
  });
  const context = await browser.newContext();
  t.after(async () => {
    await context.close();
    await browser.close();
  });

  const state = { otpFilled: null, otpPosts: 0, log: [] };

  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    // Everything in this fixture is answered locally, including sub-resources
    // and redirect targets. Nothing reaches the real GitHub.
    if (!request.isNavigationRequest()) return route.fulfill({ status: 200, body: "" });
    const posted = request.method() === "POST";
    state.log.push(`${request.method()} ${url.pathname}`);

    if (posted) {
      if (url.pathname === "/sessions/two-factor") {
        state.otpPosts++;
        await new Promise((r) => setTimeout(r, delayMs));
        if ((rejectAll || (rejectFirst && state.otpPosts === 1)))
          return route.fulfill({ contentType: "text/html", body: twoFactor });
        return route.fulfill({
          contentType: "text/html",
          body: hop(redirectHome ? 'https://github.com/' : "https://github.com/settings/personal-access-tokens/new"),
        });
      }
      if (url.pathname === "/session") {
        return route.fulfill({
          contentType: "text/html",
          body: hop("https://github.com/sessions/two-factor/app"),
        });
      }
      if (url.pathname === "/settings/personal-access-tokens") {
        // GitHub lands on the created-token page, which is where the plaintext
        // token is rendered once.
        return route.fulfill({
          contentType: "text/html",
          body: hop("https://github.com/settings/personal-access-tokens/12345"),
        });
      }
    }
    const path = url.pathname;
    return route.fulfill({
      contentType: "text/html",
      body: path === '/' ? '<meta name="user-login" content="octo"><p>Dashboard</p>' : pages[path] || "<p>unexpected page</p>",
    });
  });

  const page = await context.newPage();
  // Playwright does not expose postData for form navigations, so the submitted
  // value is recorded from the live DOM at submit time instead.
  await page.exposeFunction("__recordOtp", (value) => {
    state.otpFilled = value;
  });
  await page.addInitScript(() => {
    document.addEventListener(
      "submit",
      (event) => {
        const input = event.target.querySelector?.('input#app_totp');
        if (input) window.__recordOtp?.(input.value);
      },
      true,
    );
  });
  await page.goto("https://github.com/login");
  return { context, page, chromium, state };
}

function session(context, secrets, extra = {}) {
  return new PatSession(context, {
    account: { username: "octo" },
    getSecrets: () => secrets(),
    name: "2fa fixture",
    onSubmitted() {},
    onToken() {},
    ...extra,
  });
}

test("a two-factor page is filled and submitted automatically instead of pausing", async (t) => {
  const f = await github(t, { delayMs: 400 });
  const s = session(f.context, () => ({
    password: "synthetic-password",
    otp: { code: "654321", expiresAt: Date.now() + 25000 },
  }));
  for (let i = 0; i < 8; i++) {
    const result = await s.step();
    if (result.status === "captured") break;
    if (result.status === "manual") {
      assert.fail(`paused on ${result.reason} — 2FA was not completed automatically\n${f.state.log.join("\n")}`);
    }
  }
  assert.equal(f.state.otpFilled, "654321", "TOTP code must be submitted");
  assert.equal(f.state.otpPosts, 1);
});

test('successful two-factor redirect to the signed-in homepage resumes the intended PAT form', async t => {
  const f = await github(t, { redirectHome: true });
  const s = session(f.context, () => ({ password: 'synthetic-password', otp: { code: '654321', expiresAt: Date.now() + 25000 } }));
  assert.equal((await s.step()).status, 'captured');
  assert.equal(f.state.otpPosts, 1);
  assert.ok(f.state.log.includes('GET /'));
  assert.ok(f.state.log.includes('GET /settings/personal-access-tokens/new'));
});

test('a document replaced while reading the login form is reacquired before credentials are used', async t => {
  const f = await github(t);
  let reads=0, replaced=false;
  const s = session(f.context, () => { reads++; return {password:'synthetic-password',otp:{code:'654321',expiresAt:Date.now()+25000}}; });
  const query=s.query.bind(s);
  s.query=async(page,selector)=>{
    const forms=await query(page,selector);
    if(!replaced && selector==='form[action="/session"]' && forms.length) {
      replaced=true;
      forms[0].evaluate=async()=>{await page.goto('https://github.com/sessions/two-factor/app');throw new Error('Execution context was destroyed, most likely because of a navigation');};
    }
    return forms;
  };
  assert.equal((await s.step()).status,'captured');
  assert.equal(reads,1,'only the landed two-factor document may read secrets');
  assert.equal(f.state.otpPosts,1);
});

test('the trusted-device redirect is allowed to finish without treating it as a human challenge', async t => {
  const f=await github(t);
  await f.context.route('https://github.com/sessions/trusted-device',route=>route.fulfill({contentType:'text/html',body:'<p>Signing in</p><script>setTimeout(()=>location.replace("/"),700)</script>'}));
  await f.page.goto('https://github.com/sessions/trusted-device');
  const s=session(f.context,()=>{throw new Error('must not request secrets on redirect');});
  assert.equal((await s.step()).status,'captured');
});

test("a slow two-factor navigation is awaited rather than misread as a human challenge", async (t) => {
  // The post-submit redirect takes longer than the old fixed 250 ms wait.
  const f = await github(t, { delayMs: 1200 });
  const s = session(f.context, () => ({
    password: "p",
    otp: { code: "123123", expiresAt: Date.now() + 25000 },
  }));
  const result = await s.step();
  assert.notEqual(result.reason, "human_security_challenge", "a slow navigation must not be reported as a human challenge");
  assert.equal(f.state.otpFilled, "123123");
});

test("missing TOTP secret is reported precisely, not as a generic challenge", async (t) => {
  const f = await github(t);
  await f.page.goto("https://github.com/sessions/two-factor/app");
  const s = session(f.context, () => ({ password: "p", otp: null }));
  const result = await s.step();
  assert.equal(result.status, "manual");
  assert.equal(
    result.reason,
    "missing_totp",
    "an account without a TOTP key must be distinguishable in the UI",
  );
});

test("a nearly expired TOTP is regenerated at fill time rather than rejected", async (t) => {
  const f = await github(t);
  await f.page.goto("https://github.com/sessions/two-factor/app");
  let reads = 0;
  const s = session(f.context, () => {
    reads++;
    // First read is nearly expired; the refetch returns a fresh code.
    return {
      password: "p",
      otp: {
        code: reads === 1 ? "000000" : "135790",
        expiresAt: Date.now() + (reads === 1 ? 500 : 25000),
      },
    };
  });
  await s.step();
  assert.equal(reads >= 2, true, "a nearly expired code must be refetched");
  assert.equal(f.state.otpFilled, "135790");
});

test("a rejected code is retried once with a fresh code and the flow continues", async (t) => {
  const f = await github(t, { rejectFirst: true });
  await f.page.goto("https://github.com/sessions/two-factor/app");
  const codes = [];
  let reads = 0;
  const s = session(f.context, () => {
    const code = String(++reads).repeat(6).slice(0, 6);
    codes.push(code);
    return { password: "p", otp: { code, expiresAt: Date.now() + 25000 } };
  });
  const result = await s.step();
  assert.equal(f.state.otpPosts, 2, "one automatic retry is expected");
  assert.notEqual(codes[0], codes[1], "the retry uses a freshly generated code");
  assert.equal(result.status, "captured", "a corrected second attempt completes the flow");
});

test("two rejected codes stop with an explicit totp_rejected reason", async (t) => {
  const f = await github(t, { rejectAll: true });
  await f.page.goto("https://github.com/sessions/two-factor/app");
  let reads = 0;
  const s = session(f.context, () => ({
    password: "p",
    otp: { code: String(++reads).padStart(6, "1"), expiresAt: Date.now() + 25000 },
  }));
  const result = await s.step();
  assert.equal(f.state.otpPosts, 2, "exactly one retry is attempted");
  assert.equal(result.status, "manual");
  assert.equal(result.reason, "totp_rejected");
});
