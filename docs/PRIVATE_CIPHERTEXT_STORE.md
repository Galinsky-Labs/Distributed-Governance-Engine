# Ciphertext-only private document store (partial DCE-003)

Migration 014 creates tenant-scoped private document pointers, immutable encrypted version records and logical byte accounting. \`createPrivateDocumentStore\` and \`createPrivateDocumentRoutes\` implement an **opt-in server component** that only accepts authenticated AES-256-GCM envelopes; no semantic document, title, text, revision body, plaintext fallback or server-held decryption key is accepted.

## Deployment gate — intentionally disabled

The production bootstrap does **not** mount these routes, and this code must not be enabled by simply toggling a flag. Construction requires an authoritative server-injected \`authorizeDevice\` adapter that checks verified device enrollment, current tenant membership and cryptographic epoch authority; a user-supplied device ID is not accepted. Epoch increases additionally require the trusted \`authorizeEpochAdvance\` adapter. These adapters are **not** implemented or configured for production.

Group key distribution and rotation, interoperable MLS, device proof, member-removal rekeying, session-to-device binding, encrypted Yjs state reconciliation, and multi-instance realtime relay remain incomplete. A mocked authorizer used in PGlite tests is never an acceptable deployment substitute.

## Storage and authority

- Existing OIDC session, origin/CSRF and tenant checks are shared with the account boundary. Current owner/admin/editor roles may write; authorized membership can read opaque ciphertext. Device authorization is a second mandatory check for every operation.
- The API accepts only \`{version:1,cipher:"AES-256-GCM",keyEpoch,nonce,ciphertext}\`, plus routing/command/version metadata. Nonces are exactly 12 bytes; the ciphertext is bounded to 2.9 MB, and both encodings must be canonical base64url. No plaintext metadata is stored.
- Each version is immutable under the ordinary DB credential; the latest pointer advances by exactly one version via a guarded trigger. Requests are idempotent by unique command ID plus bound request digest; expected-version checks and row locks stop lost writes.
- A server-computed domain-separated digest binds tenant, document, version, key epoch, nonce, ciphertext and previous digest; it detects accidental/tampered server data but does **not** prove legal authorship or encrypt/verify a private document's application plaintext.
- Membership and storage quota transactions roll back together on error. Private records never pass through public document publishing, public Yjs state, proposal indexing, public outbox, exports, telemetry or audit text.
- Runtime ownership checks include \`dge_private\`; schema migrations are appended to the verified checksum chain and must not edit earlier applied migrations.
- The storage model currently allows *only reviewed, independently authorized* epoch progression. It cannot securely rekey itself after membership changes. No "automatic rekey" or compromised-server E2EE promise is made.

## Verification and remaining work

\`tests/private-document-store.test.mjs\` exercises persistence across service instances, unauthorized roles/nonmembers, tampering, idempotency, version conflicts, reject-plaintext inputs, device gating, epoch approval and storage-budget rollback using embedded PostgreSQL. The HTTP boundary tests reject extra plaintext fields and forged origins. These are unit/integration fixtures, not a production authorization proof.

Before enabling a private UI or server path: integrate a reviewed client MLS/device-key implementation, verified hardware-passkey provider, authoritative key epochs bound to workspace member history, ciphertext-only attachments and Yjs relaying, membership revocation/rekey tests, interop/reconnect/concurrency/load suites, backups and deployed TLS/routing evidence.

**Status: partial. No production deployment, private group E2EE acceptance or third-party certification.**

The pinned OpenMLS endpoint contribution now exercises standard group messages,
complete client-pinned rosters and member-removal rotation natively and in isolated
browsers. See MLS_ENDPOINT.md for actual scope and integration gates. Production
private paths, durable encrypted state, device/pin distribution, recovery and
complete DCE-003/DCE-008 acceptance remain unverified.
