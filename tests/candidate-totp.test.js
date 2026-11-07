import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { PatStore } from '../server/pat-store.js';
import { WorkBuddyService } from '../server/workbuddy.js';

const totp='JBSWY3DPEHPK3PXP';
function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'candidate-totp-'));
  const store=new Store(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  function account(username,secret='') {
    const row=store.create({username,email:username+'@example.test',password:'synthetic-password',totp:secret});
    store.setCheck(row.id,username,{status:'reachable',message:'fixture'});
    return row;
  }
  return {store,account};
}

test('candidate selection requires a saved TOTP and reacts to adding or removing it',t=>{
  const {store,account}=fixture(t);
  const missing=account('missing'), ready=account('ready',totp);
  assert.deepEqual(store.candidateRows().map(a=>a.id),[ready.id]);
  assert.throws(()=>store.select(missing.id),/TOTP|两步验证/);
  assert.equal(store.get(missing.id).selectedAt,null);
  assert.equal(store.select().id,ready.id);
  store.release(ready.id);
  store.update(ready.id,{totp:''});
  assert.equal(store.candidateRows().length,0);
  assert.throws(()=>store.select(),/没有可选/);
  store.update(missing.id,{totp});
  assert.deepEqual(store.candidateRows().map(a=>a.id),[missing.id]);
  assert.equal(store.select(missing.id).id,missing.id);
});

test('WorkBuddy preview excludes missing TOTP and rejects a stale preview after its removal',t=>{
  const {store,account}=fixture(t);
  account('missing');const ready=account('ready',totp);
  const wb=new WorkBuddyService(store,{target:()=>({id:'t',name:'Test',baseUrl:'https://example.test',revision:'r1'})},{oauthBrowser:{assertAvailable(){}}});
  const body={targetId:'t',targetRevision:'r1',realm:'global',count:1,requestId:'totp-required',accountIds:[ready.id]};
  assert.deepEqual(wb.candidates().accounts.map(a=>a.id),[ready.id]);
  assert.equal(wb.preview(body).accounts[0].hasTotp,true);
  store.update(ready.id,{totp:''});
  assert.throws(()=>wb.start(body),/候选/);
  assert.equal(wb.jobs().length,0);
  assert.equal(store.get(ready.id).reservedBy,null);
  assert.throws(()=>wb.preview(body),/不足/);
});

test('PAT replenishment also skips accounts without saved TOTP',t=>{
  const {store,account}=fixture(t);
  const missing=account('missing');const pats=new PatStore(store);
  assert.equal(pats.reserve(),null);
  assert.equal(store.get(missing.id).patDedicated,0);
  const ready=account('ready',totp);
  assert.equal(pats.reserve().accountId,ready.id);
});
