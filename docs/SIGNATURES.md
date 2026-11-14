# Signing intent, identities, frozen bytes and mass manifests — DCE-026 / DCE-027 contribution

Signatures attach to an immutable final edition ([EDITIONS.md](EDITIONS.md)). Three kinds are recorded separately because they mean different things:

| Kind | Meaning | Who | Mark | Passkey |
| --- | --- | --- | --- | --- |
| `support` | Public support for a bill or text | Any workspace member | typed, drawn or none | optional |
| `approval` | Approval of this exact edition | owner, admin, editor, participant | typed or drawn | optional |
| `execution` | Intent to execute the edition in a stated capacity | Configured signatories, in configured order | typed or drawn | **required** |

`execution` is only offered on `adopted` and `final` editions. Support or approval is never converted into execution, and no vote or upvote creates a signature.

## Ceremony

1. **Intent.** `POST …/editions/{e}/intents {kind, capacity?}` returns a server-issued intent: schema `quill-signature-intent-v1`, tenant, document, edition, edition digest, rendered-artifact digest (or null), kind, capacity, consent text and consent version, account, a fresh 256-bit nonce, issue and expiry times (15 minutes by default). The **signing digest** is `digest('quill-signature-intent-v1', intent)` (dce-c14n-v0-dev canonical JSON, SHA-256). For execution the capacity comes from the signatory configuration (for example "Secretary, Acme Inc."), not from the signer.
2. **Review.** The signer sees the consent wording, edition digest, artifact digest and capacity. They may decline (`…/intents/{i}/decline`), which closes the intent.
3. **Submit.** `POST …/editions/{e}/signatures {intentId, signingDigest, consent: true, mark, display, passkey?}`. `consent` must be literally `true`. `mark` is `{type:"typed", text, fontId}`, `{type:"drawn", strokes}` or `{type:"none"}` (support only). `display` is `{visibility:"private"}` or `{visibility:"public", name}`.
4. **Passkey (execution; optional otherwise).** The WebAuthn challenge is the 32 raw bytes of the signing digest, base64url-encoded. The assertion is verified by the existing pinned `@simplewebauthn/server` adapter (`server/passkey-verifier.mjs`): exact origin, RP ID, user verification, credential ownership, signature, and a strictly increasing counter, which is then stored. An assertion produced for any other intent, edition or origin fails. No new cryptography is introduced.
5. **Record.** The canonical signature record (`quill-signature-record-v1`) contains edition and artifact digests, kind, the signing digest, consent version, capacity, a mark *digest* (never the ink), display choice and public name if chosen, identity assurance (session authentication time, session assurance level, whether a passkey assertion was verified), method (e.g. `drawn+passkey`) and time. Its digest is the record digest used in manifests and receipts.

### Rules enforced in the store and the database

- An intent is single-use (`evidence.intent_id` is unique; a closed intent cannot be reopened by trigger), account-bound and expiring. Replays return `INTENT_ALREADY_USED`; an intent presented for a different edition returns `INTENT_EDITION_MISMATCH`; a different digest returns `INTENT_DIGEST_MISMATCH`.
- One active signature per account, edition and kind: primary key on `dge_signatures.active`. Concurrent attempts produce exactly one success and `ALREADY_SIGNED`.
- Execution order: a trigger rejects an active execution signature unless every earlier configured signatory already has one. Signatories and capacities are configured once and are append-only.
- Withdrawal and dispute are new records referencing the original record digest. History is never erased; withdrawal only removes the account from the active projection and the public directory. Re-signing after withdrawal needs a new intent.
- Records, evidence, signatories, manifest entries, manifest nodes and manifests reject UPDATE and DELETE by trigger. Grants are SELECT/INSERT except for the active projection, directory and freeze queue (DELETE) and counters/heads (UPDATE of named columns).

### Identity and the visual mark

**A visual mark is never identity proof.** It is a presentation of assent chosen by the signer. Identity evidence is the authenticated session (provider login time and assurance as recorded by the identity store) and, where present, the verified passkey assertion bound to the signing digest. Typed marks use font ids whose licences permit embedding (Dancing Script, Caveat, Great Vibes — SIL OFL 1.1 — or the system serif, which is not embedded); the font files are not shipped in this repository. Drawn ink is up to 64 strokes, 1,000 points per stroke and 4,000 points in total on a 1000×400 integer grid. Names and marks reject control, bidirectional-override and zero-width characters.

### Privacy

