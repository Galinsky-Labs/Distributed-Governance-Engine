// DCE-032 notification worker. It consumes committed public events from the
// transparency log (dge_ledger.entries) after a stored cursor, fans them out
// to subscribers as durable delivery rows, and delivers due rows in-app or by
// email. Permission is checked again at delivery: an unsubscribe, a removed
// membership, a suspended account or a channel switched off suppresses the
// notice before it is shown or sent. Messages carry titles, event kinds and
// links to public content only. Worker transactions declare
// dge.worker='notifications', which the row policies require.
import { randomUUID } from "node:crypto";
import { createTranslator } from "../src/i18n.mjs";
import { defaultLinks } from "./notification-store.mjs";

const KNOWN_KINDS = new Set(["document-version", "proposal", "discussion-event", "decision-event"]);
const DIGEST = new Set(["daily", "weekly"]);
const errorCode = (error) => String(error?.code ?? error?.message ?? "delivery-error").toLowerCase().replace(/[^a-z0-9 .:_-]/g, "").slice(0, 120) || "delivery-error";

/** Next digest boundary strictly after `from`: daily at hourUtc, weekly on weekdayUtc (0 = Sunday). */
export function nextDigestAt(from, cadence, { hourUtc = 8, weekdayUtc = 1 } = {}) {
  const at = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), hourUtc));
  if (at <= from) at.setUTCDate(at.getUTCDate() + 1);
  if (cadence === "weekly") while (at.getUTCDay() !== weekdayUtc) at.setUTCDate(at.getUTCDate() + 1);
  return at;
}

