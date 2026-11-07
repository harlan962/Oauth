import { randomBytes, createHash, createHmac, timingSafeEqual, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import express from 'express';
import { AppError } from './store.js';
import { encrypt, decrypt, totpCode } from './crypto.js';
import { describeAgent } from './user-agent.js';

const scryptAsync=promisify(scrypt),hash=value=>createHash('sha256').update(value).digest('hex');
// Version 1 is the historical default (N=2^14, about 16 MB). Version 2 follows the
// current OWASP recommendation. Every stored hash records the version that produced
// it, so an old row still verifies once and is silently re-hashed on the next login.
const kdf={1:{N:16384,r:8,p:1,maxmem:64*1024*1024},2:{N:131072,r:8,p:1,maxmem:256*1024*1024}};
const currentKdf=2;
const same=(a,b)=>typeof a==='string' && typeof b==='string' && timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));
const lifetime=12*3600000;
// A request counts as "active" for the idle timer only once per minute, so the
// common path stays read-only instead of writing the sessions table per request.
const idleTouchMs=60000, idleLimit=2*3600000;
// Consecutive failures escalate the cooldown instead of allowing a flat drip of
// guesses: 30 s, 60 s, 2 min, 4 min, 8 min, then a 15 min ceiling.
const lockAfter=5, lockStep=30000, lockMax=900000;
// One budget for the whole machine is a denial-of-service switch: five wrong
// guesses from anywhere lock the real operator out, and because a successful
// login is the only thing that clears it, the lock can be held forever. Count
// per source instead, and keep a much higher global ceiling only as a backstop
// against a distributed low-and-slow attempt.
const globalAttemptsPerMinute=60, sourceBuckets=500, bucketIdleMs=24*3600000;
// Each successful login inserts a session row, so a long-lived browser that
// re-authenticates over weeks would accumulate dozens of stale entries and bury
// the one line that matters. Keep a small working set; the rest are dropped
// oldest-first. Active windows touch lastSeenAt, so they are never the first out.
const sessionLimit=8;
// Reading plaintext passwords is gated behind a fresh password check, so an
// unattended browser tab cannot dump credentials by itself. The grant is short
// lived and bound to the session that created it.
const reauthLifetime=5*60000;
// A grant is a "the human just typed the password" proof, not a session. Cap
// how many plaintext reads it can authorise so a stolen token cannot walk the
// whole account list; the UI re-prompts automatically when it runs out.
const reauthMaxUses=5;
const credentialAuditLimit=2000;
// Optional second factor. Codes are accepted within one 30 s step of skew so a
// slightly-off clock still works; recovery codes are single use.
const totpStepMs=30000, totpDrift=1, recoveryCount=8;
const base32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// Used when no administrator exists yet, so an unknown username still costs one
// scrypt run and cannot be told apart from a wrong password by response time.
const dummySalt=hash('account-desk-absent-administrator');
function passwordValid(value) {
  if(typeof value!=='string' || value.length<12 || value.length>128 || Buffer.byteLength(value)>512)throw new AppError('密码须为 12–128 个字符');
}
function record(body) { if(!body || typeof body!=='object' || Array.isArray(body))throw new AppError('请求格式无效'); }

