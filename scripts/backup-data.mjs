// Backup and restore for the local data directory.
//
// A live SQLite database must be checkpointed before copying: the WAL file can
// contain commits that a plain file copy of accounts.sqlite would miss, and a
// restored database whose WAL belongs to a different checkpoint state can be
// rejected by SQLite. Backing up always through this script guarantees a
// self-contained snapshot.
//
// A backup is a decryptable copy of every credential: `master.key` and the
// database always travel together, because a restore without the key is
// useless. That makes the backup directory exactly as sensitive as `data/`, so
// it is written outside `output/` (which inherits wide permissions) and is
// locked down immediately after the copy.
//
// Usage:
//   node scripts/backup-data.mjs [target-directory]   default: backups/manual-<timestamp>
//   node scripts/restore-data.mjs <backup-directory>  (see that file)
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { hardenDirectory } from "./lib/acl.mjs";

const dataDir = resolve(process.env.ACCOUNT_DESK_DATA_DIR || "data");
const target =
  resolve(process.argv[2] || "") ||
  join("backups", `manual-${new Date().toISOString().replace(/[:.]/g, "-")}`);

if (!existsSync(join(dataDir, "accounts.sqlite"))) {
  console.error(`数据目录 ${dataDir} 中没有 accounts.sqlite，没有可备份的内容。`);
  process.exit(1);
}

// Tightening permissions rewrites the ACL of the whole directory, so refuse
// targets where that would be destructive or pointless.
const unsafe =
  (dirname(target) === target && target === parse(target).root) ||
  target === resolve(homedir()) ||
  target === resolve(".");
if (unsafe) {
  console.error(`拒绝把 ${target} 作为备份目录：请指定一个专用的子目录。`);
  process.exit(1);
}

// The server holds a BEGIN EXCLUSIVE lock on runtime-lock.sqlite for its whole
// lifetime. A held lock means the server is running and the backup would race
// its writes, so refuse instead of producing a torn snapshot.
const lockPath = join(dataDir, "runtime-lock.sqlite");
if (existsSync(lockPath)) {
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      `import {DatabaseSync} from 'node:sqlite';
       const db = new DatabaseSync(process.argv[1]);
       try { db.exec('BEGIN EXCLUSIVE'); console.log('free'); db.exec('ROLLBACK'); }
       catch (e) { console.log(e.errcode === 5 || e.errcode === 6 ? 'busy' : 'error'); }
       db.close();`,
      lockPath,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (probe.stdout?.trim() === "busy") {
    console.error("数据目录正在被运行中的工作台使用；请先停止服务再备份。");
    process.exit(1);
  }
}

mkdirSync(target, { recursive: true });
// A checkpoint folds the WAL into the main database so the copy is complete on
// its own. It runs on a throwaway connection; the server must not be running.
try {
  spawnSync(
    process.execPath,
    [
      "-e",
      `import {DatabaseSync} from 'node:sqlite';
       const db = new DatabaseSync(process.argv[1]);
       db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
       db.close();`,
      join(dataDir, "accounts.sqlite"),
    ],
    { stdio: "ignore", windowsHide: true },
  );
} catch {
  // A failed checkpoint is not fatal: the WAL file itself is copied below.
}

for (const name of readdirSync(dataDir)) {
  if (name === "runtime-lock.sqlite" || name.endsWith("-journal")) continue;
  cpSync(join(dataDir, name), join(target, name));
}

let restriction;
try {
  restriction = hardenDirectory(target);
} catch (error) {
  console.error(`备份已生成，但收紧目录权限失败：${error.message}`);
  console.error(`请立即手动限制 ${target} 的访问权限，或删除该目录后重试。`);
  process.exit(1);
}
const files = readdirSync(target);
const bytes = files.reduce((n, f) => n + statSync(join(target, f)).size, 0);
console.log(`已备份 ${files.length} 个文件（${(bytes / 1024).toFixed(1)} KB）到 ${target}`);
console.log(`目录权限已收紧到 ${restriction.restrictedTo}、SYSTEM、Administrators。`);
if (restriction.remaining.length)
  console.log(`仍有残留主体：${restriction.remaining.join("、")}，请手动检查。`);
if (files.includes("master.key"))
  console.log("注意：该目录含 master.key，等同于全部明文凭据；请勿放入网盘同步目录或代码仓库。");
console.log("恢复方法：停止服务后运行 node scripts/restore-data.mjs " + target);
