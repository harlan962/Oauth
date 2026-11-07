import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { WorkBuddyService } from '../server/workbuddy.js';

const { PatStore } = await import('../server/pat-store.js').catch(() => ({}));
function fixture(t) {
  assert.equal(typeof PatStore, 'function');
  const directory = mkdtempSync(join(tmpdir(), 'pat-store-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, pats: new PatStore(store), directory };
}
function account(store, username = 'pat-candidate') {
  const row = store.create({ email: username + '@example.test', username, password: 'synthetic-password', totp: 'JBSWY3DPEHPK3PXP' });
  store.setCheck(row.id, username, { status: 'reachable', message: 'fixture' });
  return row;
}

test('PAT settings require consent and validate the configured target', t => {
  const { pats } = fixture(t);
  assert.deepEqual(pats.settings(), { enabled: false, targetCount: 1 });
  assert.throws(() => pats.configure({ enabled: true, targetCount: 1 }), /确认|confirmed/);
  for (const targetCount of [0, 101, 1.5, '2']) assert.throws(() => pats.configure({ targetCount }), /1|数量/);
  assert.throws(() => pats.configure({ targetCount: null }), /1|数量/);
  assert.throws(() => pats.configure({ enabled: null }), /启用/);
  assert.deepEqual(pats.configure({ enabled: true, targetCount: 3, confirmed: true }), { enabled: true, targetCount: 3 });
  assert.deepEqual(pats.configure({ enabled: false }), { enabled: false, targetCount: 3 });
});

test('PAT reservation isolates the account, holds a distinct lock, and never duplicates it', t => {
  const { store, pats } = fixture(t);
  const row = account(store);
  const item = pats.reserve();
  assert.equal(item.accountId, row.id);
  assert.equal(item.status, 'preparing');
  assert.equal(store.get(row.id).patDedicated, 1);
  assert.equal(store.get(row.id).reservedBy, 'pat:' + item.id);
  assert.throws(() => store.select(row.id), /PAT/);
  assert.equal(pats.reserve(), null);
  pats.complete(item.id);
  assert.equal(store.get(row.id).reservedBy, null);
  assert.equal(store.get(row.id).patDedicated, 1);
  assert.throws(() => store.select(), /没有可选/);
  assert.throws(() => store.update(row.id, { username: 'renamed' }), /PAT/);
  assert.throws(() => store.update(row.id, { password: 'replacement' }), /PAT/);
  assert.throws(() => store.update(row.id, { totp: '' }), /PAT/);
  assert.throws(() => store.trash(row.id), /PAT/);
  assert.equal(store.update(row.id, { notes: 'safe note' }).notes, 'safe note');
});

test('PAT reservation excludes stale, selected, locked, deleted, and mapped accounts', t => {
  const { store, pats } = fixture(t);
  const wb = new WorkBuddyService(store, {});
  for (const state of ['stale', 'selected', 'locked', 'deleted', 'mapped', 'unchecked']) {
    const row = account(store, state);
    const patches = {
      stale: "checkedAt='2000-01-01T00:00:00.000Z'", selected: "selectedAt='selected'",
      locked: "reservedBy='job'", deleted: "deletedAt='deleted'", unchecked: "publicStatus='unchecked'",
    };
    if (patches[state]) store.db.prepare(`UPDATE accounts SET ${patches[state]} WHERE id=?`).run(row.id);
    if (state === 'mapped') store.db.prepare('INSERT INTO workbuddy_mappings VALUES(?,?,?,?,?)').run('t', 'uid', row.id, 'j', new Date().toISOString());
  }
  assert.equal(pats.reserve(), null);
  assert.equal(wb.candidates().accounts.length, 0);
});

test('dedicated account isolation works before PAT store startup in all WorkBuddy paths', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pat-isolation-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const row = account(store);
  assert.equal(store.get(row.id).patDedicated, 0);
  assert.equal(store.get(row.id).pat, null);
  store.db.prepare('UPDATE accounts SET patDedicated=1 WHERE id=?').run(row.id);
  const wb = new WorkBuddyService(store, { target: () => ({ id: 't', revision: 1 }) }, { oauthBrowser: {} });
  const body = { realm: 'global', count: 1, targetId: 't', targetRevision: 1, requestId: 'test-request', accountIds: [row.id] };
  assert.equal(wb.candidates().accounts.length, 0);
  assert.throws(() => wb.preview(body), /不足/);
  assert.throws(() => wb.start(body), /候选账号/);
  assert.throws(() => store.select(row.id), /PAT/);
  assert.throws(() => store.select(), /没有可选/);
});

test('PAT secrets persist encrypted and never appear in public records or checkpoints', t => {
  const { store, pats, directory } = fixture(t);
  account(store);
  const item = pats.reserve();
  assert.equal(item.hasToken, false, 'dedicated reservation is not an issued token');
  const token = 'github_pat_SYNTHETIC_ONLY_TEST_SECRET';
  pats.saveToken(item.id, token, '2099-01-01T00:00:00.000Z');
  assert.equal(pats.secret(item.id), token);
  assert.equal(pats.list()[0].status, 'verifying');
  assert.equal(pats.list()[0].hasToken, true);
  assert.equal(pats.summary(item.accountId).hasToken, true);
  assert.equal(JSON.stringify([pats.list(), store.list(), store.get(item.accountId)]).includes(token), false);
  const raw = store.db.prepare('SELECT * FROM pats WHERE id=?').get(item.id);
  assert.equal(JSON.stringify(raw).includes(token), false);
  pats.setCheckpoint('checker', { checkedAt: '2026-01-01', ids: [item.id] });
  assert.throws(() => pats.setCheckpoint('unsafe', { token }), /凭据|secret|token/i);
  assert.throws(() => pats.setCheckpoint('unsafe', { arbitrary: token }), /凭据|secret|token/i);
  const second = new Store(directory);
  try {
    const reopened = new PatStore(second);
    assert.equal(reopened.secret(item.id), token);
    assert.deepEqual(reopened.getCheckpoint('checker'), { checkedAt: '2026-01-01', ids: [item.id] });
  } finally { second.close(); }
});

test('PAT metadata allowlist rejects secret and identity mutation', t => {
  const { store, pats } = fixture(t);
  account(store);
  const item = pats.reserve();
  for (const patch of [{ token: 'no' }, { accountId: 'other' }, { status: 'unknown' }]) assert.throws(() => pats.update(item.id, patch));
  pats.update(item.id, { status: 'manual', message: 'needs review', creationUncertain: true });
  assert.equal(pats.summary(item.accountId).creationUncertain, true);
  assert.equal(pats.summary(item.accountId).status, 'manual');
  assert.equal(pats.summary('missing'), null);
});

test('cooling and verifying PATs count as valid until expiry and metadata never returns ciphertext', t => {
  const { store, pats } = fixture(t);
  for (const status of ['valid', 'cooling', 'verifying']) {
    account(store, status);
    const item = pats.reserve();
    pats.saveToken(item.id, 'ghp_SYNTHETIC_' + status, '2099-01-01T00:00:00.000Z');
    pats.update(item.id, { status, remaining: 0, limit: 5000, resetAt: '2099-01-01', retryAt: '2099-01-01' });
    pats.complete(item.id);
  }
  assert.equal(pats.usable().length, 3);
  const item = pats.list()[0];
  pats.update(item.id, { expiresAt: '2000-01-01T00:00:00.000Z' });
  assert.equal(pats.usable().length, 2);
  assert.equal(pats.summary(item.accountId).status, 'invalid');
  assert.equal('token' in pats.list()[0], false);
  assert.equal('ciphertext' in pats.list()[0], false);
});

test('dedicated release requires consent, no lock, and a known unusable token outcome', t => {
  const { store, pats } = fixture(t);
  account(store);
  const item = pats.reserve();
  assert.throws(() => pats.releaseDedicated(item.id, { confirmed: true }), /占用|浏览器/);
  pats.complete(item.id);
  assert.throws(() => pats.releaseDedicated(item.id, {}), /确认/);
  pats.update(item.id, { creationUncertain: true, status: 'manual' });
  assert.throws(() => pats.releaseDedicated(item.id, { confirmed: true }), /未知|确认/);
  pats.update(item.id, { creationUncertain: false });
  pats.saveToken(item.id, 'ghp_SYNTHETIC_VALID', '2099-01-01T00:00:00.000Z');
  assert.throws(() => pats.releaseDedicated(item.id, { confirmed: true }), /有效|撤销|PAT/);
  pats.disable(item.id);
  assert.equal(pats.usable().length, 0);
  assert.throws(() => pats.releaseDedicated(item.id, { confirmed: true }), /有效|撤销|PAT/);
  pats.markInvalid(item.id, 'confirmed invalid');
  pats.releaseDedicated(item.id, { confirmed: true });
  assert.equal(store.get(item.accountId).patDedicated, 0);
  assert.equal(pats.list().length, 1);
  assert.equal(store.select(item.accountId).id, item.accountId);
});

test('completion only releases its owned temporary lock and expired tokens may be released', t => {
  const { store, pats } = fixture(t);
  account(store);
  const item = pats.reserve();
  pats.saveToken(item.id, 'ghp_SYNTHETIC_EXPIRED', '2000-01-01T00:00:00.000Z');
  store.db.prepare("UPDATE accounts SET reservedBy='other-job' WHERE id=?").run(item.accountId);
  pats.complete(item.id);
  assert.equal(store.get(item.accountId).reservedBy, 'other-job');
  assert.throws(() => pats.releaseDedicated(item.id, { confirmed: true }), /占用/);
  store.db.prepare('UPDATE accounts SET reservedBy=NULL WHERE id=?').run(item.accountId);
  pats.releaseDedicated(item.id, { confirmed: true });
  assert.equal(store.get(item.accountId).patDedicated, 0);
});

test('unknown creation cannot be cleared by an expiry metadata value', t => {
  const { store, pats } = fixture(t);
  account(store);
  const item = pats.reserve();
  pats.update(item.id, { status: 'manual', creationUncertain: true, expiresAt: '2000-01-01T00:00:00.000Z' });
  pats.complete(item.id);
  assert.equal(pats.summary(item.accountId).creationUncertain, true);
  assert.throws(() => pats.releaseDedicated(item.id, { confirmed: true }), /未知/);
});

test('safe metadata normalizes dates and redacts token text before persistence', t => {
  const { store, pats } = fixture(t);
  account(store);
  const item = pats.reserve();
  const token = 'arbitrary-synthetic-sensitive-value';
  pats.saveToken(item.id, token, '2099-01-01T00:00:00.000Z');
  pats.update(item.id, { message: 'server echoed ' + token, expiresAt: 'January 1, 2000 UTC' });
  assert.equal(pats.summary(item.accountId).status, 'invalid');
  assert.equal(JSON.stringify(pats.list()).includes(token), false);
  assert.throws(() => pats.setCheckpoint('echo', { arbitrary: token }), /凭据|token/);
});

test('a released tokenless reservation keeps history while another connection cannot reserve twice', t => {
  const { store, pats, directory } = fixture(t);
  account(store);
  pats.persistSettings({ enabled: true, targetCount: 2, confirmed: true });
  const item = pats.reserve();
  const second = new Store(directory);
  try {
    const reopened = new PatStore(second);
    assert.deepEqual(reopened.settings(), { enabled: true, targetCount: 2 });
    assert.equal(reopened.reserve(), null);
  } finally { second.close(); }
  pats.complete(item.id);
  pats.releaseDedicated(item.id, { confirmed: true });
  assert.equal(store.get(item.accountId).patDedicated, 0);
  assert.equal(pats.list().length, 1);
});
