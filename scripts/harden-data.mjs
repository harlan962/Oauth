// Restrict the data directory to the account that runs the service.
//
// Why this matters more than any login control: `master.key` sits next to the
// database, so anyone who can read the *directory* can decrypt every stored
// password and TOTP seed. On Windows the POSIX 0600 mode written by the app is
// ignored, and a fresh checkout inherits `Authenticated Users: Modify` from the
// parent folder, which means every local account can read the key.
//
// Usage:
//   node scripts/harden-data.mjs                 apply (idempotent, safe to re-run)
//   node scripts/harden-data.mjs --check         report only, exit 1 when too open
//   node scripts/harden-data.mjs --dir <path>    target another directory (e.g. a backup)
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { hardenDirectory, wideAccess } from "./lib/acl.mjs";

const args = process.argv.slice(2);
const dirFlag = args.indexOf("--dir");
const dataDir = resolve(
  dirFlag >= 0 ? args[dirFlag + 1] : process.env.ACCOUNT_DESK_DATA_DIR || "data",
);
const checkOnly = args.includes("--check");
const windows = process.platform === "win32";

if (!dataDir || !existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
  console.error(`目录不存在：${dataDir}`);
  process.exit(1);
}

if (windows) {
  const wide = wideAccess(dataDir);
  if (wide.length) console.log(`当前过宽，可被这些主体读取：${wide.join("、")}`);
  else console.log("当前权限已收紧。");

  if (checkOnly) {
    console.log(wide.length ? "\n建议执行：npm run harden:data" : "");
    process.exit(wide.length ? 1 : 0);
  }

  let result;
  try {
    result = hardenDirectory(dataDir);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  console.log(`\n已收紧到 ${result.restrictedTo}、SYSTEM、Administrators。`);
  if (result.remaining.length)
    console.log(`仍有残留主体：${result.remaining.join("、")}（可能来自子项，请手动检查）`);
  else console.log("Authenticated Users / Users 已不再具备访问权限。");
} else {
  const mode = statSync(dataDir).mode & 0o777;
  const files = readdirSync(dataDir).map((name) => ({
    name,
    mode: statSync(join(dataDir, name)).mode & 0o777,
  }));
  const loose = files.filter((file) => (file.mode & 0o077) !== 0);
  const dirLoose = (mode & 0o077) !== 0;
  if (!dirLoose && !loose.length) {
    console.log(`目录权限已收紧（${mode.toString(8)}）。`);
    process.exit(0);
  }
  if (checkOnly) {
    console.log(`目录 ${mode.toString(8)}，${loose.length} 个文件对组/其他用户可读。建议执行：npm run harden:data`);
    process.exit(1);
  }
  hardenDirectory(dataDir);
  console.log(`已收紧：目录 700，${files.length} 个文件 600。`);
}
