import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "./api";
import { Modal, ConfirmDialog, useDiscardConfirmation } from "./components";
import { beijingDate, type PatRecord, type PatStatus } from "./types";

export function PatMetadata({record}:{record:PatRecord}) {
  return <dl className="pat-metadata">
    <div><dt>PAT 来源</dt><dd>@{record.username}</dd></div>
    <div><dt>任务开始时间 · 北京时间</dt><dd>{beijingDate(record.createdAt)}</dd></div>
    <div><dt>凭据保存</dt><dd>{record.hasToken===true?"已加密保存":record.creationUncertain?"生成结果待确认":record.hasToken===false?"尚未生成":"以验证状态为准"}</dd></div>
    <div><dt>到期时间 · 北京时间</dt><dd>{beijingDate(record.expiresAt)}</dd></div>
    <div><dt>剩余额度 / 实际上限</dt><dd>{record.remaining ?? "—"} / {record.limit ?? "—"}</dd></div>
    <div><dt>额度恢复 · 北京时间</dt><dd>{beijingDate(record.retryAt || record.resetAt)}</dd></div>
    <div><dt>最近诊断</dt><dd>{record.message || "暂无诊断"}</dd></div>
  </dl>;
}

export function PatConfig({status,onStatus,onClose}:{status:PatStatus;onStatus:(status:PatStatus)=>void;onClose:()=>void}) {
  const [enabled,setEnabled]=useState(status.settings.enabled);
  const [target,setTarget]=useState(String(status.settings.targetCount));
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [confirming,setConfirming]=useState(false);
  const dirty=enabled!==status.settings.enabled || target!==String(status.settings.targetCount);
  const validTarget=/^\d+$/.test(target) && Number(target)>=1 && Number(target)<=100;
  const discard=useDiscardConfirmation(dirty,busy,onClose);
  useEffect(()=>{setEnabled(status.settings.enabled);setTarget(String(status.settings.targetCount));},[status.settings.enabled,status.settings.targetCount]);
  async function save() {
    if(!validTarget){setError("请输入 1–100 的整数");return;}
    setBusy(true);setError("");
    try {onStatus(await api<PatStatus>("/pat/config","PUT",{enabled,targetCount:Number(target),confirmed:true}));onClose();}
    catch(e) {setError((e as Error).message || "配置未保存，请重试。");}
    finally{setBusy(false);}
  }
  return <>
    <Modal title="PAT 配置" onClose={discard.close} className="pat-config">
      <div className="modal-body">
        <div className="notice"><ShieldCheck size={18}/><p>检测时按需补充公共资源只读 PAT，有效期 30 天。</p></div>
        <label className="pat-switch"><input type="checkbox" checked={enabled} disabled={busy} onChange={e=>setEnabled(e.target.checked)}/>启用 PAT 自动补充</label>
        <label className="field">有效 PAT 目标数量<input type="number" min="1" max="100" step="1" inputMode="numeric" value={target} disabled={busy} onChange={e=>setTarget(e.target.value)} aria-describedby="pat-target-hint"/></label>
        <p id="pat-target-hint" className="muted small">1–100 个，冷却与待验证的 PAT 也计入维护数量。</p>
        <div className="dialog-feedback" aria-live="polite">{error?<p className="inline-error" role="alert">{error}</p>:busy?<p>正在保存…</p>:null}</div>
      </div>
      <footer className="modal-footer">
        <button className="button" disabled={busy} onClick={discard.close}>关闭</button>
        <button className="button primary" disabled={busy || !dirty || !validTarget} onClick={()=>setConfirming(true)}>保存配置</button>
      </footer>
    </Modal>
    {discard.confirmation}
    {confirming && <ConfirmDialog title={enabled===status.settings.enabled?"更新 PAT 配置？":enabled?"开启 PAT 自动补充？":"关闭 PAT 自动补充？"} description={enabled?`将允许检测按需在独立浏览器登录 GitHub 并创建 PAT，访问范围为公共资源只读，有效期 30 天；维护目标为 ${target} 个。此操作会在 GitHub 创建外部凭据。`:"关闭后停止自动补充及本地 PAT 使用；专用用途保留，远端 Token 不会自动撤销。"} confirmLabel="确认保存" onCancel={()=>setConfirming(false)} onConfirm={()=>{setConfirming(false);void save();}}/>}
  </>;
}
