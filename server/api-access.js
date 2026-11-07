import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { AppError } from './store.js';
import { parseImport } from './parser.js';

const scopes = ['accounts:import', 'organization:read'];
const keyColumns = 'id,name,prefix,scopes,enabled,expiresAt,createdAt,lastUsedAt,requestCount,groupId';
const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function only(body, fields) {
  if (!object(body) || Object.keys(body).some(key => !fields.includes(key))) throw new AppError('请求包含无效字段');
}

export class ApiAccess {
  constructor(store, { apiClock = Date.now, onEvent, writeBudgetPerMinute = 12000 } = {}) {
    this.store = store; this.db = store.db; this.clock = apiClock; this.onEvent = onEvent || (() => {});
    this.writeBudget = Number.isInteger(writeBudgetPerMinute) && writeBudgetPerMinute > 0 ? writeBudgetPerMinute : 12000;
    this.db.exec(`CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL,
      digest TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      expiresAt TEXT, createdAt TEXT NOT NULL, lastUsedAt TEXT, requestCount INTEGER NOT NULL DEFAULT 0,
      rateWindow INTEGER NOT NULL DEFAULT 0, rateCount INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS api_import_receipts (
      keyId TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      requestId TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, expiresAt INTEGER NOT NULL,
      PRIMARY KEY(keyId,requestId)
    );
    CREATE INDEX IF NOT EXISTS api_receipt_expiry ON api_import_receipts(expiresAt);`);
    if (!this.db.prepare('PRAGMA table_info(api_keys)').all().some(column=>column.name==='groupId'))
      this.db.exec('ALTER TABLE api_keys ADD COLUMN groupId TEXT REFERENCES account_groups(id) ON DELETE SET NULL');
    if (!this.db.prepare('PRAGMA table_info(api_keys)').all().some(column=>column.name==='writeWindow'))
      this.db.exec('ALTER TABLE api_keys ADD COLUMN writeWindow INTEGER NOT NULL DEFAULT 0; ALTER TABLE api_keys ADD COLUMN writeCount INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`CREATE TABLE IF NOT EXISTS api_key_tags (
      keyId TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
      tagId TEXT NOT NULL REFERENCES account_tags(id) ON DELETE CASCADE,
      PRIMARY KEY(keyId,tagId)
    );`);
    this.cleanup();
  }
  cleanup() { this.db.prepare('DELETE FROM api_import_receipts WHERE expiresAt<=?').run(this.clock()); }
  present(row) {
    const { digest: ignored, rateWindow, rateCount, writeWindow, writeCount, ...safe } = row;
    return { ...safe, scopes: JSON.parse(row.scopes), enabled: !!row.enabled,
      tagIds:this.db.prepare('SELECT tagId FROM api_key_tags WHERE keyId=? ORDER BY tagId').all(row.id).map(value=>value.tagId),
      status: !row.enabled ? 'disabled' : row.expiresAt && Date.parse(row.expiresAt) <= this.clock() ? 'expired' : 'active' };
  }
  list() { return this.db.prepare(`SELECT ${keyColumns} FROM api_keys ORDER BY createdAt DESC,rowid DESC`).all().map(row=>this.present(row)); }
  validate(body, previous) {
    only(body, ['name','scopes','enabled','expiresAt','groupId','tagIds']);
    const name = body.name === undefined ? previous?.name : typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 60) throw new AppError('密钥名称须为 1–60 字');
    const permissions = body.scopes === undefined ? previous?.scopes ?? scopes : body.scopes;
    if (!Array.isArray(permissions) || !permissions.length || permissions.length>2 || permissions.some(s=>!scopes.includes(s))) throw new AppError('请选择有效权限');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new AppError('启用状态无效');
    let expiresAt = body.expiresAt === undefined ? previous?.expiresAt ?? null : body.expiresAt;
    if (expiresAt !== null) {
      if (typeof expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt))) throw new AppError('有效期须为带时区的时间');
      expiresAt = new Date(expiresAt).toISOString();
      if (body.expiresAt !== undefined && Date.parse(expiresAt)<=this.clock()) throw new AppError('有效期必须晚于当前时间');
    }
    const groupId=body.groupId===undefined?previous?.groupId ?? null:body.groupId;
    const tagIds=body.tagIds===undefined?previous?.tagIds ?? []:body.tagIds;
    this.store.organization.validate({groupId,tagIds});
    return {name,scopes:[...new Set(permissions)],enabled:body.enabled ?? previous?.enabled ?? true,expiresAt,groupId,tagIds:[...new Set(tagIds)]};
  }
  assignTags(id,tagIds) {
    this.db.prepare('DELETE FROM api_key_tags WHERE keyId=?').run(id);
    const insert=this.db.prepare('INSERT INTO api_key_tags(keyId,tagId) VALUES(?,?)');
    for(const tagId of tagIds)insert.run(id,tagId);
  }
  create(body) {
    const value=this.validate(body);
    if (this.db.prepare('SELECT count(*) AS n FROM api_keys').get().n>=100) throw new AppError('最多保留 100 把密钥，请删除不用的密钥',409);
    const secret=`adk_${randomBytes(32).toString('base64url')}`, id=randomUUID();
    return this.store.transaction(()=>{
      this.db.prepare('INSERT INTO api_keys(id,name,prefix,digest,scopes,enabled,expiresAt,createdAt,groupId) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id,value.name,secret.slice(0,12),digest(secret),JSON.stringify(value.scopes),Number(value.enabled),value.expiresAt,new Date(this.clock()).toISOString(),value.groupId);
      this.assignTags(id,value.tagIds);
      return {key:this.get(id),secret};
    });
  }
  get(id) {
    const row=this.db.prepare(`SELECT ${keyColumns} FROM api_keys WHERE id=?`).get(id);
    if (!row) throw new AppError('密钥不存在',404);
    return this.present(row);
  }
  update(id,body) {
    const value=this.validate(body,this.get(id));
    return this.store.transaction(()=>{
      this.db.prepare('UPDATE api_keys SET name=?,scopes=?,enabled=?,expiresAt=?,groupId=? WHERE id=?').run(value.name,JSON.stringify(value.scopes),Number(value.enabled),value.expiresAt,value.groupId,id);
      this.assignTags(id,value.tagIds);
      return this.get(id);
    });
  }
  delete(id) { this.get(id); this.db.prepare('DELETE FROM api_keys WHERE id=?').run(id); return {ok:true}; }
  authorize(id,scope) {
    const row=this.db.prepare('SELECT enabled,expiresAt,scopes FROM api_keys WHERE id=?').get(id);
    if (!row || !row.enabled || (row.expiresAt && Date.parse(row.expiresAt)<=this.clock())) throw new AppError('API 密钥无效、已停用或已过期',401);
    if (!JSON.parse(row.scopes).includes(scope)) throw new AppError('此密钥没有该接口的权限',403);
  }
  authenticate(header,scope,meta=null) {
    try{ return this.#authenticate(header,scope); }
    catch(error){
      // A leaked or guessed key shows up here before it shows up in the data.
      if(error.status===401)this.onEvent('api_key_rejected','invalid_or_expired',meta);
      else if(error.status===403)this.onEvent('api_key_scope_denied',scope,meta);
      throw error;
    }
  }
  #authenticate(header,scope) {
    const match=typeof header==='string' && /^Bearer (adk_[A-Za-z0-9_-]{43})$/i.exec(header);
    const row=match && this.db.prepare('SELECT * FROM api_keys WHERE digest=?').get(digest(match[1]));
    const now=this.clock();
    if (!row || !row.enabled || (row.expiresAt && Date.parse(row.expiresAt)<=now)) throw new AppError('API 密钥无效、已停用或已过期',401);
    const window=Math.floor(now/60000),count=row.rateWindow===window?row.rateCount:0;
    if (count>=60) { const error=new AppError('请求过于频繁，请稍后重试',429);error.retryAfter=Math.max(1,Math.ceil(((window+1)*60000-now)/1000));throw error; }
    this.db.prepare('UPDATE api_keys SET lastUsedAt=?,requestCount=requestCount+1,rateWindow=?,rateCount=? WHERE id=?').run(new Date(now).toISOString(),window,count+1,row.id);
    if (!JSON.parse(row.scopes).includes(scope)) throw new AppError('此密钥没有该接口的权限',403);
    return row.id;
  }
  // The write budget is counted in rows, not in calls: a batch job sending many
  // small imports is never blocked by an arbitrary call count, while a single
  // 1000-row import costs 1000 rows of budget.
  throttleWrite(id, rows = 1) {
    const now=this.clock(),window=Math.floor(now/60000);
    const cost=Math.min(Math.max(1,Number.isFinite(rows)?Math.floor(rows):1),this.writeBudget);
    const row=this.db.prepare('SELECT writeWindow,writeCount FROM api_keys WHERE id=?').get(id);
    if(!row)throw new AppError('API 密钥无效、已停用或已过期',401);
    const used=row.writeWindow===window?row.writeCount:0;
    if(used+cost>this.writeBudget){
      const error=new AppError(`写入量超过每分钟上限（${this.writeBudget} 条），请稍后重试`,429);
      error.retryAfter=Math.max(1,Math.ceil(((window+1)*60000-now)/1000));
      this.onEvent('api_write_throttled',id);
      throw error;
    }
    this.db.prepare('UPDATE api_keys SET writeWindow=?,writeCount=? WHERE id=?').run(window,used+cost,id);
  }
  import(keyId,body,requestId) {
    only(body,['accounts','text','notes']);
    if (Object.hasOwn(body,'accounts')===Object.hasOwn(body,'text')) throw new AppError('accounts 与 text 必须且只能提供一种');
    if (requestId!==undefined && (typeof requestId!=='string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestId))) throw new AppError('Idempotency-Key 须为 8–128 位字母、数字或 . _ : -');
    this.throttleWrite(keyId, Array.isArray(body.accounts) ? body.accounts.length : typeof body.text==='string' ? body.text.split('\n').filter(line=>line.trim()).length : 1);
    const fingerprint=createHmac('sha256',this.store.key).update(JSON.stringify(body)).digest('hex');
    this.cleanup();
    return this.store.transaction(()=>{
      if (requestId) {
        const previous=this.db.prepare('SELECT fingerprint,result FROM api_import_receipts WHERE keyId=? AND requestId=?').get(keyId,requestId);
        if (previous) { if (previous.fingerprint!==fingerprint) throw new AppError('此请求编号已用于不同内容，请使用新的编号',409);return JSON.parse(previous.result); }
        const receipts=this.db.prepare('SELECT count(*) AS n,min(expiresAt) AS nextExpiry FROM api_import_receipts WHERE keyId=?').get(keyId);
        if (receipts.n>=100) {
          const error=new AppError('此密钥的幂等请求已达 24 小时上限（100 次），请等待已有结果过期',429);
          error.retryAfter=Math.max(1,Math.ceil((receipts.nextExpiry-this.clock())/1000));throw error;
        }
      }
      const binding=this.get(keyId);
      const defaults={groupId:binding.groupId,tagIds:binding.tagIds,notes:body.notes};
      this.store.organization.validate(defaults);
      if (body.notes!==undefined && (typeof body.notes!=='string' || body.notes.length>2000)) throw new AppError('备注不得超过 2000 字');
      let records,results=[];
      if (Object.hasOwn(body,'text')) {
        let parsed;try { parsed=parseImport(body.text); } catch(error) { throw new AppError(error.message); }
        records=parsed.records.map(({line,...record})=>({line,record}));
        results=parsed.errors.map(({line,message})=>({line,status:'failed',message}));
      } else {
        if (!Array.isArray(body.accounts) || !body.accounts.length || body.accounts.length>1000) throw new AppError('accounts 须包含 1–1000 个账号');
        records=body.accounts.map((record,i)=>({line:i+1,record}));
      }
      if (!records.length && !results.length) throw new AppError('导入内容不能为空');
      for (const {line,record} of records) {
        // A row-level savepoint keeps partial validation failures from leaving account/tag fragments.
        this.db.exec('SAVEPOINT api_row');
        try {
          only(record,['email','username','password','totp','notes']);
          const id=this.store.insertAccount({...defaults,...record});
          this.db.exec('RELEASE api_row');
          results.push({line,status:'imported',id});
        } catch(error) {
          this.db.exec('ROLLBACK TO api_row; RELEASE api_row');
          if (!(error instanceof AppError)) throw error;
          results.push({line,status:error.status===409?'duplicate':'failed',message:error.message});
        }
      }
      results.sort((a,b)=>a.line-b.line);
      const result={imported:results.filter(r=>r.status==='imported').length,duplicates:results.filter(r=>r.status==='duplicate').length,failed:results.filter(r=>r.status==='failed').length,results};
      if (requestId) this.db.prepare('INSERT INTO api_import_receipts(keyId,requestId,fingerprint,result,expiresAt) VALUES(?,?,?,?,?)').run(keyId,requestId,fingerprint,JSON.stringify(result),this.clock()+86400000);
      return result;
    });
  }
}
