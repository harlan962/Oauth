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
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

const batchSize = Number(process.env.TEST_BATCH_SIZE || 4);
const files = readdirSync("tests")
  .filter(name => name.endsWith(".test.js") && !name.endsWith("-browser.test.js"))
  .sort()
  .map(name => `tests/${name}`);

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
