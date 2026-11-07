import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { Store } from '../server/store.js';
import { createApp } from './authenticated-app.js';
import { ApiAccess } from '../server/api-access.js';
import { apiOrigin } from '../server/public-api.js';

async function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'public-api-'));
  const store=new Store(dir);
  let now=Date.parse('2026-10-20T00:00:00Z');
  const privateServer=createServer().listen(0,'127.0.0.1');
  const publicServer=createServer().listen(0,'127.0.0.1');
  await Promise.all([privateServer,publicServer].map(s=>new Promise(r=>s.once('listening',r))));
  const local=`http://127.0.0.1:${privateServer.address().port}`, external=`http://127.0.0.1:${publicServer.address().port}`;
  const services=createApp(store,{allowedHosts:[new URL(local).host],apiOrigin:external,apiClock:()=>now});
  t.after(async()=>{await Promise.all([services.checker.cancel(),services.pat.stop(),services.workbuddy.stop()]);await services.integrations.stop();await Promise.all([privateServer,publicServer].map(s=>{s.closeAllConnections();return new Promise(r=>s.close(r));}));store.close();rmSync(dir,{recursive:true,force:true});});
  privateServer.on('request',services.app);
  assert.ok(services.publicApp,'API-only HTTP application must exist');
  publicServer.on('request',services.publicApp);
  const request=async(base,path,method='GET',body,headers={})=>{
    if (headers.Host) return new Promise((resolve,reject)=>{
      const req=httpRequest(base+path,{method,headers},res=>{let text='';res.on('data',data=>text+=data);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);req.end();
    });
    const res=await fetch(base+path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:res.status,body:await res.json(),headers:res.headers};
  };
  return {store,services,external,advance:ms=>now+=ms,
    local:(p,m,b,h)=>request(local,p,m,b,{'X-Local-Client':'account-desk',...h}),
    public:(p,m,b,token,h)=>request(external,p,m,b,{...(token?{Authorization:`Bearer ${token}`} :{}),...h})};
}
const account=(username='alice')=>({email:`${username}@example.test`,username,password:'keep-secret',totp:'JBSWY3DPEHPK3PXP'});
async function key(f,body={}){const res=await f.local('/api/access/keys','POST',{name:'测试程序',scopes:['accounts:import','organization:read'],...body});assert.equal(res.status,201);return res.body;}

test('API-only listener never serves private routes, even with local Host or marker; auth fails closed',async t=>{
  const f=await fixture(t), k=await key(f);
  for(const path of ['/','/api/accounts','/api/access','/api/access/keys','/api/accounts/test/secrets']){
    assert.equal((await f.public(path,'GET',undefined,k.secret,{'X-Local-Client':'account-desk'})).status,404);
  }
  assert.equal((await f.public('/api/v1/groups')).status,401);
  assert.equal((await f.public('/api/v1/groups','GET',undefined,'wrong')).status,401);
  assert.equal((await f.public('/api/v1/groups','GET',undefined,k.secret,{Host:'evil.test'})).status,403);
  assert.equal((await f.public('/api/v1/groups','GET',undefined,k.secret,{Origin:'https://evil.test'})).status,403);
  assert.equal((await f.public('/api/v1/groups','GET',undefined,k.secret)).status,200);
  const list=await f.local('/api/access');
  assert.equal(list.body.keys.length,1);
  assert.ok(!JSON.stringify(list.body).includes(k.secret));
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM api_keys').all()).includes(k.secret));
});

