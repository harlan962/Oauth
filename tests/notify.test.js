// Notification channels: the point of the feature is that the operator learns
// about a login or a probe *while it happens*, so these tests check routing,
// signing, deduplication and honest error reporting rather than formatting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { Notifier } from '../server/notify.js';
import { decrypt } from '../server/crypto.js';

function memoryFetcher(responder = () => ({ ok: true, status: 200, json: async () => ({ code: 0 }) })) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return responder(url, init, calls.length);
  };
  return { fetcher, calls };
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'notify-'));
  const store = new Store(dir);
  let now = Date.parse('2026-10-20T00:00:00Z');
  const notifier = new Notifier(store, { clock: () => now, fetcher: memoryFetcher().fetcher });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    store,
    notifier,
    advance(ms) { now += ms; },
    now: () => now,
  };
}

const loginEvent = {
  kind: 'login_succeeded',
  detail: 'previous_fails=2',
  at: Date.parse('2026-10-20T03:04:05Z'),
  ip: '203.0.113.7',
  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36',
  method: 'password+totp',
  target: null,
};

test('a login is pushed with the time, method, address and device that produced it', async (t) => {
  const { fetcher, calls } = memoryFetcher();
  const dir = mkdtempSync(join(tmpdir(), 'notify-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const notifier = new Notifier(store, { fetcher });
  notifier.create({
    type: 'feishu', name: '飞书群', events: ['login'],
    config: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' },
  });
  notifier.handle(loginEvent);
  await new Promise((done) => setImmediate(done));
  assert.equal(calls.length, 1, 'one message leaves the machine');
  const text = calls[0].body.content.text;
  assert.match(text, /登录成功/);
  assert.match(text, /密码 \+ 动态码/, 'the method is spelled out');
  assert.match(text, /203\.0\.113\.7/, 'the source address is included');
  assert.match(text, /Chrome 141 · Windows 10\/11/, 'the device is described, not dumped');
  assert.match(text, /previous_fails=2/, 'the detail line survives');
});

test('a channel only receives the categories it subscribed to', async (t) => {
  const { fetcher, calls } = memoryFetcher();
  const dir = mkdtempSync(join(tmpdir(), 'notify-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const notifier = new Notifier(store, { fetcher });
  notifier.create({
    type: 'feishu', name: '只收异常', events: ['intrusion'],
    config: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' },
  });
  notifier.handle(loginEvent);
  notifier.handle({ ...loginEvent, kind: 'api_key_rejected' });
  await new Promise((done) => setImmediate(done));
  assert.equal(calls.length, 1, 'only the intrusion event is delivered');
  assert.match(calls[0].body.content.text, /API 密钥被拒/);
});

test('a burst of the same event collapses instead of becoming a message flood', async (t) => {
  const f = fixture(t);
  const { fetcher, calls } = memoryFetcher();
  f.notifier.fetcher = fetcher;
  f.notifier.create({
    type: 'feishu', name: '飞书群', events: ['login'],
    config: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc' },
  });
  for (let i = 0; i < 8; i++) f.notifier.handle({ ...loginEvent, kind: 'login_failed' });
  await new Promise((done) => setImmediate(done));
  assert.equal(calls.length, 1, 'eight failures become one message');
  f.advance(61000);
  f.notifier.handle({ ...loginEvent, kind: 'login_failed' });
  await new Promise((done) => setImmediate(done));
  assert.equal(calls.length, 2, 'a later round is delivered again');
});

test('a stored secret is masked on read and kept when the edit leaves it blank', async (t) => {
  const f = fixture(t);
  const created = f.notifier.create({
    type: 'dingtalk', name: '钉钉群', events: ['login'],
    config: { webhook: 'https://oapi.dingtalk.com/robot/send?access_token=x', secret: 'SEC123' },
  });
  assert.equal(created.config.secret, '••••••', 'the secret never comes back in clear text');
  assert.equal(created.config.hasSecret, true);
  const updated = f.notifier.update(created.id, {
    name: '钉钉群', events: ['login'], config: { webhook: created.config.webhook, secret: '' },
  });
  assert.equal(updated.config.hasSecret, true, 'blank means keep, not erase');
  const raw = f.store.db.prepare('SELECT config FROM notify_channels WHERE id=?').get(created.id).config;
  assert.equal(raw.includes('SEC123'), false, 'the secret is not sitting in the table in clear text');
  assert.equal(JSON.parse(decrypt(raw, f.store.key)).secret, 'SEC123', 'and it is still the stored one');
});

test('dingtalk and feishu requests carry a valid signature when a secret is set', async (t) => {
  const { fetcher, calls } = memoryFetcher();
  const dir = mkdtempSync(join(tmpdir(), 'notify-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const notifier = new Notifier(store, { fetcher });
  const ding = notifier.create({
    type: 'dingtalk', name: '钉钉', events: ['login'],
    config: { webhook: 'https://oapi.dingtalk.com/robot/send?access_token=x', secret: 'SEC123' },
  });
  const fei = notifier.create({
    type: 'feishu', name: '飞书', events: ['login'],
    config: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', secret: 'SEC123' },
  });
  await notifier.test(ding.id);
  await notifier.test(fei.id);
  const dingUrl = new URL(calls[0].url);
  assert.ok(dingUrl.searchParams.get('timestamp'), 'dingtalk sends a timestamp');
  assert.ok(dingUrl.searchParams.get('sign'), 'dingtalk sends a signature');
  assert.ok(calls[1].body.timestamp && calls[1].body.sign, 'feishu signs the payload');
});

test('a failed delivery is reported on the channel instead of disappearing', async (t) => {
  const { fetcher } = memoryFetcher(() => ({ ok: false, status: 500, json: async () => ({}) }));
  const dir = mkdtempSync(join(tmpdir(), 'notify-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const notifier = new Notifier(store, { fetcher });
  const channel = notifier.create({
    type: 'webhook', name: '自建回调', events: ['login'],
    config: { url: 'https://example.com/hook' },
  });
  await assert.rejects(() => notifier.test(channel.id), /发送失败/);
  const [updated] = notifier.list();
  assert.match(updated.lastError, /500/, 'the reason is kept where the operator can see it');
  assert.equal(notifier.deliveries()[0].ok, false, 'the delivery log records the failure');
});

test('plain http webhooks are refused so credentials do not travel in clear text', (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.notifier.create({ type: 'feishu', name: 'x', events: ['login'], config: { webhook: 'http://example.com/hook' } }),
    /https/,
  );
});

test('every audit row carries the address, device and method that produced it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-app-'));
  const store = new Store(dir);
  const priv = createServer().listen(0, '127.0.0.1');
  await new Promise((done) => priv.once('listening', done));
  const local = `http://127.0.0.1:${priv.address().port}`;
  const services = createApp(store, { allowedHosts: [new URL(local).host] });
  priv.on('request', services.app);
  t.after(async () => {
    await Promise.all([services.checker.cancel(), services.pat.stop(), services.workbuddy.stop()]);
    await services.integrations.stop();
    priv.closeAllConnections();
    await new Promise((done) => priv.close(done));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const setupCode = readFileSync(join(dir, 'admin-setup-code.txt'), 'utf8').trim();
  const response = await fetch(local + '/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Client': 'account-desk', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' },
    body: JSON.stringify({ username: 'admin', password: 'notify-test-password-1', setupCode }),
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const state = await (await response.json());
  const events = await (await fetch(local + '/api/auth/events?limit=5', {
    headers: { 'X-Local-Client': 'account-desk', Cookie: cookie },
  })).json();
  const created = events.events.find((item) => item.kind === 'admin_initialized');
  assert.ok(created, 'the initialisation is on the trail');
  assert.equal(created.ip, '127.0.0.1', 'the source address is recorded');
  assert.equal(created.method, 'setup', 'how it authenticated is recorded');
  assert.match(created.agent, /Safari 18 · macOS/, 'the device is described');
  const sessions = await (await fetch(local + '/api/auth/sessions', {
    headers: { 'X-Local-Client': 'account-desk', Cookie: cookie },
  })).json();
  const current = sessions.sessions.find((item) => item.current);
  assert.equal(current.method, 'setup');
  assert.match(current.agent, /Safari 18 · macOS/);
  assert.equal(state.csrfToken.length > 20, true);
});
