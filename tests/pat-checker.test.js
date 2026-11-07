import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../server/store.js';
import { PatStore } from '../server/pat-store.js';
import { PatService } from '../server/pat-service.js';
import { checkGithub, createChecker } from '../server/checker.js';
import { createApp } from './authenticated-app.js';

const token = 'github_pat_SYNTHETIC_checker_123456789';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const profile = name => new Response(JSON.stringify({ login: name, type: 'User' }));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pat-checker-'));
  const store = new Store(directory);
  const pats = new PatStore(store);
  const row = store.create({ email: 'alice@example.test', username: 'alice', password: 'synthetic', totp: 'JBSWY3DPEHPK3PXP' });
  store.setCheck(row.id, row.username, { status: 'reachable', message: 'previous valid result' });
  const connections = [];
  const cleanup = [];
  t.after(async () => { for (const action of cleanup) await action(); for (const connection of connections) connection.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, pats, row, directory, connections, cleanup };
}
async function until(predicate) {
  const end = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('checker condition timed out');
    await new Promise(r => setTimeout(r, 2));
  }
}
const finished = async checker => { await until(() => !checker.status().running); return checker.status(); };
function provider(overrides = {}) {
  return { status: () => ({ settings: { enabled: true } }), credential: async () => ({ id: 'synthetic-pat', token }), reportResponse() {}, stop() { throw new Error('checker must not stop independent PAT task'); }, ...overrides };
}

test('resuming a saved check recovers its unsubmitted PAT without manual browser intervention', async t => {
  const { store, pats, row, cleanup } = fixture(t);
  pats.configure({ enabled: true, confirmed: true });
  const source = pats.reserve();
  pats.update(source.id, { status: 'manual' });
  const blocked = createChecker(store, async () => assert.fail('no profile before PAT'), 0, {
    pat: provider({ credential: async () => { throw new Error('interrupted'); } }),
  });
  blocked.start([row.id]);
  assert.equal((await finished(blocked)).canResume, true);
  const pat = new PatService(store, {
    patBrowser: { assertAvailable() {}, confirmClosed: async () => true, async open({ account, onSubmitted, onToken }) {
      assert.equal(account.id, source.accountId);
      return { async step() {
        onSubmitted(); onToken(token, new Date(Date.now() + 86400000).toISOString());
        return { status: 'captured' };
      }, async close() {} };
    } },
    patFetcher: async () => profile('alice'),
  });
  cleanup.push(() => pat.stop());
  const restored = createChecker(store, async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    return profile('alice');
  }, 0, { pat });
  restored.resume();
  const done = await finished(restored);
  assert.equal(done.done, 1);
  assert.equal(done.counts.reachable, 1);
  assert.equal(pats.list().length, 1);
  assert.equal(pats.list()[0].id, source.id);
});

for (const scenario of ['partial pool', 'saved token 401']) test(`real checker acquisition reconciles ${scenario} before checking the queued account`, async t => {
  const { store, pats, row, cleanup } = fixture(t);
  const source = pats.reserve();
  pats.saveToken(source.id, token, new Date(Date.now() + 86400000).toISOString());
  pats.update(source.id, { status: scenario === 'partial pool' ? 'valid' : 'verifying' });
  pats.complete(source.id);
  for (const username of ['replacement1', 'replacement2', 'replacement3']) {
    const account = store.create({ email: username + '@example.test', username, password: 'synthetic', totp: 'JBSWY3DPEHPK3PXP' });
    store.setCheck(account.id, username, { status: 'reachable', message: 'fixture' });
  }
  let opens = 0, verifies = 0, profiles = 0;
  const pat = new PatService(store, { patBrowser: { assertAvailable() {}, async open({ account, onSubmitted, onToken }) {
    opens++;
    return { async step() { onSubmitted(); onToken(token + '_' + account.username, new Date(Date.now() + 86400000).toISOString()); return { status: 'captured' }; }, async close() {} };
  } }, patFetcher: async (_url, options) => {
    verifies++;
    if (options.headers.Authorization === 'Bearer ' + token) return new Response('{}', { status: 401 });
    return profile(options.headers.Authorization.slice(('Bearer ' + token + '_').length));
  } });
  cleanup.push(() => pat.stop());
  pat.configure({ enabled: true, confirmed: true, targetCount: scenario === 'partial pool' ? 2 : 1 });
  const checker = createChecker(store, async (url, options) => {
    profiles++;
    assert.equal(url, 'https://api.github.com/users/alice');
    assert.match(options.headers.Authorization, /^Bearer github_pat_SYNTHETIC_/);
    assert.equal(pats.usable().length, scenario === 'partial pool' ? 2 : 1);
    return profile('alice');
  }, 0, { pat });
  checker.start([row.id]);
  const status = await finished(checker);
  assert.equal(status.done, 1); assert.equal(status.phase, 'idle');
  assert.equal(opens, 1); assert.equal(profiles, 1);
  assert.equal(verifies, scenario === 'partial pool' ? 1 : 2);
  assert.equal(pats.getCheckpoint('checks').index, 1);
  assert.ok(!JSON.stringify(status).includes(token));
});

