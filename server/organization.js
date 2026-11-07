import { randomUUID } from 'node:crypto';
import { AppError } from './store.js';

export class Organization {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE);
      CREATE TABLE IF NOT EXISTS account_tags (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, color TEXT NOT NULL DEFAULT 'blue');
      CREATE TABLE IF NOT EXISTS account_group_links (accountId TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, groupId TEXT NOT NULL REFERENCES account_groups(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS account_tag_links (accountId TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, tagId TEXT NOT NULL REFERENCES account_tags(id) ON DELETE CASCADE, PRIMARY KEY(accountId,tagId));
      CREATE INDEX IF NOT EXISTS account_group_source ON account_group_links(groupId);
      CREATE INDEX IF NOT EXISTS account_tag_source ON account_tag_links(tagId);
    `);
  }
  table(kind) {
    if (!['groups', 'tags'].includes(kind)) throw new AppError('分类类型无效');
    return kind === 'groups' ? 'account_groups' : 'account_tags';
  }
  list() {
    return {
      groups: this.db.prepare(`SELECT g.*, (SELECT count(*) FROM account_group_links l JOIN accounts a ON a.id=l.accountId WHERE l.groupId=g.id AND a.deletedAt IS NULL) AS count FROM account_groups g ORDER BY name COLLATE NOCASE`).all(),
      tags: this.db.prepare(`SELECT t.*, (SELECT count(*) FROM account_tag_links l JOIN accounts a ON a.id=l.accountId WHERE l.tagId=t.id AND a.deletedAt IS NULL) AS count FROM account_tags t ORDER BY name COLLATE NOCASE`).all(),
    };
  }
  save(kind, body, id) {
    const table = this.table(kind);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 40) throw new AppError('名称须为 1–40 字');
    const color = body?.color ?? 'blue';
    if (!['blue','teal','violet','amber','rose','slate'].includes(color)) throw new AppError('标签颜色无效');
    return this.store.transaction(() => {
      if (id && !this.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(id)) throw new AppError('分组或标签已不存在，请刷新', 404);
      if (this.db.prepare(`SELECT id FROM ${table} WHERE name=? AND id<>?`).get(name, id || '')) throw new AppError('名称已存在，请换一个名称', 409);
      const key = id || randomUUID();
      if (kind === 'tags') this.db.prepare(`INSERT INTO account_tags(id,name,color) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color`).run(key,name,color);
      else this.db.prepare(`INSERT INTO account_groups(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name`).run(key,name);
      this.store.event({id:null,username:name}, 'organize', `${id ? '更新' : '创建'}${kind === 'groups' ? '分组' : '标签'}`);
      return this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(key);
    });
  }
  delete(kind, id) {
    const table = this.table(kind);
    return this.store.transaction(() => {
      const row = this.db.prepare(`SELECT name FROM ${table} WHERE id=?`).get(id);
      if (!row) throw new AppError('分组或标签已不存在，请刷新',404);
      this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
      this.store.event({id:null,username:row.name}, 'organize', kind === 'groups' ? '删除分组，账号归入未分组' : '删除标签，保留账号');
      return {ok:true};
    });
  }
  metadata(id) {
    return { groupId: this.db.prepare('SELECT groupId FROM account_group_links WHERE accountId=?').get(id)?.groupId || null,
      tagIds: this.db.prepare('SELECT tagId FROM account_tag_links WHERE accountId=? ORDER BY tagId').all(id).map(row => row.tagId) };
  }
  decorate(rows) {
    const groups = new Map(this.db.prepare('SELECT * FROM account_group_links').all().map(row=>[row.accountId,row.groupId]));
    const tags = new Map();
    for (const row of this.db.prepare('SELECT * FROM account_tag_links ORDER BY tagId').all()) {
      if (!tags.has(row.accountId)) tags.set(row.accountId, []);
      tags.get(row.accountId).push(row.tagId);
    }
    return rows.map(row => ({...row,groupId:groups.get(row.id)||null,tagIds:tags.get(row.id)||[]}));
  }
  validate(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('整理参数无效');
    if (body.groupId !== undefined && body.groupId !== null) {
      if (typeof body.groupId !== 'string') throw new AppError('分组无效');
      if (!this.db.prepare('SELECT id FROM account_groups WHERE id=?').get(body.groupId)) throw new AppError('分组不存在，请刷新',404);
    }
    if (body.tagMode !== undefined && !['replace','add','remove'].includes(body.tagMode)) throw new AppError('标签操作无效');
    if (body.tagIds !== undefined) {
      if (!Array.isArray(body.tagIds) || body.tagIds.length > 50 || body.tagIds.some(id=>typeof id !== 'string')) throw new AppError('每个账号最多 50 个标签');
      for (const id of body.tagIds) if (!this.db.prepare('SELECT id FROM account_tags WHERE id=?').get(id)) throw new AppError('标签不存在，请刷新',404);
    }
  }
  // Caller owns the transaction and validates references before writing.
  apply(id, body) {
    if (body.groupId !== undefined) {
      this.db.prepare('DELETE FROM account_group_links WHERE accountId=?').run(id);
      if (body.groupId !== null) this.db.prepare('INSERT INTO account_group_links VALUES(?,?)').run(id,body.groupId);
    }
    if (body.tagIds !== undefined) {
      const mode = body.tagMode || 'replace';
      if (mode === 'replace') this.db.prepare('DELETE FROM account_tag_links WHERE accountId=?').run(id);
      for (const tagId of new Set(body.tagIds)) {
        if (mode === 'remove') this.db.prepare('DELETE FROM account_tag_links WHERE accountId=? AND tagId=?').run(id,tagId);
        else this.db.prepare('INSERT OR IGNORE INTO account_tag_links VALUES(?,?)').run(id,tagId);
      }
      if (this.db.prepare('SELECT count(*) AS n FROM account_tag_links WHERE accountId=?').get(id).n > 50) throw new AppError('每个账号最多 50 个标签');
    }
  }
  assign(ids, body) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(id=>typeof id !== 'string')) throw new AppError('请选择 1–10000 个账号');
    return this.store.transaction(() => {
      this.validate(body);
      const rows = [...new Set(ids)].map(id => this.store.get(id));
      for (const row of rows) {
        this.apply(row.id,body);
        this.store.event(row,'organize','更新来源分组 / 用途标签');
      }
      return {changed:rows.length};
    });
  }
}
