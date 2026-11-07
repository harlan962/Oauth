import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const name of ['diagnose-workbuddy-bounded.mjs', 'diagnose-workbuddy-once.mjs']) {
  test(`${name} rejects a trashed historical account before reading credentials or starting a remote session`, t => {
    const root = mkdtempSync(join(tmpdir(), 'diagnostic-eligibility-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'data'));
    const db = new DatabaseSync(join(root, 'data', 'accounts.sqlite'));
    db.exec(`
      CREATE TABLE workbuddy_jobs(id TEXT,targetId TEXT,running INTEGER);
      CREATE TABLE integration_jobs(running INTEGER);
      CREATE TABLE workbuddy_items(jobId TEXT,position INTEGER,accountId TEXT,status TEXT);
      CREATE TABLE accounts(id TEXT,username TEXT,email TEXT,password TEXT,totp TEXT,reservedBy TEXT,deletedAt TEXT,selectedAt TEXT,patDedicated INTEGER);
      INSERT INTO workbuddy_jobs VALUES('old-job','target',0);
      INSERT INTO workbuddy_items VALUES('old-job',1,'trashed','unknown');
      INSERT INTO accounts VALUES('trashed','fixture-user','fixture@example.test','not-a-real-secret','not-a-real-secret',NULL,'2026-10-19',NULL,0);
    `);
    db.close();
    const result = spawnSync(process.execPath, [resolve('scripts', name), 'old-job', '1'], { cwd: root, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Account is deleted/);
    assert.doesNotMatch(result.stdout, /"stage":"start"/);
    assert.equal(existsSync(join(root, 'output')), false);
  });
}
