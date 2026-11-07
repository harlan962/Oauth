import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const cli = join(
  dirname(require.resolve("playwright-core/package.json")),
  "cli.js",
);
const child = spawn(
  process.execPath,
  [cli, "install", "chromium", "--no-shell"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: fileURLToPath(
        new URL("../.local-browsers/", import.meta.url),
      ),
    },
    windowsHide: true,
  },
);
child.on("error", () => {
  console.error("无法运行专用浏览器安装程序");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
