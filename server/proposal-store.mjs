import { randomUUID } from "node:crypto";
import { digest } from "../src/integrity.mjs";
import {
  createTextProposal,
  textProposalDigest,
} from "../src/legal-proposals.mjs";
import { legalDocumentDigest } from "../src/legal-schema.mjs";
import { DocumentError } from "./document-store.mjs";
import { requireSectionRight } from "./section-grants.mjs";
import { removedView } from "./moderation-store.mjs";
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const requireValue = (value, code, status = 400) => {
  if (!value) throw new DocumentError(code, status);
};
const view = (row, currentVersion) => {
  requireValue(
    textProposalDigest(row.proposal) === row.digest,
    "PROPOSAL_INTEGRITY_ERROR",
    503,
  );
  return {
    proposal: row.proposal,
    digest: row.digest,
    baseVersion: row.base_version,
    createdAt: new Date(row.created_at).toISOString(),
    stale: row.base_version !== currentVersion,
    anchorStatus: "pending",
    revisionOf: row.revision_of ?? null,
    revisedBy: row.revised_by ?? null,
    // A moderated proposal keeps its place and digest; only its wording is
    // replaced by a visible placeholder. Nothing is deleted.
    ...(row.moderation_hidden
      ? removedView(row.moderation_reason, (placeholder) => ({
          proposal: { ...row.proposal, replacement: placeholder, rationale: placeholder },
        }))
      : {}),
  };
};
const MODERATED_PROPOSALS =
  "SELECT p.*,v.hidden AS moderation_hidden,v.reason_category AS moderation_reason,r1.revises AS revision_of,r2.proposal_id AS revised_by FROM dge_proposals.proposals p LEFT JOIN dge_moderation.visibility v ON v.tenant_id=p.tenant_id AND v.target_kind='proposal' AND v.target_id=p.id" +
  " LEFT JOIN dge_proposals.revisions r1 ON r1.tenant_id=p.tenant_id AND r1.document_id=p.document_id AND r1.proposal_id=p.id" +
  " LEFT JOIN dge_proposals.revisions r2 ON r2.tenant_id=p.tenant_id AND r2.document_id=p.document_id AND r2.revises=p.id";
