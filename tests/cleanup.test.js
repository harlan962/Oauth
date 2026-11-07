import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { PatService } from '../server/pat-service.js';
import { WorkBuddyService } from '../server/workbuddy.js';
import { createChecker } from '../server/checker.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'desk-cleanup-'));
  let store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const account=(username)=>{const a=store.create({username,email:username+'@example.test',password:'fixture',totp:'JBSWY3DPEHPK3PXP'});store.setCheck(a.id,username,{status:'reachable',message:'fixture'});return a;};
  return {get store(){return store;},account,reopen(){store.close();store=new Store(dir);return store;}};
}
test('target five creates five credentials without a fixed three-account ceiling',async t=>{
  const f=fixture(t);for(let n=0;n<5;n++)f.account('candidate'+n);
  let opened=0;
  const pat=new PatService(f.store,{patBrowser:{assertAvailable(){},async open({account,onToken}){opened++;return {async step(){onToken('fixture-'+account.username,'2099-01-01T00:00:00Z');return {status:'captured'};},async close(){}};}},patFetcher:async(url,opts)=>new Response(JSON.stringify({login:opts.headers.Authorization.slice('Bearer fixture-'.length)}))});
  pat.configure({enabled:true,targetCount:5,confirmed:true});pat.start();await pat.active?.promise;
  assert.equal(opened,5);assert.equal(pat.pats.usable().length,5);
  for(const value of [0,101,1.1,'5',null])assert.throws(()=>pat.configure({targetCount:value}));
});
test('deletion requires disabled or released state, confirmation, no task and known outcome',t=>{
  const f=fixture(t);f.account('pat-account');const pat=new PatService(f.store,{patBrowser:{}}),p=pat.pats.reserve();
  assert.throws(()=>pat.remove(p.id,{confirmed:true}));
  pat.pats.complete(p.id);pat.pats.disable(p.id);
  assert.throws(()=>pat.remove(p.id,{}));
  pat.pats.update(p.id,{creationUncertain:true});assert.throws(()=>pat.remove(p.id,{confirmed:true}));
  pat.pats.update(p.id,{creationUncertain:false});pat.verifications.set(p.id,Promise.resolve());assert.throws(()=>pat.remove(p.id,{confirmed:true}));pat.verifications.clear();
  pat.remove(p.id,{confirmed:true});assert.equal(pat.pats.list().length,0);
  pat.pats.releaseAccount(p.accountId,{confirmed:true});assert.equal(f.store.get(p.accountId).patDedicated,0);
});
test('deleting disabled token cannot erase remote-credential protection, including after restart',t=>{
  const f=fixture(t);f.account('held');let pat=new PatService(f.store,{patBrowser:{}});const p=pat.pats.reserve();
  pat.pats.saveToken(p.id,'fixture-token','2099-01-01T00:00:00Z');pat.pats.complete(p.id);pat.pats.disable(p.id);pat.remove(p.id,{confirmed:true});
  assert.equal(pat.pats.list().length,0);assert.equal(f.store.get(p.accountId).patDedicated,1);
  pat=new PatService(f.reopen(),{patBrowser:{}});assert.throws(()=>pat.pats.releaseAccount(p.accountId,{confirmed:true}),/远端|有效/);
  f.store.db.prepare('UPDATE pat_credential_holds SET expiresAt=?').run('2000-01-01T00:00:00Z');
  pat.pats.releaseAccount(p.accountId,{confirmed:true});assert.equal(f.store.get(p.accountId).patDedicated,0);
});
test('purge is atomic, only accepts trash and removes credentials, labels and WorkBuddy associations',t=>{
  const f=fixture(t);const a=f.account('trashed'),b=f.account('kept');new PatService(f.store,{patBrowser:{}});new WorkBuddyService(f.store,{});
  f.store.trash(a.id);
  assert.throws(()=>f.store.purge([a.id],{}));assert.throws(()=>f.store.purge([a.id,b.id],{confirmed:true}));assert.equal(f.store.list().length,2);
  f.store.db.prepare("INSERT INTO pats(id,accountId,status,createdAt) VALUES('old',?,'invalid','2020-01-01')").run(a.id);
  f.store.db.prepare('INSERT INTO workbuddy_mappings VALUES(?,?,?,?,?)').run('target','uid',a.id,'old-job','2020-01-01');
  const group=f.store.organization.save('groups',{name:'source'});f.store.db.prepare('INSERT INTO account_group_links VALUES(?,?)').run(a.id,group.id);
  assert.equal(f.store.purge([a.id],{confirmed:true}).changed,1);
  assert.equal(f.store.list().length,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM pats').get().n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM workbuddy_mappings').get().n,0);assert.equal(f.store.db.prepare('SELECT count(*) n FROM account_group_links').get().n,0);
  assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length,0);
});
test('legacy events migrate only confirmed current WorkBuddy ownership then stop accumulating',t=>{
  const f=fixture(t);const a=f.account('registered'),b=f.account('unconfirmed');const purpose='WorkBuddy 国际版：远端账号池已存在（用户确认）',stamp='2026-01-02T00:00:00Z';
  f.store.db.exec('CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,accountId TEXT,username TEXT,action TEXT,detail TEXT,createdAt TEXT)');
  for(const row of [a,b]){f.store.db.prepare('UPDATE accounts SET selectedAt=?,purpose=? WHERE id=?').run(stamp,purpose,row.id);f.store.db.prepare('INSERT INTO events(accountId,username,action,detail,createdAt) VALUES(?,?,?,?,?)').run(row.id,row.username,'select',purpose,stamp);}
  f.store.db.prepare('INSERT INTO events(accountId,username,action,detail,createdAt) VALUES(?,?,?,?,?)').run(b.id,b.username,'release','release',stamp);
  f.reopen();assert.equal(f.store.get(a.id).taskSummary.owner,'workbuddy');assert.equal(f.store.get(b.id).taskSummary.owner,'other');
  assert.equal(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name='events'").get(),undefined);
  f.store.update(a.id,{notes:'edit'});f.store.release(a.id);assert.equal(f.store.get(a.id).taskSummary.owner,'unassigned');
  f.reopen();assert.equal(f.store.get(a.id).taskSummary.owner,'unassigned');
});

test('purging scrubs a paused checker queue atomically and preserves other resumable accounts',t=>{
  const f=fixture(t),a=f.account('remove-from-queue'),b=f.account('still-pending');
  const pat=new PatService(f.store,{patBrowser:{}});
  pat.pats.setCheckpoint('checks:queue:0',[{id:a.id,username:a.username},{id:b.id,username:b.username}]);
  pat.pats.setCheckpoint('checks',{version:1,queuePages:1,index:0,authenticated:false,job:{total:2,done:0,counts:{},running:false}});
  const checker=createChecker(f.store,async()=>{throw Error('No requests expected');},0,{pat});
  f.store.trash(a.id);
  let change=checker.prepareRemoval([a.id]);
  assert.throws(()=>f.store.purge([a.id],{confirmed:true,beforeCommit:()=>{change.persist();throw Error('rollback fixture');}}),/rollback/);
  assert.equal(f.store.get(a.id,true).id,a.id);assert.equal(pat.pats.getCheckpoint('checks').job.total,2);assert.equal(checker.status().total,2);
  change=checker.prepareRemoval([a.id]);f.store.purge([a.id],{confirmed:true,beforeCommit:change.persist});change.commit();
  assert.equal(checker.status().total,1);assert.equal(checker.status().canResume,true);
  assert.deepEqual(pat.pats.getCheckpoint('checks:queue:0'),[{id:b.id,username:b.username}]);
  const reopened=new PatService(f.reopen(),{patBrowser:{}});const recovered=createChecker(f.store,async()=>{throw Error('No requests expected');},0,{pat:reopened});
  assert.equal(recovered.status().total,1);assert.equal(recovered.status().canResume,true);
});