test('authenticated check is bound to official API, rejects redirects and returns only safe diagnostics', async () => {
  let request;
  const result = await checkGithub('alice', async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ login: 'alice', type: 'User', token }), { headers: { 'x-ratelimit-limit': '73', 'x-ratelimit-remaining': '72', 'x-ratelimit-reset': '1900000000' } });
  }, undefined, { token });
  assert.equal(request.url, 'https://api.github.com/users/alice');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers.Authorization, 'Bearer ' + token);
  assert.equal(result.status, 'reachable');
  assert.equal(result.quota.limit, 73);
  assert.equal(result.quota.remaining, 72);
  assert.equal(result.quota.resetAt, '2030-03-17T17:46:40.000Z');
  assert.ok(!JSON.stringify(result).includes(token));
  const failed = await checkGithub('alice', async () => { throw new Error(token); }, undefined, { token });
  assert.equal(failed.kind, 'network');
  assert.ok(!JSON.stringify(failed).includes(token));
});

test('quota wait preserves prior result and current index, makes no requests or replenishment until release', async t => {
  const { store, row, pats } = fixture(t);
  let now = Date.parse('2030-01-01T00:00:00Z'), requests = 0, credentials = 0;
  const gate = deferred(), waiting = deferred();
  const pat = provider({ credential: async () => { credentials++; return { id: 'synthetic-pat', token }; } });
  const checker = createChecker(store, async () => ++requests === 1
    ? new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '73', 'x-ratelimit-reset': String(now / 1000 + 120) } })
    : profile('alice'), 0, { pat, clock: () => now, wait: async (ms, signal) => { waiting.resolve(); await gate.promise; now += ms; } });
  checker.start([row.id]);
  await until(() => checker.status().phase === 'waiting');
  assert.equal(checker.status().phase, 'waiting');
  assert.equal(checker.status().done, 0);
  assert.equal(checker.status().retryAt, '2030-01-01T00:02:00.000Z');
  assert.equal(store.get(row.id).checkMessage, 'previous valid result');
  assert.equal(store.get(row.id).publicStatus, 'reachable');
  assert.equal(requests, 1);
  assert.equal(credentials, 1);
  assert.equal(pats.getCheckpoint('checks').index, 0);
  gate.resolve();
  assert.equal((await finished(checker)).done, 1);
  assert.equal(requests, 2);
  assert.equal(credentials, 1);
  assert.ok(!JSON.stringify(pats.getCheckpoint('checks')).includes(token));
});

test('credential cooldown waits without a request and cancel immediately settles durable task', async t => {
  const { store, row, pats } = fixture(t);
  let credentials = 0, requests = 0;
  const pat = provider({ credential: async () => { credentials++; return { waitUntil: new Date(Date.now() + 600000).toISOString(), message: 'cooling' }; } });
  const checker = createChecker(store, async () => { requests++; return profile('alice'); }, 0, { pat });
  checker.start([row.id]);
  await until(() => checker.status().phase === 'waiting');
  const start = Date.now();
  await checker.cancel();
  await finished(checker);
  assert.ok(Date.now() - start < 300);
  assert.equal(requests, 0);
  assert.equal(credentials, 1);
  assert.equal(checker.status().done, 0);
  assert.equal(checker.status().canResume, true);
  assert.equal(pats.getCheckpoint('checks').job.running, false);
});

