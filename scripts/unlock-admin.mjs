// Break-glass unlock for the administrator login.
//
// Login lockouts are per source so that one caller cannot shut the operator out,
// but the loopback interface still shares a single bucket: a local process (or a
// mistyped password in a loop) can hold that one bucket locked. Waiting always
// works; this command makes the wait unnecessary, and it needs no password.
//
// Usage: npm run admin:unlock
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const directory = resolve(process.env.ACCOUNT_DESK_DATA_DIR || "data");
const path = join(directory, "accounts.sqlite");
if (!existsSync(path)) {
  console.error(`没有找到数据库：${path}`);
  process.exit(1);
}

const db = new DatabaseSync(path);
try {
  db.exec("PRAGMA busy_timeout=5000");
  const sources = Number(db.prepare("DELETE FROM admin_lockout_sources").run().changes);
  db.prepare("UPDATE admin_lockout SET fails=0,lockUntil=0 WHERE id=1").run();
  db.prepare("UPDATE admin_login_limits SET window=0,count=0 WHERE id=1").run();
  console.log(`已清除登录锁定（${sources} 个来源桶）。现在可以用正确密码登录。`);
} catch (error) {
  console.error(`清除锁定失败：${error.message}`);
  process.exit(1);
} finally {
  db.close();
}
