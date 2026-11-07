import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

async function reserve(){const server=createServer().listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));return server;}
test('production entrypoint starts separate loopback listeners and rejects public admin requests',{timeout:30000},async t=>{
  const dir=mkdtempSync(join(tmpdir(),'api-runtime-'));
  const reservations=await Promise.all([reserve(),reserve()]);const [port,apiPort]=reservations.map(s=>s.address().port);
  await Promise.all(reservations.map(s=>new Promise(r=>s.close(r))));
  const child=spawn(process.execPath,['server/index.js'],{cwd:resolve('.'),env:{...process.env,ACCOUNT_DESK_DATA_DIR:dir,ACCOUNT_DESK_PORT:String(port),ACCOUNT_DESK_API_PORT:String(apiPort),ACCOUNT_DESK_API_ORIGIN:`http://127.0.0.1:${apiPort}`},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const exited=new Promise(r=>child.once('exit',r));
  t.after(async()=>{if(child.exitCode===null){child.kill();await exited;}rmSync(dir,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{
    let output='';const timer=setTimeout(()=>reject(new Error('Server did not become ready')),20000);
    child.stdout.on('data',data=>{output+=data;if(output.includes('账号工作台') && output.includes('对外 API')){clearTimeout(timer);resolve();}});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Server exited: ${code}`));});
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status,200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/access`,{headers:{'X-Local-Client':'account-desk'}})).status,401);
  const setup=await fetch(`http://127.0.0.1:${port}/api/auth/setup`,{method:'POST',headers:{'X-Local-Client':'account-desk','Content-Type':'application/json'},body:JSON.stringify({setupCode:readFileSync(join(dir,'admin-setup-code.txt'),'utf8').trim(),username:'admin',password:'fixture-runtime-password'})});
  assert.equal(setup.status,201);
  const settings=await fetch(`http://127.0.0.1:${port}/api/access`,{headers:{'X-Local-Client':'account-desk',Cookie:setup.headers.get('set-cookie').split(';')[0]}});
  assert.equal(settings.status,200);assert.equal((await settings.json()).baseUrl,`http://127.0.0.1:${apiPort}/api/v1`);
  assert.equal((await fetch(`http://127.0.0.1:${apiPort}/`)).status,404);
  assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/access`,{headers:{'X-Local-Client':'account-desk'}})).status,404);
  assert.equal((await fetch(`http://127.0.0.1:${apiPort}/api/v1/groups`)).status,401);
});
