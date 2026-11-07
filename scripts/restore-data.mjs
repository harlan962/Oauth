// Restore a backup produced by scripts/backup-data.mjs.
//
// Refuses to run while the server is running (same lock probe as the backup
// script) and moves the current data directory aside instead of deleting it, so
// a wrong restore is always reversible.
//
// Usage: node scripts/restore-data.mjs <backup-directory>
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

const backup = resolve(process.argv[2] || "");
if (!backup || !existsSync(join(backup, "accounts.sqlite"))) {
  console.error("用法：node scripts/restore-data.mjs <备份目录>（目录需包含 accounts.sqlite）");
  process.exit(1);
}
if (!existsSync(join(backup, "master.key"))) {
  console.error("备份缺少 master.key；没有密钥无法解密密码与 TOTP，拒绝恢复不完整的备份。");
  process.exit(1);
}

const dataDir = resolve(process.env.ACCOUNT_DESK_DATA_DIR || "data");
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
    console.error("数据目录正在被运行中的工作台使用；请先停止服务再恢复。");
    process.exit(1);
  }
}

if (existsSync(dataDir)) {
  const aside = `${dataDir}.before-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  renameSync(dataDir, aside);
  console.log(`现有数据已移到 ${aside}（确认无误后可自行删除）`);
}

mkdirSync(dataDir, { recursive: true });
// Copy after validation; keep it flat and simple with cpSync at file level.
const { cpSync } = await import("node:fs");
const items = readdirSync(backup);
let copied = 0;
for (const name of items) {
  if (statSync(join(backup, name)).isDirectory()) {
    console.error(`跳过意外的子目录 ${name}；备份应只包含文件`);
    continue;
  }
  cpSync(join(backup, name), join(dataDir, name));
  copied++;
}
const bytes = items.reduce((n, f) => n + statSync(join(backup, f)).size, 0);
console.log(`已恢复 ${copied} 个文件（${(bytes / 1024).toFixed(1)} KB）到 ${dataDir}`);
console.log("现在可以重新启动工作台。");
