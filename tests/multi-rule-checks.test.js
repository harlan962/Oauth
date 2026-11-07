import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createApp } from './authenticated-app.js';

const rule = (overrides={}) => ({id:'one',name:'规则一',enabled:true,mode:'interval',intervalDays:7,stageDays:[1,3,7,15,30],baseline:'imported',baselineDate:null,repeatDays:30,statuses:['reachable','missing','unknown','unchecked'],groupIds:null,tagIds:null,...overrides});
const config = (...rules) => ({version:2,enabled:true,rules});
async function settled(checker){for(let i=0;i<1000;i++){if(!checker.status().running)return;await new Promise(r=>setTimeout(r,2));}throw Error('timeout');}
function fixture(t,{now='2026-10-20T00:00:00+08:00',fetcher}={}) {
  const dir=mkdtempSync(join(tmpdir(),'multi-rule-')),store=new Store(dir);let time=Date.parse(now);const calls=[];
  const options={clock:()=>time,delayMs:0,wait:async()=>{},fetcher:fetcher||(async url=>{const name=url.split('/').pop();calls.push(name);return new Response(JSON.stringify({login:name,type:'User'}));})};
  const app=createApp(store,options);
  t.after(async()=>{app.schedule.stop();await app.checker.cancel();await app.pat.stop();store.close();rmSync(dir,{recursive:true,force:true});});
  const add=(name,createdAt='2026-10-01T12:00:00+08:00')=>{const a=store.create({username:name,email:name+'@example.test',password:'synthetic'});store.db.prepare('UPDATE accounts SET createdAt=? WHERE id=?').run(createdAt,a.id);return a;};
  return {...app,store,dir,options,calls,add,setTime:value=>{time=Date.parse(value);},advance:ms=>{time+=ms;}};
}

test('legacy settings migrate without changing range or cadence, and stale legacy requests cannot overwrite multiple rules',t=>{
  const f=fixture(t); const legacy={enabled:true,intervalDays:11,statuses:['missing'],groupIds:[],tagIds:['none']};
  f.store.db.prepare('UPDATE check_settings SET value=? WHERE id=1').run(JSON.stringify(legacy));
  const reopened=new Store(f.dir),app=createApp(reopened,f.options);
  try {
    const migrated=app.schedule.settings();assert.equal(migrated.version,2);assert.equal(migrated.enabled,true);
    assert.equal(migrated.rules[0].id,'legacy-default');assert.equal(migrated.rules[0].intervalDays,11);assert.deepEqual(migrated.rules[0].groupIds,[]);assert.deepEqual(migrated.rules[0].tagIds,['none']);assert.deepEqual(migrated.rules[0].statuses,['missing']);
    app.schedule.configure({...legacy,intervalDays:12});assert.equal(app.schedule.settings().rules[0].intervalDays,12);
    app.schedule.configure(config(rule(),rule({id:'two'})));
    assert.throws(()=>app.schedule.configure(legacy));assert.throws(()=>app.schedule.startRange(legacy));assert.equal(app.schedule.settings().rules.length,2);
  } finally {app.schedule.stop();reopened.close();}
});

test('rule validation rejects malformed stages, duplicate IDs, invalid calendar dates and oversized rule sets',t=>{
  const f=fixture(t);
  const invalid=[{name:' '},{name:'a'.repeat(41)},{id:''},{enabled:'true'},{mode:'other'},{intervalDays:0},{repeatDays:366},{stageDays:[]},{stageDays:[3,1]},{stageDays:[1,1]},{stageDays:[1.5]},{stageDays:[366]},{baseline:'other'},{baseline:'date',baselineDate:'2026-02-30'},{baseline:'date',baselineDate:'2025-02-29'},{baseline:'date',baselineDate:'1999-12-31'},{baseline:'date',baselineDate:null},{statuses:[]},{groupIds:undefined}];
  for(const patch of invalid)assert.throws(()=>f.schedule.configure(config(rule(patch))),JSON.stringify(patch));
  assert.throws(()=>f.schedule.configure(config(rule(),rule())));assert.throws(()=>f.schedule.configure(config(...Array.from({length:31},(_,i)=>rule({id:String(i)})))));
  assert.equal(f.schedule.configure(config(rule({baseline:'date',baselineDate:'2024-02-29'}))).settings.version,2);
  assert.equal(f.schedule.configure(config()).matched,0);
});

