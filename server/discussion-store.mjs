import { randomUUID } from "node:crypto";
import { digest } from "../src/integrity.mjs";
import {
  createDiscussionPoint,
  discussionPointDigest,
} from "../src/discussion.mjs";
import { DocumentError } from "./document-store.mjs";
import { sectionAccess, proposalBase, targetPath } from "./section-grants.mjs";
import { removedView } from "./moderation-store.mjs";
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const check = (value, code, status = 400) => {
  if (!value) throw new DocumentError(code, status);
};
const roles = ["owner", "admin", "editor", "participant"];
const pointView = (row) => {
  check(
    discussionPointDigest(row.data ?? row.point) === row.digest,
    "POINT_INTEGRITY_ERROR",
    503,
  );
  return {
    point: row.data ?? row.point,
    digest: row.digest,
    depth: row.depth,
    createdAt: new Date(row.created_at ?? row.createdAt).toISOString(),
    up: row.up ?? 0,
    down: row.down ?? 0,
    net: row.net ?? 0,
    // Hidden points stay in the thread with a visible placeholder; scores
    // and votes are untouched and nothing is deleted.
    ...(row.moderation_hidden
      ? removedView(row.moderation_reason, (placeholder) => ({
          point: { ...(row.data ?? row.point), text: placeholder, evidence: [] },
        }))
      : {}),
  };
};
/** DCE-016: every ranking states what it sorts by; scores never affect decision ballots. */
export const RANKING_EXPLANATIONS = Object.freeze({
  top: "Net score (up minus down ratings), then point ID. Ratings never change any decision ballot or weight.",
  new: "Newest first, then point ID, so new and minority points are discoverable. Ratings never change any decision ballot or weight.",
  confidence: "Lower bound of the 95% Wilson interval for the share of up ratings, then point ID: a few ratings rank below many consistent ones. Ratings never change any decision ballot or weight.",
});