export function createNotificationWorker({
  transaction, store, email = null, origin, links = defaultLinks(origin), clock = Date.now,
  fanOutBatch = 200, deliveryGroups = 50, digestLimit = 200, maxAttempts = 8, leaseMs = 300000,
  digestHourUtc = 8, digestWeekdayUtc = 1, onError = () => {},
}) {
  if (typeof transaction !== "function" || typeof store?.unsubscribeToken !== "function")
    throw Error("Notification worker requires a transaction runner and the notification store");
  if (email !== null && typeof email?.send !== "function") throw Error("Email adapter must provide send()");
  if (!Number.isSafeInteger(digestHourUtc) || digestHourUtc < 0 || digestHourUtc > 23 ||
      !Number.isSafeInteger(digestWeekdayUtc) || digestWeekdayUtc < 0 || digestWeekdayUtc > 6) throw Error("Invalid digest schedule");
  const now = () => new Date(clock());
  const worker = (fn) => transaction(async (db) => {
    await db.query("SELECT set_config('dge.worker','notifications',true), set_config('dge.public_document_directory','enabled',true), set_config('dge.public_search','enabled',true)");
    return fn(db);
  });
  const backoff = (attempts) => Math.min(6 * 3600000, 60000 * 2 ** Math.min(attempts, 9));

  /** Maps a log entry to the public document (and proposal) it concerns, or null to skip it. */
  async function resolveEntry(db, entry) {
    await db.query("SELECT set_config('dge.tenant_id',$1,true)", [entry.tenant_id]);
    let documentId = entry.subject_id, proposalId = null;
    const digest = entry.event_digest.trim();
    if (entry.kind === "proposal")
      proposalId = (await db.query("SELECT proposal_id FROM dge_proposals.anchor_outbox WHERE tenant_id=$1 AND document_id=$2 AND event_digest=$3", [entry.tenant_id, documentId, digest])).rows[0]?.proposal_id ?? null;
    else if (entry.kind === "discussion-event")
      proposalId = (await db.query("SELECT proposal_id FROM dge_discussion.anchor_outbox WHERE tenant_id=$1 AND document_id=$2 AND event_digest=$3", [entry.tenant_id, documentId, digest])).rows[0]?.proposal_id ?? null;
    else if (entry.kind === "decision-event") {
      const decision = (await db.query("SELECT document_id,proposal_id FROM dge_decisions.decisions WHERE tenant_id=$1 AND id=$2", [entry.tenant_id, entry.subject_id])).rows[0];
      if (!decision) return null;
      documentId = decision.document_id;
      proposalId = decision.proposal_id;
    }
    const document = (await db.query("SELECT 1 FROM dge_documents.documents WHERE tenant_id=$1 AND id=$2 AND visibility='public'", [entry.tenant_id, documentId])).rows[0];
    return document ? { tenantId: entry.tenant_id, documentId, proposalId, kind: KNOWN_KINDS.has(entry.kind) ? entry.kind : "other" } : null;
  }

  /** One fan-out pass. Re-running it never duplicates: rows are unique per (account, channel, seq). */
  async function fanOut() {
    return worker(async (db) => {
      const cursor = Number((await db.query("SELECT ledger_seq FROM dge_notifications.worker_cursor WHERE id FOR UPDATE")).rows[0].ledger_seq);
      const entries = (await db.query("SELECT * FROM dge_ledger.entries WHERE seq>$1 ORDER BY seq LIMIT $2", [cursor, fanOutBatch])).rows;
      if (!entries.length) return { entries: 0, queued: 0 };
      let queued = 0;
      const at = now();
      for (const entry of entries) {
        if (entry.scope !== "public") continue;
        const target = await resolveEntry(db, entry);
        if (!target) continue;
        const subscribers = (await db.query(
          `SELECT DISTINCT s.account_id, coalesce(p.in_app,'immediate') AS in_app, coalesce(p.email,'off') AS email
             FROM dge_notifications.subscriptions s LEFT JOIN dge_notifications.preferences p ON p.account_id=s.account_id
            WHERE s.created_at<=$4 AND ((s.target_kind='workspace' AND s.target_id=$1) OR (s.target_kind='document' AND s.target_id=$2)
               OR (s.target_kind='proposal' AND s.target_id=$3))`,
          [target.tenantId, target.documentId, target.proposalId, entry.recorded_at])).rows;
        for (const subscriber of subscribers)
          for (const [channel, cadence] of [["in-app", subscriber.in_app], ["email", subscriber.email]]) {
            if (cadence === "off") continue;
            const due = cadence === "immediate" ? at : nextDigestAt(at, cadence, { hourUtc: digestHourUtc, weekdayUtc: digestWeekdayUtc });
            queued += (await db.query(
              `INSERT INTO dge_notifications.deliveries(id,account_id,channel,cadence,ledger_seq,event_kind,tenant_id,document_id,proposal_id,recorded_at,status,due_at,next_attempt_at,created_at,updated_at)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$11,$12,$12) ON CONFLICT (account_id,channel,ledger_seq) DO NOTHING RETURNING id`,
              [randomUUID(), subscriber.account_id, channel, cadence, entry.seq, target.kind, target.tenantId, target.documentId, target.proposalId, entry.recorded_at, due, at])).rows.length;
          }
      }
      await db.query("UPDATE dge_notifications.worker_cursor SET ledger_seq=$1,updated_at=$2 WHERE id", [entries.at(-1).seq, at]);
      return { entries: entries.length, queued };
    });
  }

  /** The most specific still-valid subscription that covers an item, or null when access ended. */
  async function currentSubscription(db, accountId, row) {
    await db.query("SELECT set_config('dge.account_id',$1,true)", [accountId]);
    return (await db.query(
      `SELECT s.id FROM dge_notifications.subscriptions s
        WHERE s.account_id=$1 AND (
          (s.target_kind='proposal' AND s.target_id=$4) OR (s.target_kind='document' AND s.target_id=$3) OR
          (s.target_kind='workspace' AND s.target_id=$2 AND EXISTS (SELECT 1 FROM dge_identity.memberships m WHERE m.tenant_id=$2 AND m.account_id=$1 AND m.active)))
        ORDER BY CASE s.target_kind WHEN 'proposal' THEN 0 WHEN 'document' THEN 1 ELSE 2 END LIMIT 1`,
      [accountId, row.tenant_id, row.document_id, row.proposal_id])).rows[0]?.id ?? null;
  }

  const suppress = (db, ids, reason) => ids.length && db.query(
    "UPDATE dge_notifications.deliveries SET status='suppressed',last_error=$2,updated_at=$3 WHERE id = ANY($1::uuid[])", [ids, reason, now()]);

  /**
   * Claims one delivery group (a single immediate notice, or every due digest
   * item for one account, channel and cadence), re-checks access, writes the
   * in-app notice or prepares the email, all in one transaction.
   */
  async function claimGroup(group) {
    return worker(async (db) => {
      const at = now();
      const rows = (await db.query(
        `SELECT * FROM dge_notifications.deliveries
          WHERE status='pending' AND account_id=$1 AND channel=$2 AND cadence=$3 AND due_at<=$4 AND next_attempt_at<=$4
            AND ($5::uuid IS NULL OR id=$5) ORDER BY ledger_seq LIMIT $6 FOR UPDATE SKIP LOCKED`,
        [group.account_id, group.channel, group.cadence, at, group.cadence === "immediate" ? group.id : null, digestLimit])).rows;
      if (!rows.length) return null;
      const account = (await db.query("SELECT status FROM dge_identity.accounts WHERE id=$1", [group.account_id])).rows[0];
      const preference = (await db.query("SELECT * FROM dge_notifications.preferences WHERE account_id=$1", [group.account_id])).rows[0];
      const cadenceNow = group.channel === "email" ? (preference?.email ?? "off") : (preference?.in_app ?? "immediate");
      if (account?.status !== "active" || cadenceNow === "off") {
        await suppress(db, rows.map((r) => r.id), account?.status !== "active" ? "account-inactive" : "channel-off");
        return { suppressed: rows.length };
      }
      const valid = [], revoked = [];
      for (const row of rows) {
        const subscriptionId = await currentSubscription(db, group.account_id, row);
        const title = subscriptionId && (await db.query("SELECT current->'metadata'->>'title' AS title FROM dge_documents.documents WHERE id=$1 AND visibility='public'", [row.document_id])).rows[0]?.title;
        if (title === undefined || title === null) revoked.push(row.id);
        else valid.push({ row, subscriptionId, title });
      }
      await suppress(db, revoked, "access-ended");
      if (!valid.length) return { suppressed: revoked.length };
      const items = valid.map(({ row, title }) => ({
        seq: Number(row.ledger_seq), eventKind: row.event_kind, workspaceId: row.tenant_id, documentId: row.document_id,
        proposalId: row.proposal_id, title, recordedAt: new Date(row.recorded_at).toISOString(),
      }));
      const ids = valid.map((v) => v.row.id);
      if (group.channel === "in-app") {
        await db.query("INSERT INTO dge_notifications.inbox(id,account_id,kind,cadence,items,created_at) VALUES($1,$2,$3,$4,$5,$6)",
          [randomUUID(), group.account_id, DIGEST.has(group.cadence) ? "digest" : "event", group.cadence, JSON.stringify(items), at]);
        await db.query("UPDATE dge_notifications.deliveries SET status='delivered',updated_at=$2 WHERE id = ANY($1::uuid[])", [ids, at]);
        return { delivered: ids.length, suppressed: revoked.length };
      }
      const address = (await db.query("SELECT address,verified_at FROM dge_notifications.email_addresses WHERE account_id=$1", [group.account_id])).rows[0];
      if (!address?.verified_at) {
        await suppress(db, ids, "no-verified-address");
        return { suppressed: ids.length + revoked.length };
      }
      // Lease: a concurrent or restarted worker skips these rows until it expires.
      await db.query("UPDATE dge_notifications.deliveries SET next_attempt_at=$2,updated_at=$3 WHERE id = ANY($1::uuid[])", [ids, new Date(clock() + leaseMs), at]);
      const message = composeEmail({
        locale: preference?.locale ?? "en", cadence: group.cadence, items, to: address.address,
        emailUnsubscribe: links.unsubscribe(store.unsubscribeToken(group.account_id, { channel: "email" })),
        itemUnsubscribe: group.cadence === "immediate" ? links.unsubscribe(store.unsubscribeToken(group.account_id, { subscriptionId: valid[0].subscriptionId })) : null,
        links,
      });
      return { email: { ids, attempts: Math.max(...valid.map((v) => v.row.attempts)), message }, suppressed: revoked.length };
    });
  }

  async function sendEmail({ ids, attempts, message }) {
    try {
      if (!email) throw Object.assign(Error("email-unavailable"), { code: "email-unavailable" });
      await email.send(message);
      await worker((db) => db.query("UPDATE dge_notifications.deliveries SET status='delivered',last_error=NULL,updated_at=$2 WHERE id = ANY($1::uuid[]) AND status='pending'", [ids, now()]));
      return "delivered";
    } catch (error) {
      onError(error);
      const next = attempts + 1, dead = error?.permanent === true || next >= maxAttempts;
      await worker((db) => db.query(
        "UPDATE dge_notifications.deliveries SET status=$2,attempts=$3,next_attempt_at=$4,last_error=$5,updated_at=$6 WHERE id = ANY($1::uuid[]) AND status='pending'",
        [ids, dead ? "dead" : "pending", next, new Date(clock() + backoff(next)), errorCode(error), now()]));
      return dead ? "dead" : "failed";
    }
  }

  /** Delivers due groups. Email network calls happen outside database transactions. */
  async function deliver() {
    const result = { delivered: 0, suppressed: 0, failed: 0, dead: 0 };
    const groups = await worker(async (db) => (await db.query(
      `SELECT account_id, channel, cadence, CASE WHEN cadence='immediate' THEN id END AS id
         FROM dge_notifications.deliveries WHERE status='pending' AND due_at<=$1 AND next_attempt_at<=$1
        GROUP BY account_id, channel, cadence, CASE WHEN cadence='immediate' THEN id END
        ORDER BY min(next_attempt_at), min(ledger_seq) LIMIT $2`,
      [now(), deliveryGroups])).rows);
    for (const group of groups) {
      const claimed = await claimGroup(group);
      if (!claimed) continue;
      result.delivered += claimed.delivered ?? 0;
      result.suppressed += claimed.suppressed ?? 0;
      if (claimed.email) result[await sendEmail(claimed.email)] += claimed.email.ids.length;
    }
    return result;
  }

  return Object.freeze({
    fanOut, deliver,
    /** One pass of every duty; safe to run concurrently with itself. */
    async tick() {
      let entries = 0, queued = 0, pass;
      do { pass = await fanOut(); entries += pass.entries; queued += pass.queued; } while (pass.entries === fanOutBatch);
      return { entries, queued, ...(await deliver()) };
    },
  });
}

