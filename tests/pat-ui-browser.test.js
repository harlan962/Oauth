import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { chromium } from '../server/browser-runtime.js';

// Deliberately serves only staged assets and synthetic public API projections.
// No Store, application server, real accounts or external network are used.
const staged=resolve('output/pat-build');
const artifacts=resolve('output/playwright/pat-ui');
async function fixture(t,viewport,reducedMotion='no-preference',{idle=false,enabled=false}={}) {
  assert.ok(existsSync(resolve(staged,'index.html')),'Build staged assets first: cmd /c npm run build -- --outDir output/pat-build');
  mkdirSync(artifacts,{recursive:true});
  const now=new Date().toISOString();
  const rows=Array.from({length:8},(_,i)=>({id:String(i),username:`synthetic${i}`,email:`synthetic${i}@example.test`,hasTotp:1,notes:'合成验证账号',publicStatus:'reachable',checkMessage:'公开资料可访问',checkedAt:now,selectedAt:null,reservedBy:null,patDedicated:i<7?1:0,purpose:'',createdAt:now,deletedAt:null}));
  const states=['preparing','valid','cooling','invalid','manual','verifying','disabled'];
  const records=states.map((status,i)=>({hasToken:['valid','cooling','verifying'].includes(status),id:`p${i}`,accountId:String(i),username:rows[i].username,status,message:status==='cooling'?'等待额度恢复':'合成状态说明',createdAt:now,expiresAt:'2099-11-18T00:00:00Z',remaining:status==='cooling'?0:4000,limit:5000,resetAt:'2099-10-19T12:00:00Z',retryAt:null,creationUncertain:false}));
  const state={settings:{enabled,targetCount:1},records,running:false,activeId:null,message:'合成数据：等待操作'};
  const job={running:!idle,phase:idle?'idle':'waiting',retryAt:'2099-10-19T12:00:00Z',canResume:!idle,total:8,done:1,current:'synthetic7',currentId:'7',message:idle?'':'额度冷却，等待恢复',scope:'all',cancelled:false,counts:{reachable:1,missing:0,limited:0,error:0,skipped:0}};
  const writes=[];let activeReads=0,maxReads=0;const failures=new Set();
  let heldPatRead=null,patReadCount=0;
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture');
    if(url.pathname.startsWith('/api/')) {
      res.setHeader('Content-Type','application/json');
      let body='';for await(const chunk of req)body+=chunk;
      const method=req.method,path=url.pathname.slice(4);
      if(path==='/auth/status'){res.end(JSON.stringify({initialized:true,authenticated:true,username:'fixture-admin',csrfToken:'synthetic-csrf'}));return;}
      if(method!=='GET')writes.push({path,body:body?JSON.parse(body):null});
      if(failures.delete(path)){res.writeHead(409).end(JSON.stringify({error:'合成限制：账号仍被占用'}));return;}
      if(path==='/pat/config')state.settings=JSON.parse(body);
      if(path==='/pat/start'){state.running=true;state.activeId='p4';rows[4].reservedBy='pat:p4';}
      if(path==='/pat/resume'){records[4].status='valid';state.running=false;state.activeId=null;rows[4].reservedBy=null;}
      if(path==='/pat/stop'){state.running=false;state.activeId=null;rows[4].reservedBy=null;if(records[4].status==='preparing')records[4].status='manual';}
      if(path.endsWith('/disable'))records.find(r=>r.id===path.split('/')[2]).status='disabled';
      if(path.endsWith('/release'))rows[Number(records.find(r=>r.id===path.split('/')[2]).accountId)].patDedicated=0;
      if(path==='/checks/cancel'){job.running=false;job.phase='interrupted';job.message='检查已取消，进度已保留';}
      if(path==='/checks/resume'){job.running=true;job.phase='waiting';job.message='额度冷却，等待恢复';}
      if(path==='/checks'&&method==='POST'){job.running=true;job.phase='checking';job.message='正在检查';job.retryAt=null;job.canResume=false;}
      if(path==='/pat' && method==='GET'){
        patReadCount++;activeReads++;maxReads=Math.max(maxReads,activeReads);
        if(heldPatRead){const hold=heldPatRead;heldPatRead=null;const snapshot=JSON.stringify(state);hold.started();await hold.pending;activeReads--;res.end(snapshot);return;}
        await new Promise(r=>setTimeout(r,35));activeReads--;
      }
      const result=path==='/organization'?{groups:[],tags:[]}:path==='/accounts'?rows.map(a=>({...a,pat:records.find(r=>r.accountId===a.id)})):path==='/events'?[]:path.startsWith('/checks')?job:state;
      res.end(JSON.stringify(result));return;
    }
    const file=resolve(staged,'.'+(url.pathname==='/'?'/index.html':url.pathname));
    if(!file.startsWith(staged+sep)){res.writeHead(403).end();return;}
    try{const bytes=await readFile(file);res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(file)]||'application/octet-stream');res.end(bytes);}catch{res.writeHead(404).end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let browser;
  t.after(async()=>{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:chromium.executablePath()});
  const context=await browser.newContext({viewport,reducedMotion});
  await context.route('**/*',route=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'PAT 管理',exact:true}).waitFor();
  await page.getByRole('button',{name:'synthetic0',exact:true}).waitFor();
  return {page,writes,state,records,job,errors,maxReads:()=>maxReads,failures,patReads:()=>patReadCount,holdNextPatRead(){let started,release;const began=new Promise(r=>started=r),pending=new Promise(r=>release=r);heldPatRead={started,pending};return{began,release};}};
}
async function noOverflow(page) {
  const result=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>({width:d.clientWidth,scroll:d.scrollWidth}))}));
  assert.ok(result.scroll<=result.width,JSON.stringify(result));
  for(const d of result.dialogs)assert.ok(d.scroll<=d.width,JSON.stringify(result));
}
for(const mutation of ['resume','start','cancel'])test(`staged pre-write shared read cannot overwrite successful checker ${mutation}`,async t=>{
  const {page,job,holdNextPatRead,patReads,maxReads,errors}=await fixture(t,{width:1280,height:900},'reduce',{idle:mutation!=='cancel'});
  if(mutation==='resume'){
    job.phase='interrupted';job.canResume=true;job.message='检查已中断';
    await page.getByRole('button',{name:'回收站',exact:true}).click();
    await page.getByRole('button',{name:/账号管理/}).click();
    await page.getByRole('button',{name:'继续检查',exact:true}).waitFor();
  }
  await page.waitForLoadState("networkidle");
  const baseline=patReads();const held=holdNextPatRead();t.after(()=>held.release());
  const captured=page.waitForResponse(r=>r.url().endsWith('/api/checks')&&r.request().method()==='GET');
  await page.getByRole('button',{name:'回收站',exact:true}).click();await Promise.all([held.began,captured]);
  await page.getByRole('button',{name:/账号管理/}).click();
  const wanted=mutation==='cancel'?'继续检查':'取消检查';
  await page.getByRole('button',{name:mutation==='start'?/检查全部/:mutation==='resume'?'继续检查':'取消检查',exact:mutation!=='start'}).click();
  await page.getByRole('button',{name:wanted,exact:true}).waitFor();
  assert.equal(job.running,mutation!=='cancel');
  const released=page.waitForResponse(r=>r.url().endsWith('/api/pat')&&r.request().method()==='GET');held.release();await released;
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await page.getByRole('button',{name:wanted,exact:true}).count(),1,'old shared snapshot must not replace the successful write');
  assert.equal(await page.getByRole('button',{name:mutation==='cancel'?'取消检查':'继续检查',exact:true}).count(),0);
  assert.ok(patReads()>=baseline+2,'every successful job write requires a genuinely fresh GET');
  if(mutation!=='cancel'){
    const freshReads=patReads();
    await page.waitForResponse(r=>r.url().endsWith('/api/pat')&&r.request().method()==='GET');
    await page.waitForTimeout(1600);
    assert.ok(patReads()>freshReads,'running checker must continue polling');
    assert.equal(await page.getByRole('button',{name:'取消检查',exact:true}).count(),1);
  }
  assert.equal(maxReads(),1);assert.deepEqual(errors,[]);
});
async function openPat(page) {
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'PAT 管理',exact:true}).click();
  const panel=page.getByRole('region',{name:'PAT 管理工作区'});await panel.waitFor();return panel;
}
async function openConfig(page) {
  await page.getByRole('button',{name:'PAT 配置',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'PAT 配置',exact:true});await dialog.waitFor();return dialog;
}
async function confirm(page,label) {await page.getByRole('alertdialog').getByRole('button',{name:label,exact:true}).click();}

