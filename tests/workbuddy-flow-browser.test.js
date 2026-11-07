import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "../server/browser-runtime.js";
import { OAuthBrowser } from "../server/oauth-browser.js";

const callback = "https://www.workbuddy.ai/auth/realms/copilot/broker/github/endpoint";
const authorize = "https://github.com/login/oauth/authorize?client_id=fixture-client&state=fixture-state&redirect_uri=" + encodeURIComponent(callback);

async function fixture(t, { checked = [], slow = false, resume = false, english = false, delayedForm = false, cancelOnService = false, passkey = false, confirmLogin = false, finalState = 'fixture-device', finalText = '登录成功', modernConsent = false, consentIdentity = 'fixture-user', consentAction = '/login/oauth/authorize?client_id=fixture-client', delayedConsent = false, networkFailures = 0, consentLabel = 'Authorize', belowFold = false, consentBlockedMs = 0, consentMutation = null, requiresConsentScroll = false, automaticGrant = false, profileIdentity = 'fixture-user', profileChangeFlow = false, profileOtherLogin = false } = {}) {
  const events = [];
  let session;
  const browser = new OAuthBrowser({ chromium: {
    executablePath: () => chromium.executablePath(),
    async launch(options) {
      const engine = await chromium.launch({ ...options, headless: true });
      return {
        close: () => engine.close(),
        async newContext(options) {
          const context = await engine.newContext(options);
          await context.exposeFunction("recordStep", async (event) => {
            events.push(event);
            if (cancelOnService && event === "service") await session.close();
          });
          await context.route("**/*", async (route) => {
            const url = new URL(route.request().url());
            if (route.request().method() === 'POST' && url.hostname === 'example.test') events.push('unsafe-submit');
            if (url.hostname === "github.com" && networkFailures > 0) {
              networkFailures--;
              events.push("network-failure");
              return route.abort("timedout");
            }
            const html = (body) => route.fulfill({ contentType: "text/html; charset=utf-8", body });
            // Browser navigations re-enter routing; HTTP redirect chains can escape a
            // Playwright route and must never reach a real provider in this fixture.
            const navigate = (target) => html(`<script>location.replace(${JSON.stringify(target)})</script>`);
            if (url.hostname === 'github.com' && url.pathname === '/settings/profile') {
              events.push('profile-identity');
              if (!route.request().headers().cookie?.includes('fixture_auth=authenticated')) return route.fulfill({status:401,body:'Sign in'});
              if (profileChangeFlow) session.invalidateEvidence();
              if (profileOtherLogin) session.navigationStarted(session.flow.page, 'https://github.com/login', 'GET');
              return html(profileIdentity ? `<meta name="user-login" content="${profileIdentity}"><h1>Profile</h1>` : '<h1>Sign in</h1>');
            }
            if (url.pathname === "/login/" && url.hostname === "www.workbuddy.ai")
              return html('<iframe src="/auth/login"></iframe>');
            if (url.pathname === "/auth/login") {
              const service = english ? 'I have read and agree to the WorkBuddy Service Agreement, Data Processing and Security Agreement' : '本人已阅读并同意 <a href="/document/term">WorkBuddy 服务协议</a>, <a href="/document/dpsa">数据处理与安全协议</a>';
              const privacy = english ? 'I have read and acknowledge the Privacy Policy and Acceptable Use Policy' : '本人已阅读并知悉 <a href="/document/privacy-policy">隐私政策</a> 和 <a href="/document/acceptable-use-policy">可接受使用政策</a>';
              return html(`
              <style>input[type=checkbox]{display:none}.sp-color-checkmark-outline{display:inline-block;width:24px;height:24px;border:1px solid}</style>
              <div id="account-tab">
                <a id="social-github" href="/broker" onclick="event.preventDefault(); if (![...document.querySelectorAll('[data-policy-kind]')].every(e=>e.checked)) { window.recordStep('unexpected-dialog'); return; } window.recordStep('github'); window.top.location.href=this.href">使用 GitHub 注册</a>
                <div class="policy-wrapper">
                  <label class="custom-checkbox"><input type="checkbox" data-policy-kind="service" ${checked[0] ? "checked" : ""} onchange="window.recordStep('service')"><div class="sp-color-checkmark-outline"></div><span>${service}</span></label>
                  <label class="custom-checkbox"><input type="checkbox" data-policy-kind="privacy" ${checked[1] ? "checked" : ""} onchange="window.recordStep('privacy')"><div class="sp-color-checkmark-outline"></div><span>${privacy}</span></label>
                </div>
                <label><input type="checkbox" onchange="window.recordStep('marketing')">订阅营销邮件</label>
              </div>`);
            }
            if (url.pathname === "/broker") {
              if (slow) await new Promise(r => setTimeout(r, 1600));
              return navigate(resume ? "https://github.com/login?client_id=fixture-client&return_to=" + encodeURIComponent(new URL(authorize).pathname + new URL(authorize).search) : authorize);
            }
            if (url.hostname === "github.com" && url.pathname === "/login") {
              const form = '<form method="post" action="/session"><input id="login_field" name="login"><input id="password" name="password" type="password"><input type="submit" value="Sign in"></form>';
              return html(delayedForm ? `<body>Loading<script>setTimeout(()=>document.body.innerHTML=${JSON.stringify(form)},1500)</script>` : form);
            }
            if (url.pathname === "/session") {
              events.push("credentials");
              assert.equal(new URLSearchParams(route.request().postData()).get("login"), "fixture-user");
              return navigate(passkey ? "https://github.com/sessions/trusted-device" : authorize);
            }
            if (url.pathname === "/sessions/trusted-device") return html(`<h1>Configure passwordless authentication</h1><h2>Add a passkey</h2><button onclick="window.recordStep('add-passkey')">Add passkey</button><a href="${authorize.replaceAll('&', '&amp;')}" onclick="window.recordStep('ask-later')">Ask me later</a><button onclick="window.recordStep('never-ask')">Don't ask again for this browser</button>`);
            if (url.pathname === "/login/oauth/authorize") {
              if (automaticGrant) return route.fulfill({contentType:'text/html',headers:{'set-cookie':'fixture_auth=authenticated; Path=/; Secure; HttpOnly'},body:`<script>location.replace(${JSON.stringify(callback + '?code=fixture-code&state=fixture-state')})</script>`});
              if (route.request().method() === "POST") {
                events.push("authorize");
                return navigate(callback + "?code=fixture-code&state=fixture-state");
              }
              if (requiresConsentScroll) return html(`<h1>Authorize application</h1><p ${requiresConsentScroll === true ? 'hidden' : ''}>Verify your GitHub identity (fixture-user)</p><div style="height:1800px">Permissions</div><form method="post" action="/login/oauth/authorize"><button name="authorize" value="1" disabled>Authorize</button><button name="authorize" value="0" onclick="window.recordStep('cancel')">Cancel</button></form><script>addEventListener('scroll',()=>{if(scrollY+innerHeight>=document.documentElement.scrollHeight-30){window.recordStep('consent-scrolled');document.querySelector('p').hidden=false;document.querySelector('button').disabled=false;}},{once:true})</script>`);
              if (modernConsent) return html(`${consentMutation ? `<div id="guard-cover" style="position:fixed;inset:0;z-index:10;background:white">Loading</div><script>setTimeout(()=>{${consentMutation === 'action' ? "document.getElementById('consent').action='https://example.test/changed'" : "document.querySelector('p').textContent='Verify your GitHub identity (different-user)'"};document.getElementById('guard-cover').remove()},1500)</script>` : ''}<p>Verify your GitHub identity (${consentIdentity})</p><form id="consent" method="post" action="${consentAction}"></form>${belowFold?'<div style="height:1600px">Permissions</div>':''}<button id="authorize" form="consent" type="submit" ${delayedConsent?'disabled':''}>${consentLabel}</button><button type="button">Cancel</button>${delayedConsent?'<script>setTimeout(()=>document.getElementById("authorize").disabled=false,1200)</script>':''}`);
              return html(`<meta name="user-login" content="fixture-user"><form method="post" action="/login/oauth/authorize"><button name="authorize">Authorize</button></form>${consentBlockedMs ? `<div id="cover" style="position:fixed;inset:0;z-index:10;background:white">Loading permissions</div><script>setTimeout(()=>document.getElementById('cover').remove(),${consentBlockedMs})</script>` : ''}`);
            }
            if (url.origin + url.pathname === callback) return navigate(`https://www.workbuddy.ai/login/${confirmLogin ? "select" : "started"}?platform=CLI&state=${finalState}`);
            if (url.pathname === "/login/select") return html('<div class="select-account-card selected">个人版</div><button onclick="window.recordStep(\'confirm-login\');location.href=\'/login/started?platform=CLI&state=fixture-device\'">确认登录</button>');
            if (url.pathname === "/login/started") return html(`<h1>${finalText}</h1><p>请返回 CLI 继续</p>`);
            return route.abort();
          });
          return context;
        },
      };
    },
  } });
  session = await browser.open({ url: "https://www.workbuddy.ai/login/?platform=CLI&state=fixture-device", account: { username: "fixture-user" }, getSecrets: () => ({ password: "fixture-password" }) });
  t.after(() => session.close());
  return { session, events };
}