test('scopes, expiry, disable and deletion take effect immediately',async t=>{
  const f=await fixture(t), k=await key(f,{scopes:['organization:read'],expiresAt:'2026-10-21T00:00:00Z'});
  assert.equal((await f.public('/api/v1/accounts/import','POST',{accounts:[account()]},k.secret)).status,403);
  await f.local(`/api/access/keys/${k.key.id}`,'PATCH',{enabled:false});
  assert.equal((await f.public('/api/v1/groups','GET',undefined,k.secret)).status,401);
  await f.local(`/api/access/keys/${k.key.id}`,'PATCH',{enabled:true});
  assert.equal((await f.public('/api/v1/tags','GET',undefined,k.secret)).status,200);
  f.advance(86400000);
  assert.equal((await f.public('/api/v1/groups','GET',undefined,k.secret)).status,401);
  const k2=await key(f);await f.local(`/api/access/keys/${k2.key.id}`,'DELETE');
  assert.equal((await f.public('/api/v1/groups','GET',undefined,k2.secret)).status,401);
});

test('batch import preserves secrets, organization, duplicates and row failures without overwriting',async t=>{
  const f=await fixture(t);
  const group=f.store.organization.save('groups',{name:'API 来源'}), tag=f.store.organization.save('tags',{name:'用途'});
  const k=await key(f,{groupId:group.id,tagIds:[tag.id]});
  const res=await f.public('/api/v1/accounts/import','POST',{notes:'导入备注',accounts:[account(),account(),{...account('bob'),email:'invalid'}]},k.secret);
  assert.equal(res.status,200);assert.equal(res.body.imported,1);assert.equal(res.body.duplicates,1);assert.equal(res.body.failed,1);
  assert.deepEqual(res.body.results.map(r=>r.status),['imported','duplicate','failed']);
  assert.ok(!JSON.stringify(res.body).includes('keep-secret'));assert.ok(!JSON.stringify(res.body).includes('JBSW'));
  const row=f.store.list()[0];assert.equal(row.groupId,group.id);assert.deepEqual(row.tagIds,[tag.id]);assert.equal(row.notes,'导入备注');
  assert.equal(f.store.secrets(row.id).password,'keep-secret');
  assert.notEqual(f.store.db.prepare('SELECT password FROM accounts').get().password,'keep-secret');
  f.store.trash(row.id);
  const again=await f.public('/api/v1/accounts/import','POST',{accounts:[{...account(),password:'changed',notes:'changed'}]},k.secret);
  assert.equal(again.body.duplicates,1);assert.equal(f.store.get(row.id,true).notes,'导入备注');assert.ok(f.store.get(row.id,true).deletedAt);
  const text=await f.public('/api/v1/accounts/import','POST',{text:'charlie@example.test----pass----charlie\ninvalid----DO-NOT-LEAK'},k.secret);
  assert.equal(text.body.imported,1);assert.equal(text.body.failed,1);assert.ok(!JSON.stringify(text.body).includes('DO-NOT-LEAK'));
});

test('key-bound organization controls imports, changes affect new accounts only and deleted labels become unassigned',async t=>{
  const f=await fixture(t);
  const group=f.store.organization.save('groups',{name:'来源甲'}),tag=f.store.organization.save('tags',{name:'测试用途'});
  const k=await key(f,{groupId:group.id,tagIds:[tag.id]});
  const first=await f.public('/api/v1/accounts/import','POST',{accounts:[account('first')]},k.secret,{'Idempotency-Key':'key-bound-first'});
  assert.equal(first.body.imported,1);const old=f.store.get(first.body.results[0].id);
  assert.equal(old.groupId,group.id);assert.deepEqual(old.tagIds,[tag.id]);
  assert.equal((await f.public('/api/v1/accounts/import','POST',{accounts:[account('override')],groupId:null},k.secret)).status,400);
  assert.equal((await f.public('/api/v1/accounts/import','POST',{accounts:[{...account('override'),tagIds:[]}]},k.secret)).body.failed,1);
  assert.equal((await f.local(`/api/access/keys/${k.key.id}`,'PATCH',{groupId:null,tagIds:[]})).status,200);
  const second=await f.public('/api/v1/accounts/import','POST',{accounts:[account('second')]},k.secret);
  assert.equal(f.store.get(second.body.results[0].id).groupId,null);assert.deepEqual(f.store.get(second.body.results[0].id).tagIds,[]);
  assert.equal(f.store.get(old.id).groupId,group.id);assert.deepEqual(f.store.get(old.id).tagIds,[tag.id]);
  assert.deepEqual((await f.public('/api/v1/accounts/import','POST',{accounts:[account('first')]},k.secret,{'Idempotency-Key':'key-bound-first'})).body,first.body);
  await f.local(`/api/access/keys/${k.key.id}`,'PATCH',{groupId:group.id,tagIds:[tag.id]});
  f.store.organization.delete('groups',group.id);f.store.organization.delete('tags',tag.id);
  assert.equal(f.services.access.get(k.key.id).groupId,null);assert.deepEqual(f.services.access.get(k.key.id).tagIds,[]);
  const plain=await key(f);assert.equal(plain.key.groupId,null);assert.deepEqual(plain.key.tagIds,[]);
  assert.equal((await f.local('/api/access/keys','POST',{name:'bad',groupId:'missing'})).status,404);
  assert.equal(f.services.access.list().length,2);
});

