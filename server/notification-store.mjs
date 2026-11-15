// DCE-032 subscriptions, delivery preferences, verified email addresses and
// the in-app inbox. Every account-owned row is guarded by row policies keyed
// on dge.account_id; unsubscribe and email verification work without a
// session through HMAC-signed single-purpose tokens.
import { createHmac, createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { AccessError } from "./identity-store.mjs";
import { DocumentError } from "./document-store.mjs";
import { createAccountScope, asAccount } from "./account-scope.mjs";
import { createTranslator, SUPPORTED_LOCALES } from "../src/i18n.mjs";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const CADENCES = Object.freeze(["immediate", "daily", "weekly", "off"]);
export const TARGET_KINDS = Object.freeze(["document", "proposal", "workspace"]);
const EMAIL = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const fail = (code, status = 400) => { throw new DocumentError(code, status); };
const check = (condition, code, status) => { if (!condition) fail(code, status); };
const iso = (value) => (value === null || value === undefined ? null : new Date(value).toISOString());

export function normalizeEmailAddress(value) {
  check(typeof value === "string" && value.length <= 254, "INVALID_EMAIL_ADDRESS");
  const address = value.trim();
  check(EMAIL.test(address), "INVALID_EMAIL_ADDRESS");
  const at = address.lastIndexOf("@");
  return address.slice(0, at) + "@" + address.slice(at + 1).toLowerCase();
}
const addressDigest = (address) => createHash("sha256").update("dge-notification-address-v1\0" + address).digest("hex").slice(0, 32);

/**
 * Signed single-purpose tokens: "n1.<payload>.<mac>". The purpose is inside
 * the MAC, so an unsubscribe token can never verify an email address and the
 * reverse. Tokens carry identifiers only.
 */
export function createNotificationTokens({ key, clock = Date.now }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw Error("A 32-byte notification token key is required");
  const secret = Buffer.from(key);
  const mac = (payload) => createHmac("sha256", secret).update("dge-notification-token-v1\0" + payload).digest();
  return Object.freeze({
    sign(purpose, claims, ttlMs) {
      const payload = Buffer.from(JSON.stringify({ ...claims, p: purpose, e: Math.floor((clock() + ttlMs) / 1000) })).toString("base64url");
      return "n1." + payload + "." + mac(payload).toString("base64url");
    },
    verify(purpose, token) {
      if (typeof token !== "string" || token.length > 600) return null;
      const match = /^n1\.([A-Za-z0-9_-]{10,500})\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (!match) return null;
      const expected = mac(match[1]), given = Buffer.from(match[2], "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      let claims;
      try { claims = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")); } catch { return null; }
      if (claims?.p !== purpose || !Number.isSafeInteger(claims.e) || claims.e * 1000 <= clock() || !UUID.test(claims.a ?? "")) return null;
      return claims;
    },
  });
}

export const defaultLinks = (origin) => Object.freeze({
  document: (documentId) => origin + "/?document=" + encodeURIComponent(documentId),
  unsubscribe: (token) => origin + "/notifications/unsubscribe#" + token,
  verifyEmail: (token) => origin + "/notifications/verify-email#" + token,
});

function preferenceView(row, emailRow, emailAvailable) {
  return {
    inApp: row?.in_app ?? "immediate",
    email: row?.email ?? "off",
    locale: row?.locale ?? "en",
    emailAddress: emailRow ? { address: emailRow.address, verified: emailRow.verified_at !== null } : null,
    emailAvailable,
  };
}
const subscriptionView = (row) => ({
  id: row.id, targetKind: row.target_kind, targetId: row.target_id, workspaceId: row.tenant_id,
  documentId: row.document_id, createdAt: iso(row.created_at),
});
const inboxView = (row) => ({
  id: row.id, kind: row.kind, cadence: row.cadence, items: row.items, createdAt: iso(row.created_at),
  read: row.read_at !== null, cursor: String(row.position),
});

export function createNotificationStore({
  identity, transaction, tokens, origin, email = null, links = defaultLinks(origin), clock = Date.now,
  maxSubscriptions = 500, unsubscribeTtlMs = 60 * 86400000, verificationTtlMs = 86400000, verificationIntervalMs = 60000,
}) {
  if (typeof transaction !== "function" || !tokens || typeof origin !== "string" || !origin.startsWith("https://"))
    throw Error("Notification store requires a transaction runner, tokens and an HTTPS origin");
  if (email !== null && typeof email?.send !== "function") throw Error("Email adapter must provide send()");
  const accountScope = createAccountScope({ identity, transaction });
  const now = () => new Date(clock());
  const page = (limit) => check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "INVALID_PAGE");

  async function readPreferences(db, accountId) {
    const pref = (await db.query("SELECT * FROM dge_notifications.preferences WHERE account_id=$1", [accountId])).rows[0];
    const address = (await db.query("SELECT * FROM dge_notifications.email_addresses WHERE account_id=$1", [accountId])).rows[0];
    return { pref, address };
  }
  async function writePreferences(db, accountId, next) {
    await db.query(
      `INSERT INTO dge_notifications.preferences(account_id,in_app,email,locale,updated_at) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (account_id) DO UPDATE SET in_app=EXCLUDED.in_app,email=EXCLUDED.email,locale=EXCLUDED.locale,updated_at=EXCLUDED.updated_at`,
      [accountId, next.inApp, next.email, next.locale, now()]);
  }

  /** Resolves a follow target to its workspace and document using only public or member-visible rows. */
  async function resolveTarget(db, accountId, targetKind, targetId) {
    if (targetKind === "workspace") {
      const member = (await db.query("SELECT 1 FROM dge_identity.memberships WHERE tenant_id=$1 AND account_id=$2 AND active", [targetId, accountId])).rows.length;
      if (!member) throw new AccessError("ACCESS_DENIED");
      return { tenantId: targetId, documentId: null };
    }
    await db.query("SELECT set_config('dge.public_document_directory','enabled',true), set_config('dge.public_search','enabled',true)");
    if (targetKind === "document") {
      const row = (await db.query("SELECT tenant_id FROM dge_documents.documents WHERE id=$1 AND visibility='public'", [targetId])).rows[0];
      check(row, "DOCUMENT_NOT_FOUND", 404);
      return { tenantId: row.tenant_id, documentId: targetId };
    }
    const row = (await db.query("SELECT tenant_id,document_id FROM dge_proposals.proposals WHERE id=$1", [targetId])).rows[0];
    check(row, "PROPOSAL_NOT_FOUND", 404);
    return { tenantId: row.tenant_id, documentId: row.document_id };
  }

  async function sendVerification(accountId, address, locale) {
    const t = createTranslator(locale);
    const token = tokens.sign("verify-email", { a: accountId, h: addressDigest(address) }, verificationTtlMs);
    await email.send({
      to: address,
      subject: t("notifications.email.verifySubject"),
      text: t("notifications.email.verifyBody", { link: links.verifyEmail(token) }),
      tag: "verification",
    });
  }

  return Object.freeze({
    emailAvailable: email !== null,
    unsubscribeToken: (accountId, scope) => tokens.sign("unsubscribe", scope.subscriptionId ? { a: accountId, s: scope.subscriptionId } : { a: accountId, c: "email" }, unsubscribeTtlMs),

    async subscribe(credentials, { targetKind, targetId }) {
      check(TARGET_KINDS.includes(targetKind) && UUID.test(targetId ?? ""), "INVALID_SUBSCRIPTION");
      return accountScope(credentials, { write: true }, async (db, accountId) => {
        const target = await resolveTarget(db, accountId, targetKind, targetId);
        const existing = (await db.query("SELECT * FROM dge_notifications.subscriptions WHERE account_id=$1 AND target_kind=$2 AND target_id=$3", [accountId, targetKind, targetId])).rows[0];
        if (existing) return subscriptionView(existing);
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["notification-subscriptions:" + accountId]);
        const count = (await db.query("SELECT count(*)::int AS n FROM dge_notifications.subscriptions WHERE account_id=$1", [accountId])).rows[0].n;
        check(count < maxSubscriptions, "SUBSCRIPTION_LIMIT_REACHED", 429);
        const row = (await db.query(
          `INSERT INTO dge_notifications.subscriptions(id,account_id,target_kind,target_id,tenant_id,document_id,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (account_id,target_kind,target_id) DO NOTHING RETURNING *`,
          [randomUUID(), accountId, targetKind, targetId, target.tenantId, target.documentId, now()])).rows[0]
          ?? (await db.query("SELECT * FROM dge_notifications.subscriptions WHERE account_id=$1 AND target_kind=$2 AND target_id=$3", [accountId, targetKind, targetId])).rows[0];
        return subscriptionView(row);
      });
    },

    async unsubscribe(credentials, subscriptionId) {
      check(UUID.test(subscriptionId ?? ""), "INVALID_SUBSCRIPTION");
      return accountScope(credentials, { write: true }, async (db, accountId) => {
        const removed = (await db.query("DELETE FROM dge_notifications.subscriptions WHERE id=$1 AND account_id=$2 RETURNING id", [subscriptionId, accountId])).rows.length;
        check(removed, "SUBSCRIPTION_NOT_FOUND", 404);
        return { removed: true };
      });
    },

    async subscriptions(credentials, { after = null, limit = 50 } = {}) {
      check(after === null || UUID.test(after), "INVALID_PAGE");
      page(limit);
      return accountScope(credentials, {}, async (db, accountId) => {
        const rows = (await db.query(
          "SELECT * FROM dge_notifications.subscriptions WHERE account_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3",
          [accountId, after, limit + 1])).rows;
        return { items: rows.slice(0, limit).map(subscriptionView), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
      });
    },

    async preferences(credentials) {
      return accountScope(credentials, {}, async (db, accountId) => {
        const { pref, address } = await readPreferences(db, accountId);
        return preferenceView(pref, address, email !== null);
      });
    },

    async updatePreferences(credentials, { inApp, email: emailCadence, locale }) {
      check(CADENCES.includes(inApp) && CADENCES.includes(emailCadence) && SUPPORTED_LOCALES.includes(locale), "INVALID_PREFERENCES");
      if (emailCadence !== "off") check(email !== null, "EMAIL_UNAVAILABLE", 503);
      return accountScope(credentials, { write: true }, async (db, accountId) => {
        const { address } = await readPreferences(db, accountId);
        if (emailCadence !== "off") check(address?.verified_at, "EMAIL_NOT_VERIFIED", 409);
        await writePreferences(db, accountId, { inApp, email: emailCadence, locale });
        const current = await readPreferences(db, accountId);
        return preferenceView(current.pref, current.address, email !== null);
      });
    },

    /** Stores an unverified address and sends a verification link through the adapter. */
    async setEmailAddress(credentials, { address }) {
      check(email !== null, "EMAIL_UNAVAILABLE", 503);
      const normalized = normalizeEmailAddress(address);
      const { accountId, locale } = await accountScope(credentials, { write: true }, async (db, accountId) => {
        const { pref, address: existing } = await readPreferences(db, accountId);
        if (existing && existing.address === normalized && existing.verified_at) return { accountId, locale: null };
        check(!existing || clock() - new Date(existing.verification_sent_at).getTime() >= verificationIntervalMs, "VERIFICATION_RATE_LIMITED", 429);
        await db.query(
          `INSERT INTO dge_notifications.email_addresses(account_id,address,verified_at,verification_sent_at,updated_at) VALUES($1,$2,NULL,$3,$3)
           ON CONFLICT (account_id) DO UPDATE SET address=EXCLUDED.address,verified_at=NULL,verification_sent_at=EXCLUDED.verification_sent_at,updated_at=EXCLUDED.updated_at`,
          [accountId, normalized, now()]);
        // A changed address must be verified again before any email is sent to it.
        if (pref && pref.email !== "off") await writePreferences(db, accountId, { inApp: pref.in_app, email: "off", locale: pref.locale });
        return { accountId, locale: pref?.locale ?? "en" };
      });
      if (locale === null) return { address: normalized, verified: true, verificationSent: false };
      try { await sendVerification(accountId, normalized, locale); }
      catch { fail("EMAIL_DELIVERY_FAILED", 502); }
      return { address: normalized, verified: false, verificationSent: true };
    },

    async removeEmailAddress(credentials) {
      return accountScope(credentials, { write: true }, async (db, accountId) => {
        await db.query("DELETE FROM dge_notifications.email_addresses WHERE account_id=$1", [accountId]);
        await db.query("UPDATE dge_notifications.preferences SET email='off',updated_at=$2 WHERE account_id=$1", [accountId, now()]);
        return { removed: true };
      });
    },

    async verifyEmail({ token }) {
      const claims = tokens.verify("verify-email", token);
      check(claims && /^[a-f0-9]{32}$/.test(claims.h ?? ""), "INVALID_TOKEN", 400);
      return asAccount(transaction, claims.a, async (db) => {
        const row = (await db.query("SELECT address,verified_at FROM dge_notifications.email_addresses WHERE account_id=$1 FOR UPDATE", [claims.a])).rows[0];
        check(row && addressDigest(row.address) === claims.h, "INVALID_TOKEN", 400);
        if (!row.verified_at) await db.query("UPDATE dge_notifications.email_addresses SET verified_at=$2,updated_at=$2 WHERE account_id=$1", [claims.a, now()]);
        return { verified: true };
      });
    },

    /** What a token would do, so a confirmation page can describe it without acting. */
    describeUnsubscribe({ token }) {
      const claims = tokens.verify("unsubscribe", token);
      check(claims && (UUID.test(claims.s ?? "") || claims.c === "email"), "INVALID_TOKEN", 400);
      return { scope: claims.s ? "subscription" : "email" };
    },

    /** Idempotent: a token for an already removed subscription still succeeds. */
    async applyUnsubscribe({ token }) {
      const claims = tokens.verify("unsubscribe", token);
      check(claims && (UUID.test(claims.s ?? "") || claims.c === "email"), "INVALID_TOKEN", 400);
      return asAccount(transaction, claims.a, async (db) => {
        if (claims.s) await db.query("DELETE FROM dge_notifications.subscriptions WHERE id=$1 AND account_id=$2", [claims.s, claims.a]);
        else await db.query("UPDATE dge_notifications.preferences SET email='off',updated_at=$2 WHERE account_id=$1", [claims.a, now()]);
        return { unsubscribed: true, scope: claims.s ? "subscription" : "email" };
      });
    },

    async inbox(credentials, { before = null, limit = 30 } = {}) {
      check(before === null || /^[1-9][0-9]{0,17}$/.test(before), "INVALID_PAGE");
      page(limit);
      return accountScope(credentials, {}, async (db, accountId) => {
        const rows = (await db.query(
          "SELECT * FROM dge_notifications.inbox WHERE account_id=$1 AND ($2::bigint IS NULL OR position<$2::bigint) ORDER BY position DESC LIMIT $3",
          [accountId, before, limit + 1])).rows;
        const unread = (await db.query("SELECT count(*)::int AS n FROM dge_notifications.inbox WHERE account_id=$1 AND read_at IS NULL", [accountId])).rows[0].n;
        return { items: rows.slice(0, limit).map(inboxView), nextCursor: rows.length > limit ? String(rows[limit - 1].position) : null, unreadCount: unread };
      });
    },

    async markInbox(credentials, { ids, read }) {
      check(Array.isArray(ids) && ids.length >= 1 && ids.length <= 100 && ids.every((id) => UUID.test(id)) && typeof read === "boolean", "INVALID_INBOX_UPDATE");
      return accountScope(credentials, { write: true }, async (db, accountId) => {
        const changed = (await db.query(
          "UPDATE dge_notifications.inbox SET read_at=$3 WHERE account_id=$1 AND id = ANY($2::uuid[]) RETURNING id",
          [accountId, ids, read ? now() : null])).rows.length;
        return { updated: changed };
      });
    },

    async markAllRead(credentials) {
      return accountScope(credentials, { write: true }, async (db, accountId) => ({
        updated: (await db.query("UPDATE dge_notifications.inbox SET read_at=$2 WHERE account_id=$1 AND read_at IS NULL RETURNING id", [accountId, now()])).rows.length,
      }));
    },
  });
}
