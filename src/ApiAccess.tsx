import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, KeyRound, Plus, Pencil, Trash2, RefreshCw, Code2 } from 'lucide-react';
import { api } from './api';
import { Modal, ConfirmDialog, useDiscardConfirmation } from './components';
import { OrganizationFields } from './Organization';
import type { OrganizationData } from './types';

type Scope = 'accounts:import' | 'organization:read';
type AccessKey = { id:string; name:string; prefix:string; scopes:Scope[]; enabled:boolean; status:'active'|'expired'|'disabled'; expiresAt:string|null; createdAt:string; lastUsedAt:string|null; requestCount:number; groupId:string|null; tagIds:string[] };
type AccessData = { keys:AccessKey[]; baseUrl:string; rateLimit:number };
type NewKey = {key:AccessKey;secret:string};
const scopeNames:Record<Scope,string>={'accounts:import':'导入账号','organization:read':'读取分组与标签'};
const statusNames={active:'可用',expired:'已过期',disabled:'已停用'};
const date=(value:string|null)=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):'从未使用';

export function ApiAccess({notify,organization}:{notify:(message:string)=>void;organization:OrganizationData}) {
  const [data,setData]=useState<AccessData|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [editing,setEditing]=useState<AccessKey|'new'|null>(null),[created,setCreated]=useState<NewKey|null>(null),[removing,setRemoving]=useState<AccessKey|null>(null);
  const generation=useRef(0),mounted=useRef(true),mutation=useRef(false);
  const load=useCallback(async()=>{
    const version=++generation.current;
    try {const value=await api<AccessData>('/access');if(mounted.current && version===generation.current){setData(value);setError('');}}
    catch(e){if(mounted.current && version===generation.current)setError((e as Error).message);}
  },[]);
  useEffect(()=>{mounted.current=true;void load();const timer=setInterval(()=>{if(!document.hidden && !mutation.current)void load();},15000);return()=>{mounted.current=false;generation.current++;clearInterval(timer);};},[load]);
  function install(key:AccessKey) {
    generation.current++;
    setData(value=>value?{...value,keys:value.keys.some(row=>row.id===key.id)?value.keys.map(row=>row.id===key.id?key:row):[key,...value.keys]}:value);
  }
  async function change(row:AccessKey,remove=false) {
    if(mutation.current)return;
    mutation.current=true;setBusy(true);setError('');generation.current++;
    try {
      if(remove){await api(`/access/keys/${row.id}`,'DELETE');generation.current++;setData(value=>value?{...value,keys:value.keys.filter(key=>key.id!==row.id)}:value);setRemoving(null);notify('密钥已删除');}
      else {install(await api<AccessKey>(`/access/keys/${row.id}`,'PATCH',{enabled:!row.enabled}));notify(row.enabled?'密钥已停用':'密钥已启用');}
    }catch(e){setRemoving(null);setError((e as Error).message);}finally{mutation.current=false;setBusy(false);}
  }
  return <div className="api-access-page">
    <section className="api-key-panel" aria-label="API 密钥管理">
      <div className="api-toolbar"><div><KeyRound size={18}/><h2>访问密钥</h2><span className="muted">{data?.keys.length ?? '—'} / 100</span></div><div><button className="icon-button" aria-label="刷新密钥" disabled={busy} onClick={()=>void load()}><RefreshCw size={16}/></button><button className="button primary" disabled={!data || busy} onClick={()=>setEditing('new')}><Plus size={16}/>创建密钥</button></div></div>
      {error && <p role="alert" className="inline-error api-panel-error">{error}<button className="text-button" onClick={()=>void load()}>重试</button></p>}
      {!data?<p className="api-empty" role="status">正在加载密钥…</p>:!data.keys.length?<div className="api-empty"><KeyRound size={28}/><h3>还没有 API 密钥</h3><p>为调用程序创建一把密钥，即可导入账号。</p></div>:<div className="api-key-table-wrap"><table className="api-key-table" aria-label="API 密钥列表"><thead><tr><th>名称 / 密钥</th><th>导入归属</th><th>权限</th><th>状态</th><th>有效期</th><th>最近调用 / 次数</th><th className="align-right">操作</th></tr></thead><tbody>{data.keys.map(row=><tr key={row.id}>
        <td data-label="名称"><strong>{row.name}</strong><code className="api-key-prefix">{row.prefix}…</code></td>
        <td data-label="导入归属"><span>{organization.groups.find(group=>group.id===row.groupId)?.name || '未分组'}</span><div className="api-bound-tags">{row.tagIds.length?organization.tags.filter(tag=>row.tagIds.includes(tag.id)).map(tag=><span key={tag.id} className={`user-tag tag-${tag.color || 'blue'}`}>{tag.name}</span>):<span className="muted">无标签</span>}</div></td>
        <td data-label="权限"><div className="api-permissions">{row.scopes.map(scope=><span key={scope}>{scopeNames[scope]}</span>)}</div></td>
        <td data-label="状态"><span className={`api-key-status ${row.status}`}>{statusNames[row.status]}</span></td>
        <td data-label="有效期"><span className="api-date" title="北京时间">{row.expiresAt?date(row.expiresAt):'长期有效'}</span></td>
        <td data-label="最近调用"><span className="api-date" title="北京时间">{date(row.lastUsedAt)}</span><span className="api-count">{row.requestCount} 次</span></td>
        <td data-label="操作"><div className="api-row-actions"><button className="icon-button" aria-label={`编辑 ${row.name}`} disabled={busy} onClick={()=>setEditing(row)}><Pencil size={15}/></button><button className="text-button" disabled={busy || (!row.enabled && row.expiresAt!==null && Date.parse(row.expiresAt)<=Date.now())} onClick={()=>void change(row)}>{row.enabled?'停用':'启用'}</button><button className="icon-button danger-quiet" aria-label={`删除 ${row.name}`} disabled={busy} onClick={()=>setRemoving(row)}><Trash2 size={15}/></button></div></td>
      </tr>)}</tbody></table></div>}
    </section>
    {data && <ApiDocs baseUrl={data.baseUrl} notify={notify}/>}
    {editing && <KeyEditor organization={organization} item={editing==='new'?undefined:editing} onClose={()=>setEditing(null)} onSaved={result=>{install(result.key);setEditing(null);if(result.secret)setCreated(result);else notify('密钥已更新');}}/>}
    {created && <SecretDialog value={created} onClose={()=>setCreated(null)}/>}
    {removing && <ConfirmDialog title={`删除密钥「${removing.name}」？`} description="使用此密钥的程序将立即失去访问权限，账号数据不受影响。" confirmLabel={busy?'删除中…':'删除密钥'} onCancel={()=>{if(!busy)setRemoving(null);}} onConfirm={()=>void change(removing,true)}/>}
  </div>;
}