test('preview and manual range use enabled union, deduplicate overlaps and ignore global switch and due dates',async t=>{
  const f=fixture(t);const a=f.add('alpha'),b=f.add('beta'),c=f.add('disabled');
  const g=f.store.organization.save('groups',{name:'g'});f.store.organization.assign([b.id,c.id],{groupId:g.id});
  f.store.setCheck(a.id,a.username,{status:'reachable',message:''},'2026-10-19T00:00:00+08:00');
  const draft={...config(rule({groupIds:['none']}),rule({id:'two',groupIds:['none']}),rule({id:'off',enabled:false,groupIds:[g.id]})),enabled:false};
  const p=f.schedule.preview(draft);assert.equal(p.matched,1);assert.equal(p.due,0);assert.deepEqual(p.rules.map(r=>r.matched),[1,1,2]);
  f.schedule.startRange(draft);await settled(f.checker);assert.deepEqual(f.calls,['alpha']);assert.equal(f.schedule.settings().rules[0].id,'legacy-default');
  assert.equal(f.schedule.preview(config(rule({enabled:false}))).matched,0);
});

test('a deleted scope blocks only its rule, while a range draft with an enabled invalid rule is rejected',async t=>{
  const f=fixture(t);f.add('safe');const g=f.store.organization.save('groups',{name:'deleted'});
  f.schedule.configure(config(rule({groupIds:['none']}),rule({id:'invalid',groupIds:[g.id]})));f.store.organization.delete('groups',g.id);
  const p=f.schedule.status();assert.equal(p.matched,1);assert.equal(p.due,1);assert.equal(p.rules[1].invalidFilters.length,1);assert.equal(p.invalidFilters.length,1);
  assert.throws(()=>f.schedule.startRange(p.settings));f.schedule.tick();await settled(f.checker);assert.deepEqual(f.calls,['safe']);
  assert.doesNotThrow(()=>f.schedule.preview(config(rule({enabled:false,groupIds:[g.id]}))));
});

test('stages use Beijing import calendar midnight and exact boundaries, with fixed repeat timeline',t=>{
  const f=fixture(t,{now:'2026-10-02T15:59:59Z'});const a=f.add('boundary','2026-10-01T17:30:00Z');
  f.schedule.configure(config(rule({mode:'staged'})));
  assert.equal(f.schedule.status().due,0);assert.equal(f.schedule.status().nextDueAt,'2026-10-02T16:00:00.000Z');
  f.advance(1000);assert.equal(f.schedule.status().due,1);
  f.store.setCheck(a.id,a.username,{status:'reachable',message:''},'2026-10-02T16:00:00.000Z');
  assert.equal(f.schedule.status().nextDueAt,'2026-10-04T16:00:00.000Z');
  f.setTime('2026-11-03T12:00:00+08:00');assert.equal(f.schedule.status().due,1);
  f.store.setCheck(a.id,a.username,{status:'reachable',message:''},'2026-11-03T12:00:00+08:00');
  assert.equal(f.schedule.status().nextDueAt,'2026-11-30T16:00:00.000Z');
});

