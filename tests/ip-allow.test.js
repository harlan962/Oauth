// The address allowlist is the one control that can lock the operator out of
// their own installation, so the tests concentrate on the two failure modes that
// matter: letting a stranger in, and shutting the local machine out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { parseEntry, addressValue, IpAllow } from '../server/ip-allow.js';

const password = 'allowlist-test-password';

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ip-allow-'));
  const store = new Store(dir);
  const priv = createServer().listen(0, '127.0.0.1');
  const pub = createServer().listen(0, '127.0.0.1');
  return Promise.all([priv, pub].map((server) => new Promise((done) => server.once('listening', done)))).then(() => {
    const local = `http://127.0.0.1:${priv.address().port}`;
    const services = createApp(store, {
      allowedHosts: [new URL(local).host],
      apiOrigin: `http://127.0.0.1:${pub.address().port}`,
      trustProxy: true,
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
    const call = async (path, method = 'GET', body, session, extra = {}) => {
      const response = await fetch(local + path, {
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
      dir, store, services, local,
      call,
      setup: () => call('/api/auth/setup', 'POST', {
        username: 'admin', password,
        setupCode: readFileSync(join(dir, 'admin-setup-code.txt'), 'utf8').trim(),
      }),
    };
  });
}

test('an entry accepts a single address, a CIDR or an IPv6 range', () => {
  assert.equal(parseEntry('192.168.1.5').text, '192.168.1.5');
  assert.equal(parseEntry('10.0.0.0/8').text, '10.0.0.0/8');
  assert.equal(parseEntry('::1').text, '::1');
  assert.equal(parseEntry('2001:db8::/32').text, '2001:db8::/32');
  assert.equal(addressValue('::ffff:203.0.113.9').version, 4, 'an IPv4-mapped IPv6 address is an IPv4 address');
});

test('a typo or a match-everything prefix is refused instead of silently accepted', () => {
  assert.throws(() => parseEntry('300.1.1.1'), /无法识别/);
  assert.throws(() => parseEntry('10.0.0.0/33'), /前缀长度无效/);
  assert.throws(() => parseEntry('0.0.0.0/0'), /前缀长度无效/, 'a /0 is what "disabled" means');
  assert.throws(() => parseEntry('  '), /不能为空/);
});

test('an empty list cannot be enabled, because that would be a lockout with no way back', async (t) => {
  const f = await fixture(t);
  const session = await f.setup();
  const refused = await f.call('/api/security/ip-allow', 'PUT', { enabled: true, entries: [] }, session);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /至少填写一个地址/);
});

test('a source outside the list is refused and the rejection is recorded', async (t) => {
  const f = await fixture(t);
  const session = await f.setup();
  const saved = await f.call('/api/security/ip-allow', 'PUT', { enabled: true, entries: ['203.0.113.0/24'] }, session);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.enabled, true);

  const blocked = await f.call('/api/accounts', 'GET', undefined, null, { 'X-Forwarded-For': '198.51.100.4' });
  assert.equal(blocked.status, 403, 'a stranger is stopped before the session check');
  assert.match(blocked.body.error, /白名单/);

  const events = f.services.auth.events(20);
  const recorded = events.find((item) => item.kind === 'ip_rejected');
  assert.ok(recorded, 'the refusal is visible in the audit trail');
  assert.equal(recorded.ip, '198.51.100.4');

  const allowed = await f.call('/api/accounts', 'GET', undefined, null, { 'X-Forwarded-For': '203.0.113.7' });
  assert.notEqual(allowed.status, 403, 'the listed source reaches the normal authentication path');
});

test('the machine running the service is never locked out', async (t) => {
  const f = await fixture(t);
  const session = await f.setup();
  await f.call('/api/security/ip-allow', 'PUT', { enabled: true, entries: ['203.0.113.0/24'] }, session);
  const local = await f.call('/api/accounts', 'GET', undefined, session);
  assert.equal(local.status, 200, 'loopback keeps a way in to fix a bad list');
});

test('turning the list off is recorded, because widening access is the thing worth noticing', async (t) => {
  const f = await fixture(t);
  const session = await f.setup();
  await f.call('/api/security/ip-allow', 'PUT', { enabled: true, entries: ['203.0.113.0/24'] }, session);
  const off = await f.call('/api/security/ip-allow', 'PUT', { enabled: false, entries: ['203.0.113.0/24'] }, session);
  assert.equal(off.body.enabled, false);
  const events = f.services.auth.events(50);
  assert.ok(events.some((item) => item.kind === 'ip_allow_changed' && /disabled/.test(item.detail || '')));
});

test('the environment seeds the first run only', async (t) => {
  const f = await fixture(t, { adminAllow: '10.0.0.0/8, 192.168.1.0/24' });
  const state = f.services.ipAllow.state();
  assert.equal(state.enabled, true);
  assert.deepEqual(state.entries, ['10.0.0.0/8', '192.168.1.0/24']);
  assert.equal(state.source, 'env');

  const session = await f.call('/api/auth/setup', 'POST', {
    username: 'admin', password,
    setupCode: readFileSync(join(f.dir, 'admin-setup-code.txt'), 'utf8').trim(),
  });
  assert.equal(session.status, 201, 'loopback still gets through an environment-seeded list');
  const saved = await f.call('/api/security/ip-allow', 'PUT', { enabled: true, entries: ['10.0.0.0/8'] }, session);
  assert.deepEqual(saved.body.entries, ['10.0.0.0/8']);
  assert.equal(saved.body.source, 'ui', 'once saved, the page owns the list');
});

test('a corrupt stored list fails closed rather than opening the door', async (t) => {
  const f = await fixture(t);
  const store = f.store;
  const allow = new IpAllow(store, {});
  store.db.prepare('UPDATE admin_ip_allow SET enabled=1,entries=? WHERE id=1').run('not json');
  assert.equal(allow.permits({ ip: '203.0.113.7' }), false);
  assert.equal(allow.permits({ ip: '127.0.0.1' }), true, 'loopback is exempt even then');
});