/** Plain-text email: titles, event kinds and public links only. */
export function composeEmail({ locale, cadence, items, to, emailUnsubscribe, itemUnsubscribe, links }) {
  const t = createTranslator(locale);
  const describe = (item) => t("notifications.kind." + (t.has("notifications.kind." + item.eventKind) ? item.eventKind : "other"), { title: item.title });
  const subject = DIGEST.has(cadence)
    ? t("notifications.email.subject.digest", { cadence: t("notifications.email.cadence." + cadence), count: items.length })
    : t("notifications.email.subject.single", { title: items[0].title });
  const byDocument = new Map();
  for (const item of items) byDocument.set(item.documentId, [...(byDocument.get(item.documentId) ?? []), item]);
  const lines = [t("notifications.email.intro"), ""];
  for (const [documentId, group] of byDocument) {
    for (const item of group) lines.push("- " + describe(item));
    lines.push("  " + links.document(documentId), "");
  }
  if (itemUnsubscribe) lines.push(t("notifications.unfollow") + ": " + itemUnsubscribe);
  lines.push(t("notifications.email.footer", { link: emailUnsubscribe }));
  return {
    to, subject: subject.replace(/[\r\n]+/g, " ").slice(0, 200), text: lines.join("\n"),
    headers: { "List-Unsubscribe": "<" + emailUnsubscribe + ">" }, tag: DIGEST.has(cadence) ? "digest" : "notification",
  };
}