export class AdminAuth {
  constructor(store,{authClock=Date.now,adminOrigin,trustProxy=false}={}) {
    this.store=store;this.db=store.db;this.clock=authClock;this.adminOrigin=adminOrigin;this.trustProxy=!!trustProxy;this.inFlight=0;
    this.codePath=join(store.directory,'admin-setup-code.txt');
    this.lastEvent=new Map();this.eventWrites=0;this.listeners=new Set();
    this.db.exec(`CREATE TABLE IF NOT EXISTS admin_credentials (
      id INTEGER PRIMARY KEY CHECK(id=1), username TEXT, salt TEXT, passwordHash TEXT, setupDigest TEXT, version INTEGER NOT NULL DEFAULT 0
    ); INSERT OR IGNORE INTO admin_credentials(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS admin_sessions (digest TEXT PRIMARY KEY,createdAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,ip TEXT,ua TEXT,method TEXT,lastSeenAt INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS admin_login_limits (id INTEGER PRIMARY KEY CHECK(id=1),window INTEGER NOT NULL,count INTEGER NOT NULL);
    INSERT OR IGNORE INTO admin_login_limits VALUES(1,0,0);
    CREATE TABLE IF NOT EXISTS admin_lockout (id INTEGER PRIMARY KEY CHECK(id=1),fails INTEGER NOT NULL DEFAULT 0,lockUntil INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO admin_lockout VALUES(1,0,0);
    CREATE TABLE IF NOT EXISTS admin_lockout_sources (bucket TEXT PRIMARY KEY,fails INTEGER NOT NULL DEFAULT 0,lockUntil INTEGER NOT NULL DEFAULT 0,updatedAt INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS admin_lockout_updated ON admin_lockout_sources(updatedAt);
    CREATE TABLE IF NOT EXISTS security_events (id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,detail TEXT,at INTEGER NOT NULL,ip TEXT,ua TEXT,method TEXT,target TEXT);
    CREATE INDEX IF NOT EXISTS security_events_at ON security_events(at);
    CREATE TABLE IF NOT EXISTS admin_reauth (digest TEXT PRIMARY KEY,sessionDigest TEXT NOT NULL,expiresAt INTEGER NOT NULL,uses INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS credential_access (id INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,action TEXT NOT NULL,accountId TEXT,accountLabel TEXT,accountCount INTEGER NOT NULL DEFAULT 1,sessionRef TEXT,ip TEXT,ua TEXT);
    CREATE INDEX IF NOT EXISTS credential_access_at ON credential_access(at);
    CREATE TABLE IF NOT EXISTS admin_totp (id INTEGER PRIMARY KEY CHECK(id=1),secret TEXT NOT NULL,enabledAt INTEGER NOT NULL DEFAULT 0,createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_recovery (digest TEXT PRIMARY KEY,usedAt INTEGER);`);
    // Origin of a request, kept on every audit row. Attribution turns "someone
    // logged in" into "someone logged in from 203.0.113.7 with a Linux Chrome" —
    // the difference between a log and evidence.
    this.addColumn('security_events','ip','TEXT');
    this.addColumn('security_events','ua','TEXT');
    this.addColumn('security_events','method','TEXT');
    this.addColumn('security_events','target','TEXT');
    this.addColumn('admin_sessions','ip','TEXT');
    this.addColumn('admin_sessions','ua','TEXT');
    this.addColumn('admin_sessions','method','TEXT');
    this.addColumn('credential_access','ip','TEXT');
    this.addColumn('credential_access','ua','TEXT');
    if(!this.db.prepare('PRAGMA table_info(admin_credentials)').all().some(column=>column.name==='hashVersion'))
      this.db.exec('ALTER TABLE admin_credentials ADD COLUMN hashVersion INTEGER NOT NULL DEFAULT 1');
    if(!this.db.prepare('PRAGMA table_info(admin_sessions)').all().some(column=>column.name==='lastSeenAt'))
      this.db.exec('ALTER TABLE admin_sessions ADD COLUMN lastSeenAt INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(admin_reauth)').all().some(column=>column.name==='uses'))
      this.db.exec('ALTER TABLE admin_reauth ADD COLUMN uses INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(admin_totp)').all().some(column=>column.name==='lastStep'))
      this.db.exec('ALTER TABLE admin_totp ADD COLUMN lastStep INTEGER NOT NULL DEFAULT 0');
    this.cleanup();
    if(!this.credentials().username)this.ensureSetupCode();
  }
  credentials(){return this.db.prepare('SELECT * FROM admin_credentials WHERE id=1').get();}
  cleanup(){
    const now=this.clock();
    this.db.prepare('DELETE FROM admin_sessions WHERE expiresAt<=?').run(now);
    this.db.prepare('DELETE FROM admin_reauth WHERE expiresAt<=?').run(now);
    // Stale source buckets are noise; keep the table bounded so a flood of
    // distinct sources cannot grow it without limit.
    this.db.prepare('DELETE FROM admin_lockout_sources WHERE updatedAt<=?').run(now-bucketIdleMs);
    this.db.prepare(`DELETE FROM admin_lockout_sources WHERE bucket NOT IN (
      SELECT bucket FROM admin_lockout_sources ORDER BY updatedAt DESC LIMIT ?)`).run(sourceBuckets);
  }
  addColumn(table,column,type) {
    if(this.db.prepare(`PRAGMA table_info(${table})`).all().some(item=>item.name===column))return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  // Where a request came from, in the two forms that matter for attribution.
  // Forwarding headers are only honoured when the operator opted into a reverse
  // proxy (express only sets req.ip from them in that mode), so a spoofed
  // X-Forwarded-For cannot be laundered into the audit trail.
  requestContext(req) {
    if(!req)return {ip:null,ua:null};
    const raw=req.ip||req.socket?.remoteAddress||'';
    const ip=raw.startsWith('::ffff:')?raw.slice(7):raw;
    const ua=typeof req.headers?.['user-agent']==='string'?req.headers['user-agent']:null;
    return {ip:ip||null,ua:ua?ua.slice(0,300):null};
  }
  // Security trail. Never stores passwords, setup codes or request bodies; high-volume
  // sources (API authentication failures) collapse to one row per 5 s so a flood
  // cannot turn the log itself into a write amplification vector.
  event(kind,detail=null,urgent=false,meta=null) {
    const now=this.clock(),last=this.lastEvent.get(kind)||0;
    if(!urgent && now-last<5000)return;
    this.lastEvent.set(kind,now);
    const origin=meta?.req?this.requestContext(meta.req):{ip:meta?.ip||null,ua:meta?.ua||null};
    const row={
      kind,
      detail:detail===null?null:String(detail).slice(0,200),
      at:now,
      ip:origin.ip,ua:origin.ua,
      method:meta?.method||null,
      target:meta?.target?String(meta.target).slice(0,120):null,
    };
    this.db.prepare('INSERT INTO security_events(kind,detail,at,ip,ua,method,target) VALUES(?,?,?,?,?,?,?)')
      .run(row.kind,row.detail,row.at,row.ip,row.ua,row.method,row.target);
    if(++this.eventWrites%20===0)
      this.db.prepare('DELETE FROM security_events WHERE id NOT IN (SELECT id FROM security_events ORDER BY id DESC LIMIT 5000)').run();
    for(const listener of this.listeners){
      try{listener(row);}catch{/* A broken notification channel must not break the audit write. */}
    }
  }
  // Notification channels subscribe here instead of polling the table.
  subscribe(listener) {
    this.listeners.add(listener);
    return ()=>this.listeners.delete(listener);
  }
  events(limit) {
    const size=Math.min(Math.max(Number(limit)||100,1),2000);
    // Ordered by time, not insertion: a clock-backed list must read newest-first
    // even if rows land out of order (a restored backup, a backwards clock).
    return this.db.prepare('SELECT kind,detail,at,ip,ua,method,target FROM security_events ORDER BY at DESC, id DESC LIMIT ?').all(size)
      .map(row=>({kind:row.kind,detail:row.detail,at:new Date(row.at).toISOString(),ip:row.ip,ua:row.ua,method:row.method,target:row.target,agent:row.ua?describeAgent(row.ua):null}));
  }
  // Everything on the loopback interface is the same machine, so it shares one
  // bucket; anything else is keyed by address (or by the proxy-derived req.ip
  // when ACCOUNT_DESK_TRUST_PROXY is on). An attacker can then only lock out
  // their own source, and the operator keeps a way in.
  sourceOf(req){
    const raw=req?.ip||req?.socket?.remoteAddress||'local';
    const value=raw.startsWith('::ffff:')?raw.slice(7):raw;
    return !value||value==='::1'||value==='127.0.0.1'?'local':value;
  }
  lock(bucket='local'){
    return this.db.prepare('SELECT fails,lockUntil FROM admin_lockout_sources WHERE bucket=?').get(bucket)
      ||{fails:0,lockUntil:0};
  }
  lockRemaining(req){
    const bucket=typeof req==='string'?req:this.sourceOf(req);
    return Math.max(0,Math.ceil((this.lock(bucket).lockUntil-this.clock())/1000));
  }
  fail(req) {
    const bucket=typeof req==='string'?req:this.sourceOf(req);
    const count=Math.min(this.lock(bucket).fails+1,50);
    const cooldown=count<lockAfter?0:Math.min(lockStep*2**(count-lockAfter),lockMax);
    const now=this.clock();
    this.db.prepare(`INSERT INTO admin_lockout_sources(bucket,fails,lockUntil,updatedAt) VALUES(?,?,?,?)
      ON CONFLICT(bucket) DO UPDATE SET fails=excluded.fails,lockUntil=excluded.lockUntil,updatedAt=excluded.updatedAt`)
      .run(bucket,count,cooldown?now+cooldown:0,now);
    this.event('login_failed',cooldown?`source=${bucket} locked_seconds=${Math.round(cooldown/1000)}`:`source=${bucket} fails=${count}`,true,
      {req:typeof req==='string'?null:req,method:'password'});
  }
  succeed(req,method='password') {
    const bucket=typeof req==='string'?req:this.sourceOf(req);
    const fails=this.lock(bucket).fails;
    this.db.prepare('DELETE FROM admin_lockout_sources WHERE bucket=?').run(bucket);
    this.db.prepare('UPDATE admin_lockout SET fails=0,lockUntil=0 WHERE id=1').run();
    this.event('login_succeeded',fails?`previous_fails=${fails}`:null,true,{req:typeof req==='string'?null:req,method});
  }
  // The break-glass path when the operator is locked out and cannot produce a
  // successful login: an already-authenticated window, or `npm run admin:unlock`.
  unlockAll(req=null){
    const removed=Number(this.db.prepare('DELETE FROM admin_lockout_sources').run().changes);
    this.db.prepare('UPDATE admin_lockout SET fails=0,lockUntil=0 WHERE id=1').run();
    this.event('admin_unlocked',`sources=${removed}`,true,{req,method:req?'session':null});
    return {removed};
  }
  ensureSetupCode() {
    const stored=this.credentials().setupDigest;
    if(existsSync(this.codePath)) {
      const code=readFileSync(this.codePath,'utf8').trim();
      if(/^[A-Za-z0-9_-]{43}$/.test(code) && same(hash(code),stored))return;
    }
    const code=randomBytes(32).toString('base64url');
    writeFileSync(this.codePath,code+'\n',{mode:0o600});chmodSync(this.codePath,0o600);
    this.db.prepare('UPDATE admin_credentials SET setupDigest=? WHERE id=1').run(hash(code));
  }
  reset() {
    this.store.transaction(()=>{
      this.db.exec('DELETE FROM admin_sessions; DELETE FROM admin_totp; DELETE FROM admin_recovery; DELETE FROM admin_lockout_sources; UPDATE admin_credentials SET username=NULL,salt=NULL,passwordHash=NULL,setupDigest=NULL,version=version+1 WHERE id=1; UPDATE admin_login_limits SET window=0,count=0 WHERE id=1; UPDATE admin_lockout SET fails=0,lockUntil=0 WHERE id=1;');
    });
    this.event('admin_reset',null,true);
    this.ensureSetupCode();
  }
  consumeAttempt(req) {
    const bucket=typeof req==='string'?req:this.sourceOf(req);
    const locked=this.lockRemaining(bucket);
    if(locked) {
      const error=new AppError('尝试次数过多，登录已临时锁定',429);
      error.retryAfter=locked;this.event('login_locked',`source=${bucket} remaining_seconds=${locked}`,false,{req:typeof req==='string'?null:req});throw error;
    }
    const window=Math.floor(this.clock()/60000),previous=this.db.prepare('SELECT * FROM admin_login_limits WHERE id=1').get();
    const count=previous.window===window?previous.count:0;
    if(count>=globalAttemptsPerMinute || this.inFlight>=2) {
      const error=new AppError('尝试过于频繁，请稍后重试',429);
      error.retryAfter=this.inFlight>=2?2:Math.max(1,Math.ceil(((window+1)*60000-this.clock())/1000));throw error;
    }
    this.db.prepare('UPDATE admin_login_limits SET window=?,count=? WHERE id=1').run(window,count+1);
  }
  async derive(password,salt,version=currentKdf){this.inFlight++;try{return (await scryptAsync(password,Buffer.from(salt,'hex'),64,kdf[version]||kdf[1])).toString('hex');}finally{this.inFlight--;}}
  hashVersion(credential){return credential?.hashVersion===currentKdf?currentKdf:1;}
  // Re-hash a verified legacy password. The credential `version` is left untouched so
  // concurrent login/change-password checks still observe the same snapshot; if another
  // writer won in between, the guarded UPDATE simply matches no row.
  async upgrade(password,credential) {
    if(this.hashVersion(credential)===currentKdf)return;
    const salt=randomBytes(32).toString('hex'),passwordHash=await this.derive(password,salt);
    this.db.prepare('UPDATE admin_credentials SET salt=?,passwordHash=?,hashVersion=? WHERE id=1 AND version=?')
      .run(salt,passwordHash,currentKdf,credential.version);
  }
  createSession(req,method='password') {
    if(!this.credentials().username)throw new AppError('请先设置管理员',401);
    this.cleanup();
    // Order by activity rather than creation: a window used five minutes ago is
    // more relevant than one opened yesterday and never touched since.
    const pruned=this.db.prepare(`DELETE FROM admin_sessions WHERE digest NOT IN (
      SELECT digest FROM admin_sessions ORDER BY COALESCE(NULLIF(lastSeenAt,0),createdAt) DESC, rowid DESC LIMIT ?
    )`).run(sessionLimit-1);
    if(Number(pruned.changes)>0)this.event('sessions_pruned',`removed=${pruned.changes}`,false,{req});
    const token=randomBytes(32).toString('base64url'),now=this.clock();
    const {ip,ua}=this.requestContext(req);
    this.db.prepare('INSERT INTO admin_sessions(digest,createdAt,expiresAt,lastSeenAt,ip,ua,method) VALUES(?,?,?,?,?,?,?)')
      .run(hash(token),now,now+lifetime,now,ip,ua,method);
    return token;
  }
  secure(req){
    if(this.adminOrigin && new URL(this.adminOrigin).protocol==='https:' && req.headers.host===new URL(this.adminOrigin).host)return true;
    // Behind a TLS-terminating proxy the browser still speaks https, so the
    // cookie has to be marked Secure even though this hop is plain HTTP.
    return this.trustProxy && req.headers['x-forwarded-proto']==='https';
  }
  cookieName(req){return this.secure(req)?'__Host-ad_session':'ad_session';}
  token(req) {
    const values=(req.headers.cookie || '').split(';').map(value=>value.trim()).filter(value=>value.startsWith(this.cookieName(req)+'='));
    if(values.length!==1)return null;
    const value=values[0].slice(values[0].indexOf('=')+1);
    return /^[A-Za-z0-9_-]{43}$/.test(value)?value:null;
  }
  // Absolute lifetime is capped by expiresAt; an unused session additionally dies
  // after idleLimit so a copied cookie does not stay usable for a whole workday.
  session(req) {
    const token=this.token(req);
    if(!token)return null;
    const digest=hash(token),now=this.clock();
    const row=this.db.prepare('SELECT createdAt,lastSeenAt FROM admin_sessions WHERE digest=? AND expiresAt>?').get(digest,now);
    if(!row)return null;
    const seen=row.lastSeenAt||row.createdAt;
    if(now-seen>idleLimit){this.db.prepare('DELETE FROM admin_sessions WHERE digest=?').run(digest);return null;}
    if(now-seen>idleTouchMs)this.db.prepare('UPDATE admin_sessions SET lastSeenAt=? WHERE digest=?').run(now,digest);
    return token;
  }
  sessions(req) {
    const current=this.session(req),now=this.clock();
    const rows=this.db.prepare('SELECT digest,createdAt,lastSeenAt,expiresAt,ip,ua,method FROM admin_sessions WHERE expiresAt>? ORDER BY createdAt DESC').all(now);
    return rows.map(row=>{
      const tokenMatches=current && hash(current)===row.digest;
      return {
        id:row.digest.slice(0,12),
        createdAt:new Date(row.createdAt).toISOString(),
        lastSeenAt:new Date(row.lastSeenAt||row.createdAt).toISOString(),
        expiresAt:new Date(row.expiresAt).toISOString(),
        ip:row.ip||null,
        ua:row.ua||null,
        agent:row.ua?describeAgent(row.ua):null,
        method:row.method||null,
        current:!!tokenMatches,
      };
    });
  }
  // Revoking everything else is the first thing to do when a session may have
  // leaked. Targeted revocation matters just as much: the operator usually wants
  // to keep their own window and drop the one that appeared at 3 a.m.
  revokeOne(req,id) {
    const current=this.session(req);
    if(!current)throw new AppError('请先登录后台',401);
    if(typeof id!=='string' || !/^[a-f0-9]{12}$/.test(id))throw new AppError('会话标识无效',400);
    if(hash(current).startsWith(id))throw new AppError('不能下线当前会话，请直接退出登录',400);
    const result=this.db.prepare('DELETE FROM admin_sessions WHERE digest LIKE ?').run(id+'%');
    if(!Number(result.changes))throw new AppError('该会话已不存在',404);
    this.event('session_revoked',`id=${id}`,true,{req,method:'session'});
    return {removed:Number(result.changes)};
  }
  // Revoking everything else is the first thing to do when a session may have leaked.
  revokeOthers(req) {
    const current=this.session(req);
    if(!current)throw new AppError('请先登录后台',401);
    const result=this.db.prepare('DELETE FROM admin_sessions WHERE digest<>?').run(hash(current));
    this.event('sessions_revoked',`removed=${result.changes}`,true,{req,method:'session'});
    return {removed:Number(result.changes)};
  }
  // ---- Optional second factor (TOTP) ----
  totpRecord(){return this.db.prepare('SELECT * FROM admin_totp WHERE id=1').get()||null;}
  totpEnabled(){const row=this.totpRecord();return !!row && row.enabledAt>0;}
  // Returns the time step the code belongs to (0 is not a valid step), or null.
  // The step is what makes replay detection possible.
  verifyTotp(secret,code) {
    if(typeof code!=='string')return null;
    const value=code.trim();
    if(!/^\d{6}$/.test(value))return null;
    const step=Math.floor(this.clock()/totpStepMs);
    for(let offset=-totpDrift;offset<=totpDrift;offset++)
      if(same(totpCode(secret,(step+offset)*totpStepMs).code,value))return step+offset;
    return null;
  }
  recoveryDigest(code) {
    const normalized=String(code||'').replace(/[^A-Za-z0-9]/g,'').toUpperCase();
    return normalized.length===10?hash('recovery:'+normalized):null;
  }
  // Accepts a TOTP or a single-use recovery code; recovery codes are burnt here.
  consumeSecondFactor(code,row) {
    if(!row)return null;
    const step=this.verifyTotp(decrypt(row.secret,this.store.key),code);
    if(step){
      // A code is only valid for its own step. Without this, a code seen over a
      // shoulder or captured in a log stays reusable for the rest of its window.
      // The guarded UPDATE makes the check atomic against two parallel submits.
      const changed=this.db.prepare('UPDATE admin_totp SET lastStep=? WHERE id=1 AND lastStep<>?')
        .run(step,step).changes;
      if(Number(changed)===0)return null;
      return 'totp';
    }
    const digest=this.recoveryDigest(code);
    if(!digest)return null;
    const entry=this.db.prepare('SELECT usedAt FROM admin_recovery WHERE digest=?').get(digest);
    if(!entry || entry.usedAt)return null;
    this.db.prepare('UPDATE admin_recovery SET usedAt=? WHERE digest=?').run(this.clock(),digest);
    this.event('recovery_code_used',null,true);
    return 'recovery';
  }
  // A staged secret: nothing is enforced until enable() sees a working code, so a
  // half-finished setup can never lock the operator out.
  startTotp(req) {
    this.require(req);
    // 160 bits of entropy, the RFC 4226 recommendation for a shared secret.
    const secret=Array.from(randomBytes(32),byte=>base32[byte%32]).join('');
    this.db.prepare(`INSERT INTO admin_totp(id,secret,enabledAt,createdAt,lastStep) VALUES(1,?,0,?,0)
      ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,enabledAt=0,createdAt=excluded.createdAt,lastStep=0`)
      .run(encrypt(secret,this.store.key),this.clock());
    const label=encodeURIComponent(`Account Desk:${this.credentials().username||'admin'}`);
    return {
      secret,
      uri:`otpauth://totp/${label}?secret=${secret}&issuer=Account%20Desk&algorithm=SHA1&digits=6&period=30`,
    };
  }
  enableTotp(req,body) {
    record(body);this.require(req);
    const row=this.totpRecord();
    if(!row)throw new AppError('请先生成两步验证密钥',400);
    if(row.enabledAt>0)throw new AppError('两步验证已启用',409);
    if(!this.verifyTotp(decrypt(row.secret,this.store.key),body.code))throw new AppError('验证码不正确，请检查手机上的动态码',400);
    const codes=Array.from({length:recoveryCount},()=>Array.from(randomBytes(10),byte=>base32[byte%32]).join(''));
    this.store.transaction(()=>{
      this.db.prepare('UPDATE admin_totp SET enabledAt=? WHERE id=1').run(this.clock());
      this.db.prepare('DELETE FROM admin_recovery').run();
      const insert=this.db.prepare('INSERT INTO admin_recovery(digest,usedAt) VALUES(?,0)');
      for(const code of codes)insert.run(hash('recovery:'+code));
    });
    this.event('totp_enabled',null,true,{req,method:'session'});
    return {recoveryCodes:codes};
  }
  async disableTotp(req,body) {
    record(body);this.require(req);this.consumeAttempt(req);
    const before=this.credentials();
    if(typeof body.password!=='string' || !before.passwordHash)throw new AppError('请输入登录密码',400);
    const derived=await this.derive(body.password,before.salt,this.hashVersion(before));
    if(!same(derived,before.passwordHash)){this.fail(req);throw new AppError('密码不正确',401);}
    const row=this.totpRecord();
    if(row && row.enabledAt>0 && !this.consumeSecondFactor(body.code,row))
      throw new AppError('请输入当前动态验证码或恢复码',400);
    this.store.transaction(()=>{
      this.db.prepare('DELETE FROM admin_totp').run();
      this.db.prepare('DELETE FROM admin_recovery').run();
    });
    this.event('totp_disabled',null,true,{req,method:'session'});
    return {ok:true};
  }
  // ---- Step-up authentication for credential reads ----
  grant(req) {
    const value=typeof req.headers['x-reauth-token']==='string'?req.headers['x-reauth-token']:null;
    if(!value || !/^[A-Za-z0-9_-]{43}$/.test(value))return false;
    const session=this.session(req);
    if(!session)return false;
    return !!this.db.prepare('SELECT 1 FROM admin_reauth WHERE digest=? AND sessionDigest=? AND expiresAt>? AND uses<?')
      .get(hash(value),hash(session),this.clock(),reauthMaxUses);
  }
  requireGrant(req) {
    if(this.grant(req))return;
    const error=new AppError('读取明文凭据前请重新确认登录密码',403);
    error.code='REAUTH_REQUIRED';throw error;
  }
  // Counted only after something was actually read: a rejected request (bad
  // ids, empty selection) must not burn the operator's allowance.
  consumeGrant(req) {
    const value=req.headers['x-reauth-token'];
    if(typeof value!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(value))return;
    // A grant proves the human just typed the password; it is not a licence to
    // dump the book. Capping uses limits the blast radius of a stolen token.
    this.db.prepare('UPDATE admin_reauth SET uses=uses+1 WHERE digest=?').run(hash(value));
  }
  async reauth(req,body) {
    record(body);
    const token=this.require(req),before=this.credentials();
    this.consumeAttempt(req);
    if(typeof body.password!=='string' || !before.passwordHash)throw new AppError('密码不正确',401);
    if(body.password.length>128){this.fail(req);throw new AppError('密码不正确',401);}
    const derived=await this.derive(body.password,before.salt,this.hashVersion(before));
    if(!same(derived,before.passwordHash)) {
      this.fail(req);this.event('reauth_failed',null,true,{req,method:'password'});
      throw new AppError('密码不正确',401);
    }
    const second=this.totpRecord();
    if(second && second.enabledAt>0) {
      const code=typeof body.code==='string'?body.code:'';
      if(!code) {
        const error=new AppError('请输入两步验证码',403);
        error.code='TOTP_REQUIRED';throw error;
      }
      if(!this.consumeSecondFactor(code,second)) {
        this.fail(req);this.event('totp_failed',null,true,{req});
        throw new AppError('两步验证码不正确',401);
      }
    }
    this.db.prepare('UPDATE admin_lockout SET fails=0,lockUntil=0 WHERE id=1').run();
    this.db.prepare('DELETE FROM admin_lockout_sources WHERE bucket=?').run(this.sourceOf(req));
    const value=randomBytes(32).toString('base64url'),now=this.clock();
    this.db.prepare('DELETE FROM admin_reauth WHERE expiresAt<=?').run(now);
    this.db.prepare('INSERT INTO admin_reauth(digest,sessionDigest,expiresAt,uses) VALUES(?,?,?,0)')
      .run(hash(value),hash(token),now+reauthLifetime);
    return {token:value,expiresAt:new Date(now+reauthLifetime).toISOString(),seconds:reauthLifetime/1000,maxUses:reauthMaxUses};
  }
  // Structured trail for the two endpoints that hand out plaintext. The security
  // event gives an at-a-glance line in the panel; this table keeps account-level
  // detail so "who read what, and how many rows left the machine" stays answerable.
  auditCredential(action,{accountId=null,accountLabel=null,count=1,req}={}) {
    const now=this.clock(),token=req?this.session(req):null;
    const sessionRef=token?hash(token).slice(0,12):null;
    const {ip,ua}=this.requestContext(req);
    this.db.prepare('INSERT INTO credential_access(at,action,accountId,accountLabel,accountCount,sessionRef,ip,ua) VALUES(?,?,?,?,?,?,?,?)')
      .run(now,action,accountId,accountLabel,count,sessionRef,ip,ua);
    this.db.prepare('DELETE FROM credential_access WHERE id NOT IN (SELECT id FROM credential_access ORDER BY id DESC LIMIT ?)').run(credentialAuditLimit);
    this.event(action==='export'?'credential_export':'credential_read',
      `${accountLabel||'多个账号'} count=${count}`,false,{req,method:'session',target:accountLabel});
  }
  credentialAccess(limit) {
    const size=Math.min(Math.max(Number(limit)||50,1),500);
    return this.db.prepare('SELECT action,accountLabel,accountCount,at,ip,ua FROM credential_access ORDER BY at DESC, id DESC LIMIT ?').all(size)
      .map(row=>({action:row.action,label:row.accountLabel,count:row.accountCount,at:new Date(row.at).toISOString(),ip:row.ip,ua:row.ua,agent:row.ua?describeAgent(row.ua):null}));
  }
  csrf(token){return createHmac('sha256',this.store.key).update('admin-csrf:'+token).digest('hex');}
  state(token, req) {
    const credential=this.credentials(),locked=this.lockRemaining(req);
    return {initialized:!!credential.username,authenticated:!!token,totpEnabled:this.totpEnabled(),...(locked?{lockedFor:locked}:{}),...(token?{username:credential.username,csrfToken:this.csrf(token)}:{})};
  }
  cookie(res,req,token) {
    const options={httpOnly:true,sameSite:'strict',secure:this.secure(req),path:'/'};
    if(token)res.cookie(this.cookieName(req),token,{...options,maxAge:lifetime});
    else res.clearCookie(this.cookieName(req),options);
  }
  require(req) {
    const token=this.session(req);
    if(!token)throw new AppError('请先登录后台',401);
    if(!['GET','HEAD'].includes(req.method) && !same(req.headers['x-csrf-token'],this.csrf(token))) {
      const error=new AppError('登录状态已变化，请刷新后重试',403);error.code='AUTH_CSRF';throw error;
    }
    return token;
  }
  async setup(body, req) {
    record(body);const before=this.credentials();if(before.username)throw new AppError('管理员已设置，请登录',409);
    this.consumeAttempt(req);
    if(typeof body.setupCode!=='string' || body.setupCode.length>128 || !same(hash(body.setupCode),before.setupDigest))throw new AppError('一次性设置码无效',401);
    if(typeof body.username!=='string' || !/^[A-Za-z0-9_.@-]{3,40}$/.test(body.username))throw new AppError('管理员账号须为 3–40 位字母、数字或 _ . @ -');
    passwordValid(body.password);const salt=randomBytes(32).toString('hex'),passwordHash=await this.derive(body.password,salt);
    const token=this.store.transaction(()=>{
      const current=this.credentials();
      if(current.username || current.version!==before.version || current.setupDigest!==before.setupDigest)throw new AppError('设置状态已变化，请刷新',409);
      this.db.prepare('UPDATE admin_credentials SET username=?,salt=?,passwordHash=?,hashVersion=?,setupDigest=NULL,version=version+1 WHERE id=1').run(body.username,salt,passwordHash,currentKdf);
      return this.createSession(req,'setup');
    });
    try{unlinkSync(this.codePath);}catch{/* A leftover setup code is invalid once the database digest is cleared. */}
    this.db.prepare('UPDATE admin_lockout SET fails=0,lockUntil=0 WHERE id=1').run();
    this.event('admin_initialized',body.username,true,{req,method:'setup',target:body.username});
    return token;
  }
  async login(body, req) {
    record(body);this.consumeAttempt(req);const before=this.credentials();
    if(typeof body.password!=='string' || body.password.length>128){this.fail(req);throw new AppError('账号或密码不正确',401);}
    // Spend one scrypt run even when the supplied username is wrong: comparing the
    // username first would make a valid account measurably slower to reject.
    if(!before.username){await this.derive(body.password,dummySalt);this.fail(req);throw new AppError('账号或密码不正确',401);}
    const result=await this.derive(body.password,before.salt,this.hashVersion(before));
    const usernameOk=typeof body.username==='string' && body.username===before.username;
    const passwordOk=same(result,before.passwordHash);
    if(!usernameOk || !passwordOk || this.credentials().version!==before.version){this.fail(req);throw new AppError('账号或密码不正确',401);}
    // Password verified. A missing second factor is not a failed attempt (the
    // caller simply has not been asked yet); a wrong one counts toward lockout.
    let method='password';
    const second=this.totpRecord();
    if(second && second.enabledAt>0) {
      const code=typeof body.code==='string'?body.code:'';
      if(!code) {
        const error=new AppError('请输入两步验证码',403);
        error.code='TOTP_REQUIRED';throw error;
      }
      const factor=this.consumeSecondFactor(code,second);
      if(!factor) {
        this.fail(req);this.event('totp_failed',null,true,{req});throw new AppError('两步验证码不正确',401);
      }
      method=factor==='recovery'?'password+recovery':'password+totp';
    }
    await this.upgrade(body.password,before);
    this.succeed(req,method);
    return this.createSession(req,method);
  }
  async changePassword(req,body) {
    record(body);const oldToken=this.require(req),before=this.credentials();this.consumeAttempt(req);passwordValid(body.newPassword);
    if(typeof body.currentPassword!=='string' || body.currentPassword.length>128)throw new AppError('当前密码不正确',400);
    const oldHash=await this.derive(body.currentPassword,before.salt,this.hashVersion(before));
    if(!same(oldHash,before.passwordHash))throw new AppError('当前密码不正确',400);
    const salt=randomBytes(32).toString('hex'),passwordHash=await this.derive(body.newPassword,salt);
    const token=this.store.transaction(()=>{
      if(this.session(req)!==oldToken || this.credentials().version!==before.version)throw new AppError('登录状态已失效，请重新登录',401);
      this.db.prepare('UPDATE admin_credentials SET salt=?,passwordHash=?,hashVersion=?,version=version+1 WHERE id=1').run(salt,passwordHash,currentKdf);
      this.db.exec('DELETE FROM admin_sessions');return this.createSession(req,'password');
    });
    this.db.prepare('UPDATE admin_lockout SET fails=0,lockUntil=0 WHERE id=1').run();
    this.event('password_changed',null,true,{req,method:'session'});
    return token;
  }
  routes() {
    const router=express.Router();router.use(express.json({limit:'8kb'}));
    router.get('/status',(req,res)=>res.json(this.state(this.session(req),req)));
    router.post('/setup',async(req,res)=>{const token=await this.setup(req.body,req);this.cookie(res,req,token);res.status(201).json(this.state(token,req));});
    router.post('/login',async(req,res)=>{const token=await this.login(req.body,req);this.cookie(res,req,token);res.json(this.state(token,req));});
    router.post('/logout',(req,res)=>{const token=this.require(req);this.db.prepare('DELETE FROM admin_sessions WHERE digest=?').run(hash(token));this.cookie(res,req,null);res.json({ok:true});});
    router.post('/password',async(req,res)=>{const token=await this.changePassword(req,req.body);this.cookie(res,req,token);res.json(this.state(token,req));});
    // Clearing a lockout needs a working session, which is exactly what the
    // operator may have lost. `npm run admin:unlock` covers that case; this
    // endpoint covers the far more common "another tab is still signed in".
    router.post('/unlock',(req,res)=>{this.require(req);res.json(this.unlockAll(req));});
    // Session inventory and bulk revocation: the fastest response to a suspected leak.
    router.get('/sessions',(req,res)=>{this.require(req);res.json({sessions:this.sessions(req)});});
    router.delete('/sessions',(req,res)=>{this.require(req);res.json(this.revokeOthers(req));});
    router.delete('/sessions/:id',(req,res)=>{this.require(req);res.json(this.revokeOne(req,req.params.id));});
    router.get('/events',(req,res)=>{this.require(req);res.json({events:this.events(req.query.limit)});});
    // Step-up grant: the caller must already hold a session, and the grant is
    // bound to that session, so it cannot be lifted into another browser.
    router.post('/reauth',async(req,res)=>{const grant=await this.reauth(req,req.body);res.json(grant);});
    router.get('/credentials',(req,res)=>{this.require(req);res.json({entries:this.credentialAccess(req.query.limit)});});
    router.post('/totp/setup',(req,res)=>res.json(this.startTotp(req)));
    router.post('/totp/enable',(req,res)=>res.json(this.enableTotp(req,req.body)));
    router.post('/totp/disable',async(req,res)=>res.json(await this.disableTotp(req,req.body)));
    router.use((req,res)=>res.status(404).json({error:'接口不存在'}));return router;
  }
}
