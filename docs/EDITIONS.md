# Immutable final editions — DCE-019 contribution

A final edition freezes one exact saved public version of a document. It is an append-only copy: later saves, restorations or proposal applications on the working draft never change it. Signatures (see [SIGNATURES.md](SIGNATURES.md)) bind to an edition, never to the working draft, so changed wording always means a new edition and new assent.

## Kinds

| Kind | Source document mode | Lifecycle label | Extra requirement |
| --- | --- | --- | --- |
| `final` | collaboration | `published` | Explicit owner/admin finalization |
| `adopted` | collaboration | `adopted` | The closed decision whose certificate has outcome `passed`, application `applied-to-public-draft`, and `appliedVersion`/`appliedDigest` equal to the frozen version |
| `consultation-source` | public-input (frozen with `freeze-input`) | `published` | The frozen consultation source, byte-for-byte |

Public-input documents have no adoption path, so `adopted` is refused for them. An adopted edition records an internal governance decision; it is not by itself enacted law or an executed agreement. Execution is a separate signature kind.

## What freezing checks

`POST /api/workspaces/{tenantId}/documents/{documentId}/editions` with `{commandId, kind, sourceVersion, sourceDigest, decisionId?, certificateDigest?, artifact?}`:

- a recently authenticated owner or admin (same assurance as freezing public input);
- the saved version exists and its stored digest equals `sourceDigest` (the caller states exactly what it is freezing);
- the legal tree validates for finalization with zero reference issues (`finalizeLegalDocument` / `documentIssues`); unresolved references, ambiguous or cyclic definitions return `LEGAL_REFERENCE_ISSUES`;
- the edition kind matches the document mode; one edition per version and kind;
- for `adopted`, the decision certificate digest is recomputed from the stored certificate and must match.

`artifact` is an optional `{sha256, mediaType}` produced by an export/rendering step. The content digest (`editionDigest`, the canonical legal-document digest) and the rendered-artifact SHA-256 are distinct values; both are carried into every signing intent. The engine does not render PDFs here.

The edition document is `finalizeLegalDocument(version, lifecycle)` (revision + 1, lifecycle label set) for collaboration sources and the unchanged frozen version for consultation sources. `sourceDigest` always identifies the exact saved version.

Command IDs make retries idempotent; reusing one with a different request fails with `COMMAND_REUSED`.

## Records, logging and verification

Each edition stores a canonical record (`quill-final-edition-v1`: tenant, edition, document, sequence, kind, lifecycle, source version and digest, edition digest, artifact, decision reference, freeze time). Its digest is appended to the transparency outbox with `kind=final-edition`, `subjectId=documentId` and `finalization=true`, in the same transaction, so the ledger worker sequences it and schedules an anchor promptly. Public reads report `ledger.status` as `pending` until the worker has logged it, then the log sequence number; an external anchor is not claimed by this API.

Reads re-verify the stored record digest and edition document digest and fail closed (`EDITION_INTEGRITY_ERROR`).

## Routes

| Route | Access |
| --- | --- |
| `GET /api/workspaces/{t}/documents/{d}/editions?after&limit` | Workspace members |
| `POST /api/workspaces/{t}/documents/{d}/editions` | Recently authenticated owner/admin; CSRF/origin protected |
| `GET /api/public/editions?documentId=&after=&limit=` | Public (documents in this engine are public) |
| `GET /api/public/editions/{editionId}` | Public; includes the frozen document and record |

## Database enforcement (migration 023)

`dge_editions.editions` has forced row-level security (tenant scope for members, `dge.public_edition_id`/`dge.public_document_id` for public reads), insert/select grants only, and a trigger rejecting every UPDATE and DELETE. A BEFORE INSERT trigger independently re-checks the source digest, mode/kind agreement and, for adoption, that the referenced closed decision passed and produced exactly this version. Foreign keys tie an edition to the saved version and decision in the same workspace.

## Limits and honest status

- At most 1,000 editions per document (configurable down).
- Editions copy the document JSON (up to the 3 MB legal-document limit); this is not counted in the document storage budget of migration 004.
- Redaction of an edition, signed-PDF byte ranges and anchoring finality are outside this change.
- DCE-019 remains partial: diff goldens for redlines and branch isolation belong to other contributions.