function KeyEditor({item,organization,onClose,onSaved}:{item?:AccessKey;organization:OrganizationData;onClose:()=>void;onSaved:(result:NewKey)=>void}) {
  const [name,setName]=useState(item?.name || ''),[scopes,setScopes]=useState<Scope[]>(item?.scopes || ['accounts:import','organization:read']);
  const initialExpiry=item?.expiresAt?'keep':'never';
  const [expiry,setExpiry]=useState(initialExpiry),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [groupId,setGroupId]=useState(item?.groupId || ''),[tagIds,setTagIds]=useState<string[]>(item?.tagIds || []);
  const pending=useRef(false);
  const dirty=name!==(item?.name || '') || expiry!==initialExpiry || groupId!==(item?.groupId || '') || JSON.stringify(tagIds)!==JSON.stringify(item?.tagIds || []) || JSON.stringify(scopes)!==JSON.stringify(item?.scopes || ['accounts:import','organization:read']);
  const {close,confirmation}=useDiscardConfirmation(dirty,busy,onClose);
  return <><Modal title={item?'编辑 API 密钥':'创建 API 密钥'} className="api-key-editor" onClose={close}><form onSubmit={async event=>{
    event.preventDefault();if(pending.current)return;pending.current=true;setBusy(true);setError('');
    try {
      const expiresAt=expiry==='keep'?undefined:expiry==='never'?null:new Date(Date.now()+Number(expiry)*86400000).toISOString();
      const body={name,scopes,groupId:groupId || null,tagIds,...(expiresAt===undefined?{}:{expiresAt})};
      if(item){const key=await api<AccessKey>(`/access/keys/${item.id}`,'PATCH',body);onSaved({key,secret:''});}
      else onSaved(await api<NewKey>('/access/keys','POST',body));
    }catch(e){setError((e as Error).message);}finally{pending.current=false;setBusy(false);}
  }}><div className="modal-body">
    <label className="field">密钥名称<input data-autofocus required maxLength={60} value={name} disabled={busy} placeholder="例如：注册工具 / 服务器脚本" onChange={e=>setName(e.target.value)}/></label>
    <fieldset className="api-scope-fields" disabled={busy}><legend>接口权限</legend>{(Object.keys(scopeNames) as Scope[]).map(scope=><label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={e=>setScopes(e.target.checked?[...scopes,scope]:scopes.filter(value=>value!==scope))}/>{scopeNames[scope]}</label>)}</fieldset>
    <label className="field">有效期<select value={expiry} disabled={busy} onChange={e=>setExpiry(e.target.value)}>{item?.expiresAt && <option value="keep">保持当前：{date(item.expiresAt)}</option>}<option value="never">长期有效</option>{[7,30,90,365].map(days=><option key={days} value={String(days)}>{days} 天</option>)}</select></label>
    <div className="api-binding-fields"><OrganizationFields data={organization} groupId={groupId} tagIds={tagIds} onGroup={setGroupId} onTags={setTagIds} disabled={busy}/><p className="api-docs-note">通过此密钥新导入的账号将自动归入所选分组和标签。</p></div>
    {error && <p role="alert" className="inline-error">{error}</p>}
  </div><footer className="modal-footer"><button type="button" className="button" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy || !name.trim() || !scopes.length}>{busy?'保存中…':item?'保存修改':'创建密钥'}</button></footer></form></Modal>{confirmation}</>;
}

