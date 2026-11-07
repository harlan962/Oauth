import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("only one running server can own a data directory, independent of its HTTP port", async (t) => {
  const { acquireRuntimeLock } = await import("../server/runtime-lock.js");
  const dir = mkdtempSync(join(tmpdir(), "runtime-lock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const release = acquireRuntimeLock(dir);
  try {
    assert.throws(() => acquireRuntimeLock(dir), /正在使用/);
  } finally {
    release();
  }
  const releaseAgain = acquireRuntimeLock(dir);
  releaseAgain();
  releaseAgain();
});
