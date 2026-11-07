// The chat bot answers questions about the shelf without opening the workbench.
// These tests pin the two promises that make it safe to put in a group chat:
// it authenticates the platform before obeying anything, and it never returns a
// password or a TOTP seed — only counts and statuses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { BotService } from '../server/bot.js';

const password = 'account-desk-password-1';
const now = Date.parse('2026-11-01T04:00:00Z');

function profileFetcher() {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({ login: String(url).split('/').pop(), type: 'User' }),
      bodyUsed: false,
      body: null,
    };
  };
  return { fetcher, calls };
}

async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bot-'));
  const store = new Store(dir);
  const priv = createServer().listen(0, '127.0.0.1');
  const pub = createServer().listen(0, '127.0.0.1');
  await Promise.all([priv, pub].map((server) => new Promise((done) => server.once('listening', done))));
  const local = `http://127.0.0.1:${priv.address().port}`;
  const external = `http://127.0.0.1:${pub.address().port}`;
  const services = createApp(store, {
    allowedHosts: [new URL(local).host],
    apiOrigin: external,
    clock: () => now,
    authClock: () => now,
    ...options,
  });
  priv.on('request', services.app);
  pub.on('request', services.publicApp);
  t.after(async () => {
    services.bot.stop();
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
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(base === local ? { 'X-Local-Client': 'account-desk' } : {}),
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
    store, services, local, external, dir,
    call: (path, method, body, session, extra) => call(local, path, method, body, session, extra),
    hook: (token, payload, headers = {}) => call(external, `/bot/hook/${token}`, 'POST', payload, null, headers),
    setup: () => call(local, '/api/auth/setup', 'POST', {
      username: 'admin', password,
      setupCode: readFileSync(join(dir, 'admin-setup-code.txt'), 'utf8').trim(),
    }),
  };
}

test('a new bot gets a callback token, and secrets never come back out', async (t) => {
  const f = await fixture(t);
  const session = await f.setup();
  const created = await f.call('/api/bot', 'POST', {
    platform: 'dingtalk', name: '运维群', config: { appSecret: 'SEC-should-stay-secret' },
  }, session);
  assert.equal(created.status, 201);
  assert.match(created.body.token, /^[A-Za-z0-9_-]{43}$/, 'the token is the path segment of the callback URL');
  assert.equal(created.body.config.appSecret, '••••••', 'the webhook secret is stored, not echoed');

  const list = await f.call('/api/bot', 'GET', undefined, session);
  assert.equal(list.body.bots.length, 1);
  assert.equal(list.body.hookBase.endsWith('/bot/hook'), true);
  assert.equal(list.body.platforms.length, 3);
});

test('an unauthenticated caller cannot use the callback as a command channel', async (t) => {
  const f = await fixture(t);
  const session = await f.setup();
  const created = await f.call('/api/bot', 'POST', {
    platform: 'generic', name: '脚本', config: { secret: 'bot-secret-1' },
  }, session);
  const open = await f.hook(created.body.token, { text: '状态' });
  assert.equal(open.status, 401, 'without the bearer secret the hook refuses');

  const wrong = await f.hook(created.body.token, { text: '状态' }, { Authorization: 'Bearer nope' });
  assert.equal(wrong.status, 401);

  const missing = await f.hook('a'.repeat(43), { text: '状态' }, { Authorization: 'Bearer bot-secret-1' });
  assert.equal(missing.status, 404, 'an unknown token is not a valid door either');
});