Public-safe data and tenant-private evidence are separate tables. `dge_signatures.records` (public by edition) holds record digests, actions, display choice and — only for signers who opted in — the full record and mark. `dge_signatures.evidence` (tenant-only row policy) links records to accounts and holds every mark and intent. Private marks and identities are visible to the signer (`…/signatures/mine`) and to workspace owners/admins (`GET …/signatures?kind=`), never through public routes. Private records are hiding commitments: the record includes the signing digest, which commits to a random nonce, so a guessed name cannot be confirmed against a digest. Public row metadata includes the time a private record was created; it does not include the account.

## Manifests (DCE-027)

Every sign, withdraw and dispute record for an (edition, kind) enters a freeze queue. `POST …/editions/{e}/manifests {kind}` (owner/admin) appends queued records, in queue order, as leaves of an RFC 6962 Merkle tree (`leaf = SHA-256(0x00 ‖ record-digest bytes)`, `src/transparency.mjs`). Complete-subtree hashes are stored, so a freeze costs O(new records + log n) and a proof costs O(log n) rows. One freeze processes at most `maxLeavesPerFreeze` (50,000 by default) records in chunks and reports `pending: true` when more remain; call again to continue. A re-freeze creates a new manifest version (`quill-signature-manifest-v1`: size, root, previous size and root, active and publicly named signer counts, edition and artifact digests) with a stored consistency proof against the previous version; earlier versions are never rewritten. Each manifest digest is appended to the transparency outbox (`kind=signature-manifest`, `subjectId=editionId`, `finalization=true`). There is no background scheduler in this change: "periodic" re-freezes are triggered by a manager or an operator job that calls the route.

### Receipts

- Personal: `GET …/editions/{e}/signatures/{id}/receipt` (the signer or a manager) returns the full record, the intent, the position, the RFC 6962 inclusion proof, the latest manifest record and digest, and the ledger reference (`kind`, `subjectId`, `eventDigest`, sequence number once logged).
- Public: `GET /api/public/editions/{e}/receipts/{recordDigest}` returns the same proof, and the record and mark only if the signer chose public display.

Verify offline: `node scripts/verify-signature-receipt.mjs receipt.json [--manifest entries.json]`. It recomputes the manifest digest, the inclusion proof, the record digest and (when present) the intent digest, and with a manifest export recomputes the root over every entry. In a browser, `verifySignatureReceipt` from `src/signatures.mjs` does the same. A receipt proves inclusion in a manifest. It does not prove identity, legal effect or external anchoring; check the ledger entry and anchor status separately.

### Public directory and downloads

- `GET /api/public/editions/{e}/directory?kind=&q=&after=&limit=` lists only opted-in public names, in signing order, or by case-insensitive name prefix with `q`. Cursors are opaque and stable: new signatures never change a page already served. Counts (`total`, `publiclyNamed`) come from 16 sharded counters, so no request scans all signatures.
- `GET /api/public/editions/{e}/manifests?kind=` and `…/manifests/{kind}/{version}` return manifest versions.
- `…/manifests/{kind}/{version}/entries.json` and `entries.csv` stream the full manifest in 1,000-row chunks, each read in its own short transaction. Private signers appear only as position, record digest and action. CSV cells that begin with `=`, `+`, `-`, `@`, tab or carriage return are prefixed with `'` to prevent spreadsheet formula execution.

## Scale

Indexes cover `(edition, kind, seq)` for records and directory order, `(edition, kind, name_key, seq)` (C collation) for prefix search, the freeze queue order, and manifest entries/nodes by primary key. The 20,000-signature test (tests/signature-scale.test.mjs, PGlite) measured about 2.2 s to freeze 15,000 new records, 0.9 s for the next 5,000, and single-digit milliseconds per directory page, deep page and prefix search. These are in-process development timings, not a production benchmark; one million signatures has not been run.

## Legal context and limitations

Electronic-signature statutes (for example the US ESIGN Act and UETA, or eIDAS in the EU) are context for this design, not a claim of compliance or enforceability in any jurisdiction. Whether a record is a legally effective signature depends on the governing law, the parties' agreement, signer authority and evidence beyond this system. The execution consent text says so.

- Signers must be workspace members; open public petitions at very large scale would need a membership/onboarding flow sized accordingly.
- Intent creation is limited only by the shared per-peer request budget and authentication; there is no separate per-account intent quota.
- No uploaded-image marks, delegation, signature cancellation by an administrator, paged readable PDF appendices or signed PDF byte ranges are implemented.
- No service countersignature is applied; ordering and non-equivocation rely on the transparency log, its checkpoints and witnesses.
- Typed-mark fonts are referenced by id; font files and their licence texts must be supplied by the deployment.
