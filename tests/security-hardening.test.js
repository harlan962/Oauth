// Intrusion-resistance guarantees: no username oracle, escalating lockout, idle
// session expiry, a security trail, hardened headers and a separate write budget
// for the public API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';

const password = 'security-test-password-1';

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'security-'));
  const store = new Store(dir);
  let now = Date.parse('2026-10-20T00:00:00Z');
  const priv = createServer().listen(0, '127.0.0.1');
  const pub = createServer().listen(0, '127.0.0.1');
  await Promise.all([priv, pub].map(s => new Promise(r => s.once('listening', r))));
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
    await Promise.all([priv, pub].map(s => { s.closeAllConnections(); return new Promise(r => s.close(r)); }));
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
    return {
      status: res.status, body: value, headers: res.headers,
      cookie: res.headers.get('set-cookie')?.split(';')[0],
      csrfToken: value?.csrfToken,
    };
  };
  return {
    store, services, local, external, advance: ms => { now += ms; },
    call: (path, method, body, session, extra) => call(local, path, method, body, session, extra),
    public: (path, method = 'GET', body, token) => call(external, path, method, body, null, token ? { Authorization: `Bearer ${token}` } : {}),
    raw: (path, headers) => new Promise((resolve, reject) => {
      const req = httpRequest(local + path, { method: 'GET', headers }, res => {
        res.resume(); res.on('end', () => resolve(res.headers));
      });
      req.on('error', reject); req.end();
    }),
    setup: () => call(local, '/api/auth/setup', 'POST', {
      username: 'admin', password,
      setupCode: readFileSync(join(dir, 'admin-setup-code.txt'), 'utf8').trim(),
    }),
  };
}

test('an unknown username costs the same scrypt run as a wrong password', async t => {
  const f = await fixture(t);
  await f.setup();
  let calls = 0;
  const derive = f.services.auth.derive.bind(f.services.auth);
  f.services.auth.derive = async (...args) => { calls++; return derive(...args); };
  calls = 0;
  const unknown = await f.call('/api/auth/login', 'POST', { username: 'definitely-not-admin', password: 'wrong-password-x' });
  const unknownCalls = calls;
  calls = 0;
  const wrong = await f.call('/api/auth/login', 'POST', { username: 'admin', password: 'wrong-password-x' });
  const wrongCalls = calls;
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(unknown.body.error, wrong.body.error);
  assert.equal(unknownCalls, 1, 'unknown username must still pay for one key derivation');
  assert.equal(wrongCalls, 1);
});

test('repeated failures escalate the cooldown instead of allowing a steady drip of guesses', async t => {
  const f = await fixture(t);
  await f.setup();
  for (let i = 0; i < 5; i++)
    assert.equal((await f.call('/api/auth/login', 'POST', { username: 'admin', password: 'wrong-password' })).status, 401);
  const first = await f.call('/api/auth/login', 'POST', { username: 'admin', password });
  assert.equal(first.status, 429, 'the sixth attempt is refused even with the right password');
  assert.ok(Number(first.headers.get('retry-after')) > 0);
  assert.ok(Number(first.headers.get('retry-after')) <= 30);
  // After the first cooldown lapses, one more failure doubles the penalty.
  f.advance(31000);
  assert.equal((await f.call('/api/auth/login', 'POST', { username: 'admin', password: 'wrong-password' })).status, 401);
  const second = await f.call('/api/auth/login', 'POST', { username: 'admin', password });
  assert.equal(second.status, 429);
  const wait = Number(second.headers.get('retry-after'));
  assert.ok(wait > 30 && wait <= 60, `cooldown should escalate to about 60 s, got ${wait}`);
  // A successful login after the cooldown clears the counter completely.
  f.advance(61000);
  assert.equal((await f.call('/api/auth/login', 'POST', { username: 'admin', password })).status, 200);
  assert.equal(f.services.auth.lock().fails, 0);
});

test('an unused session dies on the idle timer while an active one keeps working', async t => {
  const f = await fixture(t);
  const session = await f.setup();
  assert.equal((await f.call('/api/accounts', 'GET', undefined, session)).status, 200);
  // Half an hour of genuine activity keeps the session alive past the idle limit.
  for (let i = 0; i < 4; i++) {
    f.advance(30 * 60000);
    assert.equal((await f.call('/api/accounts', 'GET', undefined, session)).status, 200);
  }
  f.advance(2 * 3600000 + 60000);
  assert.equal((await f.call('/api/accounts', 'GET', undefined, session)).status, 401);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM admin_sessions').get().n, 0, 'the idle session is deleted, not merely ignored');
});

