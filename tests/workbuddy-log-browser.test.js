import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {Store} from '../server/store.js';
import {createApp} from './authenticated-app.js';
import {chromium} from '../server/browser-runtime.js';

test('cleared WorkBuddy logs survive reload and service restart while new logs and other tasks remain visible',{timeout:45000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'wb-log-persistence-'));
  let store,services,server,port=0,browser;
  async function start(){
    store=new Store(directory);server=createServer().listen(port,'127.0.0.1');
    await new Promise(r=>server.once('listening',r));port=server.address().port;
    services=createApp(store,{allowedHosts:[`127.0.0.1:${port}`]});server.on('request',services.app);
  }
  async function stop(){
    await Promise.all([services.checker.cancel(),services.pat.stop(),services.workbuddy.stop()]);await services.integrations.stop();
    server.closeAllConnections();await new Promise(r=>server.close(r));store.close();
  }
  await start();t.after(async()=>{await browser?.close();await stop();rmSync(directory,{recursive:true,force:true});});
  function job(id,date){store.db.prepare('INSERT INTO workbuddy_jobs(id,requestId,fingerprint,targetId,targetName,baseUrl,total,status,running,createdAt,finishedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,id,id,'target','Fixture','https://example.test',0,'completed',0,date,date);}
  function log(id,message){store.db.prepare('INSERT INTO workbuddy_logs(jobId,createdAt,level,message) VALUES(?,?,?,?)').run(id,new Date().toISOString(),'info',message);}
  job('first','2026-01-01T00:00:00Z');log('first','第一任务旧日志');
  browser=await chromium.launch({headless:true,executablePath:chromium.executablePath()});
  const page=await browser.newPage();page.setDefaultTimeout(8000);
  const consoleLog=page.getByLabel('执行日志',{exact:true});
  async function open(){await page.goto(`http://127.0.0.1:${port}/`);await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:/WorkBuddy2api/i}).click();}
  await open();await consoleLog.getByText('第一任务旧日志',{exact:true}).waitFor();
  await page.getByRole('button',{name:'清空显示',exact:true}).click();
  assert.equal(await consoleLog.getByText('第一任务旧日志',{exact:true}).count(),0);
  await open();await page.getByRole('button',{name:'配置',exact:true}).waitFor();
  await consoleLog.getByText('日志显示已清空',{exact:true}).waitFor();
  await stop();await start();await open();
  await consoleLog.getByText('日志显示已清空',{exact:true}).waitFor();
  log('first','第一任务新增日志');await open();await consoleLog.getByText('第一任务新增日志',{exact:true}).waitFor();
  assert.equal(await consoleLog.getByText('第一任务旧日志',{exact:true}).count(),0);
  job('second','2026-01-02T00:00:00Z');log('second','第二任务日志');
  await open();await consoleLog.getByText('第二任务日志',{exact:true}).waitFor();
  await page.getByRole('button',{name:'清空显示',exact:true}).click();
  store.db.prepare('UPDATE workbuddy_jobs SET createdAt=? WHERE id=?').run('2026-01-03T00:00:00Z','first');
  await open();await consoleLog.getByText('第一任务新增日志',{exact:true}).waitFor();
  assert.equal(await consoleLog.getByText('第一任务旧日志',{exact:true}).count(),0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workbuddy_logs').get().n,3);
});
