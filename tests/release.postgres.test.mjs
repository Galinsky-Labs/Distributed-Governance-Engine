import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrateAndProvision } from "../server/release.mjs";
import { verifyIdentityRuntime } from "../server/identity-store.mjs";

// Requires a disposable PostgreSQL (the CI service). The release step must
// leave a runtime login that passes the same privilege check production runs.
const url = process.env.DGE_TEST_DATABASE_URL;
const plainPool = (u, { max }) => new pg.Pool({ connectionString: u, max }); // local service has no TLS
test("release provisioning creates an unprivileged runtime login that passes the runtime check", { skip: !url && "DGE_TEST_DATABASE_URL not set" }, async () => {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const database = "dge_release_" + Date.now();
  await admin.query("CREATE DATABASE " + database);
  try {
    const target = new URL(url); target.pathname = "/" + database;
    const env = { MIGRATION_DATABASE_URL: target.href, RUNTIME_DATABASE_ROLE: "quill_release_test", RUNTIME_DATABASE_PASSWORD: "x".repeat(40) };
    const runtimeUrl = await migrateAndProvision({ env, createPool: plainPool });
    assert.equal(new URL(runtimeUrl).username, "quill_release_test");
    const pool = new pg.Pool({ connectionString: runtimeUrl, max: 1 });
    try {
      assert.equal(await verifyIdentityRuntime(pool), true);
      const flags = (await pool.query("SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
      assert.deepEqual(flags, { rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false });
    } finally { await pool.end(); }
    const rotated = await migrateAndProvision({ env: { ...env, RUNTIME_DATABASE_PASSWORD: "y".repeat(40) }, createPool: plainPool });
    const second = new pg.Pool({ connectionString: rotated, max: 1 });
    try { assert.equal(await verifyIdentityRuntime(second), true, "re-running is idempotent and rotates the password"); }
    finally { await second.end(); }
    await assert.rejects(migrateAndProvision({ env: { ...env, RUNTIME_DATABASE_PASSWORD: "short" }, createPool: plainPool }), /strong runtime database password/);
    await assert.rejects(migrateAndProvision({ env: { ...env, RUNTIME_DATABASE_ROLE: 'x"; DROP' }, createPool: plainPool }), /Invalid runtime role/);
  } finally {
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [database]);
    await admin.query("DROP DATABASE " + database);
    await admin.query("DROP OWNED BY quill_release_test").catch(() => {});
    await admin.query("DROP ROLE IF EXISTS quill_release_test");
    await admin.end();
  }
});