export function createDiscussionStore({
  identity,
  transaction,
  clock = Date.now,
  maxPoints = 1000,
  maxAuthorPoints = 100,
  maxVotes = 100000,
  maxVoteChanges = 100,
  maxStoredBytes = 30000000,
  maxVotesPerAuthor = 20,
}) {
  for (const n of [
    maxVotesPerAuthor,
    maxPoints,
    maxAuthorPoints,
    maxVotes,
    maxVoteChanges,
    maxStoredBytes,
  ])
    if (!Number.isSafeInteger(n) || n < 1 || n > 1000000000)
      throw Error("Invalid discussion limit");
  const now = () => {
    const n = clock();
    if (!Number.isSafeInteger(n) || n < 0) throw Error("Invalid clock");
    return new Date(n);
  };
  const context = (credentials, tenantId, write, operation) => {
    check(uuid(tenantId), "INVALID_WORKSPACE");
    return identity.withTenant(
      credentials,
      tenantId,
      { write, roles: write ? roles : undefined },
      operation,
    );
  };
  async function proposal(db, tenantId, documentId, proposalId) {
    check(uuid(documentId) && uuid(proposalId), "INVALID_PROPOSAL_CONTEXT");
    check(
      (
        await db.query(
          "SELECT id FROM dge_proposals.proposals WHERE tenant_id=$1 AND document_id=$2 AND id=$3",
          [tenantId, documentId, proposalId],
        )
      ).rows.length,
      "PROPOSAL_NOT_FOUND",
      404,
    );
  }
  // With clause permissions, discussing a proposal needs `discuss` on the
  // section its wording targets.
  async function mayDiscuss(db, tenantId, documentId, proposalId, actor) {
    const access = await sectionAccess(db, { tenantId, documentId, at: now() });
    if (!access.restricted) return true;
    const { proposal: text, document } = await proposalBase(db, {
      tenantId,
      documentId,
      proposalId,
    });
    const path = targetPath(document, text.selection.blockId);
    return Boolean(path && access.holds(actor, path, "discuss"));
  }
  async function reserve(db, tenantId, value) {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    check(
      (
        await db.query(
          "UPDATE dge_documents.usage SET stored_bytes=stored_bytes+$2 WHERE tenant_id=$1 AND stored_bytes+$2<=$3 RETURNING stored_bytes",
          [tenantId, bytes, maxStoredBytes],
        )
      ).rows.length,
      "STORAGE_LIMIT_REACHED",
      429,
    );
  }
  async function advance(
    db,
    tenantId,
    documentId,
    proposalId,
    contentChanged = false,
  ) {
    return (
      await db.query(
        `INSERT INTO dge_discussion.activity(tenant_id,document_id,proposal_id,epoch,content_epoch) VALUES($1,$2,$3,1,1)
  ON CONFLICT(tenant_id,document_id,proposal_id) DO UPDATE SET epoch=dge_discussion.activity.epoch+1,content_epoch=dge_discussion.activity.content_epoch+CASE WHEN $4 THEN 1 ELSE 0 END RETURNING epoch::text`,
        [tenantId, documentId, proposalId, contentChanged],
      )
    ).rows[0].epoch;
  }
  const hashInput = (value) => {
    try {
      return digest("discussion-command-v1", value);
    } catch {
      throw new DocumentError("INVALID_DISCUSSION_INPUT");
    }
  };
  async function outbox(
    db,
    { tenantId, documentId, proposalId, kind, value, at },
  ) {
    const eventId = randomUUID();
    await db.query(
      "INSERT INTO dge_discussion.anchor_outbox(tenant_id,document_id,proposal_id,event_id,event_digest,created_at) VALUES($1,$2,$3,$4,$5,$6)",
      [
        tenantId,
        documentId,
        proposalId,
        eventId,
        digest("public-discussion-event-v1", {
          kind,
          documentId,
          proposalId,
          value,
          createdAt: at.toISOString(),
        }),
        at,
      ],
    );
  }
  return Object.freeze({
    async create(
      credentials,
      tenantId,
      documentId,
      proposalId,
      {
        position,
        parentId = null,
        relation = null,
        text,
        evidence = [],
        commandId,
        disclosure,
      },
    ) {
      check(
        uuid(commandId) && (parentId === null || uuid(parentId)),
        "INVALID_POINT_CONTEXT",
      );
      check(disclosure === "publish-point-v1", "PUBLIC_DISCLOSURE_REQUIRED");
      return context(credentials, tenantId, true, async (db, actor) => {
        await proposal(db, tenantId, documentId, proposalId);
        check(
          await mayDiscuss(db, tenantId, documentId, proposalId, actor),
          "SECTION_RIGHT_REQUIRED",
          403,
        );
        const requestDigest = hashInput({
          action: "create",
          actorId: actor.accountId,
          documentId,
          proposalId,
          position,
          parentId,
          relation,
          text,
          evidence,
          disclosure,
        });
        const previous = (
          await db.query(
            "SELECT * FROM dge_discussion.points WHERE tenant_id=$1 AND command_id=$2",
            [tenantId, commandId],
          )
        ).rows[0];
        if (previous) {
          check(
            previous.request_digest === requestDigest,
            "COMMAND_REUSED",
            409,
          );
          return pointView(previous);
        }
        let depth = 0;
        if (parentId) {
          const parent = (
            await db.query(
              "SELECT depth FROM dge_discussion.points WHERE tenant_id=$1 AND document_id=$2 AND proposal_id=$3 AND id=$4",
              [tenantId, documentId, proposalId, parentId],
            )
          ).rows[0];
          check(parent, "PARENT_POINT_NOT_FOUND", 404);
          depth = parent.depth + 1;
          check(depth <= 8, "POINT_DEPTH_LIMIT", 409);
        }
        let data;
        try {
          data = createDiscussionPoint({
            id: randomUUID(),
            tenantId,
            documentId,
            proposalId,
            parentId,
            position,
            relation,
            text,
            evidence,
          });
        } catch {
          throw new DocumentError("INVALID_POINT");
        }
        const counts = (
          await db.query(
            "SELECT count(*)::int AS total,count(*) FILTER(WHERE actor_id=$4)::int AS own FROM dge_discussion.points WHERE tenant_id=$1 AND document_id=$2 AND proposal_id=$3",
            [tenantId, documentId, proposalId, actor.accountId],
          )
        ).rows[0];
        check(
          counts.total < maxPoints && counts.own < maxAuthorPoints,
          "POINT_LIMIT_REACHED",
          429,
        );
        await reserve(db, tenantId, data);
        const value = discussionPointDigest(data),
          at = now();
        await db.query(
          "INSERT INTO dge_discussion.points(tenant_id,document_id,proposal_id,id,parent_id,depth,position,data,digest,actor_id,created_at,command_id,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
          [
            tenantId,
            documentId,
            proposalId,
            data.id,
            parentId,
            depth,
            position,
            data,
            value,
            actor.accountId,
            at,
            commandId,
            requestDigest,
          ],
        );
        await db.query(
          "INSERT INTO dge_discussion.scores(tenant_id,document_id,proposal_id,point_id,up_count,down_count) VALUES($1,$2,$3,$4,0,0)",
          [tenantId, documentId, proposalId, data.id],
        );
        await advance(db, tenantId, documentId, proposalId, true);
        await outbox(db, {
          tenantId,
          documentId,
          proposalId,
          kind: "point-created",
          value: { pointId: data.id, digest: value },
          at,
        });
        return pointView({ data, digest: value, depth, created_at: at });
      });
    },
    async vote(
      credentials,
      tenantId,
      documentId,
      proposalId,
      pointId,
      { value, expectedVoteVersion, commandId },
    ) {
      check(
        uuid(pointId) &&
          uuid(commandId) &&
          [-1, 0, 1].includes(value) &&
          Number.isSafeInteger(expectedVoteVersion) &&
          expectedVoteVersion >= 0 &&
          expectedVoteVersion <= maxVoteChanges + 1,
        "INVALID_POINT_VOTE",
      );
      return context(credentials, tenantId, true, async (db, actor) => {
        await proposal(db, tenantId, documentId, proposalId);
        check(
          await mayDiscuss(db, tenantId, documentId, proposalId, actor),
          "SECTION_RIGHT_REQUIRED",
          403,
        );
        const requestDigest = hashInput({
          action: "vote",
          actorId: actor.accountId,
          documentId,
          proposalId,
          pointId,
          value,
          expectedVoteVersion,
        });
        // A missing vote row cannot be locked. Serialize first votes and later changes
        // by account/point before reading either idempotency or current-vote state.
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `point-vote:${tenantId}:${pointId}:${actor.accountId}`,
        ]);
        const previous = (
          await db.query(
            "SELECT request_digest,result FROM dge_discussion.vote_events WHERE tenant_id=$1 AND actor_id=$2 AND command_id=$3",
            [tenantId, actor.accountId, commandId],
          )
        ).rows[0];
        if (previous) {
          check(
            previous.request_digest === requestDigest,
            "COMMAND_REUSED",
            409,
          );
          return previous.result;
        }
        const point = (
          await db.query(
            "SELECT actor_id FROM dge_discussion.points WHERE tenant_id=$1 AND document_id=$2 AND proposal_id=$3 AND id=$4",
            [tenantId, documentId, proposalId, pointId],
          )
        ).rows[0];
        check(point, "POINT_NOT_FOUND", 404);
        check(
          point.actor_id !== actor.accountId,
          "SELF_POINT_VOTE_FORBIDDEN",
          403,
        );
        const old = (
          await db.query(
            "SELECT value,version FROM dge_discussion.votes WHERE tenant_id=$1 AND document_id=$2 AND proposal_id=$3 AND point_id=$4 AND actor_id=$5 FOR UPDATE",
            [tenantId, documentId, proposalId, pointId, actor.accountId],
          )
        ).rows[0] ?? { value: 0, version: 0 };
        check(old.version === expectedVoteVersion, "POINT_VOTE_CONFLICT", 409);
        check(
          old.version < maxVoteChanges ||
            (old.value !== 0 && value === 0 && old.version === maxVoteChanges),
          "VOTE_CHANGE_LIMIT_REACHED",
          429,
        );
        check(old.version > 0 || value !== 0, "NO_ACTIVE_POINT_VOTE", 409);
        // DCE-016 anti-ring bound: one account's active ratings on any single
        // author's points in a proposal are capped, so a small ring cannot
        // amplify one member's arguments without limit. Withdrawals always work.
        if (old.value === 0 && value !== 0) {
          const given = (
            await db.query(
              `SELECT count(*)::int AS n FROM dge_discussion.votes v JOIN dge_discussion.points p
                ON p.tenant_id=v.tenant_id AND p.document_id=v.document_id AND p.proposal_id=v.proposal_id AND p.id=v.point_id
               WHERE v.tenant_id=$1 AND v.document_id=$2 AND v.proposal_id=$3 AND v.actor_id=$4 AND v.value<>0 AND p.actor_id=$5`,
              [tenantId, documentId, proposalId, actor.accountId, point.actor_id],
            )
          ).rows[0].n;
          check(given < maxVotesPerAuthor, "AUTHOR_RATING_LIMIT_REACHED", 429);
        }
        const score = (
          await db.query(
            "SELECT up_count,down_count FROM dge_discussion.scores WHERE tenant_id=$1 AND document_id=$2 AND proposal_id=$3 AND point_id=$4 FOR UPDATE",
            [tenantId, documentId, proposalId, pointId],
          )
        ).rows[0];
        const up =
            score.up_count + (value === 1 ? 1 : 0) - (old.value === 1 ? 1 : 0),
          down =
            score.down_count +
            (value === -1 ? 1 : 0) -
            (old.value === -1 ? 1 : 0);
        check(up + down <= maxVotes, "POINT_VOTER_LIMIT_REACHED", 429);
        const version = old.version + 1,
          at = now();
        await reserve(db, tenantId, {
          pointId,
          actorId: actor.accountId,
          value,
          version,
          commandId,
          requestDigest,
          createdAt: at.toISOString(),
        });
        await db.query(
          "INSERT INTO dge_discussion.votes(tenant_id,document_id,proposal_id,point_id,actor_id,value,version) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(tenant_id,document_id,proposal_id,point_id,actor_id) DO UPDATE SET value=excluded.value,version=excluded.version",
          [
            tenantId,
            documentId,
            proposalId,
            pointId,
            actor.accountId,
            value,
            version,
          ],
        );
        await db.query(
          "UPDATE dge_discussion.scores SET up_count=$5,down_count=$6 WHERE tenant_id=$1 AND document_id=$2 AND proposal_id=$3 AND point_id=$4",
          [tenantId, documentId, proposalId, pointId, up, down],
        );
        const epoch = await advance(db, tenantId, documentId, proposalId),
          result = {
            pointId,
            value,
            voteVersion: version,
            up,
            down,
            net: up - down,
            rankingEpoch: epoch,
          };
        await db.query(
          "INSERT INTO dge_discussion.vote_events(tenant_id,document_id,proposal_id,point_id,actor_id,command_id,request_digest,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            tenantId,
            documentId,
            proposalId,
            pointId,
            actor.accountId,
            commandId,
            requestDigest,
            result,
            at,
          ],
        );
        // Only public score changes enter the pending public log; voter IDs and private choices do not.
        await outbox(db, {
          tenantId,
          documentId,
          proposalId,
          kind: "point-score",
          value: { pointId, up, down, net: up - down, epoch },
          at,
        });
        return result;
      });
    },
    async mine(credentials, tenantId, documentId, proposalId, { pointIds }) {
      check(
        Array.isArray(pointIds) &&
          pointIds.length <= 100 &&
          pointIds.every(uuid) &&
          new Set(pointIds).size === pointIds.length,
        "INVALID_POINT_IDS",
      );
      return context(credentials, tenantId, false, async (db, actor) => {
        await proposal(db, tenantId, documentId, proposalId);
        const rows = (
          await db.query(
            'SELECT point_id AS "pointId",value,version AS "voteVersion" FROM dge_discussion.votes WHERE tenant_id=$1 AND document_id=$2 AND proposal_id=$3 AND actor_id=$4 AND point_id IN (SELECT jsonb_array_elements_text($5::jsonb)::uuid)',
            [
              tenantId,
              documentId,
              proposalId,
              actor.accountId,
              JSON.stringify(pointIds),
            ],
          )
        ).rows;
        const own = (
          await db.query(
            "SELECT id FROM dge_discussion.points WHERE tenant_id=$1 AND document_id=$2 AND proposal_id=$3 AND actor_id=$4 AND id IN (SELECT jsonb_array_elements_text($5::jsonb)::uuid)",
            [
              tenantId,
              documentId,
              proposalId,
              actor.accountId,
              JSON.stringify(pointIds),
            ],
          )
        ).rows.map((row) => row.id);
        return {
          items: rows,
          ownPointIds: own,
          canContribute:
            roles.includes(actor.role) &&
            (await mayDiscuss(db, tenantId, documentId, proposalId, actor)),
          // Every workspace member, viewers included, may report content.
          canReport: true,
        };
      });
    },
    async list(
      documentId,
      proposalId,
      {
        position = "all",
        parentId = null,
        sort = "top",
        after = null,
        limit = 10,
      } = {},
    ) {
      check(
        uuid(documentId) &&
          uuid(proposalId) &&
          (parentId === null || uuid(parentId)) &&
          ["all", "support", "oppose", "clarify"].includes(position) &&
          ["top", "new", "confidence"].includes(sort) &&
          Number.isSafeInteger(limit) &&
          limit >= 1 &&
          limit <= 100,
        "INVALID_POINT_PAGE",
      );
      let cursor = null;
      if (after !== null) {
        try {
          check(
            typeof after === "string" &&
              after.length <= 1000 &&
              /^[A-Za-z0-9_-]+$/.test(after),
            "INVALID_POINT_CURSOR",
          );
          cursor = JSON.parse(Buffer.from(after, "base64url").toString("utf8"));
          check(
            Object.keys(cursor).sort().join(",") ===
              "createdAt,epoch,id,net,parentId,position,sort" &&
              uuid(cursor.id) &&
              /^[1-9][0-9]{0,18}$/.test(cursor.epoch) &&
              Number.isSafeInteger(cursor.net) &&
              Math.abs(cursor.net) <= 1000000000 &&
              (sort !== "confidence" || cursor.net >= 0) &&
              new Date(cursor.createdAt).toISOString() === cursor.createdAt &&
              cursor.sort === sort &&
              cursor.position === position &&
              cursor.parentId === parentId,
            "INVALID_POINT_CURSOR",
          );
        } catch {
          throw new DocumentError("INVALID_POINT_CURSOR");
        }
      }
      return transaction(async (db) => {
        await db.query("SELECT set_config('dge.public_document_id',$1,true)", [
          documentId,
        ]);
        // One statement observes both ranking generation and rows in the same database snapshot.
        const row = (
          await db.query(
            `SELECT COALESCE(CASE WHEN $6='new' THEN a.content_epoch ELSE a.epoch END,0)::text AS epoch,
      (SELECT jsonb_agg(page ORDER BY page.rank_net DESC,page.rank_time DESC,page.id ASC) FROM (
       SELECT p.id,p.data AS point,p.digest,p.depth,p.created_at AS "createdAt",s.up_count AS up,s.down_count AS down,s.net,
        mv.hidden AS moderation_hidden,mv.reason_category AS moderation_reason,
        CASE WHEN $6='top' THEN s.net WHEN $6='confidence' THEN r.wilson ELSE 0 END AS rank_net,CASE WHEN $6='new' THEN p.created_at ELSE 'epoch'::timestamptz END AS rank_time,r.wilson
       FROM dge_discussion.points p JOIN dge_discussion.scores s ON s.tenant_id=p.tenant_id AND s.document_id=p.document_id AND s.proposal_id=p.proposal_id AND s.point_id=p.id
       LEFT JOIN dge_moderation.visibility mv ON mv.tenant_id=p.tenant_id AND mv.target_kind='point' AND mv.target_id=p.id
       CROSS JOIN LATERAL (SELECT CASE WHEN s.up_count+s.down_count=0 THEN 0 ELSE floor(1000000000*(
         (s.up_count::numeric/(s.up_count+s.down_count) + 1.9208/(s.up_count+s.down_count)
          - 1.96*sqrt(((s.up_count::numeric*s.down_count)/(s.up_count+s.down_count) + 0.9604)/((s.up_count+s.down_count)::numeric*(s.up_count+s.down_count))))
         /(1+3.8416/(s.up_count+s.down_count))))::bigint END AS wilson) r
       WHERE p.document_id=$1 AND p.proposal_id=$2 AND p.parent_id IS NOT DISTINCT FROM $3::uuid AND ($4='all' OR p.position=$4)
        AND ($5::uuid IS NULL OR ($6='top' AND (s.net<$7 OR (s.net=$7 AND p.id>$5::uuid))) OR ($6='confidence' AND (r.wilson<$7 OR (r.wilson=$7 AND p.id>$5::uuid))) OR ($6='new' AND (p.created_at<$8::timestamptz OR (p.created_at=$8::timestamptz AND p.id>$5::uuid))))
       ORDER BY rank_net DESC,rank_time DESC,p.id ASC LIMIT $9) page) AS items
      FROM dge_proposals.proposals source LEFT JOIN dge_discussion.activity a ON a.tenant_id=source.tenant_id AND a.document_id=source.document_id AND a.proposal_id=source.id
      WHERE source.document_id=$1 AND source.id=$2`,
            [
              documentId,
              proposalId,
              parentId,
              position,
              cursor?.id ?? null,
              sort,
              cursor?.net ?? 0,
              cursor?.createdAt ?? "1970-01-01T00:00:00.000Z",
              limit + 1,
            ],
          )
        ).rows[0];
        check(row, "PROPOSAL_NOT_FOUND", 404);
        if (cursor)
          check(cursor.epoch === row.epoch, "POINT_RANKING_CHANGED", 409);
        const rows = row.items ?? [],
          page = rows.slice(0, limit),
          last = page.at(-1);
        return {
          items: page.map((item) => ({ ...pointView(item), ...(sort === "confidence" ? { confidence: Number(item.wilson) / 1e9 } : {}) })),
          rankingEpoch: row.epoch,
          sort,
          ranking: RANKING_EXPLANATIONS[sort],
          nextCursor:
            rows.length > limit
              ? Buffer.from(
                  JSON.stringify({
                    epoch: row.epoch,
                    id: last.id,
                    net: sort === "confidence" ? Number(last.wilson) : last.net,
                    createdAt: new Date(last.createdAt).toISOString(),
                    sort,
                    position,
                    parentId,
                  }),
                ).toString("base64url")
              : null,
        };
      });
    },
  });
}
