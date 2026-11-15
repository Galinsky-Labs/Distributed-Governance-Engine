// Composition root shared by the production entry point, the test fixture and
// the CivicQuill/CharterQuill application packages. It assembles every engine
// store, route family and background worker from one set of dependencies, so
// a feature can never be wired in tests but forgotten in production.
import { createHash } from "node:crypto";
import { createDocumentStore } from "./document-store.mjs";
import { createDocumentRoutes, documentBodyLimit } from "./document-http.mjs";
import { createProposalStore } from "./proposal-store.mjs";
import { createProposalRoutes, proposalBodyLimit } from "./proposal-http.mjs";
import { createDiscussionStore } from "./discussion-store.mjs";
import { createDiscussionRoutes, discussionBodyLimit } from "./discussion-http.mjs";
import { createDecisionStore } from "./decision-store.mjs";
import { createDecisionRoutes, decisionBodyLimit } from "./decision-http.mjs";
import { createLedger } from "./ledger.mjs";
import { createLedgerRoutes, ledgerBodyLimit } from "./ledger-http.mjs";
import { createVerificationRoutes, verificationBodyLimit } from "./verification-http.mjs";
import { createExportRoutes, exportBodyLimit } from "./export-http.mjs";
import { createEditionStore } from "./edition-store.mjs";
import { createEditionRoutes, editionBodyLimit } from "./edition-http.mjs";
import { createSignatureStore } from "./signature-store.mjs";
import { createSignatureRoutes, signatureBodyLimit } from "./signature-http.mjs";
import { createSearchStore } from "./search-store.mjs";
import { createSearchRoutes, searchBodyLimit } from "./search-http.mjs";
import { createNotificationStore, createNotificationTokens } from "./notification-store.mjs";
import { createNotificationRoutes, notificationBodyLimit } from "./notification-http.mjs";
import { createNotificationWorker } from "./notification-worker.mjs";
import { createSettingsStore, createPlatformAccess } from "./settings-store.mjs";
import { createSettingsRoutes, settingsBodyLimit } from "./settings-http.mjs";
import { createEntitlementStore } from "./entitlement-store.mjs";
import { createBillingStore } from "./billing-store.mjs";
import { createBillingRoutes, billingBodyLimit } from "./billing-http.mjs";
import { createElectorateStore } from "./electorate-store.mjs";
import { createElectorateRoutes, electorateBodyLimit } from "./electorate-http.mjs";
import { createSectionGrantStore } from "./section-grants.mjs";
import { createSectionGrantRoutes, sectionGrantBodyLimit } from "./section-grants-http.mjs";
import { createModerationStore } from "./moderation-store.mjs";
import { createModerationRoutes, moderationBodyLimit } from "./moderation-http.mjs";
import { createPasskeySignin, passkeySigninBodyLimit } from "./passkey-signin.mjs";
import { createAccountHandler } from "./account-http.mjs";
import { createEngineApplication } from "./application.mjs";
import { createPrivateWorkspaceServices } from "./private-workspace.mjs";

const EXTENSION_ID = /^[a-z][a-z0-9-]{1,40}$/;
/** Browser pages served by the engine shell (see web/engine-pages.jsx). */
export const ENGINE_PAGES = Object.freeze(["/verify", "/transparency", "/documents/import", "/documents/export", "/search", "/notifications", "/notifications/unsubscribe", "/notifications/verify-email", "/editions", "/signatures", "/signers", "/admin", "/billing", "/governance/electorates", "/governance/moderation", "/governance/clause-access", "/signin"]);

/**
 * Validates an application extension (for example CivicQuill's civic module).
 * Extensions add namespaced schemas, routes, workers and browser modules; they
 * never replace engine tally, adoption, cryptography or ledger logic.
 */
export function validateExtension(extension) {
  if (!extension || !EXTENSION_ID.test(extension.id ?? "")) throw Error("Invalid platform extension");
  for (const m of extension.migrations ?? [])
    if (!/^[0-9]{3}-[a-z0-9-]+\.sql$/.test(m.name ?? "") || typeof m.sql !== "string")
      throw Error("Invalid extension migration");
  if (extension.createRoutes !== undefined && typeof extension.createRoutes !== "function") throw Error("Invalid extension routes");
  return extension;
}

const checksum = (sql) => createHash("sha256").update(sql).digest("hex");

