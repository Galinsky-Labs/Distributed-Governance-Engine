#!/usr/bin/env node
// DCE-035 restore drill. Compares a source database (or a saved manifest)
// with a restored copy and checks restore invariants. Prints only counts,
// digests and invariant names. Usage:
//   node scripts/restore-drill.mjs manifest  > source-manifest.json   (uses SOURCE_DATABASE_URL)
//   node scripts/restore-drill.mjs compare source-manifest.json       (uses RESTORED_DATABASE_URL)
// Use a read-only role. Exit status 0 = reconciled, 2 = mismatch.
import { readFile } from "node:fs/promises";
import pg from "pg";
import { reconciliationManifest, compareManifests } from "../server/restore-reconcile.mjs";

async function manifestOf(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const manifest = await reconciliationManifest((sql) => client.query(sql));
    await client.query("COMMIT");
    return manifest;
  } finally { await client.end(); }
}

const [command, file] = process.argv.slice(2);
try {
  if (command === "manifest") {
    if (!process.env.SOURCE_DATABASE_URL) throw Error("Set SOURCE_DATABASE_URL");
    console.log(JSON.stringify(await manifestOf(process.env.SOURCE_DATABASE_URL), null, 2));
  } else if (command === "compare" && file) {
    if (!process.env.RESTORED_DATABASE_URL) throw Error("Set RESTORED_DATABASE_URL");
    const source = JSON.parse(await readFile(file, "utf8"));
    const result = compareManifests(source, await manifestOf(process.env.RESTORED_DATABASE_URL));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 2;
  } else {
    console.error("Usage: restore-drill.mjs manifest | compare <source-manifest.json>");
    process.exitCode = 64;
  }
} catch (error) {
  // Connection strings and row content are never printed.
  console.error("Restore drill failed: " + (error?.code ?? error?.message ?? "unknown error").toString().slice(0, 120));
  process.exitCode = 1;
}