test('PAT is a dedicated menu with records, settings only configuration and guarded record actions',async t=>{
  const {page,writes,errors,maxReads}=await fixture(t,{width:1440,height:1080});
  const categories=page.getByRole('group',{name:'账号分类',exact:true});
  assert.equal(await categories.getByRole('button').count(),7);
  await categories.getByRole('button',{name:/PAT 专用/}).click();
  await page.getByRole('combobox',{name:'任务状态筛选'}).selectOption('cooling');
  assert.equal(await page.locator('tbody tr').count(),1);
  await page.getByRole('button',{name:'详情',exact:true}).click();
  await page.getByRole('dialog',{name:'账号详情'}).waitFor();
  assert.match(await page.getByRole('dialog',{name:'账号详情'}).innerText(),/到期时间[\s\S]*侧栏「PAT 管理」/);
  await page.keyboard.press('Escape');
  const panel=await openPat(page);
  assert.equal(await panel.locator('.pat-record').count(),7);
  assert.match(await panel.innerText(),/PAT 账号与记录[\s\S]*剩余额度 \/ 实际上限/);
  assert.match(await panel.getByRole('article',{name:'PAT 记录 @synthetic5',exact:true}).innerText(),/已保存 · 待验证/);
  assert.match(await panel.getByRole('article',{name:'PAT 记录 @synthetic0',exact:true}).innerText(),/尚未取得 Token/);
  await noOverflow(page);await page.screenshot({path:resolve(artifacts,'desktop-pat-page.png'),fullPage:true,animations:'disabled'});
  const dialog=await openConfig(page);
  assert.equal(await dialog.locator('.pat-record').count(),0);
  assert.equal(await dialog.getByRole('button',{name:'新增 PAT',exact:true}).count(),0);
  assert.equal(await dialog.getByRole('spinbutton').count(),1);
  await page.screenshot({path:resolve(artifacts,'desktop-config.png'),fullPage:true,animations:'disabled'});
  await dialog.getByRole('checkbox',{name:'启用 PAT 自动补充'}).check();
  await dialog.getByRole('button',{name:'保存配置',exact:true}).click();
  assert.match(await page.getByRole('alertdialog').innerText(),/GitHub[\s\S]*公共资源只读[\s\S]*30 天/);
  await confirm(page,'取消');assert.equal(writes.length,0);
  await dialog.getByRole('button',{name:'保存配置',exact:true}).click();await confirm(page,'确认保存');
  await dialog.waitFor({state:'detached'});
  assert.deepEqual(writes[0],{path:'/pat/config',body:{enabled:true,targetCount:1,confirmed:true}});
  await page.keyboard.press('Escape');
  await panel.getByRole('button',{name:'新增 PAT',exact:true}).click();await page.keyboard.press('Escape');assert.equal(writes.length,1);
  await panel.getByRole('button',{name:'新增 PAT',exact:true}).click();await confirm(page,'确认补充');
  await panel.getByRole('button',{name:'继续 PAT 浏览器',exact:true}).click();await confirm(page,'确认继续');
  await panel.getByRole('button',{name:'新增 PAT',exact:true}).waitFor();
  assert.ok(writes.some(w=>w.path==='/pat/resume'));assert.ok(!writes.some(w=>w.path==='/checks/resume'));
  await panel.getByRole('button',{name:'停用 PAT · @synthetic1',exact:true}).click();await confirm(page,'取消');
  assert.ok(!writes.some(w=>w.path==='/pat/p1/disable'));
  await panel.getByRole('button',{name:'停用 PAT · @synthetic1',exact:true}).click();await confirm(page,'确认停用');
  await panel.getByRole('article',{name:'PAT 记录 @synthetic1',exact:true}).getByText('已停用',{exact:true}).waitFor();
  await panel.getByRole('button',{name:'释放专用用途 · @synthetic3',exact:true}).click();await confirm(page,'确认释放');
  await panel.getByText('历史记录 · 已释放专用用途',{exact:true}).waitFor();
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:/账号管理/}).click();
  await page.getByRole('button',{name:'取消检查',exact:true}).click();await page.getByRole('button',{name:'继续检查',exact:true}).click();
  await page.getByRole('button',{name:'取消检查',exact:true}).waitFor();
  assert.ok(writes.some(w=>w.path==='/checks/resume'));assert.equal(maxReads(),1);assert.deepEqual(errors,[]);
});

