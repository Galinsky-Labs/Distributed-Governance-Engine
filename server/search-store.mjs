// DCE-032 public full-text search. The index is the generated search_vector
// columns from migration 026, so it always matches the committed public text.
// Queries go through websearch_to_tsquery with the 'simple' configuration:
// user input is a bound parameter and never parsed as raw tsquery syntax.
// Snippets are computed here from the same public row that matched, so they
// can only contain intentionally published text.
import { AccessError } from "./identity-store.mjs";
import { DocumentError } from "./document-store.mjs";
import { createAccountScope } from "./account-scope.mjs";
import { legalPlainText } from "../src/legal-structure.mjs";

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const MODES = ["collaboration", "public-input"];
const PRODUCTS = ["civic", "charter"];
const KINDS = ["all", "document", "proposal"];
export const SEARCH_LIMITS = Object.freeze({ queryChars: 200, queryTerms: 16, page: 50, indexedChars: 200000, snippetRadius: 90 });
const fail = (code, status = 400) => { throw new DocumentError(code, status); };
const TOKEN = /[\p{L}\p{N}\p{M}]+/gu;

/** Same folding as dge_search.fold(): compatibility decomposition, no combining marks, lower case. */
export const foldText = (value) => value.normalize("NFKD").replace(/[̀-ًͯ-ٰٟ]/g, "").toLowerCase();

/** Positive query words used for highlighting; negated words and phrases are excluded. */
export function highlightTerms(query) {
  const positive = query.replace(/(^|\s)-("[^"]*"?|\S+)/g, " ");
  const terms = new Set();
  for (const [word] of positive.matchAll(TOKEN)) {
    const folded = foldText(word);
    if (folded && folded !== "or") terms.add(folded);
  }
  return terms;
}

/**
 * Builds a bounded snippet as plain segments ({text, match}) instead of HTML,
 * so clients render it without injecting markup.
 */
export function buildSnippet(text, terms, radius = SEARCH_LIMITS.snippetRadius) {
  const source = String(text).slice(0, SEARCH_LIMITS.indexedChars);
  const matches = [];
  for (const match of source.matchAll(TOKEN))
    if (terms.has(foldText(match[0]))) matches.push([match.index, match.index + match[0].length]);
  let start = matches.length ? Math.max(0, matches[0][0] - radius) : 0;
  let end = Math.min(source.length, (matches.length ? matches[0][1] : 0) + radius);
  if (start > 0) {
    const space = source.slice(start, start + 24).search(/\s/);
    if (space >= 0 && start + space < (matches[0]?.[0] ?? end)) start += space + 1;
  }
  if (/[\udc00-\udfff]/.test(source[start] ?? "")) start++;
  if (/[\ud800-\udbff]/.test(source[end - 1] ?? "")) end--;
  const segments = [];
  const push = (value, match) => {
    const textValue = value.replace(/\s+/g, " ");
    if (textValue) segments.push({ text: textValue, match });
  };
  let at = start;
  for (const [from, to] of matches) {
    if (from < start) continue;
    if (to > end) break;
    push(source.slice(at, from), false);
    push(source.slice(from, to), true);
    at = to;
  }
  push(source.slice(at, end), false);
  return { segments, truncatedStart: start > 0, truncatedEnd: end < String(text).length };
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify([row.rank, row.kind_order, row.id])).toString("base64url");
}
function decodeCursor(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) fail("INVALID_CURSOR");
  let parsed;
  try { parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { fail("INVALID_CURSOR"); }
  if (!Array.isArray(parsed) || parsed.length !== 3 || typeof parsed[0] !== "number" || !Number.isFinite(parsed[0]) ||
      ![0, 1].includes(parsed[1]) || !UUID.test(parsed[2] ?? "")) fail("INVALID_CURSOR");
  return { rank: parsed[0], kindOrder: parsed[1], id: parsed[2] };
}

export function validateSearch({ query, mode = null, workspace = null, product = null, kind = "all", cursor = null, limit = 20 } = {}) {
  if (typeof query !== "string") fail("INVALID_QUERY");
  const text = query.normalize("NFC").trim();
  if (!text.length || text.length > SEARCH_LIMITS.queryChars || /[\u0000-\u001f\u007f]/.test(text) ||
      text.split(/\s+/).length > SEARCH_LIMITS.queryTerms) fail("INVALID_QUERY");
  if ((mode !== null && !MODES.includes(mode)) || (workspace !== null && !UUID.test(workspace)) ||
      (product !== null && !PRODUCTS.includes(product)) || !KINDS.includes(kind)) fail("INVALID_FILTER");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SEARCH_LIMITS.page) fail("INVALID_PAGE");
  return { query: text, mode, workspace, product, kind, cursor: decodeCursor(cursor), limit };
}

