import { useState } from 'react';
import { Folder, Tags, Plus, Pencil, Trash2, Check, Search } from 'lucide-react';
import { api } from './api';
import { Modal, ConfirmDialog, useDiscardConfirmation } from './components';
import { emptyOrganization, type OrganizationData, type OrganizationItem } from './types';

const colors = { blue: '蓝色', teal: '青色', violet: '紫色', amber: '琥珀', rose: '玫红', slate: '灰色' };
export function OrganizationFields({data = emptyOrganization, groupId, tagIds, onGroup, onTags, disabled = false, batch = false}: {
  data?: OrganizationData; groupId: string; tagIds: string[]; onGroup: (id: string)=>void; onTags:(ids:string[])=>void; disabled?:boolean; batch?:boolean;
}) {
  return <div className="organization-fields">
    <label className="field">来源分组<select aria-label="来源分组" value={groupId} disabled={disabled} onChange={e=>onGroup(e.target.value)}>
      {batch && <option value="keep">保持原分组</option>}<option value="">未分组</option>
      {data.groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}
    </select></label>
    <fieldset className="tag-picker" disabled={disabled}><legend>用途标签 <span className="muted">可多选</span></legend>
      {data.tags.length ? <div className="tag-options">{data.tags.map(tag=><label key={tag.id} className={`tag-option tag-${tag.color || 'blue'} ${tagIds.includes(tag.id)?'chosen':''}`}><input type="checkbox" checked={tagIds.includes(tag.id)} onChange={e=>onTags(e.target.checked ? [...tagIds,tag.id] : tagIds.filter(id=>id!==tag.id))}/>{tag.name}</label>)}</div> : <p className="muted small">暂无用途标签，可先到「标签管理」创建。</p>}
    </fieldset>
  </div>;
}

export function OrganizeDialog({ids,data,onClose,onSaved,initial}: {ids:string[];data:OrganizationData;onClose:()=>void;onSaved:()=>Promise<void>;initial?:{groupId?:string|null;tagIds?:string[]}}) {
  const batch = !initial;
  const [groupId,setGroupId] = useState(initial?.groupId || (batch?'keep':''));
  const [tagIds,setTagIds] = useState(initial?.tagIds || []);
  const [tagMode,setTagMode] = useState(batch?'add':'replace');
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  const dirty = groupId !== (initial?.groupId || (batch?'keep':'')) || JSON.stringify(tagIds)!==JSON.stringify(initial?.tagIds || []);
  const {close,confirmation} = useDiscardConfirmation(dirty,busy,onClose);
  return <><Modal title={batch?`整理 ${ids.length} 个账号`:'整理分组与标签'} subtitle="分组记录账号来源，标签记录账号用途。" onClose={close}>
    <form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try {
      await api('/organization/assign','POST',{ids,...(groupId==='keep'?{}:{groupId:groupId||null}),tagIds,tagMode});
      await onSaved();onClose();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>
      <div className="modal-body">
        {batch && <label className="field">标签操作<select value={tagMode} disabled={busy} onChange={e=>setTagMode(e.target.value)}><option value="add">追加标签（保留已有标签）</option><option value="remove">移除指定标签</option><option value="replace">替换全部标签</option></select></label>}
        {batch && tagMode==='replace' && <p className="inline-warning">将覆盖所选账号的全部用途标签；不选标签则清空。</p>}
        <OrganizationFields data={data} groupId={groupId} tagIds={tagIds} onGroup={setGroupId} onTags={setTagIds} batch={batch} disabled={busy}/>
        {error && <p className="inline-error" role="alert">{error}</p>}
      </div><footer className="modal-footer"><button type="button" className="button" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy || (!dirty && tagMode!=='replace')}><Check size={15}/>{busy?'保存中…':'保存整理'}</button></footer>
    </form></Modal>{confirmation}</>;
}