test('idempotency survives service recreation, rejects different payloads and commits atomically',async t=>{
  const f=await fixture(t),k=await key(f),body={accounts:[account()]},h={'Idempotency-Key':'request-123456'};
  const first=await f.public('/api/v1/accounts/import','POST',body,k.secret,h);
  const restored=new ApiAccess(f.store,{apiClock:f.services.access.clock});
  assert.deepEqual(restored.import(k.key.id,body,'request-123456'),first.body);
  const replay=await f.public('/api/v1/accounts/import','POST',body,k.secret,h);
  assert.deepEqual(replay.body,first.body);assert.equal(f.store.list().length,1);
  assert.equal((await f.public('/api/v1/accounts/import','POST',{accounts:[account('bob')]},k.secret,h)).status,409);
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM api_import_receipts').all()).includes('keep-secret'));
  // A receipt write failure must roll back account creation as well.
  f.store.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON api_import_receipts BEGIN SELECT RAISE(ABORT, 'test fault'); END");
  assert.equal((await f.public('/api/v1/accounts/import','POST',{accounts:[account('charlie')]},k.secret,{'Idempotency-Key':'request-failure'})).status,500);
  assert.equal(f.store.list().length,1);
});

test('per-key rate limit supplies Retry-After and recovers; malformed imports do not create accounts',async t=>{
  const f=await fixture(t),k=await key(f);
  for(const body of [{accounts:[]},{accounts:[account()],text:'x'},{accounts:[account()],groupId:'missing'},{accounts:Array(1001).fill(account())}]){
    assert.ok((await f.public('/api/v1/accounts/import','POST',body,k.secret)).status>=400);
  }
  assert.equal(f.store.list().length,0);
  let res;for(let i=0;i<61;i++)res=await f.public('/api/v1/groups','GET',undefined,k.secret);
  assert.equal(res.status,429);assert.ok(Number(res.headers.get('retry-after'))>0);
  f.advance(61000);assert.equal((await f.public('/api/v1/groups','GET',undefined,k.secret)).status,200);
});

