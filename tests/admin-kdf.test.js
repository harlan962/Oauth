import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scryptSync, randomBytes } from "node:crypto";
import { Store } from "../server/store.js";
import { AdminAuth } from "../server/admin-auth.js";

// An existing installation stores a v1 hash (the old scrypt defaults). Raising the
// work factor must not lock anyone out: the legacy hash verifies once, is re-hashed
// with the current parameters, and keeps working after a restart.
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "admin-kdf-"));
  const store = new Store(dir);
  const auth = new AdminAuth(store);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, auth };
}

function seedLegacy(store, password) {
  const salt = randomBytes(32).toString("hex");
  const legacy = scryptSync(password, Buffer.from(salt, "hex"), 64).toString("hex");
  store.db
    .prepare("UPDATE admin_credentials SET username='admin',salt=?,passwordHash=?,setupDigest=NULL,hashVersion=1 WHERE id=1")
    .run(salt, legacy);
  return { salt, legacy };
}

test("a legacy scrypt hash logs in once and is silently upgraded to the current parameters", async (t) => {
  const { store, auth } = await fixture(t);
  const { salt } = seedLegacy(store, "legacy-password-123");
  assert.equal(auth.credentials().hashVersion, 1);

  const token = await auth.login({ username: "admin", password: "legacy-password-123" });
  assert.ok(token);
  const upgraded = auth.credentials();
  assert.equal(upgraded.hashVersion, 2, "hash must be re-derived with the current work factor");
  assert.notEqual(upgraded.salt, salt, "re-hashing must rotate the salt");
  assert.notEqual(upgraded.passwordHash, null);
});

test("upgrading does not bump the credential version, so concurrent checks stay valid", async (t) => {
  const { store, auth } = await fixture(t);
  seedLegacy(store, "legacy-password-123");
  const before = auth.credentials().version;

  await auth.login({ username: "admin", password: "legacy-password-123" });
  assert.equal(auth.credentials().version, before);
});

test("the upgraded hash still verifies with a new process and rejects wrong passwords", async (t) => {
  const { store, auth } = await fixture(t);
  seedLegacy(store, "legacy-password-123");
  await auth.login({ username: "admin", password: "legacy-password-123" });

  const reopened = new AdminAuth(store);
  assert.ok(await reopened.login({ username: "admin", password: "legacy-password-123" }));
  await assert.rejects(
    () => reopened.login({ username: "admin", password: "wrong-password-123" }),
    (error) => error.status === 401,
  );
});
