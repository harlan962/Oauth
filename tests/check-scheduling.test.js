import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createApp } from './authenticated-app.js';

const DAY=86400000;
const legacy = settings => ({ ...settings.rules[0], enabled: settings.enabled, version: undefined });
async function settled(checker){for(let i=0;i<1000;i++){if(!checker.status().running)return;await new Promise(r=>setTimeout(r,2));}throw Error('timeout');}
function fixture(t,{fetcher,wait}={}){
  const dir=mkdtempSync(join(tmpdir(),'check-schedule-')),store=new Store(dir);let now=Date.now();const calls=[];
  const options={clock:()=>now,delayMs:0,wait:wait||(async()=>{}),fetcher:fetcher||(async url=>{calls.push(url.split('/').pop());return new Response(JSON.stringify({login:url.split('/').pop(),type:'User'}));})};
  const app=createApp(store,options);
  t.after(async()=>{app.schedule?.stop();await app.checker.cancel();await app.pat.stop();store.close();rmSync(dir,{recursive:true,force:true});});
  const add=(name,status='unchecked',age=null)=>{const a=store.create({username:name,email:name+'@example.test',password:'synthetic'});store.db.prepare('UPDATE accounts SET publicStatus=?,checkedAt=? WHERE id=?').run(status,age===null?null:new Date(now-age*DAY).toISOString(),a.id);return a;};
  return {...app,store,dir,options,calls,add,clock:()=>now,advance:ms=>{now+=ms;}};
}
test('scheduler is off by default; validates and persists settings; preview never requests upstream',t=>{
  const f=fixture(t);assert.ok(f.schedule,'createApp exposes scheduler');
  const base=legacy(f.schedule.status().settings);assert.equal(base.enabled,false);assert.equal(base.intervalDays,7);
  f.add('unchecked');f.schedule.preview(base);assert.deepEqual(f.calls,[]);
  for(const intervalDays of [0,366,1.5,'3',null])assert.throws(()=>f.schedule.configure({...base,intervalDays}));
  f.schedule.configure({...base,enabled:true,intervalDays:3});
  const reopened=new Store(f.dir);const other=createApp(reopened,f.options);
  assert.equal(other.schedule.status().settings.rules[0].intervalDays,3);assert.equal(other.schedule.status().settings.enabled,true);other.schedule.stop();reopened.close();
});
test('only due accounts with matching group, tag and status run; unknown and unchecked are included',async t=>{
  const f=fixture(t);assert.ok(f.schedule);
  const old=f.add('old','reachable',8),fresh=f.add('fresh','reachable',2),unknown=f.add('unknown','error',8),unchecked=f.add('unchecked'),missing=f.add('missing','missing',30),outside=f.add('outside','reachable',9),trash=f.add('trash');f.store.trash(trash.id);
  const g=f.store.organization.save('groups',{name:'source'}),tag=f.store.organization.save('tags',{name:'use'});
  f.store.organization.assign([old.id,fresh.id,unknown.id,unchecked.id,missing.id],{groupId:g.id,tagIds:[tag.id]});
  const cfg={...legacy(f.schedule.status().settings),enabled:true,groupIds:[g.id],tagIds:[tag.id]};
  const preview=f.schedule.configure(cfg);assert.equal(preview.matched,4);assert.equal(preview.due,3);
  f.schedule.tick();await settled(f.checker);assert.deepEqual(new Set(f.calls),new Set(['old','unknown','unchecked']));assert.equal(f.checker.status().scope,'scheduled');
  f.schedule.tick();assert.equal(f.calls.length,3);assert.equal(f.store.get(outside.id).checkedAt!==null,true);
});
test('none and empty filters never broaden to all; deleted filter pauses matching',t=>{
  const f=fixture(t);assert.ok(f.schedule);f.add('plain');const b=f.add('grouped');
  const g=f.store.organization.save('groups',{name:'g'});f.store.organization.assign([b.id],{groupId:g.id});
  const base=legacy(f.schedule.status().settings);
  assert.equal(f.schedule.preview({...base,groupIds:['none'],tagIds:['none']}).matched,1);
  assert.equal(f.schedule.preview({...base,groupIds:[]}).matched,0);
  f.schedule.configure({...base,enabled:true,groupIds:[g.id]});f.store.organization.delete('groups',g.id);
  assert.equal(f.schedule.status().matched,0);assert.equal(f.schedule.status().invalidFilters.length,1);f.schedule.tick();assert.deepEqual(f.calls,[]);
});
test('automatic network failures preserve previous result and back off across scheduler restart',async t=>{
  let calls=0;const f=fixture(t,{fetcher:async()=>{calls++;throw Error('offline');}});assert.ok(f.schedule);
  const a=f.add('offline','reachable',8),before=f.store.get(a.id);f.schedule.configure({...legacy(f.schedule.status().settings),enabled:true});
  f.schedule.tick();await settled(f.checker);assert.equal(calls,3);assert.equal(f.checker.status().done,1);assert.equal(f.checker.status().canResume,false);
  assert.equal(f.store.get(a.id).checkedAt,before.checkedAt);assert.equal(f.store.get(a.id).publicStatus,'reachable');
  f.schedule.tick();assert.equal(calls,3);f.advance(29*60000);assert.equal(f.schedule.status().due,0);
  const reopened=new Store(f.dir),other=createApp(reopened,f.options);assert.equal(other.schedule.status().due,0);other.schedule.stop();reopened.close();
  f.advance(60000);f.schedule.tick();await settled(f.checker);assert.equal(calls,6);f.advance(31*60000);assert.equal(f.schedule.status().due,0);
});
test('scheduler never overwrites running or cancelled/resumable jobs or authorization work',async t=>{
  const f=fixture(t);assert.ok(f.schedule);f.add('due');f.schedule.configure({...legacy(f.schedule.status().settings),enabled:true});
  f.workbuddy.active={};f.schedule.tick();assert.equal(f.calls.length,0);f.workbuddy.active=null;
  const status=f.checker.status;f.checker.status=()=>({...status(),canResume:true,cancelled:true});f.schedule.tick();assert.equal(f.calls.length,0);f.checker.status=status;
  f.schedule.tick();await settled(f.checker);assert.equal(f.calls.length,1);
});
test('changing interval recalculates due time without changing checkedAt; manual range ignores age',async t=>{
  const f=fixture(t);assert.ok(f.schedule);const a=f.add('recent','reachable',2);const before=f.store.get(a.id).checkedAt;
  const base=legacy(f.schedule.status().settings);assert.equal(f.schedule.preview(base).due,0);
  assert.equal(f.schedule.configure({...base,intervalDays:1}).due,1);assert.equal(f.store.get(a.id).checkedAt,before);
  f.schedule.startRange({...base,intervalDays:365});await settled(f.checker);assert.deepEqual(f.calls,['recent']);assert.equal(legacy(f.schedule.status().settings).intervalDays,1);
});
test('restart resumes interrupted automatic batch from remaining rows, while cancellation stays paused',async t=>{
  const f=fixture(t);assert.ok(f.schedule);const a=f.add('first'),b=f.add('second');
  f.schedule.configure({...legacy(f.schedule.status().settings),enabled:true});
  f.pat.pats.setCheckpoint('checks:queue:0',[a,b].map(({id,username})=>({id,username})));
  f.pat.pats.setCheckpoint('checks:results:0',[{id:a.id,status:'reachable',at:new Date(f.clock()).toISOString()}]);
  f.pat.pats.setCheckpoint('checks',{version:1,queuePages:1,index:1,authenticated:false,job:{running:true,total:2,done:1,scope:'scheduled',phase:'checking',cancelled:false,counts:{reachable:1,missing:0,limited:0,error:0,skipped:0}}});
  const restarted=createApp(f.store,f.options);restarted.schedule.tick();await settled(restarted.checker);
  assert.deepEqual(f.calls,['second']);assert.equal(restarted.checker.status().done,2);restarted.schedule.stop();await restarted.checker.cancel();
});
test('graceful service shutdown resumes automatic work but explicit user cancellation does not',async t=>{
  let requests=0;
  const f=fixture(t,{fetcher:async(url,{signal})=>{
    requests++;
    if(requests===2)await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('stopped')),{once:true}));
    return new Response(JSON.stringify({login:url.split('/').pop(),type:'User'}));
  }});
  f.add('shutdown-a');f.add('shutdown-b');f.schedule.configure({...legacy(f.schedule.status().settings),enabled:true});
  f.schedule.tick();while(requests<2)await new Promise(r=>setTimeout(r,2));
  await f.checker.cancel({shutdown:true});
  const restarted=createApp(f.store,f.options);restarted.schedule.tick();await settled(restarted.checker);
  assert.equal(requests,3);assert.equal(restarted.checker.status().done,2);
  restarted.schedule.stop();await restarted.checker.cancel();
});
test('a longer interval takes precedence over a failed attempt retry deadline',async t=>{
  const f=fixture(t,{fetcher:async()=>{throw Error('offline');}});f.add('old','reachable',8);
  f.schedule.configure({...legacy(f.schedule.status().settings),enabled:true});f.schedule.tick();await settled(f.checker);
  f.advance(31*60000);assert.equal(f.schedule.status().due,1);
  const result=f.schedule.configure({...legacy(f.schedule.status().settings),intervalDays:365});assert.equal(result.due,0);
});
test('a mismatched profile is retried with backoff, preserving the last confirmed result',async t=>{
  const f=fixture(t,{fetcher:async()=>new Response(JSON.stringify({login:'wrong-person',type:'User'}))});
  const a=f.add('expected','reachable',8);f.schedule.configure({...legacy(f.schedule.status().settings),enabled:true});
  f.schedule.tick();await settled(f.checker);assert.equal(f.store.get(a.id).publicStatus,'reachable');
  assert.equal(f.schedule.status().due,0);f.advance(30*60000);assert.equal(f.schedule.status().due,1);
});
test('disabling PAT use does not bypass a persisted global cooldown',async t=>{
  const f=fixture(t,{wait:async(_ms,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}))});
  const a=f.add('waiting');f.pat.pats.setCheckpoint('global-cooldown',{waitUntil:new Date(f.clock()+3600000).toISOString(),scope:'global'});
  f.checker.start([a.id]);await new Promise(r=>setTimeout(r,10));
  assert.deepEqual(f.calls,[]);assert.equal(f.checker.status().phase,'waiting');await f.checker.cancel();
});
test('explicitly cancelled automatic task stays paused after restart',async t=>{
  let requests=0;
  const f=fixture(t,{fetcher:async(_url,{signal})=>{requests++;await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Error('cancel')),{once:true}));}});
  f.add('cancel-me');f.schedule.configure({...legacy(f.schedule.status().settings),enabled:true});f.schedule.tick();
  while(!requests)await new Promise(r=>setTimeout(r,2));await f.checker.cancel();
  const next=createApp(f.store,f.options);next.schedule.tick();assert.equal(next.checker.status().cancelled,true);assert.equal(next.checker.status().running,false);assert.equal(requests,1);next.schedule.stop();
});

