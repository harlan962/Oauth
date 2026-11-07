import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// An OS-backed SQLite lock, held for the server lifetime. A crash releases it
// automatically, unlike a PID file. Use a separate DB so account writes stay free.
export function acquireRuntimeLock(directory) {
  mkdirSync(directory, { recursive: true });
  const lock = new DatabaseSync(join(directory, "runtime-lock.sqlite"));
  try {
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;");
  } catch (error) {
    lock.close();
    if (error.errcode === 5 || error.errcode === 6)
      throw new Error(
        "该数据目录正在使用，请先关闭已有工作台；不同端口也不能共享运行中的数据目录。",
      );
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lock.exec("ROLLBACK");
    lock.close();
  };
}
