import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { totpCode } from '../server/crypto.js';

const password = 'totp-test-password-1';
const start = Date.parse('2026-11-01T00:00:00Z');

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'totp-'));
  const store = new Store(dir);
  let now = start;
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
    return { status: response.status, body: value, cookie: response.headers.get('set-cookie')?.split(';')[0], csrfToken: value?.csrfToken };
  };
  return {
    store, services, call,
    advance: ms => { now += ms; },
    clock: () => now,
    setup: () => call('/api/auth/setup', 'POST', {
      username: 'admin', password,
      setupCode: readFileSync(join(dir, 'admin-setup-code.txt'), 'utf8').trim(),
    }),
    login: code => call('/api/auth/login', 'POST', { username: 'admin', password, ...(code === undefined ? {} : { code }) }),
  };
}

// Enables TOTP and hands back the secret plus the recovery codes.
async function enableTotp(f, session) {
  const staged = await f.call('/api/auth/totp/setup', 'POST', {}, session);
  assert.equal(staged.status, 200);
  const code = totpCode(staged.body.secret, f.clock()).code;
  const enabled = await f.call('/api/auth/totp/enable', 'POST', { code }, session);
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.recoveryCodes.length, 8);
  return { secret: staged.body.secret, recovery: enabled.body.recoveryCodes };
}

test('enabling the second factor makes login ask for a code', async t => {
  const f = await fixture(t);
  const session = await f.setup();
  const { secret } = await enableTotp(f, session);
  assert.equal(f.services.auth.totpEnabled(), true);

  const without = await f.login();
  assert.equal(without.status, 403);
  assert.equal(without.body.code, 'TOTP_REQUIRED');

  const wrong = await f.login('000000');
  assert.equal(wrong.status, 401);

  const right = await f.login(totpCode(secret, f.clock()).code);
  assert.equal(right.status, 200);
  assert.ok(right.body.authenticated);
});

test('one recovery code works once and only once', async t => {
  const f = await fixture(t);
  const session = await f.setup();
  const { recovery } = await enableTotp(f, session);

  const first = await f.login(recovery[0]);
  assert.equal(first.status, 200);
  assert.ok(f.services.auth.events(50).some(event => event.kind === 'recovery_code_used'));

  const replay = await f.login(recovery[0]);
  assert.equal(replay.status, 401, 'a burnt recovery code cannot be reused');

  const second = await f.login(recovery[1]);
  assert.equal(second.status, 200);
});

test('a staged secret is not enforced until a working code confirms it', async t => {
  const f = await fixture(t);
  const session = await f.setup();
  const staged = await f.call('/api/auth/totp/setup', 'POST', {}, session);
  assert.equal(staged.body.secret.length, 32);
  assert.ok(staged.body.uri.startsWith('otpauth://totp/'));
  assert.equal(f.services.auth.totpEnabled(), false, 'pending setup must not lock anyone out');
  const stillPasswordOnly = await f.login();
  assert.equal(stillPasswordOnly.status, 200);

  const rejected = await f.call('/api/auth/totp/enable', 'POST', { code: '123456' }, stillPasswordOnly);
  assert.equal(rejected.status, 400, 'a wrong code cannot confirm the setup');
  assert.equal(f.services.auth.totpEnabled(), false);
});

test('disabling needs the password and a current factor', async t => {
  const f = await fixture(t);
  const session = await f.setup();
  const { secret } = await enableTotp(f, session);
  const code = () => totpCode(secret, f.clock()).code;

  const badPassword = await f.call('/api/auth/totp/disable', 'POST', { password: 'nope-nope-nope', code: code() }, session);
  assert.equal(badPassword.status, 401);

  const badCode = await f.call('/api/auth/totp/disable', 'POST', { password, code: '000000' }, session);
  assert.equal(badCode.status, 400);

  const disabled = await f.call('/api/auth/totp/disable', 'POST', { password, code: code() }, session);
  assert.equal(disabled.status, 200);
  assert.equal(f.services.auth.totpEnabled(), false);
  assert.equal((await f.login()).status, 200, 'password alone works again');
});

test('reading credentials also needs the second factor', async t => {
  const f = await fixture(t);
  const session = await f.setup();
  const { secret } = await enableTotp(f, session);

  const passwordOnly = await f.call('/api/auth/reauth', 'POST', { password }, session);
  assert.equal(passwordOnly.status, 403);
  assert.equal(passwordOnly.body.code, 'TOTP_REQUIRED');

  const withCode = await f.call('/api/auth/reauth', 'POST', { password, code: totpCode(secret, f.clock()).code }, session);
  assert.equal(withCode.status, 200);
  assert.match(withCode.body.token, /^[A-Za-z0-9_-]{43}$/);
});