test('custom baseline ignores account registration/import timestamp and late checks cover all elapsed stages once',async t=>{
  const f=fixture(t);f.add('late','2026-10-20T06:00:00+08:00');
  f.schedule.configure(config(rule({mode:'staged',baseline:'date',baselineDate:'2026-10-01'})));
  assert.equal(f.schedule.status().due,1);f.schedule.tick();await settled(f.checker);assert.deepEqual(f.calls,['late']);
  assert.equal(f.schedule.status().due,0);assert.equal(f.schedule.status().nextDueAt,'2026-10-30T16:00:00.000Z');
  f.schedule.tick();assert.deepEqual(f.calls,['late']);
});

test('manual definitive checks cover stages but errors and limits cannot advance last confirmation, including restart',t=>{
  const f=fixture(t);const a=f.add('manual');f.schedule.configure(config(rule({mode:'staged'})));
  assert.equal(f.store.setCheck(a.id,'other',{status:'reachable',message:''},'2026-10-20T00:00:00+08:00'),false);assert.equal(f.schedule.status().due,1);
  f.store.setCheck(a.id,a.username,{status:'missing',message:''},'2026-10-16T00:00:00+08:00');
  assert.equal(f.schedule.status().nextDueAt,'2026-10-30T16:00:00.000Z');
  f.store.setCheck(a.id,a.username,{status:'error',message:''},'2026-11-01T00:00:00+08:00');
  f.store.setCheck(a.id,a.username,{status:'limited',message:''},'2026-11-02T00:00:00+08:00');
  f.setTime('2026-11-02T00:00:00+08:00');assert.equal(f.schedule.status().due,1);
  const reopened=new Store(f.dir),app=createApp(reopened,f.options);try{assert.equal(app.schedule.status().due,1);}finally{app.schedule.stop();reopened.close();}
});

test('existing definitive results bootstrap confirmation but existing unknown results do not',t=>{
  const f=fixture(t);const a=f.add('known'),b=f.add('unknown');
  f.store.db.prepare('UPDATE accounts SET publicStatus=?,checkedAt=? WHERE id=?').run('reachable','2026-10-19T00:00:00+08:00',a.id);
  f.store.db.prepare('UPDATE accounts SET publicStatus=?,checkedAt=? WHERE id=?').run('error','2026-10-19T00:00:00+08:00',b.id);
  f.schedule.configure(config(rule({mode:'staged'})));
  const reopened=new Store(f.dir),app=createApp(reopened,f.options);try{assert.equal(app.schedule.status().matched,2);assert.equal(app.schedule.status().due,1);}finally{app.schedule.stop();reopened.close();}
});

test('renaming and reverting cannot revive obsolete confirmation; permanent deletion removes confirmation',t=>{
  const f=fixture(t);const a=f.add('original');f.schedule.configure(config(rule({mode:'staged'})));
  f.store.setCheck(a.id,a.username,{status:'reachable',message:''},'2026-10-20T00:00:00+08:00');assert.equal(f.schedule.status().due,0);
  f.store.update(a.id,{username:'renamed',email:a.email,password:'synthetic',totp:'',notes:''});
  f.store.update(a.id,{username:'original',email:a.email,password:'synthetic',totp:'',notes:''});assert.equal(f.schedule.status().due,1);
  f.store.setCheck(a.id,a.username,{status:'reachable',message:''},'2026-10-20T00:00:00+08:00');f.store.trash(a.id);f.store.purge([a.id],{confirmed:true});
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM check_confirmations').get().count,0);
});

test('overlapping rules respect account retry floor, including a new rule and restart',async t=>{
  const f=fixture(t,{fetcher:async()=>{throw Error('offline');}});f.add('retry');
  f.schedule.configure(config(rule({mode:'staged'})));f.schedule.tick();await settled(f.checker);assert.equal(f.schedule.status().due,0);
  f.schedule.configure(config(rule({mode:'staged'}),rule({id:'new'})));assert.equal(f.schedule.status().due,0);
  f.advance(30*60000);assert.equal(f.schedule.status().due,1);
});