test('375px PAT navigation and list fit viewport; configuration traps focus and restores it on Escape',async t=>{
  const {page,writes,errors}=await fixture(t,{width:375,height:900},'reduce');
  await noOverflow(page);
  const nav=page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'PAT 管理',exact:true});
  await nav.focus();await page.keyboard.press('Enter');
  const panel=page.getByRole('region',{name:'PAT 管理工作区'});await panel.waitFor();
  await noOverflow(page);await page.screenshot({path:resolve(artifacts,'mobile-pat-page.png'),fullPage:true,animations:'disabled'});
  const trigger=page.getByRole('button',{name:'PAT 配置',exact:true});await trigger.focus();await page.keyboard.press('Enter');
  const dialog=page.getByRole('dialog',{name:'PAT 配置',exact:true});await dialog.waitFor();
  assert.equal(await dialog.evaluate(d=>getComputedStyle(d).animationName),'none');
  for(let i=0;i<12;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.closest('dialog')!==null),true);}
  await dialog.getByRole('checkbox',{name:'启用 PAT 自动补充'}).check();
  await dialog.getByRole('button',{name:'保存配置',exact:true}).click();
  const confirmation=page.getByRole('alertdialog');await confirmation.waitFor();
  assert.equal(await confirmation.getByRole('button',{name:'取消',exact:true}).evaluate(b=>b===document.activeElement),true);
  await noOverflow(page);await page.screenshot({path:resolve(artifacts,'mobile-confirmation.png'),fullPage:true,animations:'disabled'});
  await page.keyboard.press('Escape');assert.equal(writes.length,0);
  assert.equal(await dialog.getByRole('button',{name:'保存配置',exact:true}).evaluate(b=>b===document.activeElement),true);
  await page.keyboard.press('Escape');await confirm(page,'放弃修改');
  assert.equal(await page.getByRole('dialog',{name:'PAT 配置',exact:true}).count(),0);
  assert.equal(await trigger.evaluate(b=>b===document.activeElement),true);assert.deepEqual(errors,[]);
});

