# Integrating editions and signatures

This change adds stores, route extensions and browser components but does not wire them into `server/start.mjs`, `server/application.mjs` or `web/app.jsx`; the integrator does that.

## Stores

```js
import {createEditionStore} from "./server/edition-store.mjs";
import {createSignatureStore} from "./server/signature-store.mjs";
import {createPasskeyVerifiers} from "./server/passkey-verifier.mjs";

const editions = createEditionStore({
  identity,            // createIdentityStore(...) result (uses withTenant)
  transaction,         // pgTransactions(pool): runs fn(db) as dge_identity_runtime
  clock: Date.now,     // optional
  maxEditionsPerDocument: 1000, // optional, 1..1000
});
const signatures = createSignatureStore({
  identity,            // uses withTenant and sessionInfo
  transaction,
  origin,              // canonical https origin; RP ID is its hostname
  verifyPasskeyAuthentication: createPasskeyVerifiers().verifyPasskeyAuthentication, // omit to disable passkeys (execution then returns 503 PASSKEY_VERIFIER_UNAVAILABLE)
  clock: Date.now,     // optional
  intentTtlMs: 900000, // optional, signing request lifetime
  maxLeavesPerFreeze: 50000, // optional, records appended per freeze request
  freezeChunk: 2000,   // optional, rows per freeze batch
  exportChunk: 1000,   // optional, rows per streamed export chunk
});
```

Use the same verifier only when the deployment has configured passkeys (`PASSKEY_ATTESTATION_POLICY`, see PASSKEY_VERIFIER.md); the signature store reads credentials enrolled through the identity store and advances their counters.

Store methods (all throw `DocumentError(code, status)` for domain errors; the identity store throws `AccessError` for authentication/authorization):

- editions: `freeze(credentials, tenantId, documentId, body)`, `list(credentials, tenantId, documentId, {after, limit})`, `publicList(documentId, {after, limit})`, `publicRead(editionId)`.
- signatures: `configureSignatories`, `signatories`, `createIntent`, `declineIntent`, `sign`, `withdraw`, `dispute`, `mine`, `list`, `receipt`, `freezeManifest`, `manifests`, `manifest`, `exportManifest` (async generator of string chunks), `directory`, `publicReceipt`.

## Routes

```js
import {createEditionRoutes, editionBodyLimit} from "./server/edition-http.mjs";
import {createSignatureRoutes, signatureBodyLimit} from "./server/signature-http.mjs";

createAccountHandler({store: identity, login, origin, extensions: [
  createEditionRoutes({editions}),
  createSignatureRoutes({signatures}),
  // ...existing extensions
]});
// Body-size gate: include both in the max() used for the request limit.
const limit = Math.max(documentBodyLimit(path), editionBodyLimit(path), signatureBodyLimit(path) /* , ... */);
```

`signatureBodyLimit` is 96 KiB for `POST /api/workspaces/{t}/editions/{e}/signatures` (bounded ink plus a WebAuthn assertion) and 8 KiB elsewhere; `editionBodyLimit` is 8 KiB.

| Method and path | Purpose |
| --- | --- |
| GET, POST `/api/workspaces/{t}/documents/{d}/editions` | List / freeze editions |
| GET `/api/public/editions?documentId=` and `/api/public/editions/{e}` | Public edition list / edition |
| GET, POST `/api/workspaces/{t}/editions/{e}/signatories` | Read / configure execution order once |
| POST `/api/workspaces/{t}/editions/{e}/intents` | Issue a signing intent |
| POST `/api/workspaces/{t}/editions/{e}/intents/{i}/decline` | Decline an intent |
| GET, POST `/api/workspaces/{t}/editions/{e}/signatures` | Manager evidence list (`?kind=&after=&limit=`) / sign |
| GET `/api/workspaces/{t}/editions/{e}/signatures/mine` | Signer's own records and marks |
| POST `/api/workspaces/{t}/editions/{e}/signatures/{s}/withdraw` and `/dispute` | Append withdrawal / dispute (`{reason}`) |
| GET `/api/workspaces/{t}/editions/{e}/signatures/{s}/receipt` | Personal inclusion receipt |
| POST `/api/workspaces/{t}/editions/{e}/manifests` | Freeze a manifest version (`{kind}`) |
| GET `/api/public/editions/{e}/directory` | Public directory |
| GET `/api/public/editions/{e}/manifests`, `/manifests/{kind}/{version}` | Manifest versions |
| GET `/api/public/editions/{e}/manifests/{kind}/{version}/entries.json` / `.csv` | Streamed downloads (`Response`) |
| GET `/api/public/editions/{e}/receipts/{recordDigest}` | Public receipt lookup |

All mutations require the session cookie, exact `Origin` and the `x-dge-csrf` header, enforced by the common account handler; bodies are parsed with `boundedJson` and reject unknown fields.

## Browser components

- `EditionsPanel` (`web/editions-panel.jsx`): props `tenantId`, `documentId`, `role`, optional `api`, optional `onSelect(edition)`.
- `SignaturePanel` (`web/signature-panel.jsx`): props `tenantId`, `editionId`, `editionKind` (`adopted|final|consultation-source`), optional `api`, optional `authenticate(passkeyOptions)` (defaults to `@simplewebauthn/browser` `startAuthentication`). Also exports `DrawingPad({strokes, onChange, disabled})`.
- `SignerDirectory` (`web/signer-directory.jsx`): props `editionId`, `kind`, optional `api`.

`api` defaults to `createAccountAPI()` from `web/account-api.mjs`.

## Ledger worker

Editions and manifests only append to `dge_ledger.outbox` (`final-edition`, `signature-manifest`, both `finalization=true`). Run the existing `createLedger(...).tick()` worker for them to be sequenced, checkpointed and anchored; until then receipts report a `null` ledger sequence.

## Configuration and migration

No new environment variables or credentials. Migration `023-editions-and-signatures.sql` replaces the reserved placeholder in the same slot. A database that already applied the placeholder will fail the startup checksum check and must be migrated deliberately (the placeholder created nothing, so applying 023's contents and updating its recorded checksum is the expected path). Rollback must preserve editions, signature records and manifests; there is no down migration.