test('a signed DingTalk callback answers in the platform response shape', async (t) => {
  const f = await fixture(t);
  const session = await f.setup();
  await f.call('/api/accounts', 'POST', {
    email: 'alpha@example.com', username: 'alpha-ops', password: 'do-not-leak-this', totp: 'JBSWY3DPEHPK3PXP',
  }, session);
  const created = await f.call('/api/bot', 'POST', {
    platform: 'dingtalk', name: '运维群', config: { appSecret: 'SEC-ding-secret' },
  }, session);
  const timestamp = String(now);
  const sign = createHmac('sha256', 'SEC-ding-secret').update(`${timestamp}\nSEC-ding-secret`).digest('base64');

  const forged = await f.hook(created.body.token, { text: { content: '状态' } }, { timestamp, sign: 'forged' });
  assert.equal(forged.status, 401, 'a wrong signature is rejected before the command runs');

  const stale = String(now - 7200000);
  const staleSign = createHmac('sha256', 'SEC-ding-secret').update(`${stale}\nSEC-ding-secret`).digest('base64');
  assert.equal((await f.hook(created.body.token, { text: { content: '状态' } }, { timestamp: stale, sign: staleSign })).status, 401,
    'an old timestamp cannot be replayed');

  const accepted = await f.hook(created.body.token, { text: { content: '状态' }, senderNick: 'ops' }, { timestamp, sign });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.msgtype, 'text');
  const reply = accepted.body.text.content;
  assert.match(reply, /账号 1 个/);
  assert.match(reply, /两步验证：0 个账号未启用/);
  assert.equal(reply.includes('do-not-leak-this'), false, 'a chat reply never carries a password');
  assert.equal(reply.includes('JBSWY3DPEHPK3PXP'), false, 'nor a TOTP seed');

  const messages = await f.call('/api/bot?messages=20', 'GET', undefined, session);
  assert.equal(messages.body.messages.length, 2, 'the question and the answer are both kept for review');
});

test('Feishu URL verification is answered without running a command', async (t) => {
  const f = await fixture(t);
  const session = await f.setup();
  const created = await f.call('/api/bot', 'POST', {
    platform: 'feishu', name: '飞书群', config: { verificationToken: 'vt-123' },
  }, session);
  const ok = await f.hook(created.body.token, { type: 'url_verification', challenge: 'abc', token: 'vt-123' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.challenge, 'abc');
  const bad = await f.hook(created.body.token, { type: 'url_verification', challenge: 'abc', token: 'wrong' });
  assert.equal(bad.status, 401);
});

test('a Feishu message event is parsed, mentions stripped and answered', async (t) => {
  const f = await fixture(t);
  const session = await f.setup();
  const created = await f.call('/api/bot', 'POST', {
    platform: 'feishu', name: '飞书群', config: { verificationToken: 'vt-123' },
  }, session);
  const payload = {
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1', token: 'vt-123' },
    event: {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: { message_type: 'text', content: JSON.stringify({ text: '@_user_1 帮助' }) },
    },
  };
  const reply = await f.hook(created.body.token, payload);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { code: 0 }, 'Feishu wants a bare acknowledgement');
  const messages = await f.call('/api/bot?messages=20', 'GET', undefined, session);
  assert.match(messages.body.messages.find((item) => item.direction === 'out').text, /可用指令/);
});

test('"检活" starts a batch for the stale accounts and queues one report', async (t) => {
  const { fetcher } = profileFetcher();
  const f = await fixture(t, { fetcher, delayMs: 0 });
  const session = await f.setup();
  for (const name of ['stale-one', 'stale-two']) {
    await f.call('/api/accounts', 'POST', {
      email: `${name}@example.com`, username: name, password: 'pw-123456789', totp: '',
    }, session);
  }
  const created = await f.call('/api/bot', 'POST', {
    platform: 'generic', name: '脚本', config: { secret: 'bot-secret-1' },
  }, session);
  const reply = await f.hook(created.body.token, { text: '检活' }, { Authorization: 'Bearer bot-secret-1' });
  assert.match(reply.body.reply, /已开始检活：2 个账号/);
  await new Promise((done) => setTimeout(done, 50));
  assert.equal(f.services.checker.status().scope, 'bot');
  assert.ok(f.services.bot.pendingReport, 'a report is owed once the batch finishes');
});

test('the patrol report reaches only the channels that asked for it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-report-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const sent = [];
  const notifier = { list: () => [], broadcast: (kind, subject, body) => { sent.push({ kind, subject, body }); return { channels: 1 }; } };
  const bot = new BotService(store, { notifier, clock: () => now });
  assert.equal(bot.pushReport('测试').channels, 1);
  assert.equal(sent[0].kind, 'bot_report');
  assert.match(sent[0].subject, /巡检报告/);
  assert.equal(sent[0].body.includes('密码：'), false);
});

test('an unknown command returns the help text instead of guessing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-help-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const bot = new BotService(store, { clock: () => now });
  assert.match(bot.command('你好'), /没识别这条指令/);
  assert.match(bot.command('帮助'), /可用指令/);
  assert.match(bot.command('账号'), /用法/);
});
