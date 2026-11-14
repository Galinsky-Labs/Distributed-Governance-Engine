#!/usr/bin/env node
// DCE-034 reproducible workload benchmark. It drives the real engine stores
// (identity, documents, proposals, discussion, decisions, ledger) against a
// real PostgreSQL server through the unprivileged runtime role, and writes a
// JSON + Markdown report. Numbers are local measurements on the stated
// hardware, never a production capacity claim.
//
//   DGE_TEST_DATABASE_URL=postgresql://postgres:…@127.0.0.1:5432/<admin>_test \
//     node scripts/benchmark.mjs --voters=2000 --label=local
//
// The URL must be a loopback database whose name ends in _test. It is used
// only as an administrative connection: every run creates its own scratch
// database (dge_bench_<random>_test) and login role, and drops both at the end
// unless --keep is given.
import os from "node:os";
import { writeFile, mkdir } from "node:fs/promises";
import { randomBytes, randomUUID, generateKeyPairSync } from "node:crypto";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { createIdentityStore, pgTransactions, applyIdentityMigrations } from "../server/identity-store.mjs";
import { createDocumentStore } from "../server/document-store.mjs";
import { createDocumentRoutes } from "../server/document-http.mjs";
import { createProposalStore } from "../server/proposal-store.mjs";
import { createProposalRoutes } from "../server/proposal-http.mjs";
import { createDiscussionStore } from "../server/discussion-store.mjs";
import { createDiscussionRoutes } from "../server/discussion-http.mjs";
import { createDecisionStore } from "../server/decision-store.mjs";
import { createLedger, loadLogSigningKey } from "../server/ledger.mjs";
import { createAccountHandler } from "../server/account-http.mjs";
import { createLegalDocument } from "../src/legal-structure.mjs";

const DEFAULTS = {
  voters: 2000, concurrency: 32, pool: 32,
  "bulk-electorate": 99999, "bulk-decisions": 10,
  "public-tenants": 20, "documents-per-tenant": 100, proposals: 200, points: 1000,
  "read-requests": 20000, "decision-reads": 200, "ledger-events": 50000,
  label: "local", out: "docs/benchmarks", keep: false,
};
export function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (const arg of argv) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match || !Object.hasOwn(DEFAULTS, match[1])) throw Error("Unknown option " + arg);
    const [, key, raw] = match;
    if (typeof DEFAULTS[key] === "boolean") options[key] = raw === undefined || raw === "true";
    else if (typeof DEFAULTS[key] === "number") {
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n < 0) throw Error("Invalid number for --" + key);
      options[key] = n;
    } else options[key] = raw;
  }
  if (!/^[a-z0-9-]{1,60}$/.test(options.label)) throw Error("Invalid --label");
  // The engine caps a frozen electorate at 100,000 members; the convenor holds one seat.
  if (options["bulk-electorate"] > 99999 || options.voters > 99999) throw Error("--voters and --bulk-electorate are limited to 99,999");
  return options;
}

