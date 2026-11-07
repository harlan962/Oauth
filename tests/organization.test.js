import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { createServer } from 'node:http';
import { createApp } from './authenticated-app.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'account-organization-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}
const account = username => ({ username, email: `${username}@example.com`, password: 'fixture-password' });

test('import and creation assign one source group and multiple reusable tags without changing duplicates', t => {
  const store = fixture(t), org = store.organization;
  assert.ok(org, 'organization service must exist');
  const group = org.save('groups', { name: '供应商 A' });
  const tag = org.save('tags', { name: '项目甲', color: 'teal' });
  const a = store.create({ ...account('alpha'), groupId: group.id, tagIds: [tag.id] });
  assert.equal(a.groupId, group.id);
  assert.deepEqual(a.tagIds, [tag.id]);
  const imported = store.import('beta@example.com----secret----beta\nalpha@example.com----secret----alpha', { groupId: group.id, tagIds: [tag.id] });
  assert.equal(imported.imported, 1);
  assert.equal(imported.duplicates, 1);
  assert.equal(store.list().find(a => a.username === 'beta').groupId, group.id);
  assert.equal(org.list().groups[0].count, 2);
  assert.throws(() => store.create({ ...account('bad'), tagIds: ['missing'] }), { status: 404 });
  assert.equal(store.list().length, 2);
});

test('batch assignment is atomic and supports tag add/remove independently of source', t => {
  const store = fixture(t), org = store.organization;
  assert.ok(org);
  const group = org.save('groups', { name: '来源' });
  const tag = org.save('tags', { name: '已用于测试' });
  const a = store.create(account('alpha')), b = store.create(account('beta'));
  assert.throws(() => org.assign([a.id, 'absent'], { groupId: group.id }), { status: 404 });
  assert.equal(store.get(a.id).groupId, null);
  org.assign([a.id, b.id], { groupId: group.id, tagIds: [tag.id], tagMode: 'add' });
  org.assign([a.id], { tagIds: [tag.id], tagMode: 'remove' });
  assert.deepEqual(store.get(a.id).tagIds, []);
  assert.equal(store.get(a.id).groupId, group.id);
  assert.deepEqual(store.get(b.id).tagIds, [tag.id]);
  assert.throws(() => org.assign([a.id], { tagIds: [tag.id], tagMode: 'bogus' }), { status: 400 });
});

test('rename preserves associations; deleting groups and tags preserves accounts and trash restores ungrouped', t => {
  const store = fixture(t), org = store.organization;
  assert.ok(org);
  const group = org.save('groups', { name: '来源' });
  const tag = org.save('tags', { name: '用途' });
  const a = store.create({ ...account('alpha'), groupId: group.id, tagIds: [tag.id] });
  org.save('groups', { name: '新来源' }, group.id);
  assert.equal(store.get(a.id).groupId, group.id);
  assert.throws(() => org.save('groups', { name: ' 新来源 ' }), { status: 409 });
  store.batchTrash([a.id], false);
  assert.equal(org.list().groups[0].count, 0);
  org.delete('groups', group.id);
  org.delete('tags', tag.id);
  store.batchTrash([a.id], true);
  assert.equal(store.get(a.id).groupId, null);
  assert.deepEqual(store.get(a.id).tagIds, []);
  assert.equal(store.secrets(a.id).password, 'fixture-password');
});

test('classification persists across restart and existing accounts keep their credentials and status', t => {
  const directory=mkdtempSync(join(tmpdir(),'organization-reopen-'));
  let store=new Store(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const a=store.create(account('legacy'));
  store.setCheck(a.id,a.username,{status:'missing',message:'fixture'});
  store.close();
  store=new Store(directory);
  assert.equal(store.get(a.id).groupId,null);
  assert.deepEqual(store.get(a.id).tagIds,[]);
  const group=store.organization.save('groups',{name:'持久分组'});
  const tag=store.organization.save('tags',{name:'持久标签'});
  store.organization.assign([a.id],{groupId:group.id,tagIds:[tag.id]});
  store.close();
  store=new Store(directory);
  assert.equal(store.get(a.id).groupId,group.id);
  assert.deepEqual(store.get(a.id).tagIds,[tag.id]);
  assert.equal(store.get(a.id).publicStatus,'missing');
  assert.equal(store.secrets(a.id).password,'fixture-password');
});

test('HTTP organization validates requests, preserves batch atomicity and does not expose credentials',{timeout:20000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'organization-api-'));
  const store=new Store(directory);
  const server=createServer().listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const {app,integrations,workbuddy,pat,checker}=createApp(store,{allowedHosts:[new URL(base).host]});
  server.on('request',app);
  t.after(async()=>{await Promise.all([checker.cancel(),workbuddy.stop(),pat.stop()]);await integrations.stop();await new Promise(r=>server.close(r));store.close();rmSync(directory,{recursive:true,force:true});});
  const request=(path,method='GET',body)=>fetch(base+'/api'+path,{method,headers:{'X-Local-Client':'account-desk','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await fetch(base+'/api/organization')).status,403);
  assert.equal((await request('/organization/groups','POST',{name:' '})).status,400);
  const group=await (await request('/organization/groups','POST',{name:'渠道'})).json();
  assert.equal((await request('/organization/groups','POST',{name:'渠道'})).status,409);
  assert.equal((await request('/organization/tags','POST',{name:'用途',color:'unsafe'})).status,400);
  assert.equal((await request('/import','POST',{text:'alpha@example.com----secret----alpha',groupId:'missing'})).status,404);
  assert.equal(store.list().length,0);
  assert.equal((await request('/import','POST',{text:'alpha@example.com----secret----alpha',groupId:group.id,tagIds:[]})).status,200);
  const rows=await (await request('/accounts')).json();
  assert.equal(rows[0].groupId,group.id);
  assert.equal(rows[0].password,undefined);
  assert.equal((await request('/organization/assign','POST',{ids:[rows[0].id,'missing'],groupId:null})).status,404);
  assert.equal(store.get(rows[0].id).groupId,group.id);
});
