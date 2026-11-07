// One explicitly requested diagnostic run for the last restricted job.
// Never save credentials, cookies, authorization URLs, response bodies or headers.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { decrypt, totpCode } from '../server/crypto.js';
import { OAuthBrowser, trustedOrigin } from '../server/oauth-browser.js';
import { chromium } from '../server/browser-runtime.js';

const jobId = process.argv[2];
const position = Number(process.argv[3] || 1);
if (!jobId) throw new Error('A specific existing job ID is required');
if (!Number.isInteger(position) || position < 1) throw new Error('Invalid item position');
const db = new DatabaseSync(resolve('data/accounts.sqlite'), {readOnly:true});
const item = db.prepare('SELECT i.*,j.targetId,j.running FROM workbuddy_items i JOIN workbuddy_jobs j ON j.id=i.jobId WHERE j.id=? AND i.position=?').get(jobId,position);
if (!item || item.running) throw new Error('Stop the existing job first');
const account = db.prepare('SELECT id,username,email,password,totp FROM accounts WHERE id=? AND deletedAt IS NULL AND reservedBy IS NULL').get(item.accountId);
if (!account) { db.close(); throw new Error('Account is deleted, missing or reserved'); }
const target = db.prepare('SELECT * FROM integration_targets WHERE id=?').get(item.targetId);
const key = readFileSync(resolve('data/master.key'));
db.close();
const directory = resolve('output/playwright/workbuddy-diagnostic');
mkdirSync(directory,{recursive:true});
const commandFile = resolve(directory,'command.json');
if (existsSync(commandFile)) unlinkSync(commandFile);
const trace = [];
const pending = new Set();
const safeURL = value => { try {const u=new URL(value); return u.origin+u.pathname;} catch {return 'invalid';} };
function log(event) { trace.push({at:new Date().toISOString(),...event}); writeFileSync(resolve(directory,'network.json'),JSON.stringify(trace,null,2)); }
const browser = new OAuthBrowser({chromium:{
  executablePath:()=>chromium.executablePath(),
  async launch(options) {
    const engine=await chromium.launch(options);
    return {close:()=>engine.close(),async newContext(options) {
      const context=await engine.newContext(options);
      context.on('response', response=>{
        const task=(async()=>{
          const req=response.request(), type=req.resourceType();
          if (!['document','xhr','fetch'].includes(type)) return;
          const entry={kind:'response',method:req.method(),url:safeURL(response.url()),status:response.status()};
          if (entry.url==='https://github.com/login/oauth/authorize' && response.status()===200) {
            const html=await response.text();
            const tags=(pattern)=>[...html.matchAll(pattern)].map(m=>m[0]);
            entry.consent={
              userMeta:tags(/<meta\b[^>]*name=["']user-login["'][^>]*>/gi).map(tag=>({present:true,matches:tag.includes('content="'+account.username+'"')})),
              identityText:tags(/Verify your GitHub identity[^<\n]{0,150}/gi),
              forms:tags(/<form\b[^>]*>/gi).map(tag=>tag.replace(/action=(["'])(.*?)\1/gi,(_,q,v)=>'action='+q+safeURL(new URL(v,'https://github.com').href)+q)),
              buttons:tags(/<button\b[^>]*>[\s\S]*?<\/button>/gi).map(tag=>tag.replace(/\bvalue=(["'])(.*?)\1/gi,'value="[omitted]"')).filter(tag=>/authorize|cancel|oauth/i.test(tag)).map(tag=>tag.slice(0,2000)),
            };
          }
          if (trustedOrigin(response.url())==='workbuddy' && /json/i.test(response.headers()['content-type']||'')) {
            try {const data=await response.json(); entry.codes={}; for(const field of ['code','errCode','errorCode','status','ret']) if(typeof data?.[field]==='number' || /^\d{1,8}$/.test(String(data?.[field]))) entry.codes[field]=data[field];} catch {}
          }
          log(entry);
        })(); pending.add(task); task.finally(()=>pending.delete(task));
      });
      context.on('requestfailed',request=>log({kind:'failed',url:safeURL(request.url()),error:request.failure()?.errorText}));
      return context;
    }};
  }
}});
let session;
async function snapshot() {
  const page=session.context.pages().filter(p=>!p.isClosed()).at(-1);
  const frames=[];
  for(const frame of page.frames()) {
    const text=await frame.locator('body').innerText({timeout:3000}).catch(()=> 'unavailable');
    frames.push({url:safeURL(frame.url()),text:text.slice(0,12000).replaceAll(account.username,'[account]').replaceAll(account.email,'[email]')});
  }
  const state={url:safeURL(page.url()),frames,flow:!!session.flow,identity:!!session.identityEvidence,callback:session.callbackVerified};
  if(trustedOrigin(page.url())==='github' && new URL(page.url()).pathname==='/login/oauth/authorize') {
    state.controls=await page.evaluate(()=>({
      userMeta:document.querySelector('meta[name="user-login"]')?.getAttribute('content')?'present':'missing',
      forms:[...document.forms].map(f=>({id:f.id,method:f.method,action:new URL(f.action).origin+new URL(f.action).pathname,queryKeys:[...new URL(f.action).searchParams.keys()],fields:[...f.elements].map(e=>({tag:e.tagName,type:e.type,name:e.name,id:e.id,disabled:e.disabled,...(['submit','button'].includes(e.type)?{text:e.textContent?.trim()}: {})}))})),
      identityElements:[...document.querySelectorAll('p,li,h2,h3')].filter(e=>/^Verify your GitHub identity/.test(e.textContent.trim())).map(e=>({tag:e.tagName,id:e.id,classes:e.className,text:e.textContent.trim()}))
    }));
  }
  writeFileSync(resolve(directory,'page.json'),JSON.stringify(state,null,2));
  if(trustedOrigin(page.url())==='workbuddy' || new URL(page.url()).pathname==='/login/oauth/authorize') await page.screenshot({path:resolve(directory,'page.png')});
  console.log(JSON.stringify(state));
}
try {
  const response=await fetch(target.baseUrl+'/panel/api/login/start',{method:'POST',redirect:'manual',headers:{Authorization:'Bearer '+decrypt(target.apiKey,key),'Content-Type':'application/json'},body:JSON.stringify({realm:'global'}),signal:AbortSignal.timeout(15000)});
  log({kind:'start',status:response.status});
  if(!response.ok) throw new Error('login/start failed');
  const data=await response.json();
  if(data.ok!==true || data.realm!=='global' || trustedOrigin(data.url)!=='workbuddy') throw new Error('Invalid authorization response');
  session=await browser.open({url:data.url,account:{id:account.id,username:account.username,email:account.email},proxy:target.browserProxy?JSON.parse(decrypt(target.browserProxy,key)):null,getSecrets:()=>{const totp=decrypt(account.totp,key);return {password:decrypt(account.password,key),otp:totp?totpCode(totp):null};}});
  let result=await session.step();
  console.log(JSON.stringify({result:{status:result.status,reason:result.reason}}));
  await snapshot();
  const deadline=Date.now()+240000;
  while(Date.now()<deadline && result.status!=='verified' && result.status!=='restricted') {
    if(existsSync(commandFile)) {
      const command=JSON.parse(readFileSync(commandFile,'utf8'));unlinkSync(commandFile);
      if(command.action==='stop')break;
      if(command.action==='step') {result=await session.step();console.log(JSON.stringify({result:{status:result.status,reason:result.reason}}));}
      await snapshot();
    }
    await new Promise(r=>setTimeout(r,500));
  }
  log({kind:'result',status:result.status,reason:result.reason});
} catch(error) { console.log(JSON.stringify({error:error.name,message:error.message.replace(/https?:\/\/\S+/g,'[url]'),code:error.cause?.code,stack:error.stack?.split('\n').filter(line=>line.includes('diagnose-workbuddy-once.mjs')).join('\n')}));process.exitCode=1; }
finally {await session?.close();await Promise.allSettled([...pending]);console.log('Diagnostic stopped; browser closed.');}