const percentile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)] : null;
const round = (n, digits = 2) => n === null ? null : Number(n.toFixed(digits));
export function summarize(latencies, wallMs, errors = 0) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    operations: latencies.length, errors, wallMs: round(wallMs),
    throughputPerSecond: round(latencies.length / (wallMs / 1000)),
    p50Ms: round(percentile(sorted, 50)), p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)), maxMs: round(sorted.at(-1) ?? null),
  };
}
/** Runs `count` operations with at most `concurrency` in flight; records per-operation latency. */
async function load(count, concurrency, operation) {
  const latencies = [], failures = new Map();
  let next = 0;
  const started = performance.now();
  const lane = async () => {
    for (let i = next++; i < count; i = next++) {
      const t = performance.now();
      try { await operation(i); latencies.push(performance.now() - t); }
      catch (error) { const code = error?.code ?? error?.message ?? "error"; failures.set(code, (failures.get(code) ?? 0) + 1); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, lane));
  const wall = performance.now() - started;
  return { ...summarize(latencies, wall, [...failures.values()].reduce((a, b) => a + b, 0)), failures: Object.fromEntries(failures) };
}
const timed = async (fn) => { const t = performance.now(); const value = await fn(); return { ms: round(performance.now() - t), value }; };
const log = (...parts) => process.stderr.write(parts.join(" ") + "\n");

function adminUrl() {
  const url = new URL(process.env.DGE_TEST_DATABASE_URL ?? "");
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/[a-z0-9_]+_test$/.test(url.pathname))
    throw Error("DGE_TEST_DATABASE_URL must be a loopback database whose name ends in _test");
  return url;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const admin = adminUrl();
  const suffix = randomBytes(6).toString("hex");
  const database = "dge_bench_" + suffix + "_test", login = "dge_bench_" + suffix;
  const password = randomBytes(24).toString("hex");
  const root = new pg.Client({ connectionString: admin.href });
  await root.connect();
  await root.query(`CREATE DATABASE ${database}`);
  log("scratch database", database);
  const ownerUrl = new URL(admin); ownerUrl.pathname = "/" + database;
  const owner = new pg.Pool({ connectionString: ownerUrl.href, max: 4 });
  owner.on("error", () => {});
  let runtime;
  try {
    await applyIdentityMigrations(pgTransactions(owner));
    await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD '${password}' IN ROLE dge_identity_runtime`);
    const runtimeUrl = new URL(ownerUrl); runtimeUrl.username = login; runtimeUrl.password = password;
    runtime = new pg.Pool({ connectionString: runtimeUrl.href, max: options.pool });
    runtime.on("error", () => {}); // Idle clients are terminated when the scratch database is dropped.
    const report = await run(options, { owner, runtime });
    await writeReport(options, report);
  } finally {
    await runtime?.end();
    await owner.end();
    if (!options.keep) {
      await root.query(`DROP DATABASE ${database} WITH (FORCE)`);
      await root.query(`DROP ROLE IF EXISTS ${login}`);
    }
    await root.end();
  }
}

async function environment(owner) {
  const version = (await owner.query("SHOW server_version")).rows[0].server_version;
  const settings = Object.fromEntries((await owner.query(
    "SELECT name,setting,unit FROM pg_settings WHERE name IN ('shared_buffers','max_connections','synchronous_commit','fsync','work_mem')")).rows
    .map((r) => [r.name, r.setting + (r.unit ? " " + r.unit : "")]));
  return {
    cpuModel: os.cpus()[0]?.model ?? "unknown", cpuCount: os.cpus().length,
    memoryGiB: round(os.totalmem() / 2 ** 30, 1), platform: `${os.type()} ${os.release()} ${os.arch()}`,
    node: process.version, postgres: version, postgresSettings: settings,
    topology: "PostgreSQL and the Node.js load generator share the same host; no network hop, no TLS, no HTTP socket.",
  };
}

async function run(options, { owner, runtime }) {
  const origin = "https://bench.example";
  const transaction = pgTransactions(runtime);
  let offset = 0; // Lets the benchmark move the decision clock past closesAt.
  const clock = () => Date.now() + offset;
  const identity = createIdentityStore({ transaction, origin, sessionKey: randomBytes(32), stateKey: randomBytes(32), maxOwnedWorkspaces: 1000 });
  const documents = createDocumentStore({ identity, transaction });
  const proposals = createProposalStore({ identity, transaction, maxPerDocument: 10000, maxPerAuthor: 10000 });
  const discussion = createDiscussionStore({ identity, transaction, maxPoints: 100000, maxAuthorPoints: 100000 });
  const maxElectors = Math.max(options.voters + 1, options["bulk-electorate"] + 1, 1000);
  const decisions = createDecisionStore({ identity, transaction, clock, maxElectors: Math.min(maxElectors, 100000) });
  const signingKey = loadLogSigningKey(generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
  const ledger = createLedger({ transaction, logId: "bench.local", signingKey, clock });
  const session = async (subject = randomUUID()) => ({
    ...await identity.establishSession({ issuer: "https://bench-provider.example", subject, authenticatedAt: Date.now() }), origin,
  });
  const grant = (tenantId, role, accountIds) => owner.query(
    `INSERT INTO dge_identity.memberships(tenant_id,account_id,role,active,updated_at)
     SELECT $1,unnest($2::uuid[]),$3,true,now() ON CONFLICT DO NOTHING`, [tenantId, accountIds, role]);
  const publish = async (who, tenantId, text) => {
    const document = structuredClone(createLegalDocument({ id: randomUUID(), tenantId, title: "Benchmark " + text }));
    document.content[0].inlines = [{ kind: "text", text: "The agency shall report annually on " + text + "." }];
    await documents.create(who, tenantId, { document, commandId: randomUUID(), disclosure: "publish-all-revisions-v1" });
    return document;
  };
  const propose = (who, tenantId, document, n) => proposals.create(who, tenantId, document.id, {
    baseVersion: 1, selection: { blockId: document.content[0].id, start: 24, end: 32, quote: "annually" },
    replacement: "quarterly", rationale: "Benchmark proposal " + n, commandId: randomUUID(), disclosure: "publish-proposal-v1",
  });
  const report = { options, environment: await environment(owner), startedAt: new Date().toISOString(), results: {} };

  // 1. Hot decision: one proposal, `voters` distinct authenticated members casting concurrently.
  log("hot decision: creating", options.voters, "voter sessions");
  const chair = await session();
  const { tenantId: hotTenant } = await identity.createTenant(chair);
  const voterSetup = await timed(async () => {
    const voters = new Array(options.voters);
    await load(options.voters, options.concurrency, async (i) => { voters[i] = await session(); });
    // Synthetic shortcut: memberships are granted in bulk instead of through
    // per-voter invitation acceptance; casting still uses each real session.
    await grant(hotTenant, "participant", voters.map((v) => v.accountId));
    return voters;
  });
  const voters = voterSetup.value;
  const hotDocument = await publish(chair, hotTenant, "hot decisions");
  const hotProposal = (await propose(chair, hotTenant, hotDocument, 0)).proposal;
  const opened = await timed(() => decisions.open(chair, hotTenant, hotDocument.id, hotProposal.id, { hours: 1, commandId: randomUUID() }));
  log("hot decision: casting");
  const choices = ["yes", "no", "abstain"];
  const casting = await load(voters.length, options.concurrency, (i) =>
    decisions.cast(voters[i], hotTenant, hotDocument.id, hotProposal.id, { choice: choices[i % 3], expectedVersion: 0, commandId: randomUUID() }));
  const revote = await load(Math.min(200, voters.length), options.concurrency, (i) =>
    decisions.cast(voters[i], hotTenant, hotDocument.id, hotProposal.id, { choice: "yes", expectedVersion: 1, commandId: randomUUID() }));
  const decisionReads = await load(options["decision-reads"], options.concurrency, (i) => decisions.read(voters[i % voters.length], hotTenant, hotDocument.id, hotProposal.id));
  offset = 3600001 + 1000;
  const hotClose = await timed(() => decisions.close(chair, hotTenant, hotDocument.id, hotProposal.id));
  const counted = (await owner.query("SELECT count(*)::int AS n FROM dge_decisions.ballots WHERE decision_id=$1", [opened.value.id])).rows[0].n;
  report.results.hotDecision = {
    voters: voters.length, electorate: opened.value.eligibleCount, sessionSetupMs: voterSetup.ms,
    openMs: opened.ms, firstBallots: casting, ballotChanges: revote, participantReadsAfterAllBallots: decisionReads,
    closeAndTallyMs: hotClose.ms, ballotsStored: counted,
    outcome: hotClose.value.certificate.outcome,
  };
  offset = 0;

  // 2. One million ballot records: bulk-loaded through the real schema, then the real close/tally path.
  const bulkElectorate = options["bulk-electorate"], bulkDecisions = options["bulk-decisions"];
  if (bulkElectorate > 0 && bulkDecisions > 0) {
    log("bulk ballots:", bulkElectorate, "x", bulkDecisions);
    const convenor = await session();
    const { tenantId: bulkTenant } = await identity.createTenant(convenor);
    const accounts = await timed(async () => (await owner.query(
      `INSERT INTO dge_identity.accounts(id,issuer,subject,created_at)
       SELECT gen_random_uuid(),'https://bench-bulk.example','bulk-'||g,now() FROM generate_series(1,$1) g RETURNING id`, [bulkElectorate])).rows.map((r) => r.id));
    await owner.query(`INSERT INTO dge_identity.memberships(tenant_id,account_id,role,active,updated_at)
      SELECT $1,id,'participant',true,now() FROM dge_identity.accounts WHERE issuer='https://bench-bulk.example'`, [bulkTenant]);
    const bulkDocument = await publish(convenor, bulkTenant, "bulk ballots");
    const opens = [];
    for (let n = 0; n < bulkDecisions; n++) {
      const proposal = (await propose(convenor, bulkTenant, bulkDocument, n)).proposal;
      opens.push({ proposal, ...await timed(() => decisions.open(convenor, bulkTenant, bulkDocument.id, proposal.id, { hours: 1, commandId: randomUUID() })) });
    }
    const loadBallots = await timed(async () => {
      for (const { value } of opens)
        await owner.query(`INSERT INTO dge_decisions.ballots(tenant_id,decision_id,account_id,choice,version,cast_at)
          SELECT tenant_id,$2,account_id,(ARRAY['yes','no','abstain'])[1+abs(hashtext(account_id::text))%3],1,now()
          FROM dge_identity.memberships WHERE tenant_id=$1 AND role='participant'`, [bulkTenant, value.id]);
      await owner.query("ANALYZE dge_decisions.ballots");
    });
    const total = (await owner.query("SELECT count(*)::int AS n FROM dge_decisions.ballots")).rows[0].n;
    const size = (await owner.query("SELECT pg_total_relation_size('dge_decisions.ballots') AS b")).rows[0].b;
    offset = 3600001 + 1000;
    const close = await timed(() => decisions.close(convenor, bulkTenant, bulkDocument.id, opens[0].proposal.id));
    const read = await timed(() => decisions.read(convenor, bulkTenant, bulkDocument.id, opens[1 % opens.length].proposal.id));
    offset = 0;
    report.results.ballotStorage = {
      electoratePerDecision: bulkElectorate, decisions: bulkDecisions, totalBallotRows: total,
      ballotTableBytesIncludingIndexes: Number(size), accountInsertMs: accounts.ms,
      openDecisionMs: opens.map((o) => o.ms), bulkLoadMs: loadBallots.ms,
      closeAndTallyOneDecisionMs: close.ms, closedDecisionBallots: close.value.certificate.outcome.counts.participating,
      readOneClosedOrOpenDecisionMs: read.ms,
      method: "Ballot rows are inserted with INSERT … SELECT into dge_decisions.ballots (real table, constraints, indexes, foreign keys); no per-ballot event/outbox rows are created for the bulk rows. Opening and closing use DecisionStore.open/close unchanged.",
    };
  }

  // 3. Public cursor-paginated reads over directory, document editions, history, proposals and points.
  log("public reads: seeding");
  const seed = await timed(async () => {
    const tenants = [];
    const author = await session();
    for (let t = 0; t < options["public-tenants"]; t++) tenants.push((await identity.createTenant(author)).tenantId);
    const docs = [];
    await load(tenants.length * options["documents-per-tenant"], options.concurrency, async (i) => {
      docs.push(await publish(author, tenants[i % tenants.length], "public " + i));
    });
    return { author, tenants, docs };
  });
  const readDocument = await publish(chair, hotTenant, "public reads");
  const proposalIds = [];
  await load(options.proposals, options.concurrency, async (n) => proposalIds.push((await propose(chair, hotTenant, readDocument, n)).proposal.id));
  const discussed = proposalIds[0];
  await load(options.points, options.concurrency, (n) => discussion.create(voters[n % voters.length], hotTenant, readDocument.id, discussed, {
    position: ["support", "oppose", "clarify"][n % 3], text: "Benchmark point " + n, commandId: randomUUID(), disclosure: "publish-point-v1",
  }));
  await owner.query("ANALYZE");
  const handler = createAccountHandler({
    store: identity, login: {}, origin, budget: () => true,
    extensions: [createDiscussionRoutes({ discussion }), createProposalRoutes({ proposals }), createDocumentRoutes({ documents })],
  });
  const get = async (path) => {
    const response = await handler(new Request(origin + path), { peerAddress: "127.0.0.1" });
    if (response.status !== 200) throw Object.assign(Error("HTTP " + response.status), { code: "HTTP_" + response.status });
    return response.json();
  };
  const cursors = { directory: [null], proposals: [null], points: [null] };
  const walk = async (kind, base, param = "after") => {
    const list = cursors[kind];
    const cursor = list[Math.floor(Math.random() * list.length)];
    const page = await get(base + (cursor ? (base.includes("?") ? "&" : "?") + param + "=" + encodeURIComponent(cursor) : ""));
    if (page.nextCursor && list.length < 5000 && !list.includes(page.nextCursor)) list.push(page.nextCursor);
  };
  const mix = [
    ["directory", () => walk("directory", "/api/public/documents?limit=30")],
    ["documentCurrent", () => get("/api/public/documents/" + seed.value.docs[Math.floor(Math.random() * seed.value.docs.length)].id)],
    ["documentEdition", () => get("/api/public/documents/" + seed.value.docs[Math.floor(Math.random() * seed.value.docs.length)].id + "?version=1")],
    ["history", () => get("/api/public/documents/" + readDocument.id + "/history")],
    ["proposals", () => walk("proposals", "/api/public/documents/" + readDocument.id + "/proposals?limit=20")],
    ["points", () => walk("points", "/api/public/documents/" + readDocument.id + "/proposals/" + discussed + "/points?limit=10&sort=new")],
  ];
  // Warm the cursor lists so later requests read deep pages, not only page one.
  for (let i = 0; i < 200; i++) for (const name of ["directory", "proposals", "points"]) await mix.find((m) => m[0] === name)[1]();
  log("public reads: measuring");
  const perKind = Object.fromEntries(mix.map(([name]) => [name, []]));
  const readStarted = performance.now();
  const reads = await load(options["read-requests"], options.concurrency, async (i) => {
    const [name, request] = mix[i % mix.length];
    const t = performance.now();
    await request();
    perKind[name].push(performance.now() - t);
  });
  const readWall = performance.now() - readStarted;
  report.results.publicReads = {
    seededDocuments: seed.value.docs.length, seedMs: seed.ms, proposalsOnReadDocument: proposalIds.length, pointsOnProposal: options.points,
    overall: reads,
    byEndpoint: Object.fromEntries(Object.entries(perKind).map(([k, v]) => [k, summarize(v, readWall)])),
    extrapolatedReadsPerDay: Math.floor(reads.throughputPerSecond * 86400),
    extrapolation: "throughputPerSecond × 86,400 on this single host with no CDN; assumes the measured mix and sustained load, which was not run for 24 hours.",
  };

  // 4. Ledger sequencing throughput: pending events from phases 1–3 plus synthetic decision events.
  log("ledger: seeding", options["ledger-events"], "events");
  const synthetic = options["ledger-events"];
  if (synthetic > 0) await owner.query(`
    WITH ev AS (SELECT gen_random_uuid() AS id, encode(sha256(convert_to('bench-'||g||'-'||$3,'UTF8')),'hex') AS digest, now() + (g||' microseconds')::interval AS at
      FROM generate_series(1,$2) g),
    e AS (INSERT INTO dge_decisions.events(tenant_id,id,decision_id,actor_id,command_id,request_digest,result,event_digest,occurred_at)
      SELECT $1,ev.id,d.id,d.created_by,gen_random_uuid(),ev.digest,'{}'::jsonb,ev.digest,ev.at FROM ev, (SELECT id,created_by FROM dge_decisions.decisions WHERE tenant_id=$1 LIMIT 1) d RETURNING id,decision_id,event_digest,occurred_at)
    INSERT INTO dge_decisions.anchor_outbox(tenant_id,event_id,decision_id,event_digest,created_at) SELECT $1,id,decision_id,event_digest,occurred_at FROM e`,
  [hotTenant, synthetic, randomUUID()]);
  await owner.query("ANALYZE");
  const pending = (await owner.query(`SELECT
    (SELECT count(*) FROM dge_documents.anchor_outbox WHERE ledger_seq IS NULL)+(SELECT count(*) FROM dge_proposals.anchor_outbox WHERE ledger_seq IS NULL)+
    (SELECT count(*) FROM dge_discussion.anchor_outbox WHERE ledger_seq IS NULL)+(SELECT count(*) FROM dge_decisions.anchor_outbox WHERE ledger_seq IS NULL)+
    (SELECT count(*) FROM dge_ledger.outbox WHERE ledger_seq IS NULL) AS n`)).rows[0].n;
  log("ledger: sequencing", pending, "events");
  const sequenced = await timed(async () => { let total = 0, pass; do { pass = await ledger.sequence(); total += pass; } while (pass > 0); return total; });
  const checkpoint = await timed(() => ledger.issueCheckpoint({ force: true }));
  const sample = (await owner.query("SELECT event_digest FROM dge_ledger.entries ORDER BY random() LIMIT 500")).rows.map((r) => r.event_digest.trim());
  const proofs = await load(sample.length, options.concurrency, async (i) => {
    const proof = await ledger.proof({ eventDigest: sample[i] });
    if (proof.status !== "included") throw Error("not included");
  });
  report.results.ledger = {
    pendingEvents: Number(pending), sequenced: sequenced.value, sequenceMs: sequenced.ms,
    entriesPerSecond: round(sequenced.value / (sequenced.ms / 1000)),
    checkpointMs: checkpoint.ms, logSize: checkpoint.value?.body.size ?? null, inclusionProofs: proofs,
  };
  report.finishedAt = new Date().toISOString();
  return report;
}

const ms = (n) => (n === null || n === undefined ? "–" : n.toLocaleString("en-US") + " ms");
const row = (name, s) => `| ${name} | ${s.operations.toLocaleString("en-US")} | ${s.errors} | ${s.throughputPerSecond} | ${s.p50Ms} | ${s.p95Ms} | ${s.p99Ms} |`;
export function markdown(report) {
  const { environment: env, results: r, options: o } = report;
  const lines = [
    `# Benchmark run \`${o.label}\``, "",
    "Local measurement with the real engine stores against PostgreSQL. Not a production capacity claim.", "",
    "## Command", "", "```sh",
    `DGE_TEST_DATABASE_URL=postgresql://postgres:…@127.0.0.1:5432/<admin>_test node scripts/benchmark.mjs ${Object.entries(o).filter(([k, v]) => k !== "keep" && (k !== "out" || v !== DEFAULTS.out) && Object.hasOwn(DEFAULTS, k)).map(([k, v]) => `--${k}=${v}`).join(" ")}`.trim(),
    "```", "",
    "## Hardware and software", "",
    `- CPU: ${env.cpuModel} × ${env.cpuCount} logical CPUs`, `- Memory: ${env.memoryGiB} GiB`, `- OS: ${env.platform}`,
    `- Node.js ${env.node}; PostgreSQL ${env.postgres} (${Object.entries(env.postgresSettings).map(([k, v]) => k + "=" + v).join(", ")})`,
    `- ${env.topology}`, `- Runtime pool: ${o.pool} connections; client concurrency: ${o.concurrency}`, "",
    "## Results", "",
    "| Operation | Count | Errors | Ops/s | p50 ms | p95 ms | p99 ms |", "|---|---:|---:|---:|---:|---:|---:|",
    row(`First ballots, one hot decision (${r.hotDecision.voters} voters)`, r.hotDecision.firstBallots),
    row("Ballot changes (expectedVersion 1)", r.hotDecision.ballotChanges),
    row("Participant decision reads after all ballots", r.hotDecision.participantReadsAfterAllBallots),
    row("Public reads, mixed", r.publicReads.overall),
    ...Object.entries(r.publicReads.byEndpoint).map(([k, s]) => row("  public " + k, s)),
    row("Ledger inclusion proofs", r.ledger.inclusionProofs), "",
    `- Hot decision open (frozen electorate ${r.hotDecision.electorate}): ${ms(r.hotDecision.openMs)}; close + tally of ${r.hotDecision.ballotsStored} ballots: ${ms(r.hotDecision.closeAndTallyMs)}.`,
  ];
  if (r.ballotStorage) lines.push(
    `- Ballot storage: ${r.ballotStorage.totalBallotRows.toLocaleString("en-US")} ballot rows (${r.ballotStorage.decisions} decisions × ${r.ballotStorage.electoratePerDecision.toLocaleString("en-US")} electors), ${(r.ballotStorage.ballotTableBytesIncludingIndexes / 2 ** 20).toFixed(1)} MiB including indexes; bulk load ${ms(r.ballotStorage.bulkLoadMs)}.`,
    `- Opening a decision with a ${r.ballotStorage.electoratePerDecision.toLocaleString("en-US")}-member frozen electorate: median ${ms([...r.ballotStorage.openDecisionMs].sort((a, b) => a - b)[Math.floor(r.ballotStorage.openDecisionMs.length / 2)])}.`,
    `- Real close + tally of one decision with ${r.ballotStorage.closedDecisionBallots.toLocaleString("en-US")} ballots while ${r.ballotStorage.totalBallotRows.toLocaleString("en-US")} rows are stored: ${ms(r.ballotStorage.closeAndTallyOneDecisionMs)}; reading another decision: ${ms(r.ballotStorage.readOneClosedOrOpenDecisionMs)}.`,
    `- Bulk method: ${r.ballotStorage.method}`);
  lines.push(
    `- Ledger: sequenced ${r.ledger.sequenced.toLocaleString("en-US")} pending events in ${ms(r.ledger.sequenceMs)} (${r.ledger.entriesPerSecond} entries/s); signed checkpoint over ${r.ledger.logSize} leaves in ${ms(r.ledger.checkpointMs)}.`,
    `- Public reads extrapolated: ${r.publicReads.extrapolatedReadsPerDay.toLocaleString("en-US")} reads/day (${r.publicReads.extrapolation}).`,
    "", "## Limits of this measurement", "",
    "- Single host; load generator and database compete for the same CPUs. No network latency, TLS, reverse proxy or CDN.",
    "- Voter memberships and bulk ballot rows are inserted directly by the administrative connection; every cast, read, open and close goes through the real store with the unprivileged runtime role and row-level security.",
    "- Short runs: no 24-hour soak, no failover, no overload/backpressure test, no autovacuum steady state.",
    `- Started ${report.startedAt}, finished ${report.finishedAt}.`, "");
  return lines.join("\n");
}

async function writeReport(options, report) {
  await mkdir(options.out, { recursive: true });
  const base = `${options.out}/${options.label}`;
  await writeFile(base + ".json", JSON.stringify(report, null, 2) + "\n");
  await writeFile(base + ".md", markdown(report));
  log("wrote", base + ".json", base + ".md");
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error); process.exit(1); });