test('PAT actions preserve failures, confirm stop and global disable while retaining records',async t=>{
  const {page,writes,failures,state}=await fixture(t,{width:1280,height:900},'reduce',{enabled:true});
  const panel=await openPat(page);
  await panel.getByRole('button',{name:'新增 PAT',exact:true}).click();await confirm(page,'确认补充');
  await panel.getByRole('button',{name:'停止 PAT 任务',exact:true}).click();await page.keyboard.press('Escape');assert.ok(!writes.some(w=>w.path==='/pat/stop'));
  await panel.getByRole('button',{name:'停止 PAT 任务',exact:true}).click();await confirm(page,'确认停止');
  await panel.getByRole('button',{name:'新增 PAT',exact:true}).waitFor();
  failures.add('/pat/p1/disable');
  await panel.getByRole('button',{name:'停用 PAT · @synthetic1',exact:true}).click();await confirm(page,'确认停用');
  await panel.getByRole('alert').waitFor();assert.match(await panel.getByRole('alert').innerText(),/操作未完成/);
  assert.equal(await panel.getByRole('button',{name:'停用 PAT · @synthetic1',exact:true}).isEnabled(),true);
  const dialog=await openConfig(page);
  await dialog.getByRole('checkbox',{name:'启用 PAT 自动补充'}).uncheck();
  await dialog.getByRole('button',{name:'保存配置',exact:true}).click();await confirm(page,'取消');assert.equal(state.settings.enabled,true);
  await dialog.getByRole('button',{name:'保存配置',exact:true}).click();await confirm(page,'确认保存');
  await dialog.waitFor({state:'detached'});
  await panel.getByText('自动补充已关闭',{exact:true}).waitFor();assert.equal(await panel.locator('.pat-record').count(),7);await noOverflow(page);
});

