import {useRef, useState} from 'react';
import {CircleAlert, Download, FileText, RefreshCw} from 'lucide-react';
import {Modal} from './components';
import {api} from './api';
import {useReauthGate} from './ReauthPrompt';

export type ExportScope = {selectedIds:string[]; filteredIds:string[]; initial:'selected' | 'filtered'};

export function ExportAccounts({scope,onClose,onComplete}:{scope:ExportScope;onClose:()=>void;onComplete:(message:string)=>void}) {
  const [range,setRange]=useState(scope.initial);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const pending=useRef(false);
  const gate=useReauthGate();
  const ids=range==='selected'?scope.selectedIds:scope.filteredIds;
  const close=()=>{if(!pending.current)onClose();};
  async function download() {
    if(pending.current || !ids.length)return;
    pending.current=true;setBusy(true);setError('');
    try {
      const result=await gate.ensure(()=>api<{filename:string;count:number;text:string}>('/accounts/export','POST',{ids}));
      const url=URL.createObjectURL(new Blob([result.text],{type:'text/plain;charset=utf-8'}));
      const link=document.createElement('a');link.href=url;link.download=result.filename;
      document.body.appendChild(link);
      try {link.click();} finally {link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
      onComplete(`已发起下载，包含 ${result.count} 个账号`);
    } catch(e) {
      const message=(e as Error).message;
      if(message && message!=='已取消')setError(message);
    }
    finally {pending.current=false;setBusy(false);}
  }
  return <><Modal title="导出账号" subtitle="选择导出范围，下载为 TXT 文件。" onClose={close} className="export-accounts">
    <div className="modal-body" aria-busy={busy}>
      <fieldset className="export-ranges" disabled={busy}>
        <legend>导出范围</legend>
        <label className={`export-range ${range==='selected'?'active':''} ${!scope.selectedIds.length?'unavailable':''}`}>
          <input type="radio" name="export-range" value="selected" checked={range==='selected'} disabled={!scope.selectedIds.length} onChange={()=>{setRange('selected');setError('');}}/>
          <span><strong>已勾选账号</strong><small>{scope.selectedIds.length?'包含其他分页中已勾选的账号':'请先在账号列表中勾选'}</small></span>
          <b>{scope.selectedIds.length} 个</b>
        </label>
        <label className={`export-range ${range==='filtered'?'active':''} ${!scope.filteredIds.length?'unavailable':''}`}>
          <input type="radio" name="export-range" value="filtered" checked={range==='filtered'} disabled={!scope.filteredIds.length} onChange={()=>{setRange('filtered');setError('');}}/>
          <span><strong>当前筛选结果</strong><small>包含所有分页，按当前列表顺序导出</small></span>
          <b>{scope.filteredIds.length} 个</b>
        </label>
      </fieldset>
      <div className="export-format"><FileText size={18}/><div><strong>TXT · 一行一个账号</strong><code>邮箱----密码----用户名----TOTP密钥</code><p>未设置 TOTP 的字段留空。分组、标签和检测结果不包含在文件中。</p></div></div>
      <p className="export-notice"><CircleAlert size={16}/><span>文件包含明文密码和 TOTP 密钥，请妥善保管。</span></p>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
    <footer className="modal-footer">
      <button type="button" className="button" disabled={busy} onClick={close} data-autofocus>取消</button>
      <button type="button" className="button primary" disabled={busy || !ids.length} onClick={()=>void download()}>{busy?<RefreshCw size={16} className="spin"/>:<Download size={16}/>}<span aria-live="polite">{busy?'正在导出…':`导出 ${ids.length} 个账号`}</span></button>
    </footer>
  </Modal>{gate.element}</>;
}
