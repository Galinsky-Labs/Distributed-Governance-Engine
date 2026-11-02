# Public decision receipts (DCE-020 / DCE-023 partial)

A workspace administrator closes a proposal decision after its published deadline.
The immutable closure certificate records the exact proposal digest, frozen
electorate snapshot digest, aggregate yes/no/abstain totals, outcome, and whether
an approved amendment was applied to a new **public draft** revision. It is not
a legally executed law or corporate resolution.

After closure, any visitor may GET
`/api/public/documents/:documentId/proposals/:proposalId/decision/receipt`.
The returned JSON has the certificate and a SHA-256 domain-separated digest.
It does **not** include the voter roster, ballot identities or account secrets.
Open votes and unknown documents yield HTTP 404.

The governance page has a **Download publicly verifiable checksum receipt**
button. A recipient can check the file offline:

```sh
node scripts/verify-decision-receipt.mjs Quill-decision-<proposal-id>.json
```

The offline verifier rejects altered documents, proposal IDs, digest strings,
unexpected receipt fields, or a purportedly executed certificate. It reports
`checksumValid`, not the identity or authority of the issuer.

**Security limit:** a digest can be recomputed by anyone. A valid checksum is
neither a server signature nor an independent transparency witness, immutable
blockchain anchor, evidentiary chain of custody, or legal-effect certificate.
The return flags `externalAnchorVerified:false` and
`legallyExecuted:false` are intentionally fixed. External finality,
qualified signatures and independent witnesses are later release gates.

The SQL migration `017-public-decision-receipts.sql` adds narrowly scoped
RLS reads for **closed** decisions. It must be applied by the privileged
migration operator with the existing migrator and independently verified
before the runtime role is granted production access.
