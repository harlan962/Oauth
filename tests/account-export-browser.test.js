import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {Store} from '../server/store.js';
import {createApp} from './authenticated-app.js';
import {chromium} from '../server/browser-runtime.js';
import {parseImport} from '../server/parser.js';

test('account export downloads cross-page selections and full combined filters; dialog is accessible on mobile and errors can be retried',{timeout:90000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'export-ui-')),store=new Store(directory);
  const server=createServer().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const services=createApp(store,{allowedHosts:[new URL(origin).host],fetcher:async()=>{throw new Error('No external requests');}});
  server.on('request',services.app);let browser;
  t.after(async()=>{await browser?.close();await Promise.all([services.checker.cancel(),services.pat.stop(),services.workbuddy.stop()]);await services.integrations.stop();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(directory,{recursive:true,force:true});});
  const group=store.organization.save('groups',{name:'导出测试分组'}),other=store.organization.save('groups',{name:'排除分组'});
  const tag=store.organization.save('tags',{name:'交付',color:'teal'});
  for(let i=0;i<32;i++) {
    const username=`export-${String(i).padStart(2,'0')}`;
    const row=store.create({username,email:`${username}@example.test`,password:`fixture-secret-${i}`,totp:'JBSWY3DPEHPK3PXP',groupId:group.id,tagIds:[tag.id]});
    store.setCheck(row.id,username,{status:'reachable',message:'合成结果'});
  }
  store.create({username:'excluded',email:'excluded@example.test',password:'fixture-excluded',totp:'',groupId:other.id});
  const trashed=store.create({username:'trashed',email:'trashed@example.test',password:'fixture-trashed',totp:''});store.trash(trashed.id);
  browser=await chromium.launch({headless:true,executablePath:chromium.executablePath()});
  const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});page.setDefaultTimeout(10000);
  const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));
  // Only successful exports count: the first attempt is answered with 403 and a
  // step-up prompt, and that rejected probe must not shift the assertions below.
  page.on('response',async r=>{if(r.url().endsWith('/api/accounts/export') && r.status()===200){const request=r.request();try{requests.push(request.postDataJSON());}catch{}}});
  await page.goto(origin);
  const table=page.getByRole('table',{name:'账号列表'}),headingExport=page.locator('.heading-actions').getByRole('button',{name:'导出账号',exact:true});
  await table.locator('tbody tr').first().waitFor();
  await page.getByRole('combobox',{name:'账号排序'}).selectOption('username');
  await table.getByRole('checkbox',{name:'勾选 export-00',exact:true}).check();
  await page.getByRole('button',{name:'下一页',exact:true}).click();
  await table.getByRole('checkbox',{name:'勾选 export-31',exact:true}).check();
  await page.getByRole('button',{name:'导出选中',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'导出账号',exact:true});
  assert.equal(await dialog.locator('input[value="selected"]').isChecked(),true);
  assert.equal(await dialog.getByRole('button',{name:'取消',exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button',{name:'导出选中',exact:true}).evaluate(el=>el===document.activeElement),true);
  async function download(button) {
    // Export sits behind a step-up grant: the first attempt opens a "confirm
    // identity" dialog, later attempts within five minutes download directly.
    const pending=page.waitForEvent('download',{timeout:30000});
    await button.click();
    const prompt=page.locator('.reauth-prompt');
    const outcome=await Promise.race([
      pending.then(()=>'download'),
      prompt.waitFor({timeout:15000}).then(()=>'reauth').catch(()=>'timeout'),
    ]);
    if(outcome==='reauth') {
      await prompt.locator('input[type=password]').fill('fixture-password-123');
      await prompt.getByRole('button',{name:'确认',exact:true}).click();
    }
    const file=await pending;
    assert.match(file.suggestedFilename(),/^accounts-\d{8}-\d{6}\.txt$/);
    const stream=await file.createReadStream();let text='';for await(const chunk of stream)text+=chunk.toString('utf8');
    await file.delete();const parsed=parseImport(text);assert.deepEqual(parsed.errors,[]);return parsed.records;
  }
  await headingExport.click();
  await dialog.locator('input[value="filtered"]').check();
  assert.equal(await dialog.getByRole('button',{name:'导出 33 个账号',exact:true}).count(),1);
  await dialog.locator('input[value="selected"]').check();
  const selected=await download(dialog.getByRole('button',{name:'导出 2 个账号',exact:true}));
  assert.deepEqual(selected.map(r=>r.username),['export-00','export-31']);
  assert.deepEqual(selected.map(r=>r.password),['fixture-secret-0','fixture-secret-31']);
  await page.getByRole('combobox',{name:'筛选来源分组'}).selectOption(group.id);
  await page.getByRole('combobox',{name:'筛选用途标签'}).selectOption(tag.id);
  await page.getByRole('combobox',{name:'筛选两步验证'}).selectOption('totp');
  await page.getByRole('combobox',{name:'筛选账号状态'}).selectOption('reachable');
  await page.getByRole('textbox',{name:'搜索账号'}).fill('export-');
  await headingExport.click();assert.equal(await dialog.locator('input[value="selected"]').isDisabled(),true);
  assert.equal(await dialog.locator('input[value="filtered"]').isChecked(),true);
  const output=resolve('output/playwright/account-export');mkdirSync(output,{recursive:true});
  await page.screenshot({path:join(output,'desktop.png'),animations:'disabled'});
  const filtered=await download(dialog.getByRole('button',{name:'导出 32 个账号',exact:true}));
  assert.equal(filtered.length,32);assert.deepEqual(filtered.map(r=>r.username),Array.from({length:32},(_,i)=>`export-${String(i).padStart(2,'0')}`));
  // Both paths must send explicit ID snapshots; pagination never narrows the filtered scope.
  assert.equal(requests[0].ids.length,2);assert.equal(requests[1].ids.length,32);
  await page.getByRole('textbox',{name:'搜索账号'}).fill('nothing-matches');assert.equal(await headingExport.isDisabled(),true);
  await page.getByRole('textbox',{name:'搜索账号'}).fill('export-');
  for(const viewport of [{width:375,height:812},{width:812,height:375}]) {
    await page.setViewportSize(viewport);await page.emulateMedia({reducedMotion:'reduce'});await headingExport.click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.equal(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
    await dialog.getByRole('button',{name:'导出 32 个账号',exact:true}).scrollIntoViewIfNeeded();
    await page.screenshot({path:join(output,`${viewport.width}.png`),animations:'disabled'});await page.keyboard.press('Escape');
  }
  await page.setViewportSize({width:1440,height:1000});
  let unblock;const gate=new Promise(r=>unblock=r);let intercepted=0;
  await page.route('**/api/accounts/export',async route=>{intercepted++;await gate;await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'列表已变化，请关闭弹窗并刷新后重试'})});});
  await headingExport.click();await dialog.getByRole('button',{name:'导出 32 个账号',exact:true}).click();
  await dialog.getByRole('button',{name:'正在导出…',exact:true}).waitFor();
  assert.equal(await dialog.getByRole('button',{name:'正在导出…',exact:true}).isDisabled(),true);
  await page.keyboard.press('Escape');assert.equal(await dialog.isVisible(),true);unblock();
  await dialog.getByRole('alert').getByText('列表已变化，请关闭弹窗并刷新后重试',{exact:true}).waitFor();
  assert.equal(intercepted,1);await page.unroute('**/api/accounts/export');
  assert.equal((await download(dialog.getByRole('button',{name:'导出 32 个账号',exact:true}))).length,32);
  assert.ok(!(await page.evaluate(()=>JSON.stringify({...localStorage,...sessionStorage}))).includes('fixture-secret'));
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:/回收站/}).click();assert.equal(await headingExport.count(),0);
  assert.equal(store.list().length,34);assert.deepEqual(errors,[]);
});