export function OrganizationManager({kind,data,onChanged,onBrowse}: {kind:'groups'|'tags';data:OrganizationData;onChanged:()=>Promise<void>;onBrowse:(id:string)=>void}) {
  const label = kind==='groups'?'分组':'标签';
  const Icon = kind==='groups'?Folder:Tags;
  const [query,setQuery] = useState('');
  const [editing,setEditing] = useState<OrganizationItem | 'new' | null>(null);
  const [removing,setRemoving] = useState<OrganizationItem | null>(null);
  const [busy,setBusy] = useState(false),[error,setError] = useState('');
  const rows = data[kind].filter(row=>row.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="organization-panel">
    <div className="organization-toolbar"><label className="search-box"><Search size={16}/><input aria-label={`搜索${label}`} placeholder={`搜索${label}名称…`} value={query} onChange={e=>setQuery(e.target.value)}/></label><button className="button primary" onClick={()=>setEditing('new')}><Plus size={16}/>新建{label}</button></div>
    <div className="organization-intro"><Icon size={17}/><span>{kind==='groups'?'每个账号归属一个来源分组。删除分组后，账号会回到未分组。':'每个账号可以拥有多个用途标签。删除标签只移除标记，账号仍然保留。'}</span><span className="organization-total">{data[kind].length} 个{label}</span></div>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {rows.length ? <div className="organization-list">{rows.map(row=><div key={row.id} className="organization-row"><span className={`organization-icon tag-${row.color || 'slate'}`}><Icon size={18}/></span><div className="organization-name"><strong>{row.name}</strong><span>{row.count} 个账号</span></div><button className="text-button" onClick={()=>onBrowse(row.id)}>查看账号</button><button className="icon-button" aria-label={`编辑${label} ${row.name}`} onClick={()=>setEditing(row)}><Pencil size={15}/></button><button className="icon-button danger-quiet" aria-label={`删除${label} ${row.name}`} onClick={()=>setRemoving(row)}><Trash2 size={15}/></button></div>)}</div> : <div className="simple-empty"><Icon size={30}/><h3>{query?'没有匹配的结果':`还没有${label}`}</h3><p>{query?'试试其他名称。':kind==='groups'?'按供应商、来源渠道或导入批次建立分组。':'例如：项目 A、已分配、待交付。'}</p>{!query && <button className="button" onClick={()=>setEditing('new')}><Plus size={16}/>新建{label}</button>}</div>}
    {editing && <OrganizationEditor kind={kind} item={editing==='new'?undefined:editing} onClose={()=>setEditing(null)} onSaved={onChanged}/>}
    {removing && <ConfirmDialog title={`删除${label}「${removing.name}」？`} description={kind==='groups'?`该分组有 ${removing.count} 个在用账号。删除后，包含回收站在内的关联账号均归入未分组，账号资料保留。`:`将移除所有账号上的此标签（含回收站），保留账号及其他标签。`} confirmLabel={busy?'删除中…':`删除${label}`} onCancel={()=>{if(!busy)setRemoving(null);}} onConfirm={async()=>{if(busy)return;setBusy(true);setError('');try{await api(`/organization/${kind}/${removing.id}`,'DELETE');setRemoving(null);await onChanged();}catch(e){setRemoving(null);setError((e as Error).message);}finally{setBusy(false);}}}/>}
  </section>;
}

function OrganizationEditor({kind,item,onClose,onSaved}: {kind:'groups'|'tags';item?:OrganizationItem;onClose:()=>void;onSaved:()=>Promise<void>}) {
  const [name,setName] = useState(item?.name || ''),[color,setColor]=useState(item?.color || 'blue');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const {close,confirmation}=useDiscardConfirmation(name!==(item?.name||'') || color!==(item?.color||'blue'),busy,onClose);
  const label=kind==='groups'?'分组':'标签';
  return <><Modal title={`${item?'编辑':'新建'}${label}`} onClose={close}><form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{await api(`/organization/${kind}${item?`/${item.id}`:''}`,item?'PATCH':'POST',{name,color});await onSaved();onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>
    <div className="modal-body"><label className="field">{label}名称<input data-autofocus required maxLength={40} value={name} disabled={busy} placeholder={kind==='groups'?'例如：供应商 A / 自注册':'例如：项目 A / 已分配'} onChange={e=>setName(e.target.value)}/></label>
      {kind==='tags' && <fieldset className="color-picker" disabled={busy}><legend>标签颜色</legend>{Object.entries(colors).map(([value,label])=><label key={value} className={`tag-${value}`}><input type="radio" name="tag-color" value={value} checked={color===value} onChange={()=>setColor(value)}/>{label}</label>)}</fieldset>}
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div><footer className="modal-footer"><button type="button" className="button" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy || !name.trim()}>{busy?'保存中…':`保存${label}`}</button></footer></form></Modal>{confirmation}</>;
}
