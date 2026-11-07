// Filesystem permission helpers shared by the data directory and by backups.
//
// The threat this closes: `master.key` sits next to the database, so reading the
// directory is equivalent to reading every password and TOTP seed in plaintext.
// `data/` was hardened, but backups contain the same two files and used to land
// in `output/`, which inherits `Authenticated Users: Modify` from the project
// root. Any local account could then copy a backup and decrypt everything.
import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const windows = process.platform === "win32";
export const widePrincipals = ["Authenticated Users", "BUILTIN\\Users", "Everyone"];

function icacls(args) {
  // icacls writes GBK on Chinese Windows; read the raw buffer and match ASCII
  // principals, which avoids depending on the console code page.
  const result = spawnSync("icacls", args, { encoding: "buffer" });
  if (result.error) throw result.error;
  return (result.stdout || Buffer.alloc(0)).toString("latin1");
}

/** Principals that can currently read the directory, on Windows only. */
export function wideAccess(dir) {
  if (!windows) return [];
  const acl = icacls([dir]);
  return widePrincipals.filter((who) => acl.includes(who));
}

/**
 * Restrict `dir` to the account that runs the service plus SYSTEM and
 * Administrators. Idempotent, and safe to call on a directory that is already
 * tight: the grant happens before inheritance is dropped so the owner never
 * loses access to its own files.
 */
export function hardenDirectory(dir) {
  if (windows) {
    const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    const steps = [
      [dir, "/grant:r", `${user}:(OI)(CI)F`],
      [dir, "/inheritance:r"],
      [dir, "/grant:r", "NT AUTHORITY\\SYSTEM:(OI)(CI)F"],
      [dir, "/grant:r", "BUILTIN\\Administrators:(OI)(CI)F"],
    ];
    for (const args of steps) {
      const output = icacls(args);
      if (/failed|拒绝访问/i.test(output))
        throw new Error(`icacls ${args.slice(1).join(" ")} 失败：${output}`);
    }
    return { restrictedTo: user, remaining: wideAccess(dir) };
  }
  chmodSync(dir, 0o700);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) hardenDirectory(path);
    else chmodSync(path, 0o600);
  }
  return { restrictedTo: process.env.USER || "current user", remaining: [] };
}