/** Applies an extension's ordered migrations with the migration credential. */
export async function applyExtensionMigrations(transaction, extension) {
  validateExtension(extension);
  return transaction(async (db) => {
    const exec = (s) => (db.exec ? db.exec(s) : db.query(s));
    await db.query("SELECT pg_advisory_xact_lock(1245995846)");
    await exec("CREATE TABLE IF NOT EXISTS dge_identity.extension_migrations(extension text NOT NULL,version integer NOT NULL,name text NOT NULL,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(extension,version))");
    // The runtime verifies extension schemas at startup; it may read, never write.
    await exec("GRANT SELECT ON dge_identity.extension_migrations TO dge_identity_runtime");
    let applied = 0;
    for (const [index, migration] of (extension.migrations ?? []).entries()) {
      const prior = (await db.query("SELECT checksum,name FROM dge_identity.extension_migrations WHERE extension=$1 AND version=$2", [extension.id, index + 1])).rows[0];
      if (prior) {
        if (prior.checksum !== checksum(migration.sql) || prior.name !== migration.name) throw Error("Extension migration history changed");
        continue;
      }
      await exec(migration.sql);
      await db.query("INSERT INTO dge_identity.extension_migrations(extension,version,name,checksum) VALUES($1,$2,$3,$4)",
        [extension.id, index + 1, migration.name, checksum(migration.sql)]);
      applied++;
    }
    return { applied };
  });
}

/** Startup check: the runtime refuses to serve against an unexpected schema. */
export async function verifyExtensionMigrations(db, extension) {
  const expected = extension.migrations ?? [];
  if (!expected.length) return true;
  const observed = (await db.query("SELECT version,name,checksum FROM dge_identity.extension_migrations WHERE extension=$1 ORDER BY version", [extension.id])).rows;
  if (observed.length !== expected.length || expected.some((m, i) => observed[i].name !== m.name || observed[i].checksum !== checksum(m.sql)))
    throw Error("Expected extension schema required");
  return true;
}

