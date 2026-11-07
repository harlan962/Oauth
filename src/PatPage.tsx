import { useEffect, useState } from 'react';
import { ShieldCheck, Plus, Play, Square, ArrowRight, Search } from 'lucide-react';
import { api } from './api';
import { ConfirmDialog, Modal, useDiscardConfirmation } from './components';
import { PatMetadata } from './PatConfig';
import { beijingDate, patLabels, patState, type Account, type PatRecord, type PatStatus } from './types';

type Confirmation = {title:string;description:string;label:string;action:()=>Promise<void>};
function credentialLabel(record:PatRecord) {
  if(record.hasToken===true || record.status==='verifying') return '已加密保存';
  if(record.creationUncertain) return '创建结果待核对';
  return '尚未取得 Token';
}
export function PatPage({status,accounts,onStatus,onAccounts,loading=false}:{status:PatStatus;accounts:Account[];onStatus:(status:PatStatus)=>void;onAccounts:()=>void;loading?:boolean}) {
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [feedback,setFeedback]=useState('');
  const [query,setQuery]=useState('');
  const [filter,setFilter]=useState('all');
  const [confirmation,setConfirmation]=useState<Confirmation|null>(null);
  const [editing,setEditing]=useState<Account|null>(null);
  const active=status.records.find(r=>r.id===status.activeId);
  const maintained=status.records.filter(r=>['valid','cooling','verifying'].includes(r.status) && (!r.expiresAt || Date.parse(r.expiresAt)>Date.now())).length;
  const available=status.records.filter(r=>r.status==='valid' && (!r.expiresAt || Date.parse(r.expiresAt)>Date.now())).length;
  const accountMap=new Map(accounts.map(a=>[a.id,a]));
  const matchesSearch=(a:Pick<Account,'username'|'email'|'notes'>)=>!query.trim() || `${a.username} ${a.email} ${a.notes}`.toLowerCase().includes(query.trim().toLowerCase());
  const records=status.records.filter(r=>{
    const a=accountMap.get(r.accountId);
    return matchesSearch(a || {username:r.username,email:'',notes:''}) && (filter==='all' || (filter==='released'?!a?.patDedicated:r.status===filter));
  });
  const withoutRecord=accounts.filter(a=>a.patDedicated && !a.deletedAt && !status.records.some(r=>r.accountId===a.id) && matchesSearch(a) && filter==='all');
  useEffect(()=>{if(!feedback)return;const timer=setTimeout(()=>setFeedback(''),4000);return()=>clearTimeout(timer);},[feedback]);
  useEffect(()=>{if(!status.running && status.message)setFeedback(status.message);},[status.running,status.message]);
  async function perform(path:string,method='POST',body?:unknown) {
    setBusy(true);setError('');setFeedback('');
    try {onStatus(await api<PatStatus>(path,method,body));setFeedback('操作已保存');}
    catch(e) {setError(`操作未完成：${(e as Error).message}`);}
    finally{setBusy(false);}
  }
  function confirm(title:string,description:string,label:string,action:()=>Promise<void>) {setError('');setConfirmation({title,description,label,action});}
  return <section className="pat-page" aria-label="PAT 管理工作区" aria-busy={busy || loading}>
    <div className="pat-overview">
      <div className="pat-overview-title"><ShieldCheck size={18}/><strong>{status.settings.enabled?'自动补充已开启':'自动补充已关闭'}</strong></div>
      <span className="muted">维护中 {maintained} / {status.settings.targetCount} · 可用 {available}</span>
    </div>
    {status.running && <section className="pat-task is-running" aria-label="PAT 当前任务">
      <div className="pat-task-copy" role="status"><strong>{active?.status==='manual'?'等待浏览器处理':'PAT 任务进行中'}</strong><p>{active?`@${active.username} · ${active.message || status.message}`:status.message}</p></div>
      <div className="pat-actions"><button className="button" disabled={busy || !status.settings.enabled || !active || !['manual','preparing'].includes(active.status)} onClick={()=>confirm('继续 PAT 浏览器？','请先在当前独立浏览器完成人工验证。','确认继续',()=>perform('/pat/resume'))}><Play size={15}/>继续 PAT 浏览器</button><button className="button" disabled={busy} onClick={()=>confirm('停止 PAT 任务？','将关闭当前独立浏览器，保留 PAT 专用用途。','确认停止',()=>perform('/pat/stop'))}><Square size={14}/>停止 PAT 任务</button></div>
    </section>}
    {(error || busy || feedback) && <div className="pat-page-feedback" aria-live="polite">{error?<p className="inline-error" role="alert">{error}</p>:<p>{busy?'处理中…':feedback}</p>}</div>}
    <section className="pat-ledger" aria-labelledby="pat-ledger-title">
      <header className="pat-ledger-head"><h2 id="pat-ledger-title">PAT 账号与记录 <span>{status.records.length}</span></h2><button className="button primary" disabled={busy || loading || !status.settings.enabled || status.running} title={!status.settings.enabled?'请先在 PAT 配置中启用自动补充':undefined} onClick={()=>confirm('新增 PAT？',`将从符合条件的候选账号中补足至 ${status.settings.targetCount} 个，登录 GitHub 创建 30 天、公共资源只读 PAT。`,'确认补充',()=>perform('/pat/start'))}><Plus size={15}/>新增 PAT</button></header>
      <div className="pat-filters"><label className="search-box"><Search size={16}/><input aria-label="搜索 PAT" placeholder="搜索账号、邮箱、备注…" value={query} onChange={e=>setQuery(e.target.value)}/></label><select aria-label="筛选 PAT 状态" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部状态</option>{Object.entries(patLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}<option value="verifying">待验证</option><option value="released">已释放</option></select></div>
      {loading?<div className="simple-empty" role="status">正在读取 PAT 记录…</div>:!records.length?<div className="simple-empty"><ShieldCheck size={28}/><h3>{query || filter!=='all'?'没有匹配的 PAT':'还没有 PAT 记录'}</h3>{!status.records.length && <button className="button" onClick={onAccounts}>前往账号管理<ArrowRight size={15}/></button>}</div>:<div className="pat-record-list">{records.map(record=>{
        const account=accountMap.get(record.accountId),dedicated=!!account?.patDedicated;
        const canDelete=!!account && !account.reservedBy && !record.creationUncertain && !['preparing','verifying'].includes(record.status) && (record.status==='disabled' || !dedicated);
        return <article className="pat-record" key={record.id} aria-label={`PAT 记录 @${record.username}`}>
          <div className="pat-record-main">
            <div className="pat-record-identity"><h3>@{record.username}</h3><span className={`badge pat-${patState(record.status)}`}>{record.status==='verifying'?'已保存 · 待验证':patLabels[patState(record.status)]}</span><span className="muted small">{dedicated?'PAT 专用账号':'历史记录 · 已释放专用用途'}</span></div>
            <dl className="pat-record-metrics"><div><dt>剩余额度 / 实际上限</dt><dd className="pat-quota">{record.remaining ?? '—'}<span> / {record.limit ?? '—'}</span></dd>{record.status==='cooling' && <small>恢复：{beijingDate(record.retryAt || record.resetAt)}</small>}</div><div><dt>到期时间 · 北京时间</dt><dd>{beijingDate(record.expiresAt)}</dd></div></dl>
            <div className="pat-record-actions">
              {account && !account.deletedAt && <button className="text-button" disabled={busy} aria-label={`编辑备注 · @${record.username}`} onClick={()=>setEditing(account)}>编辑备注</button>}
              <button className="text-button" disabled={busy || status.running || record.status==='disabled'} aria-label={`停用 PAT · @${record.username}`} onClick={()=>confirm('停用这个 PAT？','只停用本地凭据，不撤销 GitHub 远端 Token。账号继续保留 PAT 专用用途。','确认停用',()=>perform(`/pat/${record.id}/disable`))}>停用 PAT</button>
              <button className="text-button" disabled={busy || status.running || !dedicated || !!account?.reservedBy || record.creationUncertain || !['invalid','manual','disabled'].includes(record.status)} aria-label={`释放专用用途 · @${record.username}`} onClick={()=>confirm('释放 PAT 专用用途？','将允许该账号重新参与普通选用。仍可能有效或结果未知的凭据会阻止释放。','确认释放',()=>perform(`/pat/${record.id}/release`,'POST',{confirmed:true}))}>释放专用用途</button>
              <button className="text-button danger-quiet" disabled={busy || status.running || !canDelete} aria-label={`删除 PAT · @${record.username}`} title={canDelete?'删除本地记录':'仅可删除已停用或已释放、且无任务占用和未知结果的记录'} onClick={()=>confirm('删除 PAT 记录？',`将永久删除 @${record.username} 的本地 PAT 记录和凭据，账号资料保留。远端 Token 不会撤销；未到期的凭据仍保留专用账号保护。`,'确认删除',()=>perform(`/pat/${record.id}`,'DELETE',{confirmed:true}))}>删除</button>
            </div>
          </div>
          {record.creationUncertain && <p className="pat-uncertain">创建结果待核对：请在 GitHub 确认远端 Token 后处理，系统不会自动重复创建。</p>}
          <details className="pat-record-details"><summary>详情 · {credentialLabel(record)}</summary><PatMetadata record={record}/></details>
        </article>;
      })}</div>}
      {withoutRecord.map(account=><article className="pat-orphan" key={account.id}><div><strong>@{account.username}</strong><span className="muted small">PAT 专用 · 无本地凭据记录</span></div><button className="text-button" disabled={busy || status.running || !!account.reservedBy} onClick={()=>confirm('释放 PAT 专用用途？','仍可能有效的远端 PAT 会阻止释放，已到期的可恢复普通选用。','确认释放',()=>perform(`/pat/accounts/${account.id}/release`,'POST',{confirmed:true}))}>释放专用用途</button></article>)}
    </section>
    {confirmation && <ConfirmDialog title={confirmation.title} description={confirmation.description} confirmLabel={confirmation.label} onCancel={()=>setConfirmation(null)} onConfirm={()=>{const action=confirmation.action;setConfirmation(null);void action();}}/>}
    {editing && <PatNotes account={editing} onClose={()=>setEditing(null)} onSaved={async()=>{onStatus(await api<PatStatus>('/pat'));setFeedback('备注已保存');}}/>}
  </section>;
}

function PatNotes({account,onClose,onSaved}:{account:Account;onClose:()=>void;onSaved:()=>Promise<void>}) {
  const [notes,setNotes]=useState(account.notes),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const discard=useDiscardConfirmation(notes!==account.notes,busy,onClose);
  async function save(){setBusy(true);setError('');try{await api(`/accounts/${account.id}`,'PATCH',{notes});await onSaved();onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  return <><Modal title="编辑 PAT 备注" onClose={discard.close} className="pat-notes-modal"><form onSubmit={e=>{e.preventDefault();if(!busy)void save();}}><div className="modal-body"><label className="field">备注<textarea value={notes} rows={3} maxLength={2000} disabled={busy} onChange={e=>setNotes(e.target.value)}/></label>{error && <p className="inline-error" role="alert">{error}</p>}</div><footer className="modal-footer"><button type="button" className="button" disabled={busy} onClick={discard.close}>取消</button><button className="button primary" disabled={busy || notes===account.notes}>{busy?'保存中…':'保存备注'}</button></footer></form></Modal>{discard.confirmation}</>;
}