test('a single upgraded legacy rule rejects stale legacy requests, and malformed versions never downgrade',t=>{
  const f=fixture(t);const legacy={enabled:true,intervalDays:7,statuses:['reachable','unchecked'],groupIds:null,tagIds:null};
  f.schedule.configure(config(rule({id:'legacy-default',mode:'staged'})));
  assert.throws(()=>f.schedule.configure(legacy));assert.throws(()=>f.schedule.preview(legacy));
  assert.throws(()=>f.schedule.configure({...config(rule()),version:3}));
  assert.throws(()=>f.schedule.configure({...legacy,version:1}));
  for(const patch of [{enabled:false},{repeatDays:7},{stageDays:[2,4]}]) {
    f.schedule.configure(config(rule({id:'legacy-default',...patch})));assert.throws(()=>f.schedule.configure(legacy));
  }
});

test('automatic overlapping rules check once and global off or empty rules do not launch',async t=>{
  const f=fixture(t);f.add('dedup');
  f.schedule.configure({...config(rule(),rule({id:'two',mode:'staged'})),enabled:false});f.schedule.tick();assert.deepEqual(f.calls,[]);
  f.schedule.configure(config());f.schedule.tick();assert.deepEqual(f.calls,[]);
  f.schedule.configure(config(rule({enabled:false})));f.schedule.tick();assert.deepEqual(f.calls,[]);
  f.schedule.configure(config(rule(),rule({id:'two',mode:'staged'})));f.schedule.tick();await settled(f.checker);
  assert.deepEqual(f.calls,['dedup']);assert.equal(f.checker.status().total,1);assert.equal(f.schedule.status().due,0);
});

test('disabling individual rules skips remaining queued rows but global off lets active work finish',async t=>{
  for(const global of [false,true]) {
    let release,requests=0;
    const f=fixture(t,{fetcher:async url=>{requests++;if(requests===1)await new Promise(resolve=>{release=resolve;});return new Response(JSON.stringify({login:url.split('/').pop(),type:'User'}));}});
    f.add('first');f.add('second');f.schedule.configure(config(rule()));f.schedule.tick();
    assert.equal(requests,1);f.schedule.configure(global?{...config(rule()),enabled:false}:config(rule({enabled:false})));
    release();await settled(f.checker);assert.equal(requests,global?2:1);assert.equal(f.checker.status().counts.skipped,global?0:2);
  }
});

test('failed staged checks persist retry floor across reopening and cannot manufacture confirmation',async t=>{
  const f=fixture(t,{fetcher:async()=>{throw Error('offline');}});f.add('reopen');f.schedule.configure(config(rule({mode:'staged'})));
  f.schedule.tick();await settled(f.checker);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM check_confirmations').get().count,0);
  const reopened=new Store(f.dir),app=createApp(reopened,f.options);
  try {assert.equal(app.schedule.status().due,0);f.advance(30*60000);assert.equal(app.schedule.status().due,1);}finally{app.schedule.stop();reopened.close();}
});

test('preview shares one clock snapshot so unchecked accounts remain due with an advancing clock',t=>{
  const f=fixture(t);f.add('clock-a');f.add('clock-b');
  let time=Date.parse('2026-10-20T00:00:00+08:00');f.schedule.clock=()=>time++;
  const p=f.schedule.preview(config(rule()));
  assert.equal(p.matched,2);assert.equal(p.due,2);assert.equal(p.rules[0].due,2);
  assert.equal(p.nextDueAt,'2026-10-19T16:00:00.000Z');
});

test('a renamed legacy rule cannot have its name reset by a stale legacy client',t=>{
  const f=fixture(t);f.schedule.configure(config(rule({id:'legacy-default',name:'每日跟踪'})));
  const legacy={enabled:true,intervalDays:7,statuses:['reachable','unchecked'],groupIds:null,tagIds:null};
  assert.throws(()=>f.schedule.configure(legacy));assert.equal(f.schedule.settings().rules[0].name,'每日跟踪');
});
