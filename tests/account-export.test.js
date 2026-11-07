import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {Store} from '../server/store.js';
import {createApp} from '../server/app.js';
import {parseImport} from '../server/parser.js';

async function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'account-export-'));
  const store=new Store(directory), server=createServer().listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const services=createApp(store,{allowedHosts:[new URL(origin).host],fetcher:async()=>{throw new Error('No external requests');}});
  server.on('request',services.app);
  t.after(async()=>{
    await Promise.all([services.checker.cancel(),services.pat.stop(),services.workbuddy.stop()]);
    await services.integrations.stop();server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));store.close();rmSync(directory,{recursive:true,force:true});
  });
  const call=async(path,body,session,extra={})=>fetch(origin+path,{
    method:'POST',headers:{'X-Local-Client':'account-desk','Content-Type':'application/json',
      ...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrfToken}:{}),...extra},body:JSON.stringify(body),
  });
  const setup=await call('/api/auth/setup',{username:'admin',password:'fixture-admin-password',setupCode:readFileSync(join(directory,'admin-setup-code.txt'),'utf8').trim()});
  const auth=await setup.json(),session={cookie:setup.headers.get('set-cookie').split(';')[0],csrfToken:auth.csrfToken};
  // Export hands out plaintext, so it sits behind a step-up grant. These tests
  // are about the export format, not about the gate itself (that lives in
  // credential-audit.test.js), so obtain one grant up front and reuse it.
  const grant=await (await call('/api/auth/reauth',{password:'fixture-admin-password'},session)).json();
  const authed=(path,body,session2,extra={})=>call(path,body,session2,{...(grant.token?{'X-Reauth-Token':grant.token}:{}),...extra});
  const create=(username,body={})=>store.create({email:`${username}@example.test`,username,password:' fixture password ',totp:'',...body});
  return {store,services,session,call:authed,create};
}

test('export returns exactly the requested accounts in order, deduplicated and import-compatible without data changes',async t=>{
  const f=await fixture(t),a=f.create('alpha',{totp:'JBSWY3DPEHPK3PXP'}),b=f.create('bravo');f.create('excluded');
  const before=f.store.db.prepare('SELECT * FROM accounts ORDER BY id').all();
  const response=await f.call('/api/accounts/export',{ids:[b.id,a.id,b.id]},f.session);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const result=await response.json();
  assert.equal(result.count,2);assert.match(result.filename,/^accounts-\d{8}-\d{6}\.txt$/);
  const parsed=parseImport(result.text);assert.deepEqual(parsed.errors,[]);
  assert.deepEqual(parsed.records.map(({username,password,totp})=>({username,password,totp})),[
    {username:'bravo',password:' fixture password ',totp:''},
    {username:'alpha',password:' fixture password ',totp:'JBSWY3DPEHPK3PXP'},
  ]);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM accounts ORDER BY id').all(),before);
});

test('export refuses empty or malformed scopes rather than falling back to all accounts',async t=>{
  const f=await fixture(t);f.create('alpha');
  for(const body of [{},null,[],{ids:[]},{ids:'all'},{ids:[null]},{ids:['']},{ids:[{}]}]) {
    const response=await f.call('/api/accounts/export',body,f.session);
    assert.equal(response.status,400);assert.equal((await response.json()).text,undefined);
  }
});

test('missing and trashed accounts fail the whole export without returning any credentials',async t=>{
  const f=await fixture(t),a=f.create('alpha'),b=f.create('bravo');f.store.trash(b.id);
  for(const ids of [[a.id,'missing'],[a.id,b.id]]) {
    const response=await f.call('/api/accounts/export',{ids},f.session);
    assert.equal(response.status,409);
    const body=await response.json();assert.equal(body.text,undefined);assert.doesNotMatch(JSON.stringify(body),/fixture password/);
  }
});

test('export never silently corrupts passwords containing TXT delimiters or line breaks',async t=>{
  const f=await fixture(t);
  for(const [i,password] of ['secret----suffix','secret\nsuffix','secret\rsuffix'].entries()) {
    const row=f.create(`special-${i}`,{password});
    const response=await f.call('/api/accounts/export',{ids:[row.id]},f.session);
    assert.equal(response.status,400);
    const body=await response.json();assert.match(body.error,/TXT/);assert.equal(body.text,undefined);assert.ok(!body.error.includes(password));
  }
});

test('export requires administrator login, CSRF and same origin; API keys do not grant export access',async t=>{
  const f=await fixture(t),a=f.create('alpha'),body={ids:[a.id]};
  assert.equal((await f.call('/api/accounts/export',body)).status,401);
  assert.equal((await f.call('/api/accounts/export',body,f.session,{'X-CSRF-Token':''})).status,403);
  assert.equal((await f.call('/api/accounts/export',body,f.session,{Origin:'https://evil.test'})).status,403);
  const key=f.services.access.create({name:'not-an-admin'});
  assert.equal((await f.call('/api/accounts/export',body,null,{Authorization:`Bearer ${key.secret}`})).status,401);
});