function SecretDialog({value,onClose}:{value:NewKey;onClose:()=>void}) {
  const [copied,setCopied]=useState(false),[error,setError]=useState('');
  return <Modal title="保存 API 密钥" className="api-key-editor" onClose={onClose}><div className="modal-body"><p className="api-secret-note">完整密钥仅显示这一次，请保存到调用程序中。</p><label className="field">完整密钥<input readOnly autoComplete="off" spellCheck={false} value={value.secret} onFocus={e=>e.target.select()}/></label>{error && <p role="alert" className="inline-error">{error}</p>}</div><footer className="modal-footer"><button className="button" onClick={async()=>{try{await navigator.clipboard.writeText(value.secret);setCopied(true);setError('');}catch{setError('复制失败，请选中完整密钥手动复制。');}}}><Copy size={15}/>{copied?'已复制':'复制密钥'}</button><button className="button primary" onClick={onClose}>完成</button></footer></Modal>;
}

function ApiDocs({baseUrl,notify}:{baseUrl:string;notify:(message:string)=>void}) {
  const [format,setFormat]=useState('json');
  const body=format==='json'?{accounts:[{email:'alice@example.com',username:'alice',password:'账号密码',totp:'',notes:'来自注册工具'}]}:{text:'alice@example.com----账号密码----alice',notes:'来自注册工具'};
  const example=`curl '${baseUrl}/accounts/import' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: import-20261020-001' \\\n  --data '${JSON.stringify(body,null,2)}'`;
  async function copy(value:string) {try{await navigator.clipboard.writeText(value);notify('已复制');}catch{notify('复制失败，请手动选择并复制。');}}
  return <details className="api-docs"><summary><Code2 size={18}/><span>调用文档</span><span className="muted">导入账号 · 分组 · 标签</span></summary><div className="api-docs-body">
    <div className="api-endpoint"><span>接口地址</span><code>{baseUrl}</code><button className="icon-button" aria-label="复制接口地址" onClick={()=>void copy(baseUrl)}><Copy size={15}/></button></div>
    <p className="api-docs-note">在后端程序中使用 <code>Authorization: Bearer YOUR_API_KEY</code>。每把密钥每分钟最多 60 次；时间均为北京时间。</p>
    <div className="api-endpoint-list"><div><b>POST</b><code>/accounts/import</code><span>导入账号</span></div><div><b>GET</b><code>/groups</code><span>分组 ID 与名称</span></div><div><b>GET</b><code>/tags</code><span>标签 ID、名称与颜色</span></div></div>
    <div className="api-example-heading"><label>请求格式 <select aria-label="请求格式" value={format} onChange={e=>setFormat(e.target.value)}><option value="json">JSON 账号数组</option><option value="text">现有文本格式</option></select></label><button className="text-button" onClick={()=>void copy(example)}><Copy size={14}/>复制请求示例</button></div>
    <pre tabIndex={0}>{example}</pre>
    <dl className="api-parameter-list"><div><dt>accounts / text</dt><dd>二选一；单个账号也放在数组中，每次最多 1000 个。文本格式：邮箱----密码----用户名----TOTP 密钥（最后一项可省略）。</dd></div><div><dt>分组与标签</dt><dd>由密钥配置自动决定，请求不传 groupId 或 tagIds。不配置时为未分组、无标签；修改密钥归属只影响以后新导入的账号。</dd></div><div><dt>重复与失败</dt><dd>重复账号直接跳过（含回收站），不覆盖资料。返回 imported、duplicates、failed 与逐条 results；部分失败不会阻止其他有效账号导入。</dd></div><div><dt>安全重试</dt><dd>同一次导入重试时保持 Idempotency-Key 和请求内容不变，新一批使用新编号。结果保留 24 小时，每把密钥最多保留 100 次请求结果。</dd></div></dl>
    <details className="api-docs-more"><summary>响应与错误码</summary><pre>{JSON.stringify({imported:1,duplicates:0,failed:0,results:[{line:1,status:'imported',id:'账号ID'}]},null,2)}</pre><p>200：读取成功或导入处理完成（请检查 failed）。400：参数错误；401：密钥失效；403：权限或来源不允许；404：不存在；409：请求编号冲突；413：超过 2 MB；415：不是 JSON；429：达到限额；500：服务错误。</p><p>429 请遵循 Retry-After，幂等收据容量已满时需等已有结果过期。响应不会返回密码或 TOTP 密钥。</p></details>
    <details className="api-docs-more"><summary>服务器部署</summary><p>同域名部署：ACCOUNT_DESK_ADMIN_ORIGIN 与 ACCOUNT_DESK_API_ORIGIN 均设置为 HTTPS 域名。/api/v1/* 代理到 4319，其余请求代理到 4318，后台需管理员登录。</p><p>配置见 docs/admin-auth.md、deploy/Caddyfile.full。仅公开 API 可使用 deploy/Caddyfile.api。两端口均保持本机监听；调用密钥保存在调用方后端。</p></details>
  </div></details>;
}
