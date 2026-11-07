import express from 'express';
import { AppError } from './store.js';

export function apiOrigin(value, port=4319) {
  const origin=new URL(value || `http://127.0.0.1:${port}`);
  const local=['127.0.0.1','localhost','[::1]'].includes(origin.hostname);
  if ((origin.protocol!=='https:' && !(origin.protocol==='http:' && local)) || origin.username || origin.password || origin.pathname!=='/' || origin.search || origin.hash) throw new Error('ACCOUNT_DESK_API_ORIGIN 须为 HTTPS 域名地址（本机可用 HTTP），不能包含路径或凭据');
  return origin.origin;
}

// Intentionally separate from the private application: no static files or admin routes.
export function createPublicApi(access,{origin,port=4319,bot=null}) {
  const app=express();app.disable('x-powered-by');app.disable('etag');
  const hosts=new Set([new URL(origin).host,`127.0.0.1:${port}`,`localhost:${port}`]);
  const routes=new Map([
    ['POST /api/v1/accounts/import','accounts:import'],
    ['GET /api/v1/groups','organization:read'],
    ['GET /api/v1/tags','organization:read'],
  ]);
  // The chat-bot callback is the only route here that is not keyed: the platforms
  // cannot present a Bearer token. It authenticates with its own path token plus
  // a per-platform signature, so it is kept out of the API-key pipeline entirely.
  const hookPath=/^\/bot\/hook\/[A-Za-z0-9_-]{43}$/;
  // Budgets are per caller, never one shared counter: a counter that every
  // request increments before authentication lets anyone with network access
  // spend it in a second and take every legitimate integration down with them.
  // Anonymous callers get a small per-source allowance; authenticated keys keep
  // their own 60/min budget inside ApiAccess; `global` is only a backstop
  // against a distributed flood and is deliberately far above real traffic.
  const budgets=new Map();
  const sourceOf=req=>{
    const raw=req.socket?.remoteAddress||'unknown';
    const v4=raw.startsWith('::ffff:')?raw.slice(7):raw;
    return v4==='::1'?'127.0.0.1':v4;
  };
  function spend(key,limit,window){
    const current=budgets.get(key);
    const state=current&&current.window===window?current:{window,count:0};
    if(state.count>=limit){budgets.set(key,state);return false;}
    state.count+=1;budgets.set(key,state);
    if(budgets.size>4000)for(const [name,value] of budgets)if(value.window!==window)budgets.delete(name);
    return true;
  }
  const tooMany=res=>res.set('Retry-After','60').status(429).json({error:'API 请求过于频繁'});
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=()','Cross-Origin-Resource-Policy':'same-origin','X-Permitted-Cross-Domain-Policies':'none','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"});
    if(String(origin).startsWith('https:'))res.set('Strict-Transport-Security','max-age=31536000; includeSubDomains');
    // Host first: a request addressed to the wrong name should not consume
    // anyone's budget.
    if(!hosts.has(req.headers.host))return res.status(403).json({error:'接口域名不匹配'});
    if(req.headers.origin || req.headers['sec-fetch-site']==='cross-site')return res.status(403).json({error:'请从后端程序调用 API'});
    if(!spend(`global:${String(origin)}`,6000,Math.floor(access.clock()/60000)))return tooMany(res);
    if(hookPath.test(req.path))return next();
    const scope=routes.get(`${req.method} ${req.path}`);
    if(!scope)return res.status(404).json({error:'接口不存在'});
    const authorization=req.headers.authorization;
    if(!authorization){
      if(!spend(`anonymous:${sourceOf(req)}`,30,Math.floor(access.clock()/60000)))return tooMany(res);
      return res.set('WWW-Authenticate','Bearer').status(401).json({error:'缺少 API 密钥'});
    }
    try{res.locals.keyId=access.authenticate(authorization,scope,{ip:sourceOf(req),ua:req.headers['user-agent']||null});}
    catch(error){
      // A wrong or revoked key is still an unauthenticated caller, so it draws
      // from the same small source allowance instead of an unlimited one.
      if(!spend(`anonymous:${sourceOf(req)}`,30,Math.floor(access.clock()/60000)))return tooMany(res);
      return next(error);
    }
    next();
  });
  // Raw body, not JSON: both DingTalk and Feishu sign the exact bytes they sent,
  // and a re-serialised object would not reproduce them.
  if(bot)app.post('/bot/hook/:token',express.raw({type:'*/*',limit:'64kb'}),(req,res,next)=>{
    const raw=Buffer.isBuffer(req.body)?req.body.toString('utf8'):'';
    bot.handleHook(req.params.token,req,raw).then(result=>res.status(result.status||200).json(result.body))
      .catch(error=>next(error));
  });
  app.use(express.json({limit:'2mb',strict:true}));  // Uploading a body yields to other requests. Recheck revocation/expiry before
  // any reads or writes, without consuming a second rate-limit allowance.
  app.use((req,res,next)=>{
    access.authorize(res.locals.keyId,routes.get(`${req.method} ${req.path}`));
    next();
  });
  app.post('/api/v1/accounts/import',(req,res)=>{
    if(!req.is('application/json'))throw new AppError('请使用 application/json',415);
    res.json(access.import(res.locals.keyId,req.body,req.headers['idempotency-key']));
  });
  app.get('/api/v1/groups',(req,res)=>res.json({groups:access.store.organization.list().groups.map(({id,name})=>({id,name}))}));
  app.get('/api/v1/tags',(req,res)=>res.json({tags:access.store.organization.list().tags.map(({id,name,color})=>({id,name,color}))}));
  app.use((error,req,res,next)=>{
    const status=error instanceof AppError?error.status:error.type==='entity.too.large'?413:error instanceof SyntaxError?400:500;
    if(status===401)res.set('WWW-Authenticate','Bearer');
    if(status===429)res.set('Retry-After',String(error.retryAfter || 60));
    res.status(status).json({error:error instanceof AppError?error.message:status===413?'请求内容不得超过 2 MB':status===400?'JSON 格式无效':'操作失败，请稍后重试'});
  });
  return app;
}
