import { useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Eye, EyeOff, LoaderCircle, Save } from "lucide-react";
import { api } from "./api";
import { Modal, useDiscardConfirmation } from "./components";
import type { Target } from "./workbuddy-types";

type ConnectionResult = {
  ok: boolean;
  api: { ok: boolean; message: string; total?: number };
  browser: { ok: boolean; message: string; mode: 'proxy' | 'direct' };
};
function normalizedAddress(value: string) {
  try { return new URL(value.trim()).href.replace(/\/+$/, '').replace(/\/panel$/, ''); }
  catch { return value.trim(); }
}

export function WorkBuddyConfig({targets,lockedId,onSaved,onClose}: {
  targets: Target[]; selectedId?: string; lockedId?: string;
  onSaved: (target: Target) => void; onClose: () => void;
}) {
  const initial=targets[0] || null;
  const [saved,setSaved]=useState<Target|null>(initial);
  const [baseUrl,setBaseUrl]=useState(initial?.baseUrl || '');
  const [key,setKey]=useState('');
  const [show,setShow]=useState(false);
  const [proxyEnabled,setProxyEnabled]=useState(!!initial?.browserProxy);
  const [proxyServer,setProxyServer]=useState('');
  const [showProxy,setShowProxy]=useState(false);
  const [busy,setBusy]=useState('');
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [result,setResult]=useState<ConnectionResult|null>(null);
  const operation=useRef(false);
  const dirty=baseUrl!==(saved?.baseUrl || '') || !!key || proxyEnabled!==!!saved?.browserProxy ||
    (proxyEnabled && !!proxyServer);
  const changedAddress=!!saved && normalizedAddress(baseUrl)!==saved.baseUrl;
  const locked=!!saved && lockedId===saved.id;
  const {close,confirmation}=useDiscardConfirmation(dirty,!!busy,onClose,false,'关闭后将丢弃未保存的配置。');
  function changed() { setResult(null);setNotice('');setError(''); }
  async function save() {
    if(operation.current || locked)return;
    operation.current=true;setBusy('save');changed();
    try {
      const target=await api<Target>('/integrations/targets'+(saved?'/'+saved.id:''),saved?'PUT':'POST',{
        name:saved?.name || 'WorkBuddy 国际版',baseUrl,apiKey:key,
        ...(proxyEnabled ? (proxyServer.trim() ? {browserProxy:{server:proxyServer}} : saved?.browserProxy ? {} : {browserProxy:{server:''}}) : {browserProxy:null}),
      });
      setSaved(target);setBaseUrl(target.baseUrl);setKey('');setShow(false);
      setProxyEnabled(!!target.browserProxy);setProxyServer('');setShowProxy(false);
      onSaved(target);setNotice('配置已保存');
    } catch(e) { setError((e as Error).message); }
    finally {operation.current=false;setBusy('');}
  }
  async function testConnection() {
    if(!saved || dirty || operation.current)return;
    operation.current=true;setBusy('test');changed();
    try { setResult(await api<ConnectionResult>('/integrations/targets/'+saved.id+'/diagnostics','POST')); }
    catch(e) {setError((e as Error).message);}
    finally {operation.current=false;setBusy('');}
  }
  return <>
    <Modal title="WorkBuddy2api 配置" onClose={close} className="wb-config wb-config-compact">
      <form onSubmit={e=>{e.preventDefault();void save();}}>
        <div className="modal-body wb-form">
          {locked && <p className="wb-notice">任务运行中，停止后可修改配置。</p>}
          <fieldset disabled={!!busy || locked}>
            <label htmlFor="wb-base">部署地址</label>
            <input id="wb-base" type="url" required value={baseUrl} placeholder="https://your-domain.example" autoComplete="off" spellCheck={false} onChange={e=>{setBaseUrl(e.target.value);changed();}}/>
            <label htmlFor="wb-key">API Key</label>
            <div className="wb-secret">
              <input id="wb-key" type={show?'text':'password'} required={!saved || changedAddress} value={key} placeholder={saved?'已保存，留空保留':'填写 API Key'} autoComplete="new-password" spellCheck={false} onChange={e=>{setKey(e.target.value);changed();}}/>
              <button className="icon-button" type="button" aria-label={show?'隐藏 API Key':'显示 API Key'} aria-pressed={show} onClick={()=>setShow(v=>!v)}>{show?<EyeOff size={18}/>:<Eye size={18}/>}</button>
            </div>
            {changedAddress && <p className="wb-field-hint">更换部署地址需重新填写 API Key。</p>}
            <label htmlFor="wb-proxy-mode">连接方式</label>
            <select id="wb-proxy-mode" value={proxyEnabled?'proxy':'direct'} onChange={e=>{setProxyEnabled(e.target.value==='proxy');changed();}}>
              <option value="direct">直连</option><option value="proxy">代理</option>
            </select>
            {proxyEnabled && <div className="wb-proxy-fields">
              <label htmlFor="wb-proxy-server">代理链接</label>
              <div className="wb-secret">
                <input id="wb-proxy-server" type={showProxy?'text':'password'} required={!saved?.browserProxy} value={proxyServer} maxLength={2000} placeholder={saved?.browserProxy?('已保存 '+saved.browserProxy.server+'，留空保留'):'http://127.0.0.1:7890'} autoComplete="new-password" spellCheck={false} onChange={e=>{setProxyServer(e.target.value);changed();}}/>
                <button className="icon-button" type="button" aria-label={showProxy?'隐藏代理链接':'显示代理链接'} aria-pressed={showProxy} onClick={()=>setShowProxy(v=>!v)}>{showProxy?<EyeOff size={18}/>:<Eye size={18}/>}</button>
              </div>
              <p className="wb-field-hint">支持 HTTP、HTTPS、SOCKS5，可直接粘贴含用户名和密码的链接。</p>
            </div>}
          </fieldset>
          {error && <p className="wb-error" role="alert">{error}</p>}
          {notice && <p className="wb-save-notice" role="status"><CheckCircle2 size={15}/>{notice}</p>}
          {result && <div className="wb-connection-results" role={result.ok?'status':'alert'} aria-label="连接测试结果">
            {([{label:'部署接口',check:result.api},{label:result.browser.mode==='proxy'?'代理网络':'直连网络',check:result.browser}]).map(({label,check})=><div key={label} className={check.ok?'passed':'failed'}>
              {check.ok?<CheckCircle2 size={17}/>:<CircleAlert size={17}/>}<div><strong>{label} · {check.ok?'正常':'失败'}</strong><p>{check.message}</p></div>
            </div>)}
          </div>}
        </div>
        <footer className="modal-footer wb-actions">
          <button className="button" type="button" disabled={!!busy} onClick={close}>关闭</button>
          <button className="button" type="button" disabled={!saved || dirty || !!busy} title={!saved||dirty?'请先保存配置':'测试部署接口与浏览器网络'} onClick={()=>void testConnection()}>{busy==='test'&&<LoaderCircle size={16} className="spin"/>}{busy==='test'?'正在测试…':'测试连接'}</button>
          <button className="button primary" type="submit" disabled={locked||!!busy||!!saved&&!dirty}>{busy==='save'?<LoaderCircle size={16} className="spin"/>:<Save size={16}/>}保存配置</button>
        </footer>
      </form>
    </Modal>
    {confirmation}
  </>;
}