test('already-granted OAuth verifies the authenticated GitHub profile before confirming CLI login', async t => {
  const { session, events } = await fixture(t, { automaticGrant: true, confirmLogin: true });
  const result = await session.step();
  assert.equal(result.status, 'verified', JSON.stringify({result,events}));
  assert.equal(result.githubUsername, 'fixture-user');
  assert.ok(events.indexOf('profile-identity') >= 0 && events.indexOf('profile-identity') < events.indexOf('confirm-login'));
  assert.equal(events.filter(x => x === 'profile-identity').length, 1);
  assert.equal(session.context.pages().length, 1, 'temporary identity tab is closed');
});

for (const profileIdentity of ['different-user', '']) test(`already-granted OAuth cannot confirm without matching authenticated profile: ${profileIdentity || 'missing'}`, async t => {
  const { session, events } = await fixture(t, { automaticGrant: true, confirmLogin: true, profileIdentity });
  assert.notEqual((await session.step()).status, 'verified');
  assert.ok(!events.includes('confirm-login'));
  assert.equal(events.filter(x => x === 'profile-identity').length, 1);
  assert.equal(session.context.pages().length, 1);
});

test('already-granted OAuth rejects identity if the bound flow changes during profile verification', async t => {
  const { session, events } = await fixture(t, { automaticGrant: true, confirmLogin: true, profileChangeFlow: true });
  assert.notEqual((await session.step()).status, 'verified');
  assert.ok(!events.includes('confirm-login'));
  assert.equal(events.filter(x => x === 'profile-identity').length, 1);
});