export function createPlatform({
  identity, transaction, login, origin, product = "civic", clock = Date.now,
  logId, logSigningKey, anchorProviders = [], anchorOptions = {},
  extensions = [], assetDirectory, readiness, release = null, budget,
  decorateDocuments = (documents) => documents,
  verifyPasskeyAuthentication, notificationTokenKey = null, email = null,
  paymentProviders = [], enforceEntitlements = true, personKeySecret = null,
  privateWorkspaces = false, privateLimits = {}, passkeySignin = false,
}) {
  if (typeof privateWorkspaces !== "boolean") throw Error("Invalid private workspace setting");
  for (const extension of extensions) validateExtension(extension);
  const settings = createSettingsStore({ identity, transaction, product, clock });
  const entitlements = createEntitlementStore({ identity, transaction, settings, clock });
  const billing = createBillingStore({ identity, transaction, settings, entitlements, origin, clock, providers: paymentProviders.filter(Boolean) });
  const platformAccess = createPlatformAccess({ identity, clock });
  // Creation reserves an entitlement; reading, discussing and voting never do.
  const documents = decorateDocuments(createDocumentStore({ identity, transaction, ...(enforceEntitlements ? { entitlements } : {}) }));
  const proposals = createProposalStore({ identity, transaction });
  const discussion = createDiscussionStore({ identity, transaction });
  const decisions = createDecisionStore({ identity, transaction, clock });
  const ledger = logSigningKey
    ? createLedger({ transaction, logId, signingKey: logSigningKey, clock, anchorProviders, ...anchorOptions })
    : null;
  const electorates = createElectorateStore({ identity, clock, ...(personKeySecret ? { personKeySecret } : {}) });
  const sectionGrants = createSectionGrantStore({ identity, clock });
  const moderation = createModerationStore({ identity, transaction, clock });
  const editions = createEditionStore({ identity, transaction, clock });
  const signatures = createSignatureStore({ identity, transaction, origin, clock, ...(verifyPasskeyAuthentication ? { verifyPasskeyAuthentication } : {}) });
  const search = createSearchStore({ identity, transaction, product });
  // Notifications need an unsubscribe-token key; without one they stay disabled.
  const notifications = notificationTokenKey
    ? createNotificationStore({ identity, transaction, origin, email, tokens: createNotificationTokens({ key: notificationTokenKey }) })
    : null;
  const services = {
    identity, transaction, clock, origin, product, documents, proposals, discussion, decisions, ledger,
    editions, signatures, search, notifications, settings, entitlements, billing, electorates, sectionGrants, moderation,
    /** True only for platform administrators granted through the operator CLI. */
    isPlatformAdmin: async (credentials) => {
      try {
        const accountId = await platformAccess.account(credentials);
        return await transaction((db) => platformAccess.isAdmin(db, accountId));
      } catch { return false; }
    },
  };

  // Without an external OIDC provider, discoverable passkeys are the sign-in.
  const signin = passkeySignin ? createPasskeySignin({ identity, transaction, origin, clock, rpName: product === "charter" ? "CharterQuill" : "CivicQuill" }) : null;
  if (!login && !signin) throw Error("An identity provider or passkey sign-in is required");
  const routeSets = [
    ...(signin ? [{ routes: signin.routes, bodyLimit: passkeySigninBodyLimit }] : []),
    { routes: createElectorateRoutes({ electorates }), bodyLimit: electorateBodyLimit },
    { routes: createSectionGrantRoutes({ sectionGrants }), bodyLimit: sectionGrantBodyLimit },
    { routes: createModerationRoutes({ moderation }), bodyLimit: moderationBodyLimit },
    { routes: createEditionRoutes({ editions }), bodyLimit: editionBodyLimit },
    { routes: createSignatureRoutes({ signatures }), bodyLimit: signatureBodyLimit },
    { routes: createSearchRoutes({ search }), bodyLimit: searchBodyLimit },
    { routes: createSettingsRoutes({ settings }), bodyLimit: settingsBodyLimit },
    { routes: createBillingRoutes({ entitlements, billing }), bodyLimit: billingBodyLimit },
    ...(notifications ? [{ routes: createNotificationRoutes({ notifications, origin }), bodyLimit: notificationBodyLimit }] : []),
    { routes: createDecisionRoutes({ decisions }), bodyLimit: decisionBodyLimit },
    { routes: createDiscussionRoutes({ discussion }), bodyLimit: discussionBodyLimit },
    { routes: createProposalRoutes({ proposals }), bodyLimit: proposalBodyLimit },
    { routes: createDocumentRoutes({ documents }), bodyLimit: documentBodyLimit },
  ];
  routeSets.unshift({ routes: createExportRoutes({ documents, clock }), bodyLimit: exportBodyLimit });
  routeSets.unshift({ routes: createVerificationRoutes({ transaction, ledger, decisions, clock }), bodyLimit: verificationBodyLimit });
  if (ledger) routeSets.unshift({ routes: createLedgerRoutes({ ledger, isPlatformAdmin: services.isPlatformAdmin }), bodyLimit: ledgerBodyLimit });
  // End-to-end encrypted workspaces: ciphertext, public MLS material and an
  // ordered handshake mailbox only. The server never holds a decryption key.
  const privateWorkspace = privateWorkspaces ? createPrivateWorkspaceServices({ identity, clock, limits: privateLimits }) : null;
  if (privateWorkspace) { services.privateWorkspace = privateWorkspace; routeSets.unshift(...privateWorkspace.routeSets); }
  const workers = ledger ? [{ name: "ledger", intervalMs: 5000, tick: () => ledger.tick() }] : [];
  if (notifications) {
    const notificationWorker = createNotificationWorker({ transaction, store: notifications, email, origin });
    workers.push({ name: "notifications", intervalMs: 30000, tick: () => notificationWorker.tick() });
  }
  for (const extension of extensions) {
    for (const set of extension.createRoutes?.(services) ?? []) routeSets.unshift(set);
    for (const worker of extension.createWorkers?.(services) ?? []) workers.push(worker);
  }
  // Platform routes are matched before account management, in a stable order.
  const accounts = createAccountHandler({ store: identity, login: login ?? signin.login, origin, ...(budget ? { budget } : {}), extensions: routeSets.map((s) => s.routes) });
  const pagePaths = [...ENGINE_PAGES, ...extensions.flatMap((e) => e.pagePaths ?? [])];
  const application = createEngineApplication({
    accounts, origin, product, readiness, release, pagePaths, privateWorkspaces,
    ...(assetDirectory ? { assetDirectory } : {}),
  });
  const bodyLimit = (path) => Math.max(...routeSets.map((s) => s.bodyLimit(path)));
  return { services, application, bodyLimit, workers };
}

/**
 * Runs background duties on a fixed cadence without overlapping passes. The
 * scheduler is an availability mechanism only: durable outboxes stay the
 * authority, so a missed tick merely delays sequencing.
 */
export function startWorkers(workers, { onError = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const timers = new Map();
  let stopped = false;
  const stats = new Map(workers.map((w) => [w.name, { runs: 0, failures: 0, lastRunAt: null }]));
  const run = async (worker) => {
    if (stopped) return;
    const stat = stats.get(worker.name);
    try { await worker.tick(); stat.runs++; }
    catch (error) { stat.failures++; onError(worker.name, error); }
    stat.lastRunAt = new Date().toISOString();
    if (!stopped) timers.set(worker.name, setTimer(() => run(worker), worker.intervalMs));
  };
  for (const worker of workers) timers.set(worker.name, setTimer(() => run(worker), Math.min(worker.intervalMs, 1000)));
  return {
    stats: () => Object.fromEntries(stats),
    stop() { stopped = true; for (const t of timers.values()) clearTimer(t); },
  };
}
