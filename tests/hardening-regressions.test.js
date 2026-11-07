// Regressions for the findings of the penetration review:
//   1. anonymous traffic could exhaust a single shared API budget
//   2. five wrong guesses could lock the operator out of the whole service
//   3. a backup carried master.key into a world-readable directory
//   4. a step-up grant could be replayed without limit
//   5. a TOTP code stayed valid after it had been used
//   6. export audit rows did not name the accounts that left the machine
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { totpCode } from '../server/crypto.js';
import { hardenDirectory, wideAccess } from '../scripts/lib/acl.mjs';

const password = 'regression-test-password-1';

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hardening-'));
  const store = new Store(dir);
  let now = Date.parse('2026-10-20T00:00:00Z');
  const priv = createServer().listen(0, '127.0.0.1');
  const pub = createServer().listen(0, '127.0.0.1');
  await Promise.all([priv, pub].map((server) => new Promise((done) => server.once('listening', done))));
  const local = `http://127.0.0.1:${priv.address().port}`;
  const external = `http://127.0.0.1:${pub.address().port}`;
  const services = createApp(store, {
    allowedHosts: [new URL(local).host],
    apiOrigin: external,
    authClock: () => now,
    apiClock: () => now,
    ...options,
  });
  priv.on('request', services.app);
  pub.on('request', services.publicApp);
  t.after(async () => {
    await Promise.all([services.checker.cancel(), services.pat.stop(), services.workbuddy.stop()]);
    await services.integrations.stop();
    await Promise.all([priv, pub].map((server) => {
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    }));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (base, path, method = 'GET', body, session, extra = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(base === local ? { 'X-Local-Client': 'account-desk' } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let value;
    try { value = JSON.parse(text); } catch { value = text; }
    return { status: res.status, body: value, headers: res.headers, cookie: res.headers.get('set-cookie')?.split(';')[0], csrfToken: value?.csrfToken };
  };
  return {
    store, services, local, dir,
    now: () => now,
    advance: (ms) => { now += ms; },
    call: (path, method, body, session, extra) => call(local, path, method, body, session, extra),
    public: (path, method = 'GET', body, token) => call(external, path, method, body, null, token ? { Authorization: `Bearer ${token}` } : {}),
    status: (path, headers) => new Promise((resolve, reject) => {
      const req = httpRequest(local + path, { method: 'GET', headers }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    }),
    setup: () => call(local, '/api/auth/setup', 'POST', {
      username: 'admin', password,
      setupCode: readFileSync(join(dir, 'admin-setup-code.txt'), 'utf8').trim(),
    }),
  };
}

test('a locked source cannot lock out every other source', async (t) => {
  const f = await fixture(t);
  await f.setup();
  for (let i = 0; i < 5; i++) f.services.auth.fail('203.0.113.9');
  assert.ok(f.services.auth.lockRemaining('203.0.113.9') > 0, 'the abusive source is locked');
  assert.equal(f.services.auth.lockRemaining('local'), 0, 'the operator source stays open');
  const login = await f.call('/api/auth/login', 'POST', { username: 'admin', password });
  assert.equal(login.status, 200, 'a correct password still works from another source');
});

test('anonymous calls cannot spend the budget that authenticated keys rely on', async (t) => {
  const f = await fixture(t);
  const session = await f.setup();
  const created = await f.call('/api/access/keys', 'POST', { name: 'probe', scopes: ['organization:read'] }, session);
  assert.equal(created.status, 201);
  const secret = created.body.secret;
  let last;
  for (let i = 0; i < 40; i++) last = await f.public('/api/v1/groups');
  assert.equal(last.status, 429, 'the anonymous source runs out of its own allowance');
  const legitimate = await f.public('/api/v1/groups', 'GET', undefined, secret);
  assert.equal(legitimate.status, 200, 'the key holder is unaffected');
});

test('a step-up grant allows a handful of plaintext reads, not an unlimited run', async (t) => {
  const f = await fixture(t);
  const session = await f.setup();
  const created = await f.call('/api/accounts', 'POST', {
    email: 'a@example.com', username: 'alpha', password: 'pw-123456', totp: 'JBSWY3DPEHPK3PXP',
  }, session);
  assert.equal(created.status, 201);
  const id = created.body.id;
  const grant = await f.call('/api/auth/reauth', 'POST', { password }, session);
  assert.equal(grant.status, 200);
  const headers = { 'X-Reauth-Token': grant.body.token };
  for (let use = 1; use <= 5; use++) {
    const res = await f.call('/api/accounts/export', 'POST', { ids: [id] }, session, headers);
    assert.equal(res.status, 200, `authorised read ${use} should succeed`);
  }
  const blocked = await f.call('/api/accounts/export', 'POST', { ids: [id] }, session, headers);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'REAUTH_REQUIRED', 'the UI is told to prompt again');
});

test('an export audit row names the accounts that left the machine', async (t) => {
  const f = await fixture(t);
  const session = await f.setup();
  const created = await f.call('/api/accounts', 'POST', {
    email: 'audit@example.com', username: 'audit-user', password: 'pw-123456', totp: '',
  }, session);
  const grant = await f.call('/api/auth/reauth', 'POST', { password }, session);
  await f.call('/api/accounts/export', 'POST', { ids: [created.body.id] }, session, { 'X-Reauth-Token': grant.body.token });
  const log = await f.call('/api/auth/credentials', 'GET', undefined, session);
  assert.equal(log.status, 200);
  assert.match(String(log.body.entries[0].label), /audit@example\.com/);
});

test('a TOTP code cannot be replayed inside its own window', async (t) => {
  const f = await fixture(t);
  const session = await f.setup();
  const started = await f.call('/api/auth/totp/setup', 'POST', {}, session);
  assert.equal(started.status, 200);
  const code = totpCode(started.body.secret, f.now()).code;
  assert.equal((await f.call('/api/auth/totp/enable', 'POST', { code }, session)).status, 200);
  const first = await f.call('/api/auth/login', 'POST', { username: 'admin', password, code });
  assert.equal(first.status, 200, 'the code works once');
  const replay = await f.call('/api/auth/login', 'POST', { username: 'admin', password, code });
  assert.equal(replay.status, 401, 'the same code is refused the second time');
});

test('a production instance refuses the development host name', async (t) => {
  const f = await fixture(t);
  const status = await f.status('/api/auth/status', { host: '127.0.0.1:5173', 'x-local-client': 'account-desk' });
  assert.equal(status, 403);
});

test('hardening a directory strips access from other local accounts', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows ACL check');
  const dir = mkdtempSync(join(tmpdir(), 'acl-'));
  writeFileSync(join(dir, 'master.key'), 'irrelevant');
  hardenDirectory(dir);
  assert.deepEqual(wideAccess(dir), [], 'no inherited principal can read the directory');
  rmSync(dir, { recursive: true, force: true });
});
