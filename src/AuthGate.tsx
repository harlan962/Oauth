import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import {Eye,EyeOff,Github,LockKeyhole,LogIn,ShieldCheck} from 'lucide-react';
import {api,setCsrfToken,type ApiFailure} from './api';
import {AuthContext,type AuthState} from './auth-context';

export function AuthGate({children}:{children:ReactNode}) {
  const [state,setState]=useState<AuthState|null>(null),[error,setError]=useState('');
  const generation=useRef(0),alive=useRef(true);
  const install=useCallback((value:AuthState)=>{generation.current++;setCsrfToken(value.csrfToken || '');setState(value);setError('');},[]);
  const refresh=useCallback(async()=>{
    const revision=++generation.current;
    try{const value=await api<AuthState>('/auth/status');if(alive.current && revision===generation.current){setCsrfToken(value.csrfToken || '');setState(value);setError('');}}
    catch(e){if(alive.current && revision===generation.current)setError((e as Error).message);}
  },[]);
  useEffect(()=>{
    alive.current=true;void refresh();
    const denied=()=>{setCsrfToken('');setState(value=>({initialized:value?.initialized ?? true,authenticated:false}));void refresh();};
    const visible=()=>{if(!document.hidden)void refresh();};
    window.addEventListener('account-desk:auth-required',denied);document.addEventListener('visibilitychange',visible);
    const timer=setInterval(visible,60000);
    return()=>{alive.current=false;generation.current++;clearInterval(timer);window.removeEventListener('account-desk:auth-required',denied);document.removeEventListener('visibilitychange',visible);};
  },[refresh]);
  if(state?.authenticated)return <AuthContext.Provider value={{state,install,refresh}}>{children}</AuthContext.Provider>;
  return <main className="auth-screen"><section className="auth-card" aria-label="后台登录"><div className="auth-brand"><Github size={24}/><span>Account Desk</span></div>
    {!state?<><h1>连接工作台</h1><p role="status">{error || '正在检查登录状态…'}</p>{error && <button className="button" onClick={()=>void refresh()}>重试连接</button>}</>:<LoginForm key={String(state.initialized)} initialized={state.initialized} onSaved={install}/>}
  </section><p className="auth-footnote"><LockKeyhole size={13}/>账号管理后台</p></main>;
}

function LoginForm({initialized,onSaved}:{initialized:boolean;onSaved:(value:AuthState)=>void}) {
  const [username,setUsername]=useState(''),[password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[setupCode,setSetupCode]=useState('');
  const [showPassword,setShowPassword]=useState(false),[showConfirmation,setShowConfirmation]=useState(false);
  const [code,setCode]=useState(''),[needTotp,setNeedTotp]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');const pending=useRef(false);
  const toggle=(show:boolean,label:string,onToggle:()=>void,disabled:boolean)=><button type="button" className="icon-button" aria-label={show?`隐藏${label}`:`显示${label}`} aria-pressed={show} title={show?`隐藏${label}`:`显示${label}`} disabled={disabled} onClick={onToggle}>{show?<EyeOff size={16}/>:<Eye size={16}/>}</button>;
  return <><h1>{initialized?'登录工作台':'设置管理员'}</h1><p className="auth-intro">{initialized?'使用管理员账号登录。':'首次使用，请设置后台登录账号。'}</p><form onSubmit={async e=>{
    e.preventDefault();if(pending.current)return;setError('');
    if(!initialized && password!==confirmation){setError('两次输入的密码不一致');return;}
    pending.current=true;setBusy(true);
    try{onSaved(await api<AuthState>(initialized?'/auth/login':'/auth/setup','POST',{username,password,...(!initialized?{setupCode:setupCode.trim()}:{}),...(needTotp?{code:code.trim()}:{})}));setPassword('');setConfirmation('');setSetupCode('');setCode('');}
    catch(e){
      const failure=e as ApiFailure;
      // The password was accepted; the server is asking for the second factor.
      if(failure.code==='TOTP_REQUIRED'){setNeedTotp(true);setError('');}
      else setError(failure.message);
    }finally{pending.current=false;setBusy(false);}
  }}>
    {!initialized && <label className="field">一次性设置码<input aria-label="一次性设置码" aria-describedby="setup-code-help" required type="password" autoComplete="off" value={setupCode} disabled={busy} onChange={e=>setSetupCode(e.target.value)}/><span id="setup-code-help" className="auth-field-help">从服务器数据目录的 admin-setup-code.txt 中读取。</span></label>}
    <label className="field">管理员账号<input autoFocus={initialized} required minLength={3} maxLength={40} autoComplete="username" spellCheck={false} value={username} disabled={busy} onChange={e=>setUsername(e.target.value)}/></label>
    <div className="field"><label htmlFor="auth-password">密码</label><div className="input-actions"><input id="auth-password" aria-label="密码" aria-describedby={initialized?undefined:'password-help'} required type={showPassword?'text':'password'} minLength={initialized?undefined:12} maxLength={128} autoComplete={initialized?'current-password':'new-password'} value={password} disabled={busy} onChange={e=>setPassword(e.target.value)}/>{toggle(showPassword,'密码',()=>setShowPassword(v=>!v),busy)}</div>{!initialized && <span id="password-help" className="auth-field-help">12–128 个字符。</span>}</div>
    {!initialized && <div className="field"><label htmlFor="auth-confirmation">确认密码</label><div className="input-actions"><input id="auth-confirmation" required type={showConfirmation?'text':'password'} minLength={12} maxLength={128} autoComplete="new-password" value={confirmation} disabled={busy} onChange={e=>setConfirmation(e.target.value)}/>{toggle(showConfirmation,'确认密码',()=>setShowConfirmation(v=>!v),busy)}</div></div>}
    {needTotp && <label className="field"><span className="auth-totp-label"><ShieldCheck size={14}/>两步验证码</span><input aria-label="两步验证码" autoFocus required autoComplete="one-time-code" spellCheck={false} maxLength={12} placeholder="6 位动态码" value={code} disabled={busy} onChange={e=>setCode(e.target.value)}/><span className="auth-field-help">输入验证器 App 的 6 位数字；设备丢失时可用恢复码。</span></label>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <button className="button primary auth-submit" disabled={busy}><LogIn size={16}/>{busy?'请稍候…':initialized?'登录':'设置并登录'}</button>
  </form></>;
}