test('401 retries credentials with a bounded budget and preserves checked account results', async t => {
  const { store, row } = fixture(t);
  let credentials = 0, reports = 0, requests = 0;
  const pat = provider({ credential: async () => ({ id: String(++credentials), token }), reportResponse: (id, response) => { assert.equal(response.status, 401); reports++; } });
  const checker = createChecker(store, async () => { requests++; return new Response('{}', { status: 401 }); }, 0, { pat });
  checker.start([row.id]);
  const status = await finished(checker);
  assert.equal(requests, 3);
  assert.equal(credentials, 3);
  assert.equal(reports, 3);
  assert.equal(status.phase, 'manual');
  assert.equal(status.done, 0);
  assert.equal(store.get(row.id).publicStatus, 'reachable');
});

for (const kind of ['network', 'forbidden', 'server']) test(`${kind} does not replenish or overwrite a valid result`, async t => {
  const { store, row } = fixture(t);
  let credentials = 0, requests = 0;
  const checker = createChecker(store, async () => {
    requests++;
    if (kind === 'network') throw new Error(token);
    return new Response(token, { status: kind === 'forbidden' ? 403 : 503 });
  }, 0, { pat: provider({ credential: async () => { credentials++; return { id: 'synthetic-pat', token }; } }), wait: async () => {} });
  checker.start([row.id]);
  const status = await finished(checker);
  assert.equal(credentials, 1);
  assert.equal(requests, kind === 'forbidden' ? 1 : 3);
  assert.equal(status.phase, 'manual');
  assert.equal(status.done, 0);
  assert.equal(store.get(row.id).checkMessage, 'previous valid result');
  assert.ok(!JSON.stringify(status).includes(token));
});

test('anonymous reset waits and retries current row; unknown reset is resumable manual work', async t => {
  const { store, row } = fixture(t);
  let calls = 0, now = Date.parse('2030-01-01T00:00:00Z');
  const checker = createChecker(store, async () => ++calls === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }) : profile('alice'), 0,
    { clock: () => now, wait: async ms => { assert.equal(store.get(row.id).checkMessage, 'previous valid result'); now += ms; } });
  checker.start([row.id]);
  assert.equal((await finished(checker)).done, 1);
  assert.equal(calls, 2);
  const blocked = createChecker(store, async () => new Response('{}', { status: 429 }), 0);
  blocked.start([row.id]);
  const status = await finished(blocked);
  assert.equal(status.done, 0);
  assert.equal(status.phase, 'manual');
  assert.equal(status.canResume, true);
  assert.equal(store.get(row.id).publicStatus, 'reachable');
});

test('restart never runs automatically and explicit resume uses persisted queue, counts and expected usernames', async t => {
  const { store, row, directory, connections } = fixture(t);
  const bob = store.create({ email: 'bob@example.test', username: 'bob', password: 'synthetic', totp: 'JBSWY3DPEHPK3PXP' });
  const carol = store.create({ email: 'carol@example.test', username: 'carol', password: 'synthetic', totp: 'JBSWY3DPEHPK3PXP' });
  const checker = createChecker(store, async url => url.endsWith('/alice') ? profile('alice') : new Response('{}', { status: 403 }), 0);
  checker.start([row.id, bob.id, carol.id]);
  assert.equal((await finished(checker)).done, 1);
  store.update(bob.id, { username: 'renamed' });
  store.trash(carol.id);
  const secondStore = new Store(directory);
  connections.push(secondStore);
  let calls = 0;
  const resumed = createChecker(secondStore, async () => { calls++; return profile('renamed'); }, 0);
  assert.equal(calls, 0);
  assert.equal(resumed.status().phase, 'interrupted');
  assert.equal(resumed.status().canResume, true);
  assert.equal(resumed.status().done, 1);
  resumed.resume();
  const status = await finished(resumed);
  assert.equal(status.done, 3);
  assert.equal(status.counts.reachable, 1);
  assert.equal(status.counts.skipped, 2);
  assert.equal(calls, 0);
  assert.equal(secondStore.get(bob.id).publicStatus, 'unchecked');
});

test('explicit restart resume after elapsed cooldown retries current row without another wait', async t => {
  const { store, row, directory, connections } = fixture(t);
  let now = Date.parse('2030-01-01T00:00:00Z');
  const checker = createChecker(store, async () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }), 0, { clock: () => now });
  checker.start([row.id]);
  await until(() => checker.status().phase === 'waiting');
  await checker.cancel();
  now += 180000;
  const reopened = new Store(directory); connections.push(reopened);
  let requests = 0;
  const resumed = createChecker(reopened, async () => { requests++; return profile('alice'); }, 0, { clock: () => now, wait: async () => { throw new Error('elapsed cooldown must not wait'); } });
  assert.equal(resumed.status().phase, 'interrupted');
  assert.equal(requests, 0);
  resumed.resume();
  assert.equal((await finished(resumed)).done, 1);
  assert.equal(requests, 1);
});

