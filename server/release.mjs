// Boot-time release step for platforms without a separate migration job.
// With MIGRATION_DATABASE_URL set, it applies engine and extension migrations
// as the schema owner, ensures a least-privileged runtime login exists, and
// returns the runtime connection string. The caller removes the owner
// credential from the environment before the request-serving runtime starts;
// the runtime then refuses to serve unless its login has no elevated powers.
import { applyIdentityMigrations, pgTransactions } from "./identity-store.mjs";
import { applyExtensionMigrations } from "./platform.mjs";
import { databasePool } from "./runtime.mjs";

const ROLE = /^[a-z][a-z0-9_]{2,40}$/;
const quoteIdent = (name) => '"' + name.replace(/"/g, '""') + '"';
const quoteLiteral = (value) => "'" + value.replace(/'/g, "''") + "'";

export async function migrateAndProvision({ env, extensions = [], createPool = databasePool }) {
  const role = env.RUNTIME_DATABASE_ROLE ?? "quill_runtime";
  const password = env.RUNTIME_DATABASE_PASSWORD;
  if (!ROLE.test(role)) throw Error("Invalid runtime role name");
  if (typeof password !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(password)) throw Error("A strong runtime database password is required");
  const pool = createPool(env.MIGRATION_DATABASE_URL, { max: 1 });
  try {
    await applyIdentityMigrations(pgTransactions(pool));
    for (const extension of extensions) await applyExtensionMigrations(pgTransactions(pool), extension);
    await pgTransactions(pool)(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock(1245995847)");
      const exists = (await db.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rows.length > 0;
      // DDL cannot take bind parameters; the name is pattern-checked and the
      // password is restricted to URL-safe characters before quoting.
      // Managed PostgreSQL owners are not superusers: they may create a role
      // without elevated attributes, but ALTER ROLE may not even name the
      // superuser, replication or bypass-RLS attributes. A rotation therefore
      // changes only login and password; the runtime's startup check still
      // refuses to serve if the role ever holds an elevated power.
      const passwordClause = "LOGIN PASSWORD " + quoteLiteral(password);
      await db.query(exists
        ? "ALTER ROLE " + quoteIdent(role) + " " + passwordClause
        : "CREATE ROLE " + quoteIdent(role) + " NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS " + passwordClause);
      await db.query("GRANT dge_identity_runtime TO " + quoteIdent(role));
      const database = (await db.query("SELECT current_database() AS name")).rows[0].name;
      await db.query("GRANT CONNECT ON DATABASE " + quoteIdent(database) + " TO " + quoteIdent(role));
    });
  } finally {
    await pool.end();
  }
  const runtime = new URL(env.MIGRATION_DATABASE_URL);
  runtime.username = role;
  runtime.password = password;
  return runtime.href;
}

/** Runs the release step if configured, then serves with the runtime login only. */
export async function releaseAndRun({ extensions = [], assetDirectory, env = process.env }) {
  const { runPlatform } = await import("./runtime.mjs");
  const runtimeEnv = { ...env };
  if (env.MIGRATION_DATABASE_URL) {
    try {
      runtimeEnv.DATABASE_URL = await migrateAndProvision({ env, extensions });
    } catch (error) {
      const { startupFailureSummary } = await import("./runtime.mjs");
      console.error("Release failure cause: " + startupFailureSummary(error));
      console.error("Release migration failed; nothing was served. No credential details were logged.");
      process.exit(1);
    }
    delete runtimeEnv.MIGRATION_DATABASE_URL;
    delete process.env.MIGRATION_DATABASE_URL;
    delete runtimeEnv.RUNTIME_DATABASE_PASSWORD;
    delete process.env.RUNTIME_DATABASE_PASSWORD;
    console.log("Release migrations applied; serving with the least-privileged runtime login.");
  }
  return runPlatform({ extensions, env: runtimeEnv, assetDirectory });
}