/** First public-content adapter: creation is restricted to workspace contributors. */
export function createProposalStore({
  identity,
  transaction,
  clock = Date.now,
  maxPerDocument = 500,
  maxPerAuthor = 50,
  maxStoredBytes = 30000000,
}) {
  for (const n of [maxPerDocument, maxPerAuthor, maxStoredBytes])
    if (!Number.isSafeInteger(n) || n < 1 || n > 1000000000)
      throw Error("Invalid proposal budget");
  const now = () => {
    const n = clock();
    if (!Number.isSafeInteger(n) || n < 0) throw Error("Invalid clock");
    return new Date(n);
  };
  async function publicContext(documentId, operation) {
    requireValue(uuid(documentId), "INVALID_DOCUMENT_ID");
    return transaction(async (db) => {
      await db.query("SELECT set_config('dge.public_document_id',$1,true)", [
        documentId,
      ]);
      const source = (
        await db.query(
          "SELECT version FROM dge_documents.documents WHERE id=$1",
          [documentId],
        )
      ).rows[0];
      requireValue(source, "DOCUMENT_NOT_FOUND", 404);
      return operation(db, source.version);
    });
  }
  return Object.freeze({
    async create(
      credentials,
      tenantId,
      documentId,
      { baseVersion, selection, replacement, rationale, commandId, disclosure, revises = null },
    ) {
      requireValue(
        uuid(tenantId) && uuid(documentId) && uuid(commandId) && (revises === null || uuid(revises)),
        "INVALID_PROPOSAL_CONTEXT",
      );
      requireValue(
        Number.isSafeInteger(baseVersion) &&
          baseVersion >= 1 &&
          baseVersion <= 1000000,
        "INVALID_VERSION",
      );
      requireValue(
        disclosure === "publish-proposal-v1",
        "PUBLIC_DISCLOSURE_REQUIRED",
      );
      return identity.withTenant(
        credentials,
        tenantId,
        { write: true, roles: ["owner", "admin", "editor", "participant"] },
        async (db, actor) => {
          let requestDigest;
          try {
            requestDigest = digest("text-proposal-command-v1", {
              actorId: actor.accountId,
              documentId,
              baseVersion,
              selection,
              replacement,
              rationale,
              disclosure,
              ...(revises === null ? {} : { revises }),
            });
          } catch {
            throw new DocumentError("INVALID_PROPOSAL_INPUT");
          }
          const current = (
            await db.query(
              "SELECT version FROM dge_documents.documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
              [tenantId, documentId],
            )
          ).rows[0];
          requireValue(current, "DOCUMENT_NOT_FOUND", 404);
          const prior = (
            await db.query(
              "SELECT * FROM dge_proposals.proposals WHERE tenant_id=$1 AND command_id=$2",
              [tenantId, commandId],
            )
          ).rows[0];
          if (prior) {
            requireValue(
              prior.request_digest === requestDigest,
              "COMMAND_REUSED",
              409,
            );
            return view(prior, current.version);
          }
          const base = (
            await db.query(
              "SELECT document,digest FROM dge_documents.versions WHERE tenant_id=$1 AND document_id=$2 AND version=$3",
              [tenantId, documentId, baseVersion],
            )
          ).rows[0];
          requireValue(base, "VERSION_NOT_FOUND", 404);
          // DCE-009: a revision is new wording by the same author. The prior
          // proposal stays immutable and its ballots never carry over.
          if (revises !== null) {
            const original = (
              await db.query(
                "SELECT actor_id FROM dge_proposals.proposals WHERE tenant_id=$1 AND document_id=$2 AND id=$3",
                [tenantId, documentId, revises],
              )
            ).rows[0];
            requireValue(original, "PROPOSAL_NOT_FOUND", 404);
            requireValue(original.actor_id === actor.accountId, "ONLY_AUTHOR_MAY_REVISE", 403);
            requireValue(
              !(await db.query("SELECT 1 FROM dge_proposals.revisions WHERE tenant_id=$1 AND document_id=$2 AND revises=$3", [tenantId, documentId, revises])).rows.length,
              "PROPOSAL_ALREADY_REVISED",
              409,
            );
            requireValue(
              !(await db.query(
                "SELECT 1 FROM dge_decisions.decisions WHERE tenant_id=$1 AND document_id=$2 AND proposal_id=$3 AND (state='open' OR finality='provisional')",
                [tenantId, documentId, revises],
              )).rows.length,
              "VOTE_IN_PROGRESS",
              409,
            );
          }
          requireValue(
            legalDocumentDigest(base.document) === base.digest,
            "DOCUMENT_INTEGRITY_ERROR",
            503,
          );
          let proposal;
          try {
            proposal = createTextProposal(base.document, {
              id: randomUUID(),
              selection,
              replacement,
              rationale,
            });
          } catch {
            throw new DocumentError("INVALID_TEXT_SELECTION_OR_REPLACEMENT");
          }
          // Clause permissions: only unlocked sections are amendable targets.
          await requireSectionRight(db, {
            tenantId,
            documentId,
            document: base.document,
            blockId: proposal.selection.blockId,
            actor,
            right: "propose",
            at: now(),
          });
          // The document row is locked until commit. Count and insert must share
          // this serialization point or simultaneous writers can evade quotas.
          const counts = (
            await db.query(
              "SELECT count(*)::int AS total,count(*) FILTER(WHERE actor_id=$3)::int AS own FROM dge_proposals.proposals WHERE tenant_id=$1 AND document_id=$2",
              [tenantId, documentId, actor.accountId],
            )
          ).rows[0];
          requireValue(
            counts.total < maxPerDocument && counts.own < maxPerAuthor,
            "PROPOSAL_LIMIT_REACHED",
            429,
          );
          const bytes = Buffer.byteLength(JSON.stringify(proposal));
          requireValue(
            (
              await db.query(
                "UPDATE dge_documents.usage SET stored_bytes=stored_bytes+$2 WHERE tenant_id=$1 AND stored_bytes+$2<=$3 RETURNING stored_bytes",
                [tenantId, bytes, maxStoredBytes],
              )
            ).rows.length,
            "STORAGE_LIMIT_REACHED",
            429,
          );
          const value = textProposalDigest(proposal),
            at = now();
          await db.query(
            "INSERT INTO dge_proposals.proposals(tenant_id,document_id,id,base_version,proposal,digest,actor_id,created_at,command_id,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
            [
              tenantId,
              documentId,
              proposal.id,
              baseVersion,
              proposal,
              value,
              actor.accountId,
              at,
              commandId,
              requestDigest,
            ],
          );
          if (revises !== null)
            await db.query(
              "INSERT INTO dge_proposals.revisions(tenant_id,document_id,proposal_id,revises,created_at) VALUES($1,$2,$3,$4,$5)",
              [tenantId, documentId, proposal.id, revises, at],
            );
          await db.query(
            "INSERT INTO dge_proposals.anchor_outbox(tenant_id,document_id,proposal_id,event_digest,created_at) VALUES($1,$2,$3,$4,$5)",
            [
              tenantId,
              documentId,
              proposal.id,
              digest("public-proposal-event-v1", {
                documentId,
                proposalId: proposal.id,
                proposalDigest: value,
                baseVersion,
                createdAt: at.toISOString(),
                ...(revises === null ? {} : { revises }),
              }),
              at,
            ],
          );
          return view(
            {
              proposal,
              digest: value,
              base_version: baseVersion,
              created_at: at,
              revision_of: revises,
              revised_by: null,
            },
            current.version,
          );
        },
      );
    },
    async list(documentId, { after = null, limit = 20 } = {}) {
      requireValue(
        (after === null || uuid(after)) &&
          Number.isSafeInteger(limit) &&
          limit >= 1 &&
          limit <= 100,
        "INVALID_PAGE",
      );
      return publicContext(documentId, async (db, currentVersion) => {
        const rows = (
          await db.query(
            MODERATED_PROPOSALS +
              " WHERE p.document_id=$1 AND ($2::uuid IS NULL OR p.id>$2::uuid) ORDER BY p.id LIMIT $3",
            [documentId, after, limit + 1],
          )
        ).rows;
        return {
          items: rows.slice(0, limit).map((row) => view(row, currentVersion)),
          nextCursor: rows.length > limit ? rows[limit - 1].id : null,
          currentVersion,
        };
      });
    },
    async read(documentId, proposalId) {
      requireValue(uuid(proposalId), "INVALID_PROPOSAL_ID");
      return publicContext(documentId, async (db, currentVersion) => {
        const row = (
          await db.query(
            MODERATED_PROPOSALS + " WHERE p.document_id=$1 AND p.id=$2",
            [documentId, proposalId],
          )
        ).rows[0];
        requireValue(row, "PROPOSAL_NOT_FOUND", 404);
        return view(row, currentVersion);
      });
    },
  });
}