test('paged durable queue resumes across the first results page without repeating completed accounts', async t => {
  const { store, row, directory, connections, pats } = fixture(t);
  const ids = [row.id];
  for (let n = 1; n < 103; n++) ids.push(store.create({ email: `user${n}@example.test`, username: `user${n}`, password: 'synthetic', totp: 'JBSWY3DPEHPK3PXP' }).id);
  let requests = 0;
  const checker = createChecker(store, async url => ++requests === 102 ? new Response('{}', { status: 403 }) : profile(url.split('/').pop()), 0);
  checker.start(ids);
  assert.equal((await finished(checker)).done, 101);
  assert.equal(pats.getCheckpoint('checks').queuePages, 2);
  assert.equal(pats.getCheckpoint('checks:results:0').length, 100);
  assert.equal(pats.getCheckpoint('checks:results:1').length, 1);
  const reopened = new Store(directory); connections.push(reopened);
  const remaining = [];
  const resumed = createChecker(reopened, async url => { remaining.push(url.split('/').pop()); return profile(url.split('/').pop()); }, 0);
  assert.equal(resumed.status().done, 101);
  resumed.resume();
  const final = await finished(resumed);
  assert.deepEqual(remaining, ['user101', 'user102']);
  assert.equal(final.done, 103);
  assert.equal(final.counts.reachable, 103);
});

test('failed queue-page publication rolls back to the prior complete manifest', async t => {
  const { store, row, pats, directory, connections } = fixture(t);
  const checker = createChecker(store, async () => profile('alice'), 0);
  checker.start([row.id]); await finished(checker);
  const previousStatus = checker.status();
  const ids = [row.id];
  for (let n = 1; n < 101; n++) ids.push(store.create({ email: `user${n}@example.test`, username: `user${n}`, password: 'synthetic', totp: 'JBSWY3DPEHPK3PXP' }).id);
  const set = pats.setCheckpoint.bind(pats);
  pats.setCheckpoint = (name, value) => { if (name === 'checks:queue:1') throw new Error('synthetic disk failure'); return set(name, value); };
  assert.throws(() => checker.start(ids), error => error.status === 500 && !error.message.includes('synthetic disk failure'));
  assert.deepEqual(checker.status(), previousStatus);
  pats.setCheckpoint = set;
  const reopened = new Store(directory); connections.push(reopened);
  const recovered = createChecker(reopened, async () => { throw new Error('must not run'); }, 0);
  assert.equal(recovered.status().total, 1);
  assert.equal(recovered.status().done, 1);
  assert.equal(recovered.status().canResume, false);
});

for (const ownership of ['checker', 'independent', 'replaced']) test(`cancel respects real PatService ${ownership} browser ownership`, async t => {
  const { store, row, pats, cleanup } = fixture(t);
  let closed = 0;
  const pat = new PatService(store, { patBrowser: { assertAvailable() {}, async open() { return { async step() { return { status: 'manual', reason: 'challenge' }; }, async close() { closed++; } }; } }, patFetcher: async () => { throw new Error('no verification expected'); } });
  pat.configure({ enabled: true, confirmed: true });
  cleanup.push(() => pat.stop());
  if (ownership === 'independent') { pat.start(); await until(() => pat.active?.manual); }
  const checker = createChecker(store, async () => { throw new Error('manual PAT must prevent requests'); }, 0, { pat });
  checker.start([row.id]);
  assert.equal((await finished(checker)).phase, 'manual');
  const original = pat.active;
  assert.ok(original);
  if (ownership === 'replaced') {
    await pat.stop();
    pats.markInvalid(original.record.id, 'synthetic reconciliation');
    const next = store.create({ email: 'next@example.test', username: 'next', password: 'synthetic', totp: 'JBSWY3DPEHPK3PXP' });
    store.setCheck(next.id, next.username, { status: 'reachable', message: 'fixture' });
    pat.start(); await until(() => pat.active?.manual);
    assert.notEqual(pat.active, original);
  }
  const activeBeforeCancel = pat.active;
  const closedBeforeCancel = closed;
  await checker.cancel();
  if (ownership === 'checker') {
    assert.equal(pat.active, null);
    assert.equal(closed, 1);
  } else {
    assert.equal(pat.active, activeBeforeCancel);
    assert.equal(closed, closedBeforeCancel);
  }
  await pat.stop();
});

