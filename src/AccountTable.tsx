import { useEffect, useRef } from 'react';
import { Folder, ShieldCheck, CircleDashed, RefreshCw, Trash2, RotateCcw, ArrowUpRight } from 'lucide-react';
import { Status } from './components';
import { taskOwner, candidateReason } from './AccountCategories';
import { accountColumns, accountTime, fullAccountTime, type ColumnId } from './account-columns-model';
import type { Account, OrganizationData, Job } from './types';

export function AccountTable({rows,columns,checked,onToggle,onTogglePage,organization,trash,busy,job,sort,onSort,onOpen,onOrganize,onCheck,onTrash,onRestore,onTask,showCandidateReason=false}: {
  rows:Account[]; columns:ColumnId[]; checked:Set<string>; onToggle:(id:string)=>void; onTogglePage:()=>void;
  organization:OrganizationData; trash:boolean; busy:boolean; job:Job; sort:string; onSort:(sort:string)=>void;
  onOpen:(id:string,mode?:'view'|'edit')=>void; onOrganize:(a:Account)=>void; onCheck:(id:string)=>void;
  onTrash:(id:string)=>void; onRestore:(id:string)=>void; onTask:(a:Account)=>void; showCandidateReason?:boolean;
}) {
  const checkbox=useRef<HTMLInputElement>(null);
  const selectedCount=rows.filter(a=>checked.has(a.id)).length;
  useEffect(()=>{if(checkbox.current)checkbox.current.indeterminate=selectedCount>0&&selectedCount<rows.length;},[selectedCount,rows.length]);
  const registry=accountColumns.filter(c=>columns.includes(c.id));
  const groupMap=new Map(organization.groups.map(g=>[g.id,g]));
  const timeCell=(value?:string|null)=><time className="account-time" dateTime={value || undefined} title={`${fullAccountTime(value)}${value?' · 北京时间':''}`}>{accountTime(value)}</time>;
  function cell(a:Account,column:ColumnId) {
    switch(column) {
      case 'identity': return <div className="account-identity"><span className="avatar">{a.username.slice(0,2).toUpperCase()}</span><div>{trash?<strong>{a.username}</strong>:<button className="account-name" onClick={()=>onOpen(a.id)}>{a.username}</button>}<span className="account-email">{a.email}</span>{showCandidateReason && <span className="candidate-reason">{candidateReason(a)}</span>}</div></div>;
      case 'group': return <button className="group-name" disabled={trash} title="整理此账号的分组与标签" onClick={()=>onOrganize(a)}><Folder size={13}/>{groupMap.get(a.groupId || '')?.name || '未分组'}</button>;
      case 'tags': {
        const tags=organization.tags.filter(t=>a.tagIds?.includes(t.id));
        const chip=(t:typeof tags[number])=><span key={t.id} className={`user-tag tag-${t.color || 'blue'}`}>{t.name}</span>;
        return <div className="account-tags standalone-tags">{tags.slice(0,2).map(chip)}{tags.length>2 && <details className="more-tags"><summary aria-label={`展开 ${a.username} 的其余 ${tags.length-2} 个标签`}>+{tags.length-2}</summary><div>{tags.slice(2).map(chip)}</div></details>}{!tags.length && (trash?<span className="no-tags">无标签</span>:<button className="text-button add-tag" onClick={()=>onOrganize(a)}>添加标签</button>)}</div>;
      }
      case 'totp': return <span className={`totp-state ${a.hasTotp?'enabled':''}`} title={a.hasTotp?'已保存 TOTP 密钥，尚不代表密钥有效':'本工具未保存密钥，不等于 GitHub 未开启两步验证'}>{a.hasTotp?<ShieldCheck size={14}/>:<CircleDashed size={14}/>} {a.hasTotp?'已设置':'未设置'}</span>;
      case 'status': return <div className="status-stack"><Status account={a}/></div>;
      case 'createdAt': return timeCell(a.createdAt);
      case 'checkedAt': return timeCell(a.checkedAt);
      case 'selectedAt': return timeCell(a.selectedAt);
      case 'deletedAt': return timeCell(a.deletedAt);
      case 'workbuddyFinishedAt': return timeCell(a.taskSummary?.workbuddyFinishedAt ?? a.workbuddyResult?.finishedAt);
      case 'workbuddyLinkedAt': return timeCell(a.taskSummary?.workbuddyLinkedAt);
      case 'patExpiresAt': return timeCell(a.pat?.expiresAt);
      case 'notes': return !a.notes?<span className="muted">—</span>:a.notes.length<=24
        ?<div className="table-notes table-notes-plain">{a.notes}</div>
        :<details className="table-notes"><summary><span className="table-notes-preview">{a.notes.slice(0,24)}…</span><span className="table-notes-collapse">收起备注</span></summary><p>{a.notes}</p></details>;
      case 'task': {
        const summary=a.taskSummary, owner=taskOwner(a);
        const registrationOnly=summary?.state==='external'&&!summary.workbuddyJobId;
        return <div className="task-cell"><span className={`task-state task-${summary?.state || 'unassigned'}`} title={summary?.message}>{summary?.label || (owner==='pat'?'PAT 专用':owner==='other'?'已分配':'未分配')}</span>{summary?.conflict && <small className="task-conflict">用途存在冲突，请核对</small>}{(owner==='workbuddy'||owner==='pat')&&!trash && <button className="text-button" onClick={()=>registrationOnly?onOpen(a.id):onTask(a)}>{owner==='pat'?'PAT 管理':registrationOnly?'查看登记':'查看任务'}<ArrowUpRight size={12}/></button>}</div>;
      }
      case 'actions': return trash?<button className="text-button" disabled={busy} onClick={()=>onRestore(a.id)}><RotateCcw size={14}/>恢复</button>:<div className="row-tools"><button className="icon-button" disabled={busy||job.running} aria-label={`检查 ${a.username}`} title="检查此账号" onClick={()=>onCheck(a.id)}><RefreshCw size={15} className={job.running&&job.phase!=='waiting'&&job.currentId===a.id?'spin':''}/></button><button className="text-button" onClick={()=>onOpen(a.id)}>详情</button><button className="text-button" onClick={()=>onOpen(a.id,'edit')}>编辑</button><button className="icon-button danger-quiet" disabled={busy} aria-label={`移入回收站 ${a.username}`} title="移入回收站" onClick={()=>onTrash(a.id)}><Trash2 size={14}/></button></div>;
    }
  }
  function sortValue(id:ColumnId) {return id==='createdAt'?(sort==='newest'?'oldest':'newest'):id==='checkedAt'?(sort==='checked-newest'?'checked-oldest':'checked-newest'):sort==='username'?'newest':'username';}
  function direction(id:ColumnId):'ascending'|'descending'|'none' {if(id==='identity')return sort==='username'?'ascending':'none';if(id==='createdAt')return sort==='newest'?'descending':sort==='oldest'?'ascending':'none';if(id==='checkedAt')return sort==='checked-newest'?'descending':sort==='checked-oldest'?'ascending':'none';return 'none';}
  return <div className="table-wrap configurable-table"><table aria-label="账号列表"><thead><tr><th className="check-col"><input ref={checkbox} type="checkbox" aria-label="全选当前页" checked={rows.length>0&&selectedCount===rows.length} onChange={onTogglePage}/></th>{registry.map(c=><th key={c.id} className={c.id==='actions'?'align-right':''} aria-sort={['identity','createdAt','checkedAt'].includes(c.id)?direction(c.id):undefined}>{['identity','createdAt','checkedAt'].includes(c.id)?<button className="sort-button" onClick={()=>onSort(sortValue(c.id))}>{c.label}{direction(c.id)==='ascending'?' ↑':direction(c.id)==='descending'?' ↓':''}</button>:c.label}</th>)}</tr></thead><tbody>{rows.map(a=><tr key={a.id} className={checked.has(a.id)?'row-checked':''}><td className="check-col"><input type="checkbox" aria-label={`勾选 ${a.username}`} checked={checked.has(a.id)} onChange={()=>onToggle(a.id)}/></td>{registry.map(c=><td key={c.id} data-column={c.id} data-label={c.id==='actions'?undefined:c.id==='identity'?'账号':c.label} className={c.id==='actions'?'align-right row-action':''}>{cell(a,c.id)}</td>)}</tr>)}</tbody></table></div>;
}
