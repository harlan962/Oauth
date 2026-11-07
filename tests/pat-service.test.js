import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createApp } from './authenticated-app.js';
import { IntegrationService } from '../server/integrations.js';
import { WorkBuddyService } from '../server/workbuddy.js';
import { PatBrowser } from '../server/pat-browser.js';
import { createServer } from 'node:http';
const { PatService } = await import('../server/pat-service.js').catch(() => ({}));
const token = 'github_pat_SYNTHETIC_service_123456789';
const expiry = () => new Date(Date.now() + 30 * 86400000).toISOString();
const response = (status = 200, headers = {}, login = 'octo') => new Response(JSON.stringify({ login }), { status, headers });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
function fixture(t, options = {}, count = 1) {
  assert.equal(typeof PatService, 'function');
  const directory = mkdtempSync(join(tmpdir(), 'pat-service-'));
  const store = new Store(directory);
  for (let i = 0; i < count; i++) {
    const row = store.create({ email: `octo${i}@example.test`, username: i ? `octo${i}` : 'octo', password: 'synthetic-password', totp: 'JBSWY3DPEHPK3PXP' });
    store.setCheck(row.id, row.username, { status: 'reachable', message: 'fixture' });
  }
  const browser = options.patBrowser ?? { assertAvailable() {}, async open({ onSubmitted, onToken }) { return { async step() { await onSubmitted(); await onToken(token, expiry()); return { status: 'captured' }; }, async close() {} }; } };
  const service = new PatService(store, { patFetcher: async () => response(), ...options, patBrowser: browser });
  t.after(async () => { await service.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, service, pats: service.pats };
}
const enable = service => service.configure({ enabled: true, confirmed: true });

function saved(pats, status = 'valid') {
  const row = pats.reserve();
  pats.saveToken(row.id, token + '_' + row.username, expiry());
  pats.update(row.id, { status });
  pats.complete(row.id);
  return row;
}
function provisioningProbe() {
  const opened = [];
  return { opened, options: {
    patBrowser: { assertAvailable() {}, async open({ account, onSubmitted, onToken }) {
      opened.push(account.id);
      return { async step() { onSubmitted(); onToken(token + '_' + account.username, expiry()); return { status: 'captured' }; }, async close() {} };
    } },
    patFetcher: async (_url, options) => response(200, {}, options.headers.Authorization.slice(('Bearer ' + token + '_').length)),
  } };
}

for (const state of ['manual', 'expired', 'invalid']) test(`released ${state} history survives trash and application startup without activity`, async t => {
  const { store, service, pats } = fixture(t);
  const row = pats.reserve();
  if (state === 'manual') pats.update(row.id, { status: 'manual' });
  else {
    pats.saveToken(row.id, token, state === 'expired' ? new Date(Date.now() - 1000).toISOString() : expiry());
    if (state === 'invalid') pats.markInvalid(row.id);
  }
  pats.complete(row.id);
  service.release(row.id, { confirmed: true });
  store.trash(row.accountId);
  let opens = 0, requests = 0;
  const restarted = createApp(store, { patBrowser: { assertAvailable() {}, async open() { opens++; throw new Error('unexpected browser'); } }, patFetcher: async () => { requests++; return response(); } });
  assert.equal(restarted.pat.status().records.length, 1);
  assert.equal(restarted.pat.status().records[0].id, row.id);
  assert.equal(store.get(row.accountId, true).patDedicated, 0);
  assert.ok(store.get(row.accountId, true).deletedAt);
  assert.equal(restarted.pat.status().running, false);
  assert.equal(opens, 0); assert.equal(requests, 0);
  assert.ok(!JSON.stringify(restarted.pat.status()).includes(token));
});

test('stopped tokenless source release keeps history but permits another maintenance run', async t => {
  const probe = provisioningProbe();
  const { service, pats } = fixture(t, { patBrowser: { assertAvailable() {}, async open() { return { async step() { return { status: 'manual' }; }, async close() {} }; } } }, 1);
  enable(service); await service.ensure(); await service.stop();
  const first = pats.list()[0];
  service.release(first.id, { confirmed: true });
  service.browser = probe.options.patBrowser; service.fetcher = probe.options.patFetcher;
  await service.ensure();
  assert.equal(pats.list().length, 2);
  assert.ok(pats.list().some(row => row.id === first.id));
  assert.equal(pats.usable().length, 1);
  assert.equal(pats.usable()[0].accountId, first.accountId);
  assert.equal((await service.credential()).id, pats.usable()[0].id);
});

test('successful resume clears the earlier paused task message', async t => {
  let attempts=0;
  const {service}=fixture(t,{patBrowser:{assertAvailable(){},async open({onSubmitted,onToken}){return {
    async step(){if(++attempts===1)return {status:'manual',reason:'permission_layout_unknown'};await onSubmitted();await onToken(token,expiry());return {status:'captured'};},async close(){},
  };}}});
  enable(service);await service.ensure();
  assert.match(service.status().message,/暂停/);
  service.resume();await service.active.promise;
  assert.equal(service.status().running,false);
  assert.equal(service.status().records[0].status,'valid');
  assert.doesNotMatch(service.status().message,/暂停/);
});

for (const scenario of ['partial', 'raised', 'expiry', 'invalid', 'saved401']) test(`automatic credential reconciliation restores target after ${scenario}`, async t => {
  const probe = provisioningProbe();
  const { service, pats } = fixture(t, probe.options, 6);
  service.configure({ enabled: true, confirmed: true, targetCount: scenario === 'raised' ? 1 : 2 });
  const first = saved(pats);
  if (scenario === 'raised') { await service.credential(); service.configure({ targetCount: 3 }); }
  if (scenario === 'expiry' || scenario === 'invalid') {
    const lost = saved(pats);
    if (scenario === 'expiry') pats.update(lost.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    else service.reportResponse(lost.id, response(401));
  }
  if (scenario === 'saved401') {
    pats.update(first.id, { status: 'verifying' });
    service.fetcher = async (url, options) => options.headers.Authorization === 'Bearer ' + token + '_' + first.username ? response(401) : probe.options.patFetcher(url, options);
  }
  const credential = await service.credential();
  assert.ok(credential.token);
  assert.equal(pats.usable().length, scenario === 'raised' ? 3 : 2);
  assert.equal(probe.opened.length, scenario === 'raised' || scenario === 'saved401' ? 2 : 1);
  assert.equal(new Set(probe.opened).size, probe.opened.length);
});

test('automatic saved-token 401 replacement shares one three-candidate budget', async t => {
  const probe = provisioningProbe();
  const { service, pats } = fixture(t, { ...probe.options, patFetcher: async () => response(401) }, 6);
  enable(service); saved(pats, 'verifying');
  await assert.rejects(service.credential(), /没有|核对|验证/);
  assert.equal(probe.opened.length, 3);
  assert.equal(new Set(probe.opened).size, 3);
  assert.equal(pats.list().length, 4);
  assert.ok(pats.list().every(row => row.status === 'invalid'));
});

for (const outcome of ['network', 'server', 'forbidden', 'manual', 'uncertain', 'cooling']) test(`automatic partial supply pauses on ${outcome} without substitution`, async t => {
  const probe = provisioningProbe(); let verifies = 0;
  const { service, pats } = fixture(t, { ...probe.options, patFetcher: async () => {
    verifies++;
    if (outcome === 'network') throw new Error('synthetic network');
    return response(outcome === 'server' ? 503 : 403);
  } }, 5);
  service.configure({ enabled: true, confirmed: true, targetCount: 3 });
  saved(pats);
  const row = saved(pats, ['manual', 'cooling'].includes(outcome) ? outcome : 'verifying');
  if (outcome === 'uncertain') pats.update(row.id, { creationUncertain: true });
  if (outcome === 'cooling') service.reportResponse(row.id, response(429, { 'retry-after': '120' }));
  if (outcome === 'cooling') assert.ok((await service.credential()).waitUntil);
  else await assert.rejects(service.credential(), /核对|人工|验证|未知/);
  assert.equal(probe.opened.length, 0);
  assert.equal(pats.list().length, 2);
  assert.equal(verifies, ['network', 'server', 'forbidden'].includes(outcome) ? 1 : 0);
});

test('positive post-wait quota restores cooling metadata without rotation', async t => {
  const probe = provisioningProbe();
  const { service, pats } = fixture(t, probe.options, 3);
  enable(service); const row = saved(pats);
  service.reportResponse(row.id, response(429, { 'retry-after': '120' }));
  const elapsed = new Date(Date.now() - 1000).toISOString();
  pats.update(row.id, { retryAt: elapsed });
  pats.setCheckpoint('global-cooldown', { waitUntil: elapsed, failures: 1, message: 'old cooldown' });
  assert.equal(pats.list()[0].status, 'cooling', 'time alone is not proof of recovery');
  const result = service.reportResponse(row.id, response(200, { 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000' }));
  assert.equal(result.status, 'valid'); assert.equal(result.retryAt, null); assert.equal(result.message, '');
  assert.equal((await service.credential()).id, row.id);
  assert.equal(probe.opened.length, 0); assert.equal(pats.list().length, 1);
});

test('positive quota cannot resurrect protected states or clear another future cooldown', async t => {
  const probe = provisioningProbe();
  const { service, pats } = fixture(t, probe.options, 6);
  enable(service);
  const cooling = saved(pats, 'cooling');
  const elapsed = new Date(Date.now() - 1000).toISOString();
  pats.update(cooling.id, { retryAt: elapsed, message: 'old cooldown' });
  const other = saved(pats);
  service.reportResponse(other.id, response(429, { 'retry-after': '120' }));
  const checkpoint = pats.getCheckpoint('global-cooldown');
  for (const status of ['disabled', 'verifying', 'manual']) {
    const row = saved(pats, status);
    assert.equal(service.reportResponse(row.id, response(200, { 'x-ratelimit-remaining': '4999' })).status, status);
  }
  assert.equal(service.reportResponse(cooling.id, response(200, { 'x-ratelimit-remaining': '4999' })).status, 'valid');
  assert.deepEqual(pats.getCheckpoint('global-cooldown'), checkpoint);
  assert.equal((await service.credential()).waitUntil, checkpoint.waitUntil);
  assert.equal(probe.opened.length, 0);
});

test('disabled default and confirmation gate never reserve or open accounts', async t => {
  const { service, pats } = fixture(t);
  assert.equal(service.status().settings.enabled, false);
  assert.throws(() => service.configure({ enabled: true }), /确认/);
  assert.throws(() => service.start(), /启用/);
  await assert.rejects(service.credential(), /启用/);
  assert.equal(pats.list().length, 0);
});

test('provisioning durably records submission, encrypts immediately and releases after close', async t => {
  let f, closed = false;
  f = fixture(t, { patBrowser: { assertAvailable() {}, async open({ account, onSubmitted, onToken }) { return {
    async step() {
      await onSubmitted(); assert.equal(f.pats.list()[0].creationUncertain, true);
      await onToken(token, expiry()); assert.equal(f.pats.secret(f.pats.list()[0].id), token);
      assert.equal(f.pats.list()[0].status, 'verifying');
      return { status: 'captured' };
    },
    async close() { assert.ok(f.store.get(account.id).reservedBy); closed = true; },
  }; } } });
  enable(f.service);
  await f.service.ensure();
  assert.equal(closed, true);
  assert.equal(f.service.status().records[0].status, 'valid');
  const record = f.pats.list()[0];
  assert.equal(f.store.get(record.accountId).reservedBy, null);
  assert.equal(f.store.get(record.accountId).patDedicated, 1);
  assert.deepEqual(await f.service.credential(), { id: record.id, username: record.username, token });
  assert.ok(!JSON.stringify(f.service.status()).includes(token));
});

test('PAT progress identifies login, permission review and encrypted capture before verification', async t => {
  let f;
  f = fixture(t, { patBrowser: { assertAvailable() {}, async open({ onProgress, onSubmitted, onToken }) { return {
    async step() {
      onProgress('login'); assert.match(f.pats.list()[0].message, /1\/4.*登录/);
      onProgress('permissions'); assert.match(f.pats.list()[0].message, /2\/4.*权限/);
      onSubmitted(); assert.match(f.pats.list()[0].message, /3\/4/);
      onToken(token, expiry()); assert.match(f.pats.list()[0].message, /4\/4.*保存/);
      return { status: 'captured' };
    }, async close() {},
  }; } } });
  enable(f.service); await f.service.ensure();
  assert.equal(f.pats.list()[0].status, 'valid');
  assert.equal(f.pats.list()[0].hasToken, true);
});

test('unrecognized PAT form reports an adaptation failure instead of asking users to guess permissions', async t => {
  const { service, pats } = fixture(t, { patBrowser: { assertAvailable() {}, async open() { return {
    async step() { return { status: 'manual', reason: 'permission_layout_unknown' }; }, async close() {},
  }; } } });
  enable(service); await service.ensure();
  assert.match(pats.list()[0].message, /创建表单.*识别|创建表单.*适配/);
  assert.match(pats.list()[0].message, /尚未生成/);
});

test('network verification failure preserves token and never replenishes another account', async t => {
  const { service, pats } = fixture(t, { patFetcher: async () => { throw new Error('password=synthetic github_pat_LEAK'); } }, 4);
  enable(service);
  await service.ensure();
  assert.equal(pats.list().length, 1);
  assert.equal(pats.list()[0].status, 'verifying');
  assert.ok(!JSON.stringify(service.status()).includes('LEAK'));
});

test('confirmed invalidity tries at most three distinct candidates per run', async t => {
  const { service, pats } = fixture(t, { patFetcher: async () => response(401) }, 5);
  enable(service);
  await service.ensure();
  assert.equal(pats.list().length, 3);
  assert.ok(pats.list().every(row => row.status === 'invalid'));
  assert.equal(new Set(pats.list().map(row => row.accountId)).size, 3);
});

test('unknown creation stops resume/restart from creating another PAT', async t => {
  let openings = 0;
  const { service, store, pats } = fixture(t, { patBrowser: { assertAvailable() {}, async open({ onSubmitted }) { openings++; return { async step() { await onSubmitted(); return { status: 'manual', reason: 'result_unknown' }; }, async close() {} }; } } }, 3);
  enable(service); await service.ensure(); await service.stop();
  const restarted = new PatService(store, { patBrowser: { assertAvailable() {}, async open() { throw new Error('must not open'); } } });
  assert.equal(openings, 1);
  assert.equal(pats.list()[0].creationUncertain, true);
  await assert.rejects(restarted.ensure(), /核对|人工|未知/);
  assert.equal(pats.list().length, 1);
  await restarted.stop();
});

test('synchronous start guard and stop while opening await browser close before unlock', async t => {
  const opening = deferred(), closing = deferred();
  let stepped = false;
  const { service, store, pats } = fixture(t, { patBrowser: { assertAvailable() {}, open: () => opening.promise } });
  enable(service); service.start();
  assert.throws(() => service.start(), /正在|任务/);
  const stopping = service.stop();
  opening.resolve({ async step() { stepped = true; }, close: () => closing.promise });
  await new Promise(r => setImmediate(r));
  const record = pats.list()[0];
  assert.ok(store.get(record.accountId).reservedBy);
  closing.resolve(); await stopping;
  assert.equal(stepped, false);
  assert.equal(store.get(record.accountId).reservedBy, null);
  assert.equal(service.status().running, false);
});

test('primary quota cooldown selects a second usable account without provisioning', async t => {
  const { service, pats } = fixture(t, {}, 2);
  enable(service);
  const first = pats.reserve(), second = pats.reserve();
  for (const row of [first, second]) { pats.saveToken(row.id, token + row.id, expiry()); pats.update(row.id, { status: 'valid' }); pats.complete(row.id); }
  const reset = Math.floor(Date.now() / 1000) + 600;
  await service.reportResponse(first.id, response(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset), 'x-ratelimit-limit': '5000' }));
  const credential = await service.credential();
  assert.equal(credential.id, second.id);
  assert.equal(credential.token, token + second.id);
  assert.equal(service.cooldown(), null);
  assert.ok(Date.parse(pats.list().find(row=>row.id===first.id).retryAt) >= reset * 1000);
  await service.ensure(); assert.equal(pats.list().length, 2);
});

test('HTTP 403 without rate headers and wrong owner require manual instead of invalidation', async t => {
  for (const upstream of [() => response(403), () => response(200, {}, 'other')]) {
    const { service, pats } = fixture(t, { patFetcher: async () => upstream() }, 2);
    enable(service); await service.ensure();
    assert.equal(pats.list().length, 1);
    assert.equal(pats.list()[0].status, 'manual');
  }
});

test('PAT verification uses fixed URL, rejects redirects and bounds requests', async t => {
  let options;
  const { service, pats } = fixture(t, { patFetcher: async (url, init) => { assert.equal(url, 'https://api.github.com/user'); options = init; return response(302); } }, 2);
  enable(service); await service.ensure();
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers.Authorization, 'Bearer ' + token);
  assert.equal(pats.list().length, 1);
  assert.equal(pats.list()[0].status, 'verifying');
});

test('HTTP PAT endpoints expose safe metadata and inherit local request guards', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pat-api-'));
  const store = new Store(directory);
  const account = store.create({ username: 'octo', email: 'octo@example.test', password: 'synthetic', totp: 'JBSWY3DPEHPK3PXP' });
  store.setCheck(account.id, 'octo', { status: 'reachable', message: 'fixture' });
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const host = '127.0.0.1:' + server.address().port;
  const result = createApp(store, { patFetcher: async () => response(), allowedHosts: [host] });
  server.on('request', result.app);
  t.after(async () => { await result.pat.stop(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.ok(result.pat, 'createApp exposes PAT service');
  const row = result.pat.pats.reserve();
  result.pat.pats.saveToken(row.id, token, expiry()); result.pat.pats.complete(row.id);
  const url = 'http://' + host + '/api/pat';
  assert.equal((await fetch(url)).status, 403);
  const headers = { 'X-Local-Client': 'account-desk', 'Content-Type': 'application/json' };
  const publicState = await (await fetch(url, { headers })).json();
  assert.ok(!JSON.stringify(publicState).includes(token));
  assert.equal(publicState.records[0].id, row.id);
  assert.equal((await fetch(url + '/config', { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) })).status, 400);
  assert.equal((await fetch(url + '/config', { method: 'PUT', headers, body: JSON.stringify({ enabled: true, confirmed: true }) })).status, 200);
});

test('PAT and both authorization services block each other before reserving or requesting', async t => {
  const { service, store, pats } = fixture(t);
  const integrations = new IntegrationService(store, { integrationFetcher: async () => response(403) });
  const workbuddy = new WorkBuddyService(store, integrations);
  service.integrations = integrations;
  enable(service);
  integrations.active = { id: 'legacy-fixture' };
  assert.throws(() => service.start(), /授权任务|正在/);
  integrations.active = null;
  workbuddy.active = { id: 'workbuddy-fixture' };
  assert.throws(() => service.start(), /授权任务|正在/);
  workbuddy.active = null;
  const target = integrations.save({ name: 'fixture', baseUrl: 'https://fixture.test', apiKey: 'synthetic' });
  service.active = { manual: true, controller: new AbortController() };
  const common = { targetId: target.id, targetRevision: target.revision, realm: 'global', count: 1, requestId: 'fixture-request' };
  assert.throws(() => integrations.start(common), /任务|PAT/);
  assert.throws(() => workbuddy.start({ ...common, accountIds: [store.list()[0].id] }), /任务|PAT/);
  assert.equal(pats.list().length, 0);
  service.active = null;
});

test('abort owning ensure closes a pending browser before rejecting and retains dedicated role', async t => {
  const opened = deferred(), closeGate = deferred();
  const { service, pats, store } = fixture(t, { patBrowser: { assertAvailable() {}, open: () => opened.promise } });
  enable(service);
  const controller = new AbortController();
  const running = service.ensure(controller.signal);
  controller.abort();
  opened.resolve({ step: async () => { assert.fail('no step after abort'); }, close: () => closeGate.promise });
  let settled = false;
  const outcome = running.then(() => { settled = true; }, error => { settled = true; assert.match(error.message, /取消/); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  const row = pats.list()[0]; assert.ok(store.get(row.accountId).reservedBy);
  closeGate.resolve(); await outcome;
  assert.equal(store.get(row.accountId).reservedBy, null);
  assert.equal(store.get(row.accountId).patDedicated, 1);
});

test('late successful verification cannot reenable a locally disabled credential', async t => {
  const gate = deferred();
  const { service, pats } = fixture(t, { patFetcher: () => gate.promise });
  enable(service);
  const row = pats.reserve(); pats.saveToken(row.id, token, expiry()); pats.complete(row.id);
  const credential = service.credential();
  service.disable(row.id);
  gate.resolve(response());
  await assert.rejects(credential, /核对|没有|验证/);
  assert.equal(pats.list()[0].status, 'disabled');
  service.reportResponse(row.id, response(200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now()/1000)+500) }));
  assert.equal(pats.list()[0].status, 'disabled');
});

test('cooldown honors long retry-after and increasing secondary backoff without consuming body', async t => {
  const { service, pats } = fixture(t);
  enable(service);
  const row = pats.reserve(); pats.saveToken(row.id, token, expiry()); pats.update(row.id, { status: 'valid' }); pats.complete(row.id);
  service.reportResponse(row.id, response(429, { 'retry-after': '1' }));
  const firstWait = await service.credential();
  assert.ok(Date.parse(firstWait.waitUntil) > Date.now() + 59000);
  service.reportResponse(row.id, response(429, { 'retry-after': '1' }));
  const secondWait = await service.credential();
  assert.ok(Date.parse(secondWait.waitUntil) > Date.now() + 119000);
  const limited = response(429, { 'retry-after': '1209600' });
  service.reportResponse(row.id, limited);
  assert.equal(limited.bodyUsed, false);
  const wait = await service.credential();
  assert.ok(Date.parse(wait.waitUntil) > Date.now() + 13 * 86400000);
});

test('manual verification of an existing token never allocates a replacement account', async t => {
  const { service, pats } = fixture(t, { patFetcher: async () => response(403) }, 3);
  enable(service);
  const row = pats.reserve(); pats.saveToken(row.id, token, expiry()); pats.complete(row.id);
  await service.ensure();
  assert.equal(pats.list().length, 1);
  assert.equal(pats.list()[0].status, 'manual');
});

test('failed browser close retains temporary lock and blocks new tasks', async t => {
  let failClose = true;
  const { service, pats, store } = fixture(t, { patBrowser: { assertAvailable() {}, async open({ onSubmitted, onToken }) { return {
    async step() { await onSubmitted(); await onToken(token, expiry()); return { status: 'captured' }; },
    async close() { if (failClose) throw new Error('synthetic'); },
  }; } } });
  enable(service); await service.ensure();
  const row = pats.list()[0];
  assert.ok(store.get(row.accountId).reservedBy);
  assert.equal(service.status().running, true);
  assert.throws(() => service.start(), /正在/);
  // No retry of a rejected shared close promise may falsely establish closure.
  failClose = false;
  await service.stop();
  assert.ok(store.get(row.accountId).reservedBy);
});

test('cancel racing capture preserves issued token and waits for real browser close', async t => {
  const entered = deferred(), capture = deferred(), closing = deferred();
  const { service, pats, store } = fixture(t, { patBrowser: { assertAvailable() {}, async open({ onSubmitted, onToken }) { return {
    async step() { await onSubmitted(); entered.resolve(); await capture.promise; await onToken(token, expiry()); return { status: 'captured' }; },
    close: () => closing.promise,
  }; } } });
  enable(service); service.start(); await entered.promise;
  const stopped = service.stop();
  capture.resolve(); await new Promise(resolve => setImmediate(resolve));
  const row = pats.list()[0];
  assert.equal(pats.secret(row.id), token);
  assert.equal(row.status, 'verifying');
  assert.ok(store.get(row.accountId).reservedBy);
  closing.resolve(); await stopped;
  assert.equal(store.get(row.accountId).reservedBy, null);
});

test('restart without a browser-close witness retains the old temporary PAT lock', async t => {
  const { store, pats } = fixture(t);
  const row = pats.reserve();
  const restarted = new PatService(store, { patBrowser: { assertAvailable() {}, open: async () => assert.fail('no startup login') } });
  assert.equal(pats.list()[0].status, 'manual');
  assert.equal(store.get(row.accountId).reservedBy, 'pat:' + row.id);
  await restarted.stop();
  assert.equal(store.get(row.accountId).reservedBy, 'pat:' + row.id);
  assert.throws(() => restarted.release(row.id, { confirmed: true }), /占用|关闭/);
});

test('restart resumes an unsubmitted PAT on the same account after proving browsers exited', async t => {
  const { store, service, pats } = fixture(t, {}, 3);
  enable(service);
  const row = pats.reserve();
  pats.update(row.id, { status: 'manual', message: '旧 PAT 浏览器关闭状态无法确认' });
  const probe = provisioningProbe();
  let inspections = 0;
  probe.options.patBrowser.confirmClosed = async () => { inspections++; return true; };
  const restarted = new PatService(store, probe.options);
  assert.equal(inspections, 0, 'startup must not log in or launch a recovery');
  await restarted.ensure();
  assert.equal(inspections, 1);
  assert.deepEqual(probe.opened, [row.accountId]);
  assert.equal(pats.list().length, 1);
  assert.equal(pats.list()[0].id, row.id);
  assert.equal(pats.list()[0].status, 'valid');
  assert.equal(store.get(row.accountId).reservedBy, null);
  assert.equal(store.get(row.accountId).patDedicated, 1);
});

test('cleanly stopped unsubmitted PAT can be retried on the same dedicated account after upgrade', async t => {
  const { store, service, pats } = fixture(t, { patBrowser: { assertAvailable() {}, async open() { return {
    step: async () => ({status: 'manual', reason: 'permission_layout_unknown'}), close: async () => {},
  }; } } }, 2);
  enable(service); await service.ensure();
  const row = pats.list()[0];
  await service.stop();
  assert.equal(store.get(row.accountId).reservedBy, null);
  const probe = provisioningProbe(); probe.options.patBrowser.confirmClosed = async () => true;
  const restarted = new PatService(store, probe.options);
  await restarted.ensure();
  assert.deepEqual(probe.opened, [row.accountId]);
  assert.equal(pats.list().length, 1);
  assert.equal(pats.list()[0].status, 'valid');
});

for (const outcome of [false, 'error']) test(`restart retains reservation when browser inspection returns ${outcome}`, async t => {
  const { store, service, pats } = fixture(t);
  enable(service);
  const row = pats.reserve();
  const probe = provisioningProbe();
  probe.options.patBrowser.confirmClosed = async () => { if (outcome === 'error') throw new Error('inspection unavailable'); return false; };
  const restarted = new PatService(store, probe.options);
  await restarted.ensure();
  assert.equal(probe.opened.length, 0);
  assert.equal(store.get(row.accountId).reservedBy, 'pat:' + row.id);
  assert.equal(pats.list()[0].status, 'manual');
});

test('closed old browser never permits replay of an uncertain submission', async t => {
  const { store, service, pats } = fixture(t);
  enable(service);
  const row = pats.reserve();
  pats.update(row.id, { creationUncertain: true });
  const probe = provisioningProbe();
  probe.options.patBrowser.confirmClosed = async () => true;
  const restarted = new PatService(store, probe.options);
  await assert.rejects(restarted.ensure(), /核对|未知/);
  assert.equal(probe.opened.length, 0);
  assert.equal(pats.list()[0].creationUncertain, true);
});

test('recovery does not create another PAT when the configured pool is already full', async t => {
  const { store, service, pats } = fixture(t, {}, 2);
  enable(service);
  saved(pats);
  const interrupted = pats.reserve();
  const probe = provisioningProbe();
  probe.options.patBrowser.confirmClosed = async () => true;
  const restarted = new PatService(store, probe.options);
  await restarted.credential();
  assert.equal(probe.opened.length, 0);
  assert.equal(pats.usable().length, 1);
  assert.equal(store.get(interrupted.accountId).reservedBy, null);
  assert.equal(store.get(interrupted.accountId).patDedicated, 1);
  assert.equal(pats.list().find(row => row.id === interrupted.id).status, 'disabled');
});

test('cancellation during old browser inspection does not open or unlock an account', async t => {
  const { store, service, pats } = fixture(t);
  enable(service);
  const row = pats.reserve();
  const gate = deferred(), entered = deferred();
  const probe = provisioningProbe();
  probe.options.patBrowser.confirmClosed = () => { entered.resolve(); return gate.promise; };
  const restarted = new PatService(store, probe.options);
  restarted.start();
  await entered.promise;
  const stopped = restarted.stop();
  gate.resolve(true);
  await stopped;
  assert.equal(probe.opened.length, 0);
  assert.equal(store.get(row.accountId).reservedBy, 'pat:' + row.id);
});

test('failed context initialization and failed browser close retain ownership and lock', async t => {
  let closes = 0;
  const patBrowser = new PatBrowser({ chromium: { executablePath: () => process.execPath, launch: async () => ({
    newContext: async () => { throw new Error('synthetic initialization'); },
    close: async () => { closes++; throw new Error('synthetic close'); },
  }) } });
  const { service, pats, store } = fixture(t, { patBrowser });
  enable(service); await service.ensure();
  const row = pats.list()[0];
  assert.equal(closes, 1);
  assert.equal(store.get(row.accountId).reservedBy, 'pat:' + row.id);
  assert.equal(service.status().running, true);
  assert.throws(() => service.start(), /正在/);
});

test('cancel during partial initialization retains ownership when closure is unconfirmed', async t => {
  const initializing = deferred(), gate = deferred();
  let closes = 0;
  const patBrowser = new PatBrowser({ chromium: { executablePath: () => process.execPath, launch: async () => ({
    newContext: async () => { initializing.resolve(); await gate.promise; throw new Error('synthetic initialization'); },
    close: async () => { closes++; throw new Error('synthetic close'); },
  }) } });
  const { service, pats, store } = fixture(t, { patBrowser });
  enable(service); service.start(); await initializing.promise;
  const stopping = service.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closes, 1, 'cancellation closes the launched browser before initialization settles');
  gate.resolve(); await stopping;
  const row = pats.list()[0];
  assert.equal(closes, 1);
  assert.equal(store.get(row.accountId).reservedBy, 'pat:' + row.id);
  assert.equal(service.status().running, true);
});

test('configuration disable during verification prevents returning any credential', async t => {
  const gate = deferred();
  const { service, pats } = fixture(t, { patFetcher: () => gate.promise });
  enable(service);
  const row = pats.reserve(); pats.saveToken(row.id, token, expiry()); pats.complete(row.id);
  const credential = service.credential();
  service.configure({ enabled: false }); gate.resolve(response());
  await assert.rejects(credential, /启用|停用/);
});

test('configuration disable during ensure prevents yielding a newly captured credential', async t => {
  const entered = deferred(), gate = deferred();
  const { service } = fixture(t, { patFetcher: async () => { entered.resolve(); return gate.promise; } });
  enable(service);
  const credential = service.credential(); await entered.promise;
  service.configure({ enabled: false }); gate.resolve(response());
  await assert.rejects(credential, /启用|停用/);
});

for (const invalid of [false, true]) test(`manual resume continues the same bounded run after ${invalid ? '401' : 'success'}`, async t => {
  let openings = 0, username;
  const { service, pats } = fixture(t, {
    patBrowser: { assertAvailable() {}, async open({ account, onSubmitted, onToken }) {
      username = account.username;
      const number = ++openings; let steps = 0;
      return { async step() {
        if (number === 1 && ++steps === 1) return { status: 'manual', reason: 'human_security_challenge' };
        await onSubmitted(); await onToken(token + '_' + number, expiry()); return { status: 'captured' };
      }, async close() {} };
    } },
    patFetcher: async () => response(invalid ? 401 : 200, {}, username),
  }, 5);
  service.configure({ enabled: true, confirmed: true, targetCount: 3 });
  await service.ensure(); assert.equal(openings, 1);
  service.resume(); await service.ensure();
  assert.equal(openings, 3);
  assert.equal(pats.list().length, 3);
  assert.equal(new Set(pats.list().map(row => row.accountId)).size, 3);
  assert.equal(pats.list().filter(row => row.status === (invalid ? 'invalid' : 'valid')).length, 3);
  assert.equal(service.status().running, false);
});