test('authenticated HTTP checks and explicit resume expose safe backward compatible progress', async t => {
  const { store, row, pats } = fixture(t);
  pats.configure({ enabled: true, confirmed: true });
  const source = pats.reserve();
  pats.saveToken(source.id, token, new Date(Date.now() + 86400000).toISOString());
  pats.update(source.id, { status: 'valid' });
  pats.complete(source.id);
  let code = 403;
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { app, checker } = createApp(store, { allowedHosts: [new URL(base).host], delayMs: 0, fetcher: async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    return code === 200 ? profile('alice') : new Response('{}', { status: code });
  } });
  server.on('request', app);
  const post = path => fetch(base + path, { method: 'POST', headers: { 'X-Local-Client': 'account-desk', 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [row.id] }) });
  assert.equal((await post('/api/checks')).status, 200);
  assert.equal((await finished(checker)).phase, 'manual');
  // Explicit user retry after manual diagnosis; the test restores the synthetic PAT.
  pats.update(source.id, { status: 'valid' }); code = 200;
  const resumed = await post('/api/checks/resume');
  assert.equal(resumed.status, 200);
  const body = await resumed.json();
  assert.equal(typeof body.running, 'boolean');
  assert.equal(typeof body.canResume, 'boolean');
  assert.ok(!JSON.stringify(body).includes(token));
  assert.equal((await finished(checker)).done, 1);
});

test('cancel promise settles only after aborting request and final checkpoint are complete', async t => {
  const { store, row, pats } = fixture(t);
  const gate = deferred();
  let started = false, settled = false;
  const checker = createChecker(store, async (_, { signal }) => {
    started = true;
    return new Promise((resolve, reject) => signal.addEventListener('abort', async () => { await gate.promise; reject(new Error('synthetic abort')); }, { once: true }));
  }, 0);
  checker.start([row.id]);
  await until(() => started);
  const cancelled = checker.cancel().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  gate.resolve(); await cancelled;
  assert.equal(pats.getCheckpoint('checks').job.running, false);
  assert.equal(pats.getCheckpoint('checks').index, 0);
  assert.equal(store.get(row.id).checkMessage, 'previous valid result');
});

