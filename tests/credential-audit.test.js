import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

const password = 'credential-audit-password-1';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'credential-'));
  const store = new Store(dir);
  let now = Date.parse('2026-11-01T00:00:00Z');
  const server = createServer().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const services = createApp(store, {
    allowedHosts: [new URL(base).host],
    authClock: () => now,
    apiClock: () => now,
  });
  server.on('request', services.app);
  t.after(async () => {
    await Promise.all([services.checker.cancel(), services.pat.stop(), services.workbuddy.stop()]);
    await services.integrations.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (path, method = 'GET', body, session, extra = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        'X-Local-Client': 'account-desk',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { value = text; }
    return {
      status: response.status, body: value,
      cookie: response.headers.get('set-cookie')?.split(';')[0],
      csrfToken: value?.csrfToken,
    };
  };
  return {
    store, services, advance: ms => { now += ms; }, call,
    setup: () => call('/api/auth/setup', 'POST', {
      username: 'admin', password,
      setupCode: readFileSync(join(dir, 'admin-setup-code.txt'), 'utf8').trim(),
    }),
    login: () => call('/api/auth/login', 'POST', { username: 'admin', password }),
  };
}

async function account(f, session) {
  const created = await f.call('/api/accounts', 'POST', {
    email: 'audit@example.test', username: 'audit-user', password: 'secret-password-1',
    totp: 'JBSWY3DPEHPK3PXP',
  }, session);
  assert.equal(created.status, 201);
  return created.body.id;
}

test('reading plaintext credentials demands a fresh password check', async t => {
  const f = await fixture(t);
  const session = await f.setup();
  const id = await account(f, session);
  const blocked = await f.call(`/api/accounts/${id}/secrets`, 'POST', undefined, session);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'REAUTH_REQUIRED');
  const blockedExport = await f.call('/api/accounts/export', 'POST', { ids: [id] }, session);
  assert.equal(blockedExport.status, 403);
  assert.equal(blockedExport.body.code, 'REAUTH_REQUIRED');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM credential_access').get().n, 0, 'a refused read leaves no audit row');
});

test('a wrong password is refused and recorded; the right one opens a five minute window', async t => {
  const f = await fixture(t);
  const session = await f.setup();
  const id = await account(f, session);
  const wrong = await f.call('/api/auth/reauth', 'POST', { password: 'definitely-wrong-1' }, session);
  assert.equal(wrong.status, 401);
  assert.ok(f.services.auth.events(20).some(event => event.kind === 'reauth_failed'));

  const grant = await f.call('/api/auth/reauth', 'POST', { password }, session);
  assert.equal(grant.status, 200);
  assert.match(grant.body.token, /^[A-Za-z0-9_-]{43}$/);

  const read = await f.call(`/api/accounts/${id}/secrets`, 'POST', undefined, session, { 'X-Reauth-Token': grant.body.token });
  assert.equal(read.status, 200);
  assert.equal(read.body.password, 'secret-password-1');

  const exported = await f.call('/api/accounts/export', 'POST', { ids: [id] }, session, { 'X-Reauth-Token': grant.body.token });
  assert.equal(exported.status, 200);
  assert.equal(exported.body.count, 1);

  const rows = f.store.db.prepare('SELECT action,accountLabel,accountCount FROM credential_access ORDER BY id').all();
  assert.deepEqual(rows.map(row => row.action), ['secrets', 'export']);
  assert.equal(rows[0].accountLabel, 'audit@example.test');
  assert.equal(rows[1].accountCount, 1);

  f.advance(5 * 60000 + 1000);
  const expired = await f.call(`/api/accounts/${id}/secrets`, 'POST', undefined, session, { 'X-Reauth-Token': grant.body.token });
  assert.equal(expired.status, 403, 'the grant expires after five minutes');
});

test('the grant is bound to the session that created it', async t => {
  const f = await fixture(t);
  const first = await f.setup();
  const id = await account(f, first);
  const second = await f.login();
  assert.equal(second.status, 200);
  const grant = await f.call('/api/auth/reauth', 'POST', { password }, first);
  assert.equal(grant.status, 200);
  const headers = { 'X-Reauth-Token': grant.body.token };
  // Same browser family, different session: the grant must not transfer.
  const replayed = await f.call(`/api/accounts/${id}/secrets`, 'POST', undefined, second, headers);
  assert.equal(replayed.status, 403);
  assert.equal(replayed.body.code, 'REAUTH_REQUIRED');
  const original = await f.call(`/api/accounts/${id}/secrets`, 'POST', undefined, first, headers);
  assert.equal(original.status, 200);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM credential_access').get().n, 1, 'only the authorised read is audited');
});

test('audit entries survive as a queryable trail', async t => {
  const f = await fixture(t);
  const session = await f.setup();
  const id = await account(f, session);
  const grant = await f.call('/api/auth/reauth', 'POST', { password }, session);
  const headers = { 'X-Reauth-Token': grant.body.token };
  await f.call(`/api/accounts/${id}/secrets`, 'POST', undefined, session, headers);
  await f.call(`/api/accounts/${id}/secrets`, 'POST', undefined, session, headers);
  const listed = await f.call('/api/auth/credentials?limit=10', 'GET', undefined, session);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.entries.length, 2);
  assert.equal(listed.body.entries[0].action, 'secrets');
  assert.equal(listed.body.entries[0].count, 1);
  assert.ok(listed.body.entries[0].at);
});
