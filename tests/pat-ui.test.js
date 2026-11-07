import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL) for (const ext of ['.tsx', '.ts']) {
      const url = new URL(specifier + ext, context.parentURL); if (existsSync(url)) return next(url.href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (/\.tsx?$/.test(url)) return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText };
    return next(url, context);
  },
});
const types = await import('../src/types.ts');
const base = {id:'a',username:'octo',email:'test@example.test',hasTotp:1,notes:'',publicStatus:'reachable',checkedAt:new Date().toISOString(),selectedAt:null,deletedAt:null,purpose:'',createdAt:'2026-10-19T00:00:00Z',checkMessage:'公开资料可访问'};
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
test('dedicated accounts never qualify for ordinary selection', () => {
  assert.equal(types.eligible({...base,patDedicated:1}),false);
});
test('category counts and PAT substates use the same active account membership', async () => {
  const ui = await import('../src/AccountCategories.tsx').catch(()=>({}));
  assert.equal(typeof ui.categoryCounts,'function');
  const rows = [base,{...base,id:'b',patDedicated:1,pat:{status:'cooling'}},{...base,id:'c',patDedicated:1,pat:{status:'manual'},reservedBy:'pat:c'},{...base,id:'d',workbuddyResult:{status:'failed'}},{...base,id:'e',selectedAt:'2026-10-19'}, {...base,id:'z',deletedAt:'2026-10-19',patDedicated:1,pat:{status:'invalid'}}];
  assert.deepEqual(ui.categoryCounts(rows),{all:5,available:5,invalid:0,unknown:0,workbuddy:0,pat:2,pending:1});
  assert.deepEqual(ui.patStateCounts(rows),{preparing:0,valid:0,cooling:1,invalid:0,manual:1,disabled:0});
  assert.equal(ui.matchesCategory(rows[1],'available'),true);
  const html=render(ui.AccountCategories,{accounts:rows,value:'all',onChange(){}});
  for(const label of ['全部账号','可用','失效','未知','WorkBuddy2api','PAT 专用','任务占用'])assert.ok(html.includes(label));
  assert.equal(ui.matchesCategory(rows[4],'pending'),false,'manual historical selection is not a running task');
});

test('current task ownership is exclusive and released failures stay unassigned',async()=>{
  const ui=await import('../src/AccountCategories.tsx');
  const rows=[{...base,id:'linked',taskSummary:{owner:'workbuddy',state:'linked'},workbuddyResult:{status:'failed'}},{...base,id:'released',workbuddyResult:{status:'failed'}},{...base,id:'unknown',reservedBy:'orphan'},{...base,id:'pat',taskSummary:{owner:'pat',state:'verifying'},patDedicated:1},{...base,id:'trash',deletedAt:'2026-10-19',taskSummary:{owner:'pat'}}];
  assert.deepEqual(ui.categoryCounts(rows),{all:4,available:4,invalid:0,unknown:0,workbuddy:1,pat:1,pending:1});
  assert.equal(ui.taskOwner(rows[1]),'unassigned');
  assert.equal(ui.matchesTaskFilter(rows[0],'workbuddy','linked'),true);
  assert.equal(ui.matchesTaskFilter(rows[3],'pat','verifying'),true);
  assert.equal(ui.matchesTaskFilter(rows[3],'pat','manual'),false);
});

