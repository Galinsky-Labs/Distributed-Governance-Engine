# Durable private encrypted collaboration updates (partial DCE-008)

Migration 015 introduces \`dge_private.update_frames\`: an append-only, tenant-scoped, binary ciphertext ledger. Each committed frame is bound to the specific private document, server-assigned position, current key epoch, authenticated sender device, device sequence, nonce and ciphertext. No server code decrypts or interprets Yjs payloads, legal wording, private author names or encryption keys.

## Mandatory runtime boundary

The backend still does **not** mount the optional \`createPrivateUpdateRoutes\`. It can only be constructed with \`createPrivateUpdateLedger({identity,authorizeDevice})\`, and **production must inject a reviewed authorizer** that cryptographically binds a current OIDC session to a verified enrolled device, tenant/document rights, group epoch and role. An envelope's \`senderDeviceId\` or an HTTP \`recipientDeviceId\` is only a *claim*—neither is authorization. Test fixtures use synthetic functions and are NOT production authorizers.

Only owner/admin/editor OIDC members can append. Device-authorized current members can read current-epoch ciphertext. Each transaction rechecks session/membership through \`identity.withTenant\` and device authority; database row security keeps tenants isolated. A change to the private document's committed key epoch immediately makes old-epoch appends invalid and prevents old-epoch frame delivery through \`list\`. Actual MLS group rekey and device eviction remain required.

## Consistency, replay and recovery

- The writer's authenticated \`(tenant, document, epoch, sender device, sequence)\` tuple is unique. Identical retries acknowledge the original stored position without charging quota twice; reusing the sequence with changed ciphertext fails.
- The document row lock serializes frame position assignment, replay checks and stored-byte accounting. A failed quota or database write rolls back the entire transaction.
- A bounded query returns at most 100 frames with a forward \`after\` cursor and a last-page indicator. Relays and recovering clients must order updates by stored position; storage does not claim cryptographic replay protection on its own.
- A server-calculated digest detects accidental/corrupt stored ciphertext. It is not a sender's digital signature and provides no compromised-server authenticity.
- Earlier epochs are **not** automatically disclosed to newly admitted users; a reviewed MLS snapshot/epoch history policy must control authenticated history recovery.
- Source plaintext must not enter public draft, proposal, search, telemetry, screenshot, export, backup or debug paths. Network and DB operators can still observe traffic volume, timing and device/document metadata.

## Integration and remaining acceptance

\`server/private-update-http.mjs\` provides optional POST ciphertext-frame and GET ciphertext-history endpoints. They use the established account cookie, exact-origin and CSRF boundary; the server bootstrap must also add \`privateUpdateBodyLimit\` when the routes are officially enabled. Production bootstrap intentionally has neither adapter enabled.

Unit/PGlite tests include real Yjs/WebCrypto ciphertext round trips, sender replay, conflicting reuse, tampering, current-epoch isolation, member removal, tenant isolation, storage budget rollback, pagination, unprivileged SQL history immutability and HTTP origin/CSRF/extra-plaintext-field rejection.

Still required: interoperable audited MLS implementation (key exchange, membership credentials, epoch updates/removals, backups, rekey, sender authentication), persistent device-binding protocol, private websocket state-vector and encrypted snapshot protocol, multi-instance coordination, real browsers/physical authenticators, distributed load tests and a production deployment. No E2E encryption or production readiness claim is made by this increment.

The pinned OpenMLS endpoint contribution now exercises standard group messages,
complete client-pinned rosters and member-removal rotation natively and in isolated
browsers. See MLS_ENDPOINT.md for actual scope and integration gates. Production
private paths, durable encrypted state, device/pin distribution, recovery and
complete DCE-003/DCE-008 acceptance remain unverified.
