// Run the non-browser test suite in small batches.
//
// `node --test tests/*.test.js` starts every file at once. Each admin fixture
// performs a deliberate 128 MB scrypt hash, so on a small machine the whole
// suite competes for RAM and either times out or reports phantom failures —
// exactly the "passes locally, fails in CI" symptom. Batching keeps peak memory
// bounded and makes failures reproducible.
//
// Browser tests are excluded: they need a downloaded Chromium and are run by
// `npm run test:browser`.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

// Probe the project-owned Chromium once. Some non-`-browser` test files import
// `server/browser-runtime.js` and launch a real browser; CI runs `test:unit`
// before any browser download, so without the probe they would fail there with
// "Failed to launch chromium" while passing on machines that ran
// `npm run browser:install`. Skipping keeps the "no browser needed" contract
// of this suite; the files still run wherever a Chromium is installed.
let browserReady = true;
try {
  const { chromium } = await import("../server/browser-runtime.js");
  browserReady = existsSync(chromium.executablePath());
} catch {
  browserReady = false;
}

const needsBrowser = name =>
  readFileSync(`tests/${name}`, "utf8").includes("server/browser-runtime.js");

const batchSize = Number(process.env.TEST_BATCH_SIZE || 4);

const skipped = [];
const files = readdirSync("tests")
  .filter(name => name.endsWith(".test.js") && !name.endsWith("-browser.test.js"))
  .filter(name => {
    if (browserReady || !needsBrowser(name)) return true;
    skipped.push(name);
    return false;
  })
  .sort()
  .map(name => `tests/${name}`);

if (skipped.length)
  console.log(`未检测到 Chromium，跳过依赖浏览器的测试文件：${skipped.join(" ")}`);

if (!files.length) {
  console.error("tests/ 下没有找到可运行的测试文件");
  process.exit(1);
}

const failedBatches = [];
for (let index = 0; index < files.length; index += batchSize) {
  const batch = files.slice(index, index + batchSize);
  console.log(`\n── 批次 ${Math.floor(index / batchSize) + 1}: ${batch.join(" ")}`);
  const result = spawnSync(process.execPath, ["--test", ...batch], { stdio: "inherit" });
  if (result.status !== 0) failedBatches.push(batch);
}

console.log(`\n共 ${files.length} 个文件，${failedBatches.length} 个批次失败。`);
if (failedBatches.length) {
  for (const batch of failedBatches) console.error(`失败: ${batch.join(" ")}`);
  process.exit(1);
}
