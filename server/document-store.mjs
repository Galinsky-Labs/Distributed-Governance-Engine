import { digest } from "../src/integrity.mjs";
import { createHash } from "node:crypto";
import { createPublicSharedDraft } from "../editor/shared-legal-draft.mjs";
import {
  legalDocumentDigest,
  validateLegalDocument,
  publicInputEdition,
} from "../src/legal-schema.mjs";

export const PUBLIC_DISCLOSURE = "publish-all-revisions-v1";
export class DocumentError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
const requireValue = (value, code, status) => {
  if (!value) throw new DocumentError(code, status);
};
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const editableRoles = ["owner", "admin", "editor"];
const MAX_CRDT_STATE_BYTES = 3000000;
function parseCrdtState(value) {
 if(value===undefined)return null;
 if(typeof value!=='string'||!value.length||value.length>4000000||
    !/^[A-Za-z0-9_-]+$/.test(value))throw new DocumentError("INVALID_CRDT_STATE");
 const bytes=Buffer.from(value,'base64url');
 if(bytes.length<1||bytes.length>MAX_CRDT_STATE_BYTES||
    bytes.toString('base64url')!==value)throw new DocumentError("INVALID_CRDT_STATE");
 return bytes;
}
const stateDigest=bytes=>createHash('sha256').update('dge-public-yjs-v13-v1\0').update(bytes).digest('hex');
const snapshot = row => {
  const document=validateLegalDocument(row.document??row.current);
  requireValue(legalDocumentDigest(document)===row.digest,'DOCUMENT_INTEGRITY_ERROR',503);
  return {document,version:row.version,digest:row.digest,previousDigest:row.previous_digest??null,anchorStatus:'pending',visibility:'public'};
};
function legal(value) {
  try {
    return validateLegalDocument(value);
  } catch {
    throw new DocumentError("INVALID_DOCUMENT");
  }
}
const version = (value) =>
  Number.isSafeInteger(value) && value >= 1 && value <= 1000000;

