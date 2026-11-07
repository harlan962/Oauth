import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { PatService } from '../server/pat-service.js';
import { createChecker } from '../server/checker.js';

const profile = (username, headers={}) => new Response(JSON.stringify({login:username,type:'User'}),{headers});
async function until(fn) { for(let n=0;n<1500;n++){if(fn())return;await new Promise(r=>setTimeout(r,2));}throw Error('timed out'); }
function fixture(t,random=()=>0) {
  const dir=mkdtempSync(join(tmpdir(),'check-rotation-')),store=new Store(dir);
  let now=Date.now();
  const pat=new PatService(store,{random,clock:()=>now,patBrowser:{assertAvailable(){throw Error('must not provision');}},patFetcher:async()=>{throw Error('must not verify');}});
  const add=name=>store.create({username:name,email:name+'@example.test',password:'synthetic',totp:'JBSWY3DPEHPK3PXP'});
  const records=[];
  for(const name of ['source-a','source-b']) {
    const a=add(name);store.setCheck(a.id,name,{status:'reachable',message:''});
    const p=pat.pats.reserve();pat.pats.saveToken(p.id,'synthetic-'+name,new Date(now+86400000).toISOString());pat.pats.update(p.id,{status:'valid'});pat.pats.complete(p.id);records.push(p);
  }
  pat.configure({enabled:true,targetCount:2,confirmed:true});
  const target=add('target-one'),second=add('target-two');
  let checker;
  t.after(async()=>{await checker?.cancel();await pat.stop();store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,pat,records,target,second,clock:()=>now,advance:ms=>{now+=ms;},checker:(fetcher,wait)=>checker=createChecker(store,fetcher,0,{pat,clock:()=>now,wait})};
}
test('each new credential selection randomizes eligible PAT accounts',async t=>{
  const {pat,records}=fixture(t,()=>0.99);
  assert.equal((await pat.credential()).id,records[1].id);
});
test('independent new check jobs draw again while each batch keeps its chosen PAT',async t=>{
  const samples=[0,0.99,0];let draws=0;
  const f=fixture(t,()=>samples[draws++]);const requests=[];
  const checker=f.checker(async(url,options)=>{
    requests.push(options.headers.Authorization);
    return profile(url.split('/').pop(),{'x-ratelimit-remaining':'100'});
  });
  for(const scope of ['single','all','filtered']) {
    const ids=scope==='single'?[f.target.id]:[f.target.id,f.second.id];
    checker.start(ids,scope);
    await until(()=>!checker.status().running);
    assert.equal(checker.status().done,ids.length);
  }
  assert.equal(draws,3);
  assert.deepEqual(requests,['Bearer synthetic-source-a','Bearer synthetic-source-b','Bearer synthetic-source-b','Bearer synthetic-source-a','Bearer synthetic-source-a']);
});
for(const exhaustedResponse of [200,403,429]) test(`quota exhausted on HTTP ${exhaustedResponse} continues with another PAT without rechecking completed rows`,async t=>{
  const f=fixture(t);const requests=[];
  const checker=f.checker(async(url,options)=>{
    const name=url.split('/').pop(),source=options.headers.Authorization;
    requests.push([name,source]);
    if(requests.length===1){const headers={'x-ratelimit-remaining':'0','x-ratelimit-reset':String(Math.floor(f.clock()/1000)+3600)};return exhaustedResponse===200?profile(name,headers):new Response('{}',{status:exhaustedResponse,headers});}
    return profile(name,{'x-ratelimit-remaining':'50'});
  });
  checker.start([f.target.id,f.second.id]);await until(()=>!checker.status().running || checker.status().phase==='waiting');
  assert.equal(checker.status().done,2);
  assert.equal(requests.length,exhaustedResponse===200?2:3);
  assert.notEqual(requests[0][1],requests[1][1]);
  assert.equal(f.pat.cooldown(),null);
  assert.equal(checker.status().patUsername,'source-b');
  assert.ok(!JSON.stringify(f.pat.pats.getCheckpoint('checks')).includes('synthetic-'));
});
test('Retry-After with zero remaining remains global and does not switch PATs',async t=>{
  const f=fixture(t);let calls=0;
  const checker=f.checker(async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'120','x-ratelimit-remaining':'0','x-ratelimit-reset':String(Math.floor(f.clock()/1000)+60)}});});
  checker.start([f.target.id]);await until(()=>checker.status().phase==='waiting');
  assert.equal(calls,1);assert.ok(f.pat.cooldown());assert.equal(checker.status().done,0);
});
test('all exhausted PATs wait for earliest individual reset, not a global cooldown',async t=>{
  const f=fixture(t);
  for(let i=0;i<2;i++)f.pat.reportResponse(f.records[i].id,new Response('{}',{status:403,headers:{'x-ratelimit-remaining':'0','x-ratelimit-reset':String(Math.floor(f.clock()/1000)+(i+1)*120)}}));
  const credential=await f.pat.credential();
  assert.equal(credential.waitUntil,f.pat.pats.list().find(p=>p.id===f.records[0].id).retryAt);
  assert.equal(f.pat.cooldown(),null);
});