test('public categories distinguish failed detection from unchecked and never imply candidate eligibility',async()=>{
  const ui=await import('../src/AccountCategories.tsx');
  const rows=[{...base,id:'ready'}, {...base,id:'missing',publicStatus:'missing'}, {...base,id:'limited',publicStatus:'limited'}, {...base,id:'error',publicStatus:'error'}, {...base,id:'new',publicStatus:'unchecked'}, {...base,id:'busy',reservedBy:'job',taskSummary:{owner:'workbuddy',state:'running'}}, {...base,id:'linked',selectedAt:'2026-10-19',taskSummary:{owner:'workbuddy',state:'linked'}}, {...base,id:'trash',deletedAt:'2026-10-19'}];
  assert.deepEqual(ui.categoryCounts(rows),{all:7,available:3,invalid:1,unknown:2,workbuddy:2,pat:0,pending:1});
  assert.equal(ui.matchesCategory(rows[4],'unknown'),false);
  assert.equal(ui.matchesCategory(rows[5],'pending'),true);
  assert.equal(types.eligible(rows[5]),false);
  assert.equal(ui.matchesCategory(rows[6],'pending'),false);
});
test('PAT details are read-only safe metadata even when maintenance is disabled', async () => {
  const { AccountDetail }=await import('../src/AccountDetail.tsx');
  const html=render(AccountDetail,{account:{...base,patDedicated:1,pat:{id:'p',accountId:'a',username:'octo',status:'cooling',remaining:0,limit:5000,resetAt:'2026-10-19T12:00:00Z',createdAt:'2026-10-19T00:00:00Z',expiresAt:'2026-11-18T00:00:00Z',message:'等待额度恢复',token:'github_pat_NEVER_RENDER'}},checking:false,onClose(){},onUpdate:async()=>{},onSelect(){},onCheck:async()=>{},onTrash(){},notify(){}});
  for(const label of ['PAT 专用','额度冷却','到期时间','5000','北京时间'])assert.ok(html.includes(label),label);
  assert.doesNotMatch(html,/github_pat_|复制PAT|显示PAT/);
  assert.doesNotMatch(html,/<textarea|<select/);
});
test('waiting progress retains cancellation and Beijing deadline without indefinite animation', async () => {
  const { CheckProgress }=await import('../src/CheckProgress.tsx');
  const job={running:true,phase:'waiting',retryAt:'2026-10-19T12:00:00Z',canResume:true,total:3,done:1,scope:'all',message:'额度冷却',counts:{reachable:1,missing:0,limited:0,error:0,skipped:0}};
  const props={job,busy:false,onCancel(){},onDismiss(){},onResume(){}};
  const html=render(CheckProgress,props);
  assert.match(html,/北京时间.*20:00/);assert.match(html,/取消检查/);assert.doesNotMatch(html,/class="pulse"|继续检查/);
  assert.match(render(CheckProgress,{...props,job:{...job,running:false,phase:'interrupted'}}),/继续检查/);
});
test('configuration contains only replenishment settings and no record management', async () => {
  const ui=await import('../src/PatConfig.tsx').catch(()=>({}));assert.equal(typeof ui.PatConfig,'function');
  const html=render(ui.PatConfig,{status:{settings:{enabled:false,targetCount:1},records:[{id:'p',accountId:'a',username:'octo',status:'valid',createdAt:null,expiresAt:null}],running:false,activeId:null,message:''},accounts:[base],onStatus(){},onClose(){}});
  for(const label of ['PAT 配置','30 天','公共资源只读','1','3','保存配置'])assert.ok(html.includes(label),label);
  assert.doesNotMatch(html,/octo|补充检测账号|继续 PAT 浏览器|停用 PAT|释放专用用途/);
  assert.doesNotMatch(html,/type="password"|github_pat_/);
});

test('dedicated PAT page shows safe records and distinguishes saved credentials from account purpose', async () => {
  const {PatPage}=await import('../src/PatPage.tsx');
  const records=[{id:'p',accountId:'a',username:'octo',status:'verifying',hasToken:true,createdAt:null,expiresAt:null,remaining:4100,limit:5000,message:'已保存，正在验证',token:'github_pat_NEVER_RENDER'}];
  const html=render(PatPage,{status:{settings:{enabled:false,targetCount:2},records,running:false,activeId:null,message:''},accounts:[{...base,patDedicated:1}],onStatus(){},onAccounts(){}});
  for(const label of ['PAT 账号与记录','已保存 · 待验证','4100','5000','到期时间','新增 PAT','筛选 PAT 状态'])assert.ok(html.includes(label),label);
  assert.doesNotMatch(html,/github_pat_NEVER_RENDER/);
});