test('already-granted OAuth rejects identity if another GitHub login starts during profile verification', async t => {
  const { session, events } = await fixture(t, { automaticGrant: true, confirmLogin: true, profileOtherLogin: true });
  assert.notEqual((await session.step()).status, 'verified');
  assert.ok(!events.includes('confirm-login'));
  assert.equal(events.filter(x => x === 'profile-identity').length, 1);
});

for (const checked of [[false, false], [true, false], [true, true]]) {
  test(`actual hidden WorkBuddy controls are verified before GitHub; initial=${checked}`, async (t) => {
    const { session, events } = await fixture(t, { checked });
    const result = await session.step();
    assert.equal(result.status, "verified", JSON.stringify({ result, events }));
    assert.deepEqual(events, [...(!checked[0] ? ["service"] : []), ...(!checked[1] ? ["privacy"] : []), "github", "authorize"]);
  });
}

test("slow provider navigation and GitHub return_to login complete without another manual resume", async (t) => {
  const { session, events } = await fixture(t, { slow: true, resume: true });
  const result = await session.step();
  assert.equal(result.status, "verified", JSON.stringify({ result, events }));
  assert.deepEqual(events, ["service", "privacy", "github", "credentials", "authorize"]);
});

test("English official agreement labels are selected before the provider", async (t) => {
  const { session, events } = await fixture(t, { english: true });
  assert.equal((await session.step()).status, "verified");
  assert.deepEqual(events, ["service", "privacy", "github", "authorize"]);
});

test("GitHub form rendering is awaited before deciding human action is necessary", async (t) => {
  const { session, events } = await fixture(t, { resume: true, delayedForm: true });
  assert.equal((await session.step()).status, "verified");
  assert.deepEqual(events, ["service", "privacy", "github", "credentials", "authorize"]);
});

test("closing during a hidden policy click prevents the second agreement and GitHub action", async (t) => {
  const { session, events } = await fixture(t, { cancelOnService: true });
  assert.equal((await session.step()).status, "manual");
  assert.deepEqual(events, ["service"]);
});

test("a visible policy section with unrecognized controls never falls through to GitHub", async (t) => {
  const { session, events } = await fixture(t);
  const page = session.context.pages()[0];
  const frame = page.frameLocator("iframe");
  await frame.locator(".custom-checkbox").first().waitFor();
  await frame.locator(".custom-checkbox").evaluateAll(labels => labels.forEach(label => label.className = "changed-checkbox"));
  // End the readiness retry after its first observation; do not spend 45s on
  // an intentionally unsupported fixture or change production timeouts.
  page.waitForTimeout = async () => { await session.close(); };
  assert.equal((await session.step()).status, "manual");
  assert.deepEqual(events, []);
});

for (const passkey of [true, false]) test(`optional passkey=${passkey} then WorkBuddy confirmation finishes before verified`, async (t) => {
  const { session, events } = await fixture(t, { resume: true, passkey, confirmLogin: true });
  assert.equal((await session.step()).status, "verified");
  assert.deepEqual(events, ["service", "privacy", "github", "credentials", ...(passkey ? ["ask-later"] : []), "authorize", "confirm-login"]);
});