test('invalid metadata, forbidden account fields and bad media are rejected without exposing or storing input',async t=>{
  const f=await fixture(t),k=await key(f);
  for(const body of [{name:''},{name:'test',scopes:[]},{name:'test',scopes:null},{name:'test',scopes:['admin']},{name:'test',enabled:1},{name:'test',expiresAt:'2020-01-01T00:00:00Z'}]){
    assert.equal((await f.local('/api/access/keys','POST',body)).status,400);
  }
  const invalid=await f.public('/api/v1/accounts/import','POST',{accounts:[{...account(),purpose:'workbuddy',publicStatus:'reachable'}]},k.secret);
  assert.equal(invalid.body.failed,1);assert.equal(f.store.list().length,0);
  assert.equal((await f.public('/api/v1/accounts/import','POST',{accounts:[account()]},k.secret,{'Idempotency-Key':'short'})).status,400);
  const raw=async(body,type='application/json')=>fetch(f.external+'/api/v1/accounts/import',{method:'POST',headers:{Authorization:`Bearer ${k.secret}`,'Content-Type':type},body});
  const malformed=await raw('{"password":"DO-NOT-LEAK"');assert.equal(malformed.status,400);assert.ok(!(await malformed.text()).includes('DO-NOT-LEAK'));
  assert.equal((await raw('{}','text/plain')).status,415);
  const large=await raw(JSON.stringify({text:'x'.repeat(2*1024*1024)}));assert.equal(large.status,413);
  assert.equal(f.store.list().length,0);
});

test('receipt capacity is bounded, expiry permits new imports and revoked keys cannot replay',async t=>{
  const f=await fixture(t),k=await key(f);
  const insert=f.store.db.prepare('INSERT INTO api_import_receipts VALUES(?,?,?,?,?)');
  for(let i=0;i<100;i++)insert.run(k.key.id,`prior-${i}`,'fingerprint','{}',f.services.access.clock()+120000);
  const body={accounts:[account()]},headers={'Idempotency-Key':'request-capacity'};
  const full=await f.public('/api/v1/accounts/import','POST',body,k.secret,headers);
  assert.equal(full.status,429);assert.equal(Number(full.headers.get('retry-after')),120);assert.equal(f.store.list().length,0);
  f.advance(121000);
  assert.equal((await f.public('/api/v1/accounts/import','POST',body,k.secret,headers)).body.imported,1);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM api_import_receipts').get().n,1);
  await f.local(`/api/access/keys/${k.key.id}`,'PATCH',{enabled:false});
  assert.equal((await f.public('/api/v1/accounts/import','POST',body,k.secret,headers)).status,401);
  await f.local(`/api/access/keys/${k.key.id}`,'DELETE');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM api_import_receipts').get().n,0);
});

test('configured public origin only permits HTTPS domains or local HTTP origins',()=>{
  assert.equal(apiOrigin('https://api.example.com'),'https://api.example.com');
  assert.equal(apiOrigin(undefined,5900),'http://127.0.0.1:5900');
  for(const value of ['http://api.example.com','https://name:password@api.example.com','https://api.example.com/path','https://api.example.com?token=secret','file:///etc/passwd'])assert.throws(()=>apiOrigin(value));
});

test('in-flight imports recheck revocation, permissions and expiry after the complete body arrives',async t=>{
  const f=await fixture(t);
  for(const action of ['delete','disable','scope','expire']) {
    const k=await key(f,{expiresAt:new Date(f.services.access.clock()+60000).toISOString()});
    const body=JSON.stringify({accounts:[account(action)]});
    let req;
    const response=new Promise((resolve,reject)=>{
      req=httpRequest(f.external+'/api/v1/accounts/import',{method:'POST',headers:{Authorization:`Bearer ${k.secret}`,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
        let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
      });req.on('error',reject);req.write(body.slice(0,1));
    });
    t.after(()=>req.destroy());
    const deadline=Date.now()+3000;
    while(f.services.access.get(k.key.id).requestCount===0 && Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
    assert.equal(f.services.access.get(k.key.id).requestCount,1,'request must pass initial auth before revocation');
    if(action==='delete')await f.local(`/api/access/keys/${k.key.id}`,'DELETE');
    if(action==='disable')await f.local(`/api/access/keys/${k.key.id}`,'PATCH',{enabled:false});
    if(action==='scope')await f.local(`/api/access/keys/${k.key.id}`,'PATCH',{scopes:['organization:read']});
    if(action==='expire')f.advance(60001);
    req.end(body.slice(1));
    assert.equal((await response).status,action==='scope'?403:401,action);
    assert.equal(f.store.list().length,0);
  }
});