for(const initiallyEnabled of [false,true])test(`old read cannot revert confirmed ${initiallyEnabled?'disable':'enable'} from PAT configuration`,async t=>{
  const {page,state,holdNextPatRead,patReads}=await fixture(t,{width:1280,height:900},'reduce',{idle:true,enabled:initiallyEnabled});
  await openPat(page);
  // Ensure the navigation read is complete before deliberately holding the next one.
  await page.waitForResponse(r=>r.url().endsWith('/api/pat')&&r.request().method()==='GET');
  const baseline=patReads(),held=holdNextPatRead();t.after(()=>held.release());
  await page.getByRole('button',{name:'回收站',exact:true}).click();await held.began;
  await openPat(page);const dialog=await openConfig(page);
  await dialog.getByRole('checkbox',{name:'启用 PAT 自动补充'}).setChecked(!initiallyEnabled);
  await dialog.getByRole('spinbutton',{name:'有效 PAT 目标数量'}).fill('5');
  await dialog.getByRole('button',{name:'保存配置',exact:true}).click();await confirm(page,'确认保存');
  await dialog.waitFor({state:'detached'});assert.equal(state.settings.enabled,!initiallyEnabled);
  const completed=page.waitForResponse(r=>r.url().endsWith('/api/pat')&&r.request().method()==='GET');held.release();await completed;
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await openConfig(page);
  assert.equal(await dialog.getByRole('checkbox',{name:'启用 PAT 自动补充'}).isChecked(),!initiallyEnabled);
  assert.equal(await dialog.getByRole('spinbutton',{name:'有效 PAT 目标数量'}).inputValue(),'5');
  assert.ok(patReads()>=baseline+2,'a post-mutation GET must follow the discarded snapshot');
});
for(const stopStatus of ['manual','disabled'])test(`stopped ${stopStatus} record permits confirmed release and preserves backend refusal`,async t=>{
  const {page,records,state,failures,writes}=await fixture(t,{width:1280,height:900},'reduce',{idle:true,enabled:true});
  records[4].status='preparing';records[4].expiresAt=null;records[4].remaining=null;records[4].limit=null;
  const panel=await openPat(page);
  await panel.getByRole('button',{name:'新增 PAT',exact:true}).click();await confirm(page,'确认补充');
  await panel.getByRole('button',{name:'停止 PAT 任务',exact:true}).click();await confirm(page,'确认停止');
  await panel.getByRole('button',{name:'新增 PAT',exact:true}).waitFor();
  assert.equal(state.running,false);assert.equal(records[4].status,'manual');
  if(stopStatus==='disabled'){await panel.getByRole('button',{name:'停用 PAT · @synthetic4',exact:true}).click();await confirm(page,'确认停用');await panel.getByRole('article',{name:'PAT 记录 @synthetic4',exact:true}).getByText('已停用',{exact:true}).waitFor();}
  const release=panel.getByRole('button',{name:'释放专用用途 · @synthetic4',exact:true});
  await page.waitForFunction(()=>[...document.querySelectorAll('.pat-page button')].some(b=>b.getAttribute('aria-label')==='释放专用用途 · @synthetic4'&&!b.disabled));
  await release.click();await confirm(page,'取消');assert.ok(!writes.some(w=>w.path==='/pat/p4/release'));
  failures.add('/pat/p4/release');await release.click();await confirm(page,'确认释放');await panel.getByRole('alert').waitFor();
  assert.equal(await release.isEnabled(),true);assert.equal(await panel.getByText('历史记录 · 已释放专用用途',{exact:true}).count(),0);
  await release.click();await confirm(page,'确认释放');await panel.getByText('历史记录 · 已释放专用用途',{exact:true}).waitFor();
  assert.equal(await release.isDisabled(),true);
});

test('uncertain record blocks release and empty page directs users to account management',async t=>{
  const {page,records}=await fixture(t,{width:375,height:900},'reduce',{idle:true,enabled:true});
  records[4].creationUncertain=true;
  const panel=await openPat(page);
  await panel.getByText(/创建结果待核对：/).waitFor();
  assert.equal(await panel.getByRole('button',{name:'释放专用用途 · @synthetic4',exact:true}).isDisabled(),true);
  records.splice(0);
  await panel.getByText('还没有 PAT 记录',{exact:true}).waitFor();
  await noOverflow(page);
  await panel.getByRole('button',{name:'前往账号管理',exact:true}).click();await page.getByRole('group',{name:'账号分类',exact:true}).waitFor();
});

test('completed check notice expires without returning on refresh; interrupted checks remain actionable',async t=>{
  const {page,job,errors}=await fixture(t,{width:1280,height:900},'reduce',{idle:true});
  const reloadAccounts=async()=>{await page.getByRole('button',{name:'回收站',exact:true}).click();await page.getByRole('button',{name:/账号管理/}).click();};
  Object.assign(job,{running:false,phase:'idle',canResume:false,total:1,done:1,message:'检查完成'});
  await reloadAccounts();
  const progress=page.getByRole('region',{name:'活性检查进度'});
  await progress.waitFor();
  await progress.waitFor({state:'detached',timeout:8000});
  await reloadAccounts();
  await page.getByRole('table',{name:'账号列表'}).waitFor();
  assert.equal(await progress.count(),0,'a fresh server read must not resurrect dismissed completion');
  Object.assign(job,{running:true,phase:'checking',canResume:false,total:2,done:0,message:'正在检查公开资料'});
  await reloadAccounts();await progress.waitFor();
  Object.assign(job,{running:false,phase:'idle',canResume:false,total:2,done:2,message:'检查完成'});
  await progress.getByText('检查完成',{exact:true}).waitFor();
  await progress.waitFor({state:'detached',timeout:8000});
  Object.assign(job,{running:false,phase:'interrupted',canResume:true,total:3,done:1,message:'检查已中断'});
  await reloadAccounts();await progress.getByRole('button',{name:'继续检查',exact:true}).waitFor();
  await page.waitForTimeout(5500);
  assert.equal(await progress.getByRole('button',{name:'继续检查',exact:true}).isVisible(),true);
  assert.deepEqual(errors,[]);
});