for (const mutation of ['disabled', 'expired']) test(`cached PAT ${mutation} between rows is not sent again`, async t => {
  const { store, row, pats, cleanup } = fixture(t);
  const source = pats.reserve();
  pats.saveToken(source.id, token, new Date(Date.now() + 86400000).toISOString());
  pats.update(source.id, { status: 'valid' }); pats.complete(source.id);
  const bob = store.create({ email: 'bob@example.test', username: 'bob', password: 'synthetic', totp: 'JBSWY3DPEHPK3PXP' });
  pats.configure({ enabled: true, confirmed: true });
  const pat = new PatService(store, { patBrowser: { assertAvailable() { throw new Error('synthetic browser unavailable'); } } });
  cleanup.push(() => pat.stop());
  let requests = 0;
  const checker = createChecker(store, async () => { requests++; return profile(requests === 1 ? 'alice' : 'bob'); }, 1, { pat, wait: async () => {
    if (mutation === 'disabled') pats.disable(source.id);
    else pats.update(source.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  } });
  checker.start([row.id, bob.id]);
  const status = await finished(checker);
  assert.equal(requests, 1);
  assert.equal(status.done, 1);
  assert.equal(status.phase, 'manual');
  assert.equal(store.get(bob.id).publicStatus, 'unchecked');
});

test('real PatService replenishes only after confirmed 401 and resumes the same checked account', async t => {
  const { store, row, pats, cleanup } = fixture(t);
  const source = pats.reserve();
  pats.saveToken(source.id, token, new Date(Date.now() + 86400000).toISOString());
  pats.update(source.id, { status: 'valid' }); pats.complete(source.id);
  const bob = store.create({ email: 'bob@example.test', username: 'bob', password: 'synthetic', totp: 'JBSWY3DPEHPK3PXP' });
  store.setCheck(bob.id, bob.username, { status: 'reachable', message: 'candidate' });
  pats.configure({ enabled: true, confirmed: true });
  let openings = 0;
  const replacement = 'github_pat_SYNTHETIC_checker_replacement';
  const pat = new PatService(store, { patBrowser: { assertAvailable() {}, async open({ onToken, onSubmitted, account }) {
    assert.equal(account.id, bob.id); openings++;
    return { async step() { onSubmitted(); onToken(replacement, new Date(Date.now() + 86400000).toISOString()); return { status: 'captured' }; }, async close() {} };
  } }, patFetcher: async (url, options) => { assert.equal(url, 'https://api.github.com/user'); assert.equal(options.headers.Authorization, 'Bearer ' + replacement); return new Response(JSON.stringify({ login: 'bob' })); } });
  cleanup.push(() => pat.stop());
  const requested = [];
  const checker = createChecker(store, async (url, options) => {
    requested.push(url);
    if (requested.length === 1) { assert.equal(options.headers.Authorization, 'Bearer ' + token); return new Response('{}', { status: 401 }); }
    assert.equal(options.headers.Authorization, 'Bearer ' + replacement);
    assert.equal(store.get(row.id).checkMessage, 'previous valid result');
    return profile('alice');
  }, 0, { pat });
  checker.start([row.id]);
  assert.equal((await finished(checker)).done, 1);
  assert.equal(openings, 1);
  assert.deepEqual(requested, ['https://api.github.com/users/alice', 'https://api.github.com/users/alice']);
  assert.equal(pats.list().find(record => record.id === source.id).status, 'invalid');
});

test('successful last-quota response persists next-row cooldown with completed progress', async t => {
  const { store, row, pats } = fixture(t);
  const bob = store.create({ email: 'bob@example.test', username: 'bob', password: 'synthetic', totp: 'JBSWY3DPEHPK3PXP' });
  const now = Date.parse('2030-01-01T00:00:00Z');
  let firstProgress;
  const save = pats.setCheckpoint.bind(pats);
  pats.setCheckpoint = (name, value) => { if (name === 'checks' && value.index === 1 && !firstProgress) firstProgress = structuredClone(value); return save(name, value); };
  const checker = createChecker(store, async () => new Response(JSON.stringify({ login: 'alice', type: 'User' }), { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 120) } }), 0,
    { clock: () => now, wait: (ms, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('synthetic abort')), { once: true })) });
  checker.start([row.id, bob.id]);
  await until(() => checker.status().phase === 'waiting');
  await checker.cancel();
  assert.equal(firstProgress.job.retryAt, '2030-01-01T00:02:00.000Z');
  assert.equal(firstProgress.job.done, 1);
});

test('cached credentials honor a shared cooldown established between rows', async t => {
  const { store, row, pats } = fixture(t);
  const bob = store.create({ email: 'bob@example.test', username: 'bob', password: 'synthetic', totp: 'JBSWY3DPEHPK3PXP' });
  let now = Date.parse('2030-01-01T00:00:00Z'), requests = 0;
  const checker = createChecker(store, async () => { requests++; return profile(requests === 1 ? 'alice' : 'bob'); }, 1, { pat: provider(), clock: () => now, wait: (ms, signal) => {
    if (ms === 1) { now++; pats.setCheckpoint('global-cooldown', { waitUntil: '2030-01-01T00:02:00.000Z', message: 'shared cooldown' }); return Promise.resolve(); }
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('synthetic abort')), { once: true }));
  } });
  checker.start([row.id, bob.id]);
  await until(() => checker.status().phase === 'waiting' || !checker.status().running);
  await checker.cancel();
  assert.equal(requests, 1);
  assert.equal(checker.status().done, 1);
});