test('session inventory marks the current session and can revoke every other one', async t => {
  const f = await fixture(t);
  const first = await f.setup();
  const second = await f.call('/api/auth/login', 'POST', { username: 'admin', password });
  assert.notEqual(first.cookie, second.cookie);
  const listed = await f.call('/api/auth/sessions', 'GET', undefined, second);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.sessions.length, 2);
  assert.equal(listed.body.sessions.filter(s => s.current).length, 1);
  assert.ok(!JSON.stringify(listed.body).includes(second.cookie.split('=')[1]), 'session tokens never leave the server');
  const revoked = await f.call('/api/auth/sessions', 'DELETE', undefined, second);
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.removed, 1);
  assert.equal((await f.call('/api/accounts', 'GET', undefined, first)).status, 401);
  assert.equal((await f.call('/api/accounts', 'GET', undefined, second)).status, 200);
});

test('the security trail records authentication events without storing secrets', async t => {
  const f = await fixture(t);
  await f.setup();
  await f.call('/api/auth/login', 'POST', { username: 'admin', password: 'wrong-password' });
  await f.call('/api/auth/login', 'POST', { username: 'admin', password });
  const listed = await f.call('/api/auth/events', 'GET', undefined, await f.call('/api/auth/login', 'POST', { username: 'admin', password }));
  assert.equal(listed.status, 200);
  const kinds = listed.body.events.map(event => event.kind);
  assert.ok(kinds.includes('admin_initialized'));
  assert.ok(kinds.includes('login_failed'));
  assert.ok(kinds.includes('login_succeeded'));
  const serialized = JSON.stringify(listed.body);
  assert.ok(!serialized.includes(password));
  assert.ok(!serialized.includes('wrong-password'));
});

test('rejected hosts and forged origins are logged rather than only returned', async t => {
  const f = await fixture(t);
  const session = await f.setup();
  const rejected = await f.raw('/api/accounts', { Host: 'evil.test', 'X-Local-Client': 'account-desk' });
  assert.equal(rejected['x-frame-options'], 'DENY');
  const events = await f.call('/api/auth/events', 'GET', undefined, session);
  assert.ok(events.body.events.some(event => event.kind === 'host_rejected'));
  const forged = await f.call('/api/accounts', 'GET', undefined, session, { Origin: 'https://evil.test' });
  assert.equal(forged.status, 403);
  const after = await f.call('/api/auth/events', 'GET', undefined, session);
  assert.ok(after.body.events.some(event => event.kind === 'origin_rejected'));
});

test('browser responses carry the hardened header set', async t => {
  const f = await fixture(t);
  const headers = await f.raw('/', { Host: new URL(f.local).host, 'X-Local-Client': 'account-desk' });
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(headers['x-permitted-cross-domain-policies'], 'none');
  assert.match(headers['permissions-policy'], /camera=\(\)/);
  assert.match(headers['content-security-policy'], /object-src 'none'/);
  assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(headers['strict-transport-security'], undefined, 'no HSTS on plain loopback HTTP');
});

test('public API writes are metered by rows, not by call count', async t => {
  const f = await fixture(t, { writeBudgetPerMinute: 6 });
  const session = await f.setup();
  const created = await f.call('/api/access/keys', 'POST', { name: '外部程序', scopes: ['accounts:import', 'organization:read'] }, session);
  assert.equal(created.status, 201);
  const token = created.body.secret;
  const body = (from, count) => ({ accounts: Array.from({ length: count }, (_, i) => ({ email: `bulk${from + i}@example.test`, username: `bulk${from + i}`, password: 'secret-value' })) });
  // Five one-row imports must all pass: a batch script sending many small
  // writes is the normal case, so call count alone never blocks it.
  for (let i = 0; i < 5; i++) {
    const single = await f.public('/api/v1/accounts/import', 'POST', body(i, 1), token);
    assert.equal(single.status, 200, `single-row import ${i + 1} succeeded`);
    assert.equal(single.body.imported, 1);
  }
  // A two-row import would take the total to 7 rows, past the 6-row budget.
  const over = await f.public('/api/v1/accounts/import', 'POST', body(5, 2), token);
  assert.equal(over.status, 429, 'rows beyond the minute budget are refused');
  assert.ok(Number(over.headers.get('retry-after')) > 0);
  // A one-row import still fits in the remaining allowance.
  const fits = await f.public('/api/v1/accounts/import', 'POST', body(20, 1), token);
  assert.equal(fits.status, 200);
  const denied = await f.public('/api/v1/groups', 'GET', undefined, 'adk_' + 'A'.repeat(43));
  assert.equal(denied.status, 401);
  const events = await f.call('/api/auth/events', 'GET', undefined, session);
  const kinds = events.body.events.map(event => event.kind);
  assert.ok(kinds.includes('api_write_throttled'));
  assert.ok(kinds.includes('api_key_rejected'));
});
