import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,request as httpRequest} from 'node:http';
import {Store} from '../server/store.js';
import {createApp} from '../server/app.js';
import {AdminAuth} from '../server/admin-auth.js';

const password='test-admin-password-123';
async function fixture(t,options={}) {
  const dir=mkdtempSync(join(tmpdir(),'admin-auth-')),store=new Store(dir);
  let time=Date.parse('2026-10-20T00:00:00Z');
  const server=createServer().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const services=createApp(store,{allowedHosts:[new URL(origin).host],authClock:()=>time,...options});server.on('request',services.app);
  t.after(async()=>{await Promise.all([services.checker.cancel(),services.pat.stop(),services.workbuddy.stop()]);await services.integrations.stop();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
  const call=async(path,method='GET',body,session,extra={})=>{
    const res=await fetch(origin+path,{method,headers:{'X-Local-Client':'account-desk',...(body===undefined?{}:{'Content-Type':'application/json'}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrfToken}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
    const value=await res.json();return {status:res.status,body:value,headers:res.headers,cookie:res.headers.get('set-cookie')?.split(';')[0],csrfToken:value.csrfToken};
  };
  return {dir,store,origin,services,call,advance:ms=>time+=ms,setup:()=>call('/api/auth/setup','POST',{username:'admin',password,setupCode:readFileSync(join(dir,'admin-setup-code.txt'),'utf8').trim()})};
}

test('anonymous users and API keys cannot access private data; initialization requires local one-time code',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/api/accounts')).status,401);
  assert.equal((await f.call('/api/access')).status,401);
  assert.equal((await f.call('/api/auth/status')).body.initialized,false);
  assert.equal((await f.call('/api/auth/setup','POST',{username:'admin',password,setupCode:'wrong'})).status,401);
  const s=await f.setup();assert.equal(s.status,201);assert.equal(s.body.authenticated,true);
  assert.ok(s.headers.get('set-cookie').includes('HttpOnly'));assert.ok(s.headers.get('set-cookie').includes('SameSite=Strict'));
  assert.ok(!s.headers.get('set-cookie').includes('Secure'));assert.equal(existsSync(join(f.dir,'admin-setup-code.txt')),false);
  assert.equal((await f.call('/api/accounts','GET',undefined,s)).status,200);
  assert.equal((await f.call('/api/auth/setup','POST',{username:'hijack',password,setupCode:'wrong'})).status,409);
  const k=f.services.access.create({name:'external'});
  assert.equal((await f.call('/api/accounts','GET',undefined,null,{Authorization:`Bearer ${k.secret}`})).status,401);
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM admin_credentials').all()).includes(password));
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM admin_sessions').all()).includes(s.cookie.split('=')[1]));
});

test('writes require session CSRF, logout invalidates server session, and passwords do not bypass origin checks',async t=>{
  const f=await fixture(t),s=await f.setup();assert.equal(s.status,201);
  assert.equal((await f.call('/api/access/keys','POST',{name:'blocked'},s,{'X-CSRF-Token':''})).status,403);
  assert.equal((await f.call('/api/access/keys','POST',{name:'allowed'},s)).status,201);
  assert.equal((await f.call('/api/auth/login','POST',{username:'admin',password},null,{Origin:'https://evil.test'})).status,403);
  assert.equal((await f.call('/api/auth/logout','POST',{},s)).status,200);
  assert.equal((await f.call('/api/accounts','GET',undefined,s)).status,401);
  assert.equal((await f.call('/api/auth/login','POST',{username:'admin',password:'wrong'})).status,401);
  const login=await f.call('/api/auth/login','POST',{username:'admin',password});assert.equal(login.status,200);assert.notEqual(login.cookie,s.cookie);
});

test('changing password revokes every old session and expiry is enforced server-side',async t=>{
  const f=await fixture(t),first=await f.setup();
  const second=await f.call('/api/auth/login','POST',{username:'admin',password});
  const changed=await f.call('/api/auth/password','POST',{currentPassword:password,newPassword:'new-password-456789'},first);
  assert.equal(changed.status,200);
  assert.equal((await f.call('/api/accounts','GET',undefined,first)).status,401);
  assert.equal((await f.call('/api/accounts','GET',undefined,second)).status,401);
  assert.equal((await f.call('/api/accounts','GET',undefined,changed)).status,200);
  assert.equal((await f.call('/api/auth/login','POST',{username:'admin',password})).status,401);
  f.advance(12*3600000+1);assert.equal((await f.call('/api/accounts','GET',undefined,changed)).status,401);
});

test('persistent login throttling bounds password guesses and recovers on the next minute',async t=>{
  const f=await fixture(t);await f.setup();
  let last;for(let i=0;i<11;i++)last=await f.call('/api/auth/login','POST',{username:'admin',password:'wrong'});
  assert.equal(last.status,429);assert.ok(Number(last.headers.get('retry-after'))>0);
  f.advance(61000);assert.equal((await f.call('/api/auth/login','POST',{username:'admin',password})).status,200);
});

test('private in-flight writes cannot commit after logout',async t=>{
  const f=await fixture(t),s=await f.setup(),body=JSON.stringify({name:'must-not-exist'});
  let request;const response=new Promise((resolve,reject)=>{
    request=httpRequest(f.origin+'/api/access/keys',{method:'POST',headers:{'X-Local-Client':'account-desk','Content-Type':'application/json',Cookie:s.cookie,'X-CSRF-Token':s.csrfToken,'Content-Length':Buffer.byteLength(body)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});request.on('error',reject);request.write(body.slice(0,1));
  });t.after(()=>request.destroy());
  await new Promise(r=>setTimeout(r,30));await f.call('/api/auth/logout','POST',{},s);request.end(body.slice(1));
  assert.equal(await response,401);assert.equal(f.services.access.list().length,0);
});

test('HTTPS origin sets a host-only Secure cookie and ignores forged forwarding headers',async t=>{
  const f=await fixture(t,{adminOrigin:'https://www.abc.test'});
  const raw=(path,method='GET',body,headers={})=>new Promise((resolve,reject)=>{
    const req=httpRequest(f.origin+path,{method,headers:{Host:'www.abc.test','X-Local-Client':'account-desk',...(body?{'Content-Type':'application/json'}:{}),...headers}},res=>{let value='';res.on('data',d=>value+=d);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(value),headers:res.headers}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  const setup=await raw('/api/auth/setup','POST',{username:'admin',password,setupCode:readFileSync(join(f.dir,'admin-setup-code.txt'),'utf8').trim()},{Origin:'https://www.abc.test'});
  assert.equal(setup.status,201);const cookie=setup.headers['set-cookie'][0];
  assert.ok(cookie.startsWith('__Host-ad_session='));assert.ok(cookie.includes('Secure'));assert.ok(cookie.includes('HttpOnly'));assert.ok(!cookie.includes('Domain='));
  assert.equal((await raw('/api/accounts','GET',undefined,{Cookie:cookie.split(';')[0]})).status,200);
  assert.equal((await raw('/api/accounts','GET',undefined,{Host:'evil.test','X-Forwarded-Host':'www.abc.test','X-Forwarded-Proto':'https',Cookie:cookie.split(';')[0]})).status,403);
  assert.equal((await raw('/api/accounts','GET',undefined,{Origin:'https://evil.test',Cookie:cookie.split(';')[0]})).status,403);
  assert.equal((await raw('/api/auth/login','POST',{username:'admin',password},{Origin:'http://www.abc.test'})).status,403);
});

test('sessions and throttles survive reconstruction; reset clears administrator sessions but preserves API keys',async t=>{
  const f=await fixture(t),s=await f.setup(),key=f.services.access.create({name:'keep-me'});
  const restarted=new AdminAuth(f.store,{authClock:f.services.auth.clock});
  const req={headers:{cookie:s.cookie,host:new URL(f.origin).host},method:'GET'};
  assert.ok(restarted.session(req));
  for(let i=0;i<9;i++)await f.call('/api/auth/login','POST',{username:'admin',password:'incorrect'});
  const again=new AdminAuth(f.store,{authClock:f.services.auth.clock});assert.throws(()=>again.consumeAttempt(),error=>error.status===429);
  restarted.reset();assert.equal(restarted.session(req),null);assert.equal(restarted.credentials().username,null);
  assert.ok(existsSync(join(f.dir,'admin-setup-code.txt')));assert.equal(f.services.access.get(key.key.id).name,'keep-me');
  assert.equal((await f.setup()).status,201);
});

test('only one initialization wins and a login started with an old password cannot finish after password change',async t=>{
  const f=await fixture(t),code=readFileSync(join(f.dir,'admin-setup-code.txt'),'utf8').trim();
  const results=await Promise.all([1,2].map(()=>f.call('/api/auth/setup','POST',{username:'admin',password,setupCode:code})));
  assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);const session=results.find(r=>r.status===201);
  const derive=f.services.auth.derive.bind(f.services.auth);let release,entered,hold=true;
  const barrier=new Promise(r=>release=r),ready=new Promise(r=>entered=r);
  f.services.auth.derive=async(...args)=>{const result=await derive(...args);if(hold){hold=false;entered();await barrier;}return result;};
  const login=f.call('/api/auth/login','POST',{username:'admin',password});await ready;
  const change=await f.call('/api/auth/password','POST',{currentPassword:password,newPassword:'changed-password-123'},session);
  release();assert.equal(change.status,200);assert.equal((await login).status,401);
});
