import { retireActivity } from '../server/activity-retirement.js';
const seedLegacyEvents = store => store.db.exec('CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,accountId TEXT,username TEXT,action TEXT,detail TEXT,createdAt TEXT)');
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { PatStore } from '../server/pat-store.js';
import { WorkBuddyService } from '../server/workbuddy.js';

function fixture(t, services = true) {
  const dir = mkdtempSync(join(tmpdir(), 'account-tasks-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  if (services) { new PatStore(store); new WorkBuddyService(store, {}); }
  let serial = 0;
  function account(patch = {}) {
    const name = 'summary-' + ++serial;
    const row = store.create({ username: name, email: name + '@example.test', password: 'private-password', totp: 'JBSWY3DPEHPK3PXP' });
    store.setCheck(row.id, name, { status: 'reachable', message: '公开可访问' });
    if (Object.keys(patch).length) store.db.prepare(`UPDATE accounts SET ${Object.keys(patch).map(key => key + '=?').join(',')} WHERE id=?`).run(...Object.values(patch), row.id);
    return row.id;
  }
  function job(id, accountId, status = 'browser', running = 1, jobStatus = 'running') {
    store.db.prepare('INSERT INTO workbuddy_jobs(id,requestId,fingerprint,targetId,targetName,baseUrl,total,status,running,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, id, 'fixture', 'target-' + id, '目标 ' + id, 'https://example.test', 1, jobStatus, running, '2026-01-01T00:00:00.000Z');
    store.db.prepare('INSERT INTO workbuddy_items(jobId,position,accountId,username,email,status,createdAt) VALUES(?,0,?,?,?,?,?)')
      .run(id, accountId, 'fixture', 'fixture@example.test', status, '2026-01-01T00:00:00.000Z');
  }
  function pat(id, accountId, status = 'preparing', createdAt = '2026-01-01T00:00:00.000Z') {
    store.db.prepare('INSERT INTO pats(id,accountId,status,createdAt) VALUES(?,?,?,?)').run(id, accountId, status, createdAt);
  }
  function mapping(id, accountId, createdAt = '2026-01-02T00:00:00.000Z') {
    store.db.prepare('INSERT INTO workbuddy_mappings(targetId,uid,accountId,jobId,createdAt) VALUES(?,?,?,?,?)').run('target-' + id, 'private-uid', accountId, id, createdAt);
  }
  return { store, account, job, pat, mapping, summary: id => store.get(id, true).taskSummary };
}

test('Store alone exposes unassigned and manual ownership without guessing purpose text', t => {
  const f = fixture(t, false);
  const free = f.account({ purpose: 'WorkBuddy PAT legacy text' });
  const used = f.account({ selectedAt: '2026-01-01T00:00:00Z', purpose: 'PAT' });
  assert.equal(f.summary(free)?.owner, 'unassigned');
  assert.equal(f.summary(free).canPat, true);
  assert.equal(f.summary(used).owner, 'other');
  assert.equal(f.summary(used).state, 'assigned');
});

test('reservation ownership requires the same account and exact record key', t => {
  const f = fixture(t);
  const real = f.account({ reservedBy: 'wb-real' });
  const fake = f.account({ reservedBy: 'wb-real' });
  const prefix = f.account({ reservedBy: 'pat:not-a-record' });
  const patOwner = f.account({ reservedBy: 'pat:real' });
  const wrongPat = f.account({ reservedBy: 'pat:real' });
  f.job('wb-real', real);
  f.pat('real', patOwner);
  assert.equal(f.summary(real)?.owner, 'workbuddy');
  assert.equal(f.summary(real).state, 'running');
  assert.equal(f.summary(patOwner).owner, 'pat');
  for (const id of [fake, prefix, wrongPat]) {
    assert.equal(f.summary(id).owner, 'other');
    assert.equal(f.summary(id).label, '占用来源待核对');
    assert.equal(f.summary(id).canPat, false);
  }
});

test('WorkBuddy queue, paused and stale reservations reflect actual task state', t => {
  const f = fixture(t);
  for (const [id, item, running, status, expected] of [
    ['queued', 'queued', 1, 'running', 'queued'],
    ['active', 'polling', 1, 'running', 'running'],
    ['manual', 'manual', 1, 'paused', 'manual'],
    ['stale', 'browser', 0, 'stopped', 'manual'],
  ]) {
    const accountId = f.account({ reservedBy: id });
    f.job(id, accountId, item, running, status);
    assert.equal(f.summary(accountId)?.state, expected);
  }
});

test('released failures stay unassigned and successful mappings survive newer failures and skips', t => {
  const f = fixture(t);
  const released = f.account();
  f.job('failed', released, 'failed', 0, 'completed');
  assert.equal(f.summary(released)?.owner, 'unassigned');
  const linked = f.account({ selectedAt: '2026-01-01T00:00:00Z' });
  f.job('success', linked, 'success', 0, 'completed');
  f.mapping('success', linked);
  f.job('later-failure', linked, 'failed', 0, 'completed');
  f.store.db.prepare('UPDATE workbuddy_items SET finishedAt=? WHERE jobId=?').run('2026-01-03T00:00:00.000Z', 'later-failure');
  f.job('skip', linked, 'skipped', 0, 'completed');
  f.store.db.prepare('INSERT INTO workbuddy_restrictions VALUES(?,?,?,?)').run(linked, 'later-failure', '限制标记', '2026-01-04T00:00:00.000Z');
  const row = f.store.get(linked);
  assert.equal(row.taskSummary.owner, 'workbuddy');
  assert.equal(row.taskSummary.state, 'linked');
  assert.equal(row.taskSummary.workbuddyFinishedAt, '2026-01-03T00:00:00.000Z');
  assert.equal(row.taskSummary.workbuddyJobId, 'later-failure');
  assert.equal(row.taskSummary.workbuddyLinkedAt, '2026-01-02T00:00:00.000Z');
  assert.equal(row.workbuddyResult.status, 'restricted');
  assert.equal(row.workbuddyResult.finishedAt, '2026-01-04T00:00:00.000Z');
});

test('PAT priority reports conflicts without changing mappings or unknown reservations', t => {
  const f = fixture(t);
  const id = f.account({ patDedicated: 1, reservedBy: 'legacy-unknown' });
  f.job('old', id, 'success', 0, 'completed'); f.mapping('old', id);
  assert.equal(f.summary(id)?.owner, 'pat');
  assert.equal(f.summary(id).conflict, true);
  assert.equal(f.summary(id).state, 'pending');
  assert.equal(f.store.get(id).reservedBy, 'legacy-unknown');
});

test('PAT preparation only means running when the matching live task is active', t => {
  const f = fixture(t);
  const id = f.account({ patDedicated: 1, reservedBy: 'pat:prepare' });
  f.pat('prepare', id);
  assert.equal(f.summary(id)?.state, 'manual');
  f.store.patService = { active: { record: { id: 'prepare', accountId: id }, manual: false } };
  assert.equal(f.summary(id).state, 'preparing');
  f.store.patService.active.manual = true;
  assert.equal(f.summary(id).state, 'manual');
  for (const state of ['verifying', 'valid', 'cooling', 'manual', 'invalid', 'disabled']) {
    f.store.db.prepare('UPDATE pats SET status=? WHERE id=?').run(state, 'prepare');
    assert.equal(f.summary(id).state, state);
  }
});

test('current reserved PAT wins over historical records and read expiry never mutates database', t => {
  const f = fixture(t);
  const id = f.account({ patDedicated: 1, reservedBy: 'pat:current' });
  f.pat('current', id, 'valid'); f.pat('history', id, 'disabled', '2026-02-01T00:00:00.000Z');
  f.store.db.prepare('UPDATE pats SET expiresAt=?,token=? WHERE id=?').run('2020-01-01T00:00:00.000Z', 'private-ciphertext', 'current');
  const before = f.store.db.prepare('SELECT total_changes() AS n').get().n;
  const listed = f.store.list().find(row => row.id === id);
  const got = f.store.get(id);
  assert.equal(got.taskSummary?.state, 'invalid');
  assert.equal(listed.pat.id, 'current');
  assert.equal(listed.pat.status, 'invalid');
  assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get().n, before);
  assert.equal(f.store.db.prepare('SELECT status FROM pats WHERE id=?').get('current').status, 'valid');
  const json = JSON.stringify(listed);
  for (const secret of ['private-password', 'JBSWY3DPEHPK3PXP', 'private-ciphertext', 'private-uid']) assert.ok(!json.includes(secret));
});

test('candidate summaries share store rules and WorkBuddy restrictions do not exclude PAT candidates', t => {
  const f = fixture(t);
  const ready = f.account();
  const restricted = f.account();
  f.store.db.prepare('INSERT INTO workbuddy_restrictions VALUES(?,?,?,?)').run(restricted, 'old', '受限', '2026-01-01T00:00:00.000Z');
  const cases = [
    [{ hasTotp: 0 }, /TOTP/],
    [{ publicStatus: 'unchecked', checkedAt: null }, /未检测/],
    [{ checkedAt: '2020-01-01T00:00:00.000Z' }, /过期/],
    [{ publicStatus: 'missing' }, /公开/],
    [{ deletedAt: '2026-01-01T00:00:00Z' }, /回收站/],
    [{ reservedBy: '' }, /占用/],
  ];
  for (const [patch, reason] of cases) {
    const id = f.account(patch);
    assert.equal(f.summary(id)?.canPat, false);
    assert.equal(f.summary(id).canWorkbuddy, false);
    assert.match(f.summary(id).candidateReason, reason);
  }
  assert.equal(f.summary(ready).canPat, true);
  assert.equal(f.summary(ready).canWorkbuddy, true);
  assert.equal(f.summary(restricted).canPat, true);
  assert.equal(f.summary(restricted).canWorkbuddy, false);
  assert.match(f.summary(restricted).candidateReason, /WorkBuddy.*受限/);
  assert.deepEqual(new Set(f.store.list().filter(row => row.taskSummary.canPat).map(row => row.id)), new Set(f.store.candidateRows().map(row => row.id)));
});

test('multiple links preserve their actual dates and ownership counts partition active accounts', t => {
  const f = fixture(t);
  f.account(); f.account({ selectedAt: '2026-01-01' }); f.account({ patDedicated: 1 });
  f.account({ deletedAt: '2026-01-01' });
  const linked = f.account();
  f.job('one', linked, 'success', 0, 'completed'); f.mapping('one', linked);
  f.job('two', linked, 'success', 0, 'completed'); f.mapping('two', linked, '2026-02-01T00:00:00.000Z');
  const summary = f.summary(linked);
  assert.equal(summary?.workbuddyLinkedAt, '2026-02-01T00:00:00.000Z');
  assert.equal(summary.workbuddyLinks.length, 2);
  assert.deepEqual(summary.workbuddyLinks[0], { targetId: 'target-two', targetName: '目标 two', createdAt: '2026-02-01T00:00:00.000Z' });
  const owners = f.store.list().filter(row => !row.deletedAt).map(row => row.taskSummary.owner);
  assert.deepEqual(owners.sort(), ['other', 'pat', 'unassigned', 'workbuddy']);
});

test('bulk account reads use a fixed query count as account and PAT counts grow', t => {
  const f = fixture(t);
  const first = f.account({ patDedicated: 1 });
  f.pat('first', first, 'valid');
  const prepare = f.store.db.prepare.bind(f.store.db);
  let queries = 0;
  f.store.db.prepare = (...args) => { queries++; return prepare(...args); };
  f.store.list();
  const initialQueries = queries;
  for (let index = 0; index < 20; index++) {
    const id = f.account({ patDedicated: 1 });
    f.pat('bulk-' + index, id, 'valid');
  }
  queries = 0;
  const rows = f.store.list();
  assert.equal(rows.length, 21);
  assert.equal(queries, initialQueries);
  assert.ok(rows.every(row => row.taskSummary.owner === 'pat' && row.pat.status === 'valid'));
});

test('running retries retain the last real processing end time while navigating to the current job', t => {
  const f = fixture(t);
  const id = f.account({ reservedBy: 'retry' });
  f.job('previous-failure', id, 'failed', 0, 'completed');
  f.store.db.prepare('UPDATE workbuddy_items SET finishedAt=? WHERE jobId=?').run('2026-01-03T00:00:00.000Z', 'previous-failure');
  f.job('retry', id, 'browser');
  for (const status of ['browser', 'linking', 'polling', 'manual']) {
    f.store.db.prepare('UPDATE workbuddy_items SET status=? WHERE jobId=?').run(status, 'retry');
    const row = f.store.get(id);
    assert.equal(row.taskSummary.workbuddyFinishedAt, '2026-01-03T00:00:00.000Z');
    assert.equal(row.taskSummary.workbuddyJobId, 'retry');
    assert.equal(row.taskSummary.state, status === 'manual' ? 'manual' : 'running');
    assert.equal(row.workbuddyResult.status, status);
    assert.equal(row.workbuddyResult.finishedAt, null);
  }
});

test('invalid and skipped newer end times cannot replace a previous valid processing end time', t => {
  const f = fixture(t);
  const id = f.account();
  f.job('finished', id, 'failed', 0, 'completed');
  f.store.db.prepare('UPDATE workbuddy_items SET finishedAt=? WHERE jobId=?').run('2026-01-03T00:00:00.000Z', 'finished');
  f.job('invalid-finish', id, 'failed', 0, 'completed');
  f.store.db.prepare('UPDATE workbuddy_items SET finishedAt=? WHERE jobId=?').run('not-a-date', 'invalid-finish');
  f.job('new-skipped', id, 'skipped', 0, 'completed');
  f.store.db.prepare('UPDATE workbuddy_items SET finishedAt=? WHERE jobId=?').run('2026-01-05T00:00:00.000Z', 'new-skipped');
  assert.equal(f.summary(id).workbuddyFinishedAt, '2026-01-03T00:00:00.000Z');
  assert.equal(f.summary(id).workbuddyJobId, 'invalid-finish');
  const invalidOnly = f.account();
  f.job('only-invalid', invalidOnly, 'failed', 0, 'completed');
  f.store.db.prepare('UPDATE workbuddy_items SET finishedAt=? WHERE jobId=?').run('not-a-date', 'only-invalid');
  assert.equal(f.summary(invalidOnly).workbuddyFinishedAt, null);
});

test('confirmed historical WorkBuddy registrations retain ownership without inventing UID mappings',t=>{
 const f=fixture(t);const purpose='WorkBuddy 国际版：远端账号池已存在（用户确认）';
 const selectedAt='2026-10-19T04:59:31.741Z';
 const id=f.account({selectedAt,purpose});
 const account=f.store.get(id);
 seedLegacyEvents(f.store);
 f.store.db.prepare('INSERT INTO events(accountId,username,action,detail,createdAt) VALUES(?,?,?,?,?)').run(id,account.username,'select',purpose,selectedAt);
 retireActivity(f.store);
 const summary=f.summary(id);
 assert.equal(summary.owner,'workbuddy');assert.equal(summary.state,'external');
 assert.equal(summary.workbuddyRegisteredAt,selectedAt);
 assert.equal(summary.workbuddyLinkedAt,null);assert.deepEqual(summary.workbuddyLinks,[]);
 assert.equal(summary.canWorkbuddy,false);assert.equal(summary.canPat,false);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM workbuddy_mappings WHERE accountId=?').get(id).n,0);
 f.store.release(id);
 assert.equal(f.summary(id).owner,'unassigned');
 assert.equal(f.summary(id).workbuddyRegisteredAt,null);
});

test('unconfirmed text and mismatched or superseded registration events never infer WorkBuddy ownership',t=>{
 const f=fixture(t);const purpose='WorkBuddy 国际版：远端账号池已存在（用户确认）';
 const selectedAt='2026-10-19T04:59:31.741Z';
 for(const kind of ['missing','timestamp','username','superseded']){
  const id=f.account({selectedAt,purpose});const account=f.store.get(id);
  seedLegacyEvents(f.store);
  if(kind!=='missing')f.store.db.prepare('INSERT INTO events(accountId,username,action,detail,createdAt) VALUES(?,?,?,?,?)').run(id,kind==='username'?'different':account.username,'select',purpose,kind==='timestamp'?'2020-01-01':selectedAt);
  if(kind==='superseded')f.store.db.prepare('INSERT INTO events(accountId,username,action,detail,createdAt) VALUES(?,?,?,?,?)').run(id,account.username,'release','释放选用标记',selectedAt);
  retireActivity(f.store);
  assert.equal(f.summary(id).owner,'other',kind);
 }
});
