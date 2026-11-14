# Public full-text search (DCE-032)

Status: implemented and locally tested against PGlite (`tests/discovery-search.test.mjs`). Not deployed, not load tested, not independently reviewed.

## What is searchable

| Source | Indexed text | Weight |
| --- | --- | --- |
| `dge_documents.documents` (current public revision) | `metadata.title` | A |
| | body: `term`, `title`, `label` and `text` of every content node, in document order, first 200,000 characters | B |
| `dge_proposals.proposals` | `rationale` | B |
| | `replacement` (first 200,000 characters) | C |

Every row in these two tables is intentionally published content (`visibility='public'`, `publish-all-revisions-v1` / `publish-proposal-v1` disclosures). Earlier document revisions are not searched; only the current revision is.

**Private documents are never indexed by the server.** Client-encrypted documents live in `dge_private` as ciphertext and the server holds no key to read them. Searching private material has to run at an authorized client over plaintext it has decrypted locally (for example the editor's in-document find, `editor/search.mjs`). No server-side private index, snippet or query log exists, and this module must not be pointed at private tables.

## Index maintenance

Migration `026-search-and-notifications.sql` adds `search_vector` as a `GENERATED ALWAYS … STORED` column on both tables, plus GIN indexes. Postgres recomputes the column inside the same statement that writes the content, so the index cannot drift, needs no backfill job, and a rollback of the write rolls back the index entry.

The expression uses only immutable functions:

- `dge_search.document_body(jsonb)` — `jsonb_path_query` over `strict $.content.**` objects, concatenated and truncated. The truncation keeps every valid document (≤ 3 MB) far below the 1 MB `tsvector` limit, so indexing can never make a document save fail; text beyond 200,000 characters is not searchable.
- `dge_search.fold(text)` — `lower(regexp_replace(normalize(value, NFKD), combining marks, ''))`. Accent- and case-insensitive matching (`État` ↔ `etat`), and Arabic harakat are stripped. The `unaccent` extension is not available in PGlite and is only `STABLE`, so it is not used.
- `to_tsvector('simple', …)`: no stemming and no stop words, so behaviour is identical for English, Spanish, French and Arabic text. Inflected forms (`report` vs `reports`) do not match each other; this is a deliberate, language-neutral first version.

## Query handling

- The user query is a bound parameter passed to `websearch_to_tsquery('simple', dge_search.fold($1))`. Raw `tsquery` syntax is never accepted; `websearch_to_tsquery` never raises a syntax error, so operators such as `& | ! :* <->` and SQL fragments are treated as words or ignored. Supported syntax: words (AND), `"exact phrase"`, `-excluded`, `or`.
- Bounds: 1–200 characters after trimming, at most 16 whitespace-separated terms, no control characters. A query whose parsed tree is empty or purely negated (`-word`) returns no results instead of matching everything.
- Filters: `mode` (`collaboration` | `public-input`), `workspace` (tenant UUID), `kind` (`all` | `document` | `proposal`), `product` (`civic` | `charter`).
- **Product filter limitation:** the engine stores no product attribute on documents or workspaces; one deployment serves one product (`QUILL_PRODUCT`). Results report the deployment's product and a `product` filter naming the other product returns no results.

## Ranking and pagination

`ts_rank(search_vector, query, 1)` (rank divided by 1 + log(document length)), so a title match (weight A) outranks a body-only match. Results from both tables are merged and ordered by `rank DESC, kind, id`. The cursor is an opaque base64url encoding of `[rank, kind, id]` and pagination is keyset-based: pages never repeat or skip a row that stays in the result set, including rows with equal rank. Page size 1–50 (default 20).

## Snippets

Snippets are computed in `server/search-store.mjs` from the same public row that matched: `legalPlainText(current)` for documents and `rationale + replacement` for proposals. They are returned as plain segments, never HTML:

```json
{"segments":[{"text":"The ","match":false},{"text":"water","match":true}],"truncatedStart":true,"truncatedEnd":false}
```

Highlighting folds each word the same way as the index and marks words equal to a positive query term (negated words are not highlighted). Snippet windows are about 90 characters either side of the first match, snap to whitespace and never split a surrogate pair. Clients render segments as text (the search panel uses `<mark>`), so document text can never inject markup.

## Access control

| Route | Who | Scope |
| --- | --- | --- |
| `GET /api/public/search` | anyone | all public documents and proposals |
| `GET /api/search` | signed-in account | public content of the caller's **active** workspaces only; a `workspace` filter for a workspace the caller is not an active member of is `403 ACCESS_DENIED` |

Row access is enforced by Postgres policies: documents through the existing `public_document_directory` policy, proposals through the new `public_proposal_search` policy (`dge.public_search='enabled'`), and membership through the `dge.account_id` membership read policy from migration 003. Membership removal takes effect on the next query.

Query parameters accepted: `q`, `mode`, `workspace`, `product`, `kind`, `cursor`, `limit`; any other or repeated parameter is `400 INVALID_QUERY`. Errors: `INVALID_QUERY`, `INVALID_FILTER`, `INVALID_CURSOR`, `INVALID_PAGE` (400), `AUTHENTICATION_REQUIRED` (401), `ACCESS_DENIED` (403).

## Not implemented

Topic discovery, synonyms, stemming per language, typo tolerance, search over historical revisions, discussion point text and decision certificates, result caching and per-tenant query budgets beyond the shared request budget. No capacity or latency measurement has been made.