for (const options of [{finalState:'different-device'}, {finalText:'登录处理中'}]) test(`WorkBuddy does not verify incomplete or different-device success: ${JSON.stringify(options)}`, async (t) => {
  const {session}=await fixture(t,options);
  const page=session.context.pages()[0], wait=page.waitForTimeout.bind(page);
  page.waitForTimeout=async ms=>new URL(page.url()).pathname==='/login/started'?wait(1):wait(ms);
  const result=await session.step();
  assert.equal(result.status,'manual');
  assert.equal(result.reason,'workbuddy_confirmation');
});

test('GitHub consent uses the displayed verified identity and associated submit form, waiting until enabled',async t=>{
  const {session,events}=await fixture(t,{modernConsent:true,delayedConsent:true});
  assert.equal((await session.step()).status,'verified');
  assert.deepEqual(events,['service','privacy','github','authorize']);
});

for(const options of [{consentIdentity:'different-user'},{consentAction:'https://example.test/login/oauth/authorize'},{consentAction:'/login/oauth/authorize?client_id=another-client'}]) test(`modern consent rejects mismatched identity or action: ${JSON.stringify(options)}`,async t=>{
  const {session,events}=await fixture(t,{modernConsent:true,...options});
  const page=session.context.pages()[0],wait=page.waitForTimeout.bind(page);
  page.waitForTimeout=async ms=>new URL(page.url()).pathname==='/login/oauth/authorize'?wait(1):wait(ms);
  assert.equal((await session.step()).status,'manual');
  assert.ok(!events.includes('authorize'));
});

test('real Chromium recovers a timed out GitHub navigation and completes the same OAuth flow', async t => {
  const {session,events}=await fixture(t,{networkFailures:1,resume:true,confirmLogin:true});
  assert.equal((await session.step()).reason,'network');
  assert.equal(await session.retryNavigation(),true);
  const result=await session.step();
  assert.equal(result.status,'verified');
  assert.equal(result.githubUsername,'fixture-user');
  assert.equal(result.callbackVerified,true);
  assert.equal(events.filter(x=>x==='credentials').length,1);
  assert.equal(events.filter(x=>x==='authorize').length,1);
  assert.equal(events.filter(x=>x==='confirm-login').length,1);
});


test('owner-labelled authorization below the fold completes without manual clicks',async t=>{
 const {session,events}=await fixture(t,{modernConsent:true,consentLabel:'Authorize CodeBuddy-Official-Account',belowFold:true,confirmLogin:true});
 const result=await session.step();
 assert.equal(result.status,'verified',JSON.stringify(result));
 assert.equal(events.filter(e=>e==='authorize').length,1);
});

test('consent scroll happens before identity and button readiness checks', async t => {
  const {session,events}=await fixture(t,{requiresConsentScroll:true,confirmLogin:true});
  const result=await session.step();
  assert.equal(result.status,'verified',JSON.stringify({result,events}));
  assert.ok(events.includes('consent-scrolled'));
  assert.equal(events.filter(event=>event==='authorize').length,1);
});

test('live consent layout enables Authorize after scroll and never clicks same-name Cancel', async t => {
  const {session,events}=await fixture(t,{requiresConsentScroll:'live',confirmLogin:true});
  const result=await session.step();
  assert.equal(result.status,'verified',JSON.stringify({result,events}));
  assert.ok(events.includes('consent-scrolled'));
  assert.equal(events.filter(event=>event==='authorize').length,1);
  assert.ok(!events.includes('cancel'));
});


test('covered authorization remains retryable and submits once after the overlay clears',async t=>{
 const {session,events}=await fixture(t,{consentBlockedMs:12000,confirmLogin:true});
 const first=await session.step();
 assert.equal(first.reason,'github_authorize_not_ready');
 assert.equal(events.filter(e=>e==='authorize').length,0);
 assert.equal(session.submittedDocuments.has(session.context.pages().at(-1)),false);
 const result=await session.step();assert.equal(result.status,'verified');
 assert.equal(events.filter(e=>e==='authorize').length,1);
});


for(const consentMutation of ['action','identity']) test(`authorization revalidates ${consentMutation} after scrolling and waiting`,async t=>{
 const {session,events}=await fixture(t,{modernConsent:true,consentMutation});
 const result=await session.step();
 assert.equal(result.status,'manual');
 assert.equal(events.filter(e=>e==='authorize'||e==='unsafe-submit').length,0);
});