/** Public-only repository. No plaintext private-content fallback exists. */
export function createDocumentStore({
  identity,
  transaction,
  clock = Date.now,
  maxDocuments = 100,
  maxVersions = 1000,
  maxStoredBytes = 30000000,
}) {
  for (const n of [maxDocuments, maxVersions])
    if (!Number.isSafeInteger(n) || n < 1 || n > 1000000)
      throw Error("Invalid document budget");
  if (
    !Number.isSafeInteger(maxStoredBytes) ||
    maxStoredBytes < 1 ||
    maxStoredBytes > 1000000000
  )
    throw Error("Invalid storage budget");
  const now = () => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw Error("Invalid clock");
    return new Date(value);
  };
  const context = (credentials, tenantId, write, operation) => {
    requireValue(uuid(tenantId), "INVALID_WORKSPACE");
    return identity.withTenant(
      credentials,
      tenantId,
      { write, roles: write ? editableRoles : undefined },
      operation,
    );
  };
  const command = (id) => requireValue(uuid(id), "INVALID_COMMAND_ID");
  async function prior(db, tenantId, commandId, requestDigest) {
    const row = (
      await db.query(
        "SELECT * FROM dge_documents.versions WHERE tenant_id=$1 AND command_id=$2",
        [tenantId, commandId],
      )
    ).rows[0];
    if (row)
      requireValue(row.request_digest === requestDigest, "COMMAND_REUSED", 409);
    return row ? snapshot(row) : null;
  }
  async function append(
    db,
    actor,
    document,
    { commandId, requestDigest, nextVersion, previousDigest, restoration },
  ) {
    const value = legalDocumentDigest(document),
      at = now(),
      bytes = Buffer.byteLength(JSON.stringify(document))+(restoration?Buffer.byteLength(JSON.stringify(restoration)):0);
    await db.query(
      "INSERT INTO dge_documents.usage(tenant_id,stored_bytes) VALUES($1,0) ON CONFLICT DO NOTHING",
      [actor.tenantId],
    );
    requireValue(
      (
        await db.query(
          "UPDATE dge_documents.usage SET stored_bytes=stored_bytes+$2 WHERE tenant_id=$1 AND stored_bytes+$2<=$3 RETURNING stored_bytes",
          [actor.tenantId, bytes, maxStoredBytes],
        )
      ).rows.length,
      "STORAGE_LIMIT_REACHED",
      429,
    );
    const eventDigest = digest(restoration?"public-document-restoration-v1":"public-document-version-v1", {
      tenantId: actor.tenantId,
      documentId: document.id,
      version: nextVersion,
      digest: value,
      previousDigest,
      createdAt: at.toISOString(),
      ...(restoration?{restoration}:{}),
    });
    await db.query(
      `INSERT INTO dge_documents.versions(tenant_id,document_id,version,document,digest,previous_digest,event_digest,command_id,request_digest,actor_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        actor.tenantId,
        document.id,
        nextVersion,
        document,
        value,
        previousDigest,
        eventDigest,
        commandId,
        requestDigest,
        actor.accountId,
        at,
      ],
    );
    await db.query(
      "INSERT INTO dge_documents.anchor_outbox(tenant_id,document_id,version,event_digest,created_at) VALUES($1,$2,$3,$4,$5)",
      [actor.tenantId, document.id, nextVersion, eventDigest, at],
    );
    return snapshot({
      document,
      version: nextVersion,
      digest: value,
      previous_digest: previousDigest,
    });
  }
  return Object.freeze({
    async create(credentials, tenantId, { document, commandId, disclosure }) {
      command(commandId);
      requireValue(
        disclosure === PUBLIC_DISCLOSURE,
        "PUBLIC_DISCLOSURE_REQUIRED",
      );
      const doc = legal(document);
      requireValue(
        uuid(doc.id) &&
          doc.tenantId === tenantId &&
          doc.mode === "collaboration" &&
          doc.lifecycle === "draft",
        "INVALID_DOCUMENT_CONTEXT",
      );
      const requestDigest = digest("public-document-command-v1", {
        action: "create",
        document: doc,
        disclosure,
      });
      return context(credentials, tenantId, true, async (db, actor) => {
        const replay = await prior(db, tenantId, commandId, requestDigest);
        if (replay) return replay;
        const count = (
          await db.query(
            "SELECT count(*)::int AS n FROM dge_documents.documents WHERE tenant_id=$1",
            [tenantId],
          )
        ).rows[0].n;
        requireValue(count < maxDocuments, "DOCUMENT_LIMIT_REACHED", 429);
        requireValue(
          !(
            await db.query(
              "SELECT id FROM dge_documents.documents WHERE id=$1",
              [doc.id],
            )
          ).rows.length,
          "DOCUMENT_ID_EXISTS",
          409,
        );
        try {
          await db.query(
            "INSERT INTO dge_documents.documents(tenant_id,id,visibility,disclosure,created_by,created_at,version,digest,current) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8)",
            [
              tenantId,
              doc.id,
              "public",
              disclosure,
              actor.accountId,
              now(),
              legalDocumentDigest(doc),
              doc,
            ],
          );
        } catch (cause) {
          if (cause.code === "23505")
            throw new DocumentError("DOCUMENT_ID_EXISTS", 409);
          throw cause;
        }
        return append(db, actor, doc, {
          commandId,
          requestDigest,
          nextVersion: 1,
          previousDigest: null,
        });
      });
    },
    async list(credentials, tenantId, { after = null, limit = 50 } = {}) {
      requireValue(
        (after === null || uuid(after)) &&
          Number.isSafeInteger(limit) &&
          limit >= 1 &&
          limit <= 100,
        "INVALID_PAGE",
      );
      return context(credentials, tenantId, false, async (db, actor) => {
        const rows = (
          await db.query(
            `SELECT id,version,digest,current->'metadata'->>'title' AS title,current->>'mode' AS mode FROM dge_documents.documents
          WHERE tenant_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`,
            [tenantId, after, limit + 1],
          )
        ).rows;
        return {
          items: rows.slice(0, limit),
          nextCursor: rows.length > limit ? rows[limit - 1].id : null,
          viewerRole: actor.role,
        };
      });
    },
    async read(credentials, tenantId, documentId) {
      requireValue(uuid(documentId), "INVALID_DOCUMENT_ID");
      return context(credentials, tenantId, false, async (db, actor) => {
        const row = (
          await db.query(
            "SELECT d.*,v.previous_digest FROM dge_documents.documents d JOIN dge_documents.versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.version=d.version WHERE d.tenant_id=$1 AND d.id=$2",
            [tenantId, documentId],
          )
        ).rows[0];
        requireValue(row, "DOCUMENT_NOT_FOUND", 404);
        return { ...snapshot(row), viewerRole: actor.role };
      });
    },
    async collaborationState(credentials, tenantId, documentId) {
      requireValue(uuid(documentId), "INVALID_DOCUMENT_ID");
      return context(credentials, tenantId, false, async (db) => {
        const row = (
          await db.query(
            "SELECT c.version,c.state,c.sha256 FROM dge_documents.crdt_states c JOIN dge_documents.documents d ON d.tenant_id=c.tenant_id AND d.id=c.document_id AND d.version=c.version WHERE c.tenant_id=$1 AND c.document_id=$2",
            [tenantId, documentId],
          )
        ).rows[0];
        if (!row) return null;
        const bytes = Buffer.from(row.state);
        requireValue(
          bytes.length > 0 && bytes.length <= MAX_CRDT_STATE_BYTES &&
            stateDigest(bytes) === row.sha256,
          "CRDT_INTEGRITY_ERROR", 503,
        );
        return {version: row.version, state: bytes.toString("base64url")};
      });
    },
    async save(
      credentials,
      tenantId,
      documentId,
      { document, commandId, expectedVersion, crdtState },
    ) {
      command(commandId);
      requireValue(
        uuid(documentId) && version(expectedVersion),
        "INVALID_VERSION",
      );
      const stateBytes = parseCrdtState(crdtState);
      const doc = legal(document);
      if (stateBytes) {
        let shared;
        try {
          shared = createPublicSharedDraft({classification:"public",document:doc,
            initialState:new Uint8Array(stateBytes)});
          requireValue(
            JSON.stringify(shared.snapshot().content) === JSON.stringify(doc.content),
            "INVALID_CRDT_STATE",
          );
        } catch { throw new DocumentError("INVALID_CRDT_STATE"); }
        finally { shared?.close(); }
      }
      requireValue(
        doc.id === documentId &&
          doc.tenantId === tenantId &&
          doc.mode === "collaboration" &&
          doc.lifecycle === "draft",
        "INVALID_DOCUMENT_CONTEXT",
      );
      const requestDigest = digest("public-document-command-v1", {
        action: "save",
        document: doc,
        expectedVersion,
        ...(crdtState !== undefined ? { crdtState } : {}),
      });
      return context(credentials, tenantId, true, async (db, actor) => {
        const replay = await prior(db, tenantId, commandId, requestDigest);
        if (replay) return replay;
        const row = (
          await db.query(
            "SELECT * FROM dge_documents.documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
            [tenantId, documentId],
          )
        ).rows[0];
        requireValue(row, "DOCUMENT_NOT_FOUND", 404);
        requireValue(
          row.current.mode === "collaboration" &&
            row.current.lifecycle === "draft",
          "SOURCE_FROZEN",
          409,
        );
        requireValue(row.version === expectedVersion, "VERSION_CONFLICT", 409);
        requireValue(row.version < maxVersions, "VERSION_LIMIT_REACHED", 429);
        requireValue(
          doc.revision > row.current.revision,
          "REVISION_MUST_ADVANCE",
          409,
        );
        await db.query(
          "UPDATE dge_documents.documents SET current=$3,version=version+1,digest=$4 WHERE tenant_id=$1 AND id=$2",
          [tenantId, documentId, doc, legalDocumentDigest(doc)],
        );
        const saved = await append(db, actor, doc, {
          commandId,
          requestDigest,
          nextVersion: row.version + 1,
          previousDigest: row.digest,
        });
        if (stateBytes) {
          requireValue(
            (await db.query(
              "UPDATE dge_documents.usage SET stored_bytes=stored_bytes+$2 WHERE tenant_id=$1 AND stored_bytes+$2<=$3 RETURNING stored_bytes",
              [tenantId, stateBytes.length, maxStoredBytes],
            )).rows.length,
            "STORAGE_LIMIT_REACHED", 429,
          );
          await db.query(
            "INSERT INTO dge_documents.crdt_states(tenant_id,document_id,version,format,state,sha256,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [tenantId, documentId, row.version + 1, "yjs-v13-public-v1", stateBytes, stateDigest(stateBytes), now()],
          );
        }
        return saved;
      });
    },
    async restore(credentials,tenantId,documentId,{commandId,expectedVersion,sourceVersion,sourceDigest,disclosure}){
      command(commandId);
      requireValue(uuid(documentId)&&version(expectedVersion)&&version(sourceVersion)&&
        typeof sourceDigest==='string'&&/^[a-f0-9]{64}$/.test(sourceDigest),'INVALID_RESTORATION');
      requireValue(disclosure==='restore-public-revision-v1','PUBLIC_DISCLOSURE_REQUIRED');
      const restoration={sourceVersion,sourceDigest};
      return identity.withTenant(credentials,tenantId,{write:true,recent:true,roles:['owner','admin']},async(db,actor)=>{
        const requestDigest=digest('public-document-command-v1',{
          action:'restore',documentId,actorId:actor.accountId,expectedVersion,sourceVersion,sourceDigest,disclosure,
        });
        const replay=await prior(db,tenantId,commandId,requestDigest);
        if(replay){
          const receipt=(await db.query('SELECT source_version,source_digest FROM dge_documents.restorations WHERE tenant_id=$1 AND document_id=$2 AND version=$3',[tenantId,documentId,replay.version])).rows[0];
          requireValue(receipt?.source_version===sourceVersion&&receipt.source_digest===sourceDigest,'RESTORATION_INTEGRITY_ERROR',503);
          return {...replay,restoration};
        }
        const row=(await db.query('SELECT * FROM dge_documents.documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenantId,documentId])).rows[0];
        requireValue(row,'DOCUMENT_NOT_FOUND',404);
        const current=snapshot(row).document;
        requireValue(current.id===documentId&&current.tenantId===tenantId,'DOCUMENT_INTEGRITY_ERROR',503);
        requireValue(current.mode==='collaboration'&&current.lifecycle==='draft','SOURCE_FROZEN',409);
        requireValue(row.version===expectedVersion,'VERSION_CONFLICT',409);
        requireValue(sourceVersion<row.version,'RESTORE_REQUIRES_OLDER_VERSION',409);
        requireValue(row.version<maxVersions,'VERSION_LIMIT_REACHED',429);
        const sourceRow=(await db.query('SELECT * FROM dge_documents.versions WHERE tenant_id=$1 AND document_id=$2 AND version=$3',[tenantId,documentId,sourceVersion])).rows[0];
        requireValue(sourceRow,'SOURCE_VERSION_NOT_FOUND',404);
        const source=snapshot(sourceRow).document;
        requireValue(source.id===documentId&&source.tenantId===tenantId,'DOCUMENT_INTEGRITY_ERROR',503);
        requireValue(sourceRow.digest===sourceDigest,'SOURCE_DIGEST_MISMATCH',409);
        requireValue(source.schemaVersion===current.schemaVersion,'RESTORE_SCHEMA_MISMATCH',409);
        // Restore only content/metadata. Current identity, mode, lifecycle and
        // schema/provenance remain authoritative; a new revision is mandatory.
        const document=legal({...structuredClone(current),revision:current.revision+1,
          metadata:structuredClone(source.metadata),content:structuredClone(source.content)});
        await db.query('UPDATE dge_documents.documents SET current=$3,version=version+1,digest=$4 WHERE tenant_id=$1 AND id=$2',[tenantId,documentId,document,legalDocumentDigest(document)]);
        const saved=await append(db,actor,document,{commandId,requestDigest,nextVersion:row.version+1,previousDigest:row.digest,restoration});
        await db.query('INSERT INTO dge_documents.restorations(tenant_id,document_id,version,source_version,source_digest) VALUES($1,$2,$3,$4,$5)',[tenantId,documentId,saved.version,sourceVersion,sourceDigest]);
        // No historical CRDT state is attached to the new version. Realtime
        // admission checks its fresh head and starts a new public Yjs snapshot.
        return {...saved,restoration};
      });
    },
    async freezeForInput(
      credentials,
      tenantId,
      documentId,
      { commandId, expectedVersion },
    ) {
      command(commandId);
      requireValue(
        uuid(documentId) && version(expectedVersion),
        "INVALID_VERSION",
      );
      const requestDigest = digest("public-document-command-v1", {
        action: "freeze-public-input",
        documentId,
        expectedVersion,
      });
      return identity.withTenant(
        credentials,
        tenantId,
        { write: true, recent: true, roles: ["owner", "admin"] },
        async (db, actor) => {
          const replay = await prior(db, tenantId, commandId, requestDigest);
          if (replay) return replay;
          const row = (
            await db.query(
              "SELECT * FROM dge_documents.documents WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
              [tenantId, documentId],
            )
          ).rows[0];
          requireValue(row, "DOCUMENT_NOT_FOUND", 404);
          requireValue(
            row.version === expectedVersion,
            "VERSION_CONFLICT",
            409,
          );
          requireValue(row.version < maxVersions, "VERSION_LIMIT_REACHED", 429);
          requireValue(
            row.current.mode === "collaboration" &&
              row.current.lifecycle === "draft",
            "SOURCE_FROZEN",
            409,
          );
          let doc;
          try {
            doc = publicInputEdition(row.current);
          } catch {
            throw new DocumentError("UNRESOLVED_REFERENCES", 409);
          }
          await db.query(
            "UPDATE dge_documents.documents SET current=$3,version=version+1,digest=$4 WHERE tenant_id=$1 AND id=$2",
            [tenantId, documentId, doc, legalDocumentDigest(doc)],
          );
          return append(db, actor, doc, {
            commandId,
            requestDigest,
            nextVersion: row.version + 1,
            previousDigest: row.digest,
          });
        },
      );
    },
    async publicDirectory({after=null,limit=30}={}){
      requireValue((after===null||uuid(after))&&
        Number.isSafeInteger(limit)&&limit>=1&&limit<=100,
        "INVALID_PAGE");
      return transaction(async db=>{
        await db.query("SELECT set_config('dge.public_document_directory','enabled',true)");
        const rows=(await db.query(
          "SELECT id,tenant_id AS \"tenantId\",version,current->'metadata'->>'title' AS title,current->>'mode' AS mode,created_at AS \"createdAt\" FROM dge_documents.documents WHERE visibility='public' AND ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2",
          [after,limit+1])).rows;
        return {
          items:rows.slice(0,limit),
          nextCursor:rows.length>limit?rows[limit-1].id:null,
          disclosure:"public-document-directory-v1"
        };
      });
    },
    async publicRead(documentId, { version: edition = null } = {}) {
      requireValue(
        uuid(documentId) && (edition === null || version(edition)),
        "INVALID_DOCUMENT_ID",
      );
      return transaction(async (db) => {
        await db.query("SELECT set_config('dge.public_document_id',$1,true)", [
          documentId,
        ]);
        const row =
          edition === null
            ? (
                await db.query(
                  "SELECT d.*,v.previous_digest FROM dge_documents.documents d JOIN dge_documents.versions v ON v.tenant_id=d.tenant_id AND v.document_id=d.id AND v.version=d.version WHERE d.id=$1",
                  [documentId],
                )
              ).rows[0]
            : (
                await db.query(
                  "SELECT * FROM dge_documents.versions WHERE document_id=$1 AND version=$2",
                  [documentId, edition],
                )
              ).rows[0];
        requireValue(row, "DOCUMENT_NOT_FOUND", 404);
        return snapshot(row);
      });
    },
    async history(documentId, { before = null, limit = 50 } = {}) {
      requireValue(
        uuid(documentId) &&
          (before === null || version(before)) &&
          Number.isSafeInteger(limit) &&
          limit >= 1 &&
          limit <= 100,
        "INVALID_PAGE",
      );
      return transaction(async (db) => {
        await db.query("SELECT set_config('dge.public_document_id',$1,true)", [
          documentId,
        ]);
        requireValue(
          (
            await db.query(
              "SELECT id FROM dge_documents.documents WHERE id=$1",
              [documentId],
            )
          ).rows.length,
          "DOCUMENT_NOT_FOUND",
          404,
        );
        const rows = (
          await db.query(
            `SELECT v.version,v.digest,v.previous_digest AS "previousDigest",v.event_digest AS "eventDigest",v.created_at AS "createdAt",
          CASE WHEN r.version IS NOT NULL THEN jsonb_build_object('sourceVersion',r.source_version,'sourceDigest',r.source_digest) END AS restoration
          FROM dge_documents.versions v LEFT JOIN dge_documents.restorations r ON r.tenant_id=v.tenant_id AND r.document_id=v.document_id AND r.version=v.version
          WHERE v.document_id=$1 AND ($2::int IS NULL OR v.version<$2::int) ORDER BY v.version DESC LIMIT $3`,
            [documentId, before, limit + 1],
          )
        ).rows;
        return {
          items: rows
            .slice(0, limit)
            .map(({restoration,...row}) => ({ ...row, ...(restoration?{restoration}:{}),anchorStatus: "pending" })),
          nextCursor: rows.length > limit ? rows[limit - 1].version : null,
        };
      });
    },
  });
}
