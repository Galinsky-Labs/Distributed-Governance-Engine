# Saved public documents — partial DCE-005 / DCE-008

The account-enabled shared editor can publish a copy of the current text into a workspace, save/reopen it, share a read-only public link, inspect immutable earlier versions, and freeze the source permanently for public input. The publisher explicitly authorizes public access to all saved versions. The static preview remains sample-only. This contribution accepts public content only; it does not provide plaintext storage as a substitute for private endpoint encryption.

## API and storage

| Route | Authority and behavior |
| --- | --- |
| GET /api/workspaces/:workspace/documents | Current member; bounded directory |
| POST /api/workspaces/:workspace/documents | Owner/admin/editor; exact legal document, commandId and publish-all-revisions-v1 disclosure |
| GET /api/workspaces/:workspace/documents/:document | Current member; exact current version and viewer role |
| PUT /api/workspaces/:workspace/documents/:document | Owner/admin/editor; commandId, expectedVersion, legal document; collaboration drafts only |
| POST /api/workspaces/:workspace/documents/:document/freeze-input | Recently authenticated owner/admin; commandId and expectedVersion |
| GET /api/public/documents/:document | Intentionally disclosed source; optional exact version |
| GET /api/public/documents/:document/history | Intentionally disclosed version metadata; bounded descending before/limit pages |

The common account HTTP boundary checks cookies, exact Origin/header proof for mutations, method/field/query bounds and request budget. Only exact document command paths receive the larger legal-document body limit (3 MB plus 16 KiB envelope); account inputs remain 8 KiB. Legal tree validation and document/workspace IDs are checked again in the store. Public responses omit internal author/command identifiers and identity evidence. Public document/workspace IDs and content/schema/version metadata are disclosed deliberately.

Migration 004 adds dge_documents with row policies, append-only version records, current pointers, a public disclosure record, a logical storage ledger and an anchoring outbox. Runtime cannot update/delete historical versions or outbox entries. The database trigger rejects rewriting any public-input source, including accidental direct runtime updates. Storage migrations and startup checksum checks now cover 001–004 without modifying previously applied files. Migration-owner and runtime credentials remain separate; startup rejects ownership/elevated privileges over both application schemas.

Authorization and write share one identity transaction/workspace lock. Removal and role changes serialize with saves. An exact expected storage version prevents lost edits. Command IDs bind the operation/payload; identical retries return their original result, while changed reuse fails. Current pointer, immutable version, linked source digest, logical byte accounting and pending commitment are committed together or all roll back. Defaults cap a workspace at 100 documents, 30 MB of logical version content, and 1,000 versions/document. These are development safety limits, not pricing or advertised scale. Current/history JSON duplication, indexes and database overhead mean the logical byte count is not a physical storage bill. Entitlement/admin integration remains pending.

## Browser behavior and failure recovery

The editor debounces public saves, serializes requests, and acknowledges a saved version without remounting or replacing newer local edits. If a response is lost, it retries the same command before submitting newer text. Publishing likewise retains an uncertain command for retry. Conflicting versions, frozen sources or lost authority stop writes and retain the local wording for export. Navigation warns about unsaved work; a browser crash can still lose unsaved memory. Public samples keep their separate optional local recovery; authenticated documents are not silently copied into that cache.

Anonymous public links and historical editions are read only even when their underlying source is a collaboration draft. Members open an editable current draft through Documents. Freezing first flushes local saves, then binds the exact storage version; the source remains permanently fixed. Revisions cannot be changed through a different save endpoint. No claim is made that a frozen feedback edition is enacted legislation, an adopted resolution or an executed agreement.

Every public version creates an atomic pending blockchain commitment. The UI/API always report pending because no chain worker or verified receipt is implemented yet. An outbox entry is a durable work record, not blockchain evidence. Public anchoring cannot be disabled by a document option. Full signed transparency receipts, chain finality and independent verification remain later units.

## Validation and limits

Focused tests cover disclosure, fresh-store reopen, wrong workspace/role/removal, immutable history, command replay, stale-save conflicts, frozen-source SQL rejection, payload/list bounds, and all-or-nothing budget rollback. Save-session tests cover typing during a request, lost responses, conflict preservation and disposal during navigation. Chrome exercises actual publication, save/reopen, anonymous read-only sharing, earlier-version viewing, two-window conflict preservation and public-input freezing through the real HTTPS app. Networked PostgreSQL CI checks competing saves and duplicate commands on separate connections.

This is a partial contribution to DCE-005 and DCE-008. Private device encryption, Yjs realtime merge (simultaneous draft edits converging automatically), offline persistent encrypted recovery, links/citations, IME/accessibility acceptance and deployment remain unfinished. Deliberation, ballots and adoption are separate planned workflows; this increment does not claim to implement them or to complete the parent units.

Explicit manager restoration appends earlier content/metadata as a new public working revision with recent OIDC authentication, source digest/current-head checks and migration-019 provenance. See [DRAFT_RESTORATION.md](DRAFT_RESTORATION.md). Frozen sources and historical rows remain unchanged; existing credentials suffice.