const SEARCH_SQL = `
WITH q AS (SELECT websearch_to_tsquery('simple', dge_search.fold($1)) AS query),
hits AS (
  SELECT 0 AS kind_order, d.id, d.id AS document_id, NULL::uuid AS proposal_id, d.tenant_id, d.version,
         d.current->>'mode' AS mode, d.current->'metadata'->>'title' AS title,
         ts_rank(d.search_vector, q.query, 1)::real AS rank
    FROM dge_documents.documents d, q
   WHERE $7 IN ('all','document') AND d.visibility = 'public' AND d.search_vector @@ q.query
     AND ($2::text IS NULL OR d.current->>'mode' = $2) AND ($3::uuid IS NULL OR d.tenant_id = $3)
     AND ($4::boolean IS FALSE OR d.tenant_id IN (SELECT tenant_id FROM dge_identity.memberships
           WHERE account_id::text = current_setting('dge.account_id', true) AND active))
  UNION ALL
  SELECT 1, p.id, p.document_id, p.id, p.tenant_id, p.base_version,
         d.current->>'mode', d.current->'metadata'->>'title',
         ts_rank(p.search_vector, q.query, 1)::real
    FROM dge_proposals.proposals p
    JOIN dge_documents.documents d ON d.tenant_id = p.tenant_id AND d.id = p.document_id, q
   WHERE $7 IN ('all','proposal') AND d.visibility = 'public' AND p.search_vector @@ q.query
     AND ($2::text IS NULL OR d.current->>'mode' = $2) AND ($3::uuid IS NULL OR p.tenant_id = $3)
     AND ($4::boolean IS FALSE OR p.tenant_id IN (SELECT tenant_id FROM dge_identity.memberships
           WHERE account_id::text = current_setting('dge.account_id', true) AND active))
)
SELECT * FROM hits
 WHERE $5::real IS NULL OR rank < $5::real OR (rank = $5::real AND (kind_order, id) > ($6::int, $8::uuid))
 ORDER BY rank DESC, kind_order, id
 LIMIT $9`;

/**
 * `product` is the deployment's product. The engine stores no per-document
 * product attribute, so a product filter naming another product matches nothing.
 */
export function createSearchStore({ identity, transaction, product }) {
  if (typeof transaction !== "function" || !PRODUCTS.includes(product)) throw Error("Search store requires a transaction runner and product");
  const accountScope = identity ? createAccountScope({ identity, transaction }) : null;

  async function run(db, request, memberOnly) {
    const { query, mode, workspace, kind, cursor, limit } = request;
    if (request.product !== null && request.product !== product) return { items: [], nextCursor: null };
    const parsed = (await db.query("SELECT querytree(websearch_to_tsquery('simple', dge_search.fold($1))) AS tree", [query])).rows[0].tree;
    // An empty or purely negated query would match nothing or everything.
    if (!parsed || parsed === "T") return { items: [], nextCursor: null };
    await db.query("SELECT set_config('dge.public_document_directory','enabled',true), set_config('dge.public_search','enabled',true)");
    const rows = (await db.query(SEARCH_SQL, [query, mode, workspace, memberOnly, cursor?.rank ?? null,
      cursor?.kindOrder ?? null, kind, cursor?.id ?? null, limit + 1])).rows;
    const page = rows.slice(0, limit);
    const terms = highlightTerms(query);
    const documents = page.filter((r) => r.kind_order === 0).map((r) => r.id);
    const proposals = page.filter((r) => r.kind_order === 1).map((r) => r.id);
    const bodies = new Map();
    if (documents.length)
      for (const row of (await db.query("SELECT id, current FROM dge_documents.documents WHERE id = ANY($1::uuid[])", [documents])).rows)
        bodies.set(row.id, legalPlainText(row.current));
    if (proposals.length)
      for (const row of (await db.query("SELECT id, proposal->>'rationale' AS rationale, proposal->>'replacement' AS replacement FROM dge_proposals.proposals WHERE id = ANY($1::uuid[])", [proposals])).rows)
        bodies.set(row.id, row.rationale + "\n" + row.replacement);
    return {
      items: page.map((row) => ({
        kind: row.kind_order === 0 ? "document" : "proposal",
        documentId: row.document_id,
        proposalId: row.proposal_id,
        workspaceId: row.tenant_id,
        product,
        mode: row.mode,
        title: row.title,
        version: row.version,
        rank: row.rank,
        snippet: buildSnippet(bodies.get(row.id) ?? "", terms),
      })),
      nextCursor: rows.length > limit ? encodeCursor(page.at(-1)) : null,
    };
  }

  return Object.freeze({
    publicSearch: async (parameters) => {
      const request = validateSearch(parameters);
      return transaction((db) => run(db, request, false));
    },
    /** Public documents of the caller's own active workspaces only. */
    memberSearch: async (credentials, parameters) => {
      const request = validateSearch(parameters);
      if (!accountScope) fail("SEARCH_UNAVAILABLE", 503);
      return accountScope(credentials, {}, async (db, accountId) => {
        if (request.workspace !== null) {
          const member = (await db.query("SELECT 1 FROM dge_identity.memberships WHERE tenant_id=$1 AND account_id=$2 AND active", [request.workspace, accountId])).rows.length;
          if (!member) throw new AccessError("ACCESS_DENIED");
        }
        return run(db, request, true);
      });
    },
  });
}