test('result-page rejection preserves committed live progress through finalization and restart', async t => {
  const { store, row, pats, directory, connections } = fixture(t);
  const bob = store.create({ email: 'bob@example.test', username: 'bob', password: 'synthetic', totp: 'JBSWY3DPEHPK3PXP' });
  const save = pats.setCheckpoint.bind(pats);
  let rejected = false;
  pats.setCheckpoint = (name, value) => {
    if (!rejected && name === 'checks:results:0') { rejected = true; throw new Error(token); }
    return save(name, value);
  };
  const checker = createChecker(store, async url => profile(url.split('/').pop()), 0);
  checker.start([row.id, bob.id]);
  const status = await finished(checker);
  assert.equal(status.phase, 'interrupted');
  assert.equal(status.done, 0);
  assert.equal(status.counts.reachable, 0);
  assert.equal(status.canResume, true);
  assert.ok(!JSON.stringify(status).includes(token));
  assert.equal(pats.getCheckpoint('checks').index, 0);
  assert.equal(pats.getCheckpoint('checks:results:0'), null);
  const reopened = new Store(directory); connections.push(reopened);
  const requested = [];
  const recovered = createChecker(reopened, async url => { requested.push(url.split('/').pop()); return profile(url.split('/').pop()); }, 0);
  assert.equal(recovered.status().total, 2);
  assert.equal(recovered.status().done, 0);
  recovered.resume();
  assert.equal((await finished(recovered)).done, 2);
  assert.equal(recovered.status().counts.reachable, 2);
  assert.deepEqual(requested, ['alice', 'bob']);
});

test('persistent checkpoint rejection safely terminates background execution and cancel without false persistence', async t => {
  const { store, row, pats, directory, connections } = fixture(t);
  const save = pats.setCheckpoint.bind(pats);
  let rejectWrites = false;
  pats.setCheckpoint = (name, value) => { if (rejectWrites) throw new Error(token); return save(name, value); };
  const checker = createChecker(store, async () => { rejectWrites = true; return profile('alice'); }, 0);
  checker.start([row.id]);
  const status = await finished(checker);
  await new Promise(resolve => setImmediate(resolve));
  await assert.doesNotReject(checker.cancel());
  assert.equal(status.phase, 'interrupted');
  assert.equal(status.done, 0);
  assert.equal(status.counts.reachable, 0);
  assert.equal(status.canResume, true);
  assert.match(status.message, /保存|存储/);
  assert.ok(!JSON.stringify(status).includes(token));
  assert.notEqual(status.message, '检查完成');
  const retained = pats.getCheckpoint('checks');
  assert.equal(retained.index, 0);
  assert.equal(retained.job.done, 0);
  assert.equal(pats.getCheckpoint('checks:results:0'), null);
  rejectWrites = false;
  const reopened = new Store(directory); connections.push(reopened);
  const recovered = createChecker(reopened, async () => profile('alice'), 0);
  assert.equal(recovered.status().total, 1);
  assert.equal(recovered.status().done, 0);
  recovered.resume();
  assert.equal((await finished(recovered)).done, 1);
});

test('cancel HTTP awaits termination and returns safe interrupted state on persistent checkpoint rejection', async t => {
  const { store, row, pats, cleanup } = fixture(t);
  const gate = deferred();
  let started = false, aborted = false, rejectWrites = false;
  const save = pats.setCheckpoint.bind(pats);
  pats.setCheckpoint = (name, value) => { if (rejectWrites) throw new Error(token); return save(name, value); };
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { app, checker } = createApp(store, { allowedHosts: [new URL(base).host], delayMs: 0, fetcher: async (_, { signal }) => {
    started = true;
    return new Promise((resolve, reject) => signal.addEventListener('abort', async () => { aborted = true; await gate.promise; reject(new Error(token)); }, { once: true }));
  } });
  server.on('request', app);
  cleanup.push(async () => { gate.resolve(); rejectWrites = false; await checker.cancel().catch(() => {}); await new Promise(resolve => server.close(resolve)); });
  const post = path => fetch(base + path, { method: 'POST', headers: { 'X-Local-Client': 'account-desk', 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [row.id] }) });
  assert.equal((await post('/api/checks')).status, 200);
  await until(() => started);
  rejectWrites = true;
  let replied = false;
  const responsePromise = post('/api/checks/cancel').then(response => { replied = true; return response; });
  await until(() => aborted);
  await new Promise(resolve => setTimeout(resolve, 15));
  const repliedBeforeTermination = replied;
  gate.resolve();
  const response = await responsePromise;
  const body = await response.json();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(repliedBeforeTermination, false);
  assert.equal(response.status, 200);
  assert.equal(body.running, false);
  assert.equal(body.phase, 'interrupted');
  assert.equal(body.done, 0);
  assert.match(body.message, /保存|存储/);
  assert.ok(!JSON.stringify(body).includes(token));
  assert.equal(pats.getCheckpoint('checks').index, 0);
});
