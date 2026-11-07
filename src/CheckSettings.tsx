import { useEffect, useMemo, useState } from 'react';
import { Clock3, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from './api';
import { Modal, useDiscardConfirmation } from './components';
import { beijingDate, type CheckRule, type CheckSettingsData, type CheckSettingsPreview, type CheckStatus, type Job, type OrganizationData, type OrganizationItem } from './types';

const statuses: {value: CheckStatus; label: string}[] = [
  {value:'reachable',label:'可用'}, {value:'missing',label:'失效'},
  {value:'unknown',label:'未知'}, {value:'unchecked',label:'未检测'},
];
const toggle = (values: string[], value: string) => values.includes(value) ? values.filter(item=>item!==value) : [...values,value];
type RuleDraft = Omit<CheckRule,'intervalDays'|'stageDays'|'repeatDays'> & {intervalDays:string;stageDays:string;repeatDays:string};
type SettingsDraft = {version:2;enabled:boolean;rules:RuleDraft[]};
const toDraft=(settings:CheckSettingsData):SettingsDraft=>({...settings,rules:settings.rules.map(rule=>({...rule,intervalDays:String(rule.intervalDays),stageDays:rule.stageDays.join(', '),repeatDays:String(rule.repeatDays)}))});
const daysValid=(value:string)=>/^\d+$/.test(value) && Number(value)>=1 && Number(value)<=365;
const parseStages=(value:string)=>value.split(/[,，\s]+/).filter(Boolean).map(Number);
function ruleError(rule:RuleDraft) {
  if(!rule.name.trim() || rule.name.trim().length>40)return {field:'check-rule-name',message:'规则名称需为 1–40 个字符。'};
  if(!daysValid(rule.intervalDays))return {field:'check-interval',message:'请输入 1–365 的整数天数。'};
  const tokens=rule.stageDays.trim().split(/[,，\s]+/).filter(Boolean);
  const days=parseStages(rule.stageDays);
  if(!tokens.length || tokens.length>30 || tokens.some(value=>!daysValid(value)) || days.some((day,i)=>i>0 && day<=days[i-1]))return {field:'check-stages',message:'阶段需为 1–365 的整数，按从小到大填写，不重复，最多 30 个。'};
  if(!daysValid(rule.repeatDays))return {field:'check-repeat',message:'后续间隔需为 1–365 的整数天数。'};
  if(rule.baseline==='date' || rule.baselineDate!==null) {
    const value=rule.baselineDate || '';
    const time=Date.parse(`${value}T00:00:00Z`);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0,4))<2000 || Number(value.slice(0,4))>9998 || !Number.isFinite(time) || new Date(time).toISOString().slice(0,10)!==value)return {field:'check-baseline-date',message:'请选择有效的起始日期（2000–9998 年）。'};
  }
  if(!rule.statuses.length)return {field:'check-status-reachable',message:'至少选择一种检测状态。'};
  return null;
}
export function CheckSettings({organization,checking,onClose,onSaved,onJob}:{
  organization: OrganizationData; checking: boolean; onClose:()=>void;
  onSaved:(result:CheckSettingsPreview)=>void; onJob:(job:Job)=>void;
}) {
  const [settings,setSettings]=useState<SettingsDraft|null>(null);
  const [selectedId,setSelectedId]=useState('');
  const [saved,setSaved]=useState('');
  const [busy,setBusy]=useState<'save'|'check'|null>(null);
  const [loadError,setLoadError]=useState('');
  const [loadVersion,setLoadVersion]=useState(0);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [previewError,setPreviewError]=useState('');
  const [preview,setPreview]=useState<{key:string;data:CheckSettingsPreview}|null>(null);
  const draft=useMemo<CheckSettingsData|null>(()=>settings ? {...settings,rules:settings.rules.map(rule=>({...rule,name:rule.name.trim(),intervalDays:Number(rule.intervalDays),stageDays:parseStages(rule.stageDays),repeatDays:Number(rule.repeatDays)}))} : null,[settings]);
  const draftKey=JSON.stringify(draft);
  const dirty=!!settings && JSON.stringify(settings)!==saved;
  const rule=settings?.rules.find(item=>item.id===selectedId);
  const invalidRule=settings?.rules.find(item=>ruleError(item));
  const validation=invalidRule ? ruleError(invalidRule) : null;
  const currentError=rule ? ruleError(rule) : null;
  const currentPreview=preview?.key===draftKey && !validation ? preview.data : null;
  const discard=useDiscardConfirmation(dirty,!!busy,onClose,false,'关闭后将丢弃未保存的检测设置，已提交的检测任务不受影响。');

  useEffect(()=>{
    let active=true;
    setLoadError('');
    void api<CheckSettingsPreview>('/checks/config').then(result=>{
      if(!active)return;
      const loaded=toDraft(result.settings);
      setSettings(loaded);setSelectedId(loaded.rules[0]?.id || '');
      setSaved(JSON.stringify(loaded));setPreview({key:JSON.stringify(result.settings),data:result});
    }).catch(e=>{if(active)setLoadError(e.message);});
    return ()=>{active=false;};
  },[loadVersion]);

  useEffect(()=>{
    setPreviewError('');setNotice('');
    if(!draft || validation)return;
    let active=true;
    const timer=setTimeout(()=>{
      void api<CheckSettingsPreview>('/checks/preview','POST',draft).then(data=>{
        if(active)setPreview({key:draftKey,data});
      }).catch(e=>{if(active)setPreviewError(e.message);});
    },250);
    return ()=>{active=false;clearTimeout(timer);};
  },[draftKey,!!validation]);

  function change(patch:Partial<SettingsDraft>) {
    setSettings(previous=>previous ? {...previous,...patch} : previous);
    setError('');setNotice('');
  }
  function changeRule(patch:Partial<RuleDraft>) {
    setSettings(previous=>previous ? {...previous,rules:previous.rules.map(item=>item.id===selectedId ? {...item,...patch} : item)} : previous);
    setError('');setNotice('');
  }
  function addRule() {
    if(!settings || settings.rules.length>=30)return;
    const added:RuleDraft={id:crypto.randomUUID(),name:`规则 ${settings.rules.length+1}`,enabled:true,mode:'interval',intervalDays:'7',stageDays:'1, 3, 7, 15, 30',baseline:'imported',baselineDate:null,repeatDays:'30',statuses:['reachable','unknown','unchecked'],groupIds:null,tagIds:null};
    change({rules:[...settings.rules,added]});setSelectedId(added.id);
  }
  function showInvalidRule() {
    if(!invalidRule || !validation)return;
    setSelectedId(invalidRule.id);
    const mode=validation.field==='check-interval' ? 'interval' : ['check-stages','check-repeat','check-baseline-date'].includes(validation.field) ? 'staged' : invalidRule.mode;
    setSettings(previous=>previous ? {...previous,rules:previous.rules.map(item=>item.id===invalidRule.id ? {...item,mode,...(validation.field==='check-baseline-date' ? {baseline:'date' as const} : {})} : item)} : previous);
    // Invalid values remain in every draft, even when its editor is not selected.
    requestAnimationFrame(()=>document.getElementById(validation.field)?.focus());
  }
  async function perform(action:'save'|'check') {
    if(!draft || busy)return;
    if(validation){showInvalidRule();return;}
    setBusy(action);setError('');setNotice('');
    try {
      if(action==='save') {
        const result=await api<CheckSettingsPreview>('/checks/config','PUT',draft);
        onSaved(result);onClose();
      } else {
        const job=await api<Job>('/checks/range','POST',draft);
        onJob(job);setNotice(`已提交 ${job.total} 个账号检测，未保存设置。`);
      }
    } catch(e) {setError((e as Error).message || '操作失败，请重试。');}
    finally {setBusy(null);}
  }
  return <>
    <Modal title="检测设置" onClose={discard.close} className="check-settings">
      <form noValidate onSubmit={event=>{event.preventDefault();void perform('save');}}>
        <div className="modal-body check-settings-body" aria-busy={!settings && !loadError}>
          {!settings ? loadError ? <div role="alert"><p className="inline-error">{loadError}</p><button type="button" className="button" onClick={()=>setLoadVersion(value=>value+1)}>重新加载</button></div> : <p className="muted" role="status">正在读取检测设置…</p> : <>
            <div className="check-schedule-toggle">
              <label><input type="checkbox" checked={settings.enabled} disabled={!!busy} onChange={event=>change({enabled:event.target.checked})}/>启用自动检测</label>
              <span className="muted small">{settings.rules.filter(item=>item.enabled).length} / {settings.rules.length} 条规则启用</span>
            </div>
            <div className="check-rule-list" aria-label="检测规则">
              {settings.rules.map(item=><button type="button" key={item.id} className="check-rule-chip" aria-pressed={selectedId===item.id} disabled={!!busy} onClick={()=>setSelectedId(item.id)}><span>{item.name || '未命名规则'}</span><small>{ruleError(item)?'待修正':item.enabled?'启用':'停用'}</small></button>)}
              <button type="button" className="button check-add-rule" disabled={!!busy || settings.rules.length>=30} onClick={addRule}><Plus size={14}/>新增规则</button>
            </div>
            {rule ? <div className="check-rule-editor">
              <div className="check-rule-heading">
                <label className="check-name-field" htmlFor="check-rule-name"><span>规则名称</span><input id="check-rule-name" value={rule.name} maxLength={40} disabled={!!busy} aria-invalid={currentError?.field==='check-rule-name'} onChange={event=>changeRule({name:event.target.value})}/></label>
                <label className="check-rule-enabled"><input type="checkbox" checked={rule.enabled} disabled={!!busy} onChange={event=>changeRule({enabled:event.target.checked})}/>启用此规则</label>
                <button type="button" className="icon-button check-delete-rule" disabled={!!busy} aria-label="删除此规则" title="删除此规则" onClick={()=>{const remaining=settings.rules.filter(item=>item.id!==rule.id);change({rules:remaining});setSelectedId(remaining[0]?.id || '');}}><Trash2 size={15}/></button>
              </div>
              <div className="check-mode" aria-label="检测模式">
                <button type="button" aria-pressed={rule.mode==='interval'} disabled={!!busy} onClick={()=>changeRule({mode:'interval'})}>固定间隔</button>
                <button type="button" aria-pressed={rule.mode==='staged'} disabled={!!busy} onClick={()=>changeRule({mode:'staged'})}>分阶段</button>
              </div>
              {rule.mode==='interval' ? <div className="check-interval">
                <label className="field" htmlFor="check-interval">检测间隔（天）</label>
                <input id="check-interval" type="number" min="1" max="365" step="1" inputMode="numeric" value={rule.intervalDays} disabled={!!busy} aria-invalid={!daysValid(rule.intervalDays)} onChange={event=>changeRule({intervalDays:event.target.value})}/>
                <div className="check-presets" aria-label="检测间隔快捷值">{[1,3,7,15,30,90,365].map(days=><button type="button" key={days} disabled={!!busy} aria-pressed={Number(rule.intervalDays)===days} onClick={()=>changeRule({intervalDays:String(days)})}>{days} 天</button>)}</div>
                <p className="muted small">从最近检测起算，未检测账号立即到期。</p>
              </div> : <div className="check-staged">
                <label htmlFor="check-stages">阶段天数<input id="check-stages" value={rule.stageDays} disabled={!!busy} aria-invalid={currentError?.field==='check-stages'} onChange={event=>changeRule({stageDays:event.target.value})}/></label>
                <label htmlFor="check-repeat">之后每隔（天）<input id="check-repeat" type="number" min="1" max="365" step="1" inputMode="numeric" value={rule.repeatDays} disabled={!!busy} aria-invalid={currentError?.field==='check-repeat'} onChange={event=>changeRule({repeatDays:event.target.value})}/></label>
                <div className="check-staged-field"><label htmlFor="check-baseline">起算日期</label><select id="check-baseline" value={rule.baseline} disabled={!!busy} onChange={event=>changeRule({baseline:event.target.value as CheckRule['baseline']})}><option value="imported">导入日（非注册日）</option><option value="date">指定日期</option></select></div>
                {rule.baseline==='date' && <label htmlFor="check-baseline-date">指定日期<input id="check-baseline-date" type="date" min="2000-01-01" max="9998-12-31" value={rule.baselineDate || ''} disabled={!!busy} aria-invalid={currentError?.field==='check-baseline-date'} onChange={event=>changeRule({baselineDate:event.target.value || null})}/></label>}
                <p className="muted small">逗号分隔；按北京时间零点起算，第 1 天为次日。</p>
              </div>}
              {currentError && <p className="inline-error" role="alert">{currentError.message}</p>}
              <fieldset className="check-scope-field" disabled={!!busy}>
                <legend>检测状态</legend>
                <div className="check-options">{statuses.map(status=><label key={status.value}><input id={`check-status-${status.value}`} type="checkbox" checked={rule.statuses.includes(status.value)} onChange={()=>changeRule({statuses:toggle(rule.statuses,status.value) as CheckStatus[]})}/>{status.label}</label>)}</div>
              </fieldset>
              <div className="check-organization">
                <ScopeChoices label="来源分组" allLabel="全部分组" noneLabel="未分组" items={organization.groups} selected={rule.groupIds} disabled={!!busy} onChange={groupIds=>changeRule({groupIds})}/>
                <ScopeChoices label="标签" allLabel="全部标签" noneLabel="无标签" items={organization.tags} selected={rule.tagIds} disabled={!!busy} onChange={tagIds=>changeRule({tagIds})}/>
              </div>
            </div> : <p className="check-empty muted">暂无规则，新增一条开始设置。</p>}
            <div className="check-preview" aria-live="polite" aria-label="检测范围预览">
              {validation ? <button type="button" className="check-error-link" onClick={showInvalidRule}>{invalidRule?.id===selectedId ? '修正当前规则' : `“${invalidRule?.name || '未命名规则'}”需修正，前往编辑`}</button> : previewError ? <p className="inline-error" role="alert">预览失败：{previewError}</p> : currentPreview ? <>
                <strong>符合范围 {currentPreview.matched} 个 · 当前到期 {currentPreview.due} 个</strong>
                <span className="muted small">所有启用规则的去重范围</span>
                {currentPreview.invalidFilters.length>0 && <p className="check-filter-warning" role="alert">选定的分组或标签已删除，请修改范围；未扩大为全部账号。</p>}
                <span className="muted small"><Clock3 size={13}/>{settings.enabled ? currentPreview.nextDueAt ? `下次到期：${beijingDate(currentPreview.nextDueAt)}（北京时间）` : '暂无待检测账号' : '自动检测未启用'}</span>
              </> : <p className="muted">正在预览范围…</p>}
            </div>
            {error && <p className="inline-error" role="alert">{error}</p>}
            {notice && <p className="check-settings-notice" role="status">{notice}</p>}
          </>}
        </div>
        <footer className="modal-footer">
          <button type="button" className="button check-range-action" disabled={!settings || !!validation || !!busy || checking || !currentPreview?.matched || !!currentPreview.invalidFilters.length || !!previewError} onClick={()=>void perform('check')} title="立即检测所有启用规则的去重范围，忽略到期时间，不保存设置"><RefreshCw size={14}/>{busy==='check'?'正在提交…':'检测启用规则'}</button>
          <button type="button" className="button" disabled={!!busy} onClick={discard.close}>关闭</button>
          <button type="submit" className="button primary" disabled={!settings || !!validation || !!busy}>{busy==='save'?'保存中…':'保存设置'}</button>
        </footer>
      </form>
    </Modal>
    {discard.confirmation}
  </>;
}

function ScopeChoices({label,allLabel,noneLabel,items,selected,disabled,onChange}:{label:string;allLabel:string;noneLabel:string;items:OrganizationItem[];selected:string[]|null;disabled:boolean;onChange:(values:string[]|null)=>void}) {
  const missing=(selected || []).filter(id=>id!=='none' && !items.some(item=>item.id===id));
  return <fieldset className="check-scope-field" disabled={disabled}>
    <legend>{label}</legend>
    <label className="check-all-choice"><input type="checkbox" checked={selected===null} onChange={event=>onChange(event.target.checked?null:[])}/>{allLabel}</label>
    <div className="check-options check-organization-options">
      {[{id:'none',name:noneLabel},...items,...missing.map(id=>({id,name:'已删除的'+label}))].map(item=><label key={item.id} className={missing.includes(item.id)?'check-filter-warning':undefined}><input type="checkbox" disabled={selected===null} checked={selected?.includes(item.id) || false} onChange={()=>onChange(toggle(selected || [],item.id))}/>{item.name}</label>)}
    </div>
  </fieldset>;
}
