# Authenticated private Yjs update frames — partial DCE-003 / DCE-008

The shared engine now exposes \`sealPrivateYjsUpdate\` and \`openPrivateYjsUpdate\` as a **client-only** encrypted update-framing primitive. These functions are not enabled by the public collaboration relay or the Quill UI; do not claim that private realtime collaboration is running.

## Boundary

- A trusted, independent device-enrollment and *reviewed group key management* system must furnish a non-extractable AES-256-GCM epoch key to authorized clients. The functions never generate, export, store, exchange or recover group keys.
- An authorized sender encrypts a binary Yjs delta (1 to 32,768 bytes). The wire frame contains only version, cipher, epoch, sender device ID, sender sequence, random nonce and authenticated ciphertext. It contains **no plaintext Yjs update**.
- WebCrypto AES-GCM uses a fresh 96-bit random nonce and a 128-bit authentication tag. AAD domain-separates protocol version, cipher, tenant, workspace, document, key epoch, sender device and sequence. The client must already trust all of these fields; an untrusted frame does not establish sender authorization.
- Receiver decryption rejects malformed and oversized envelopes, wrong keys, wrong scope, altered payloads, unknown epochs, sender mismatch and unauthenticated updates. No plaintext fallback exists.
- Each sender must persist and monotonically allocate a unique sequence across device restarts; receivers/relays must separately atomically detect duplicate \`(senderDeviceId, epoch, sequence)\` messages, handle reordered delivery, and apply Yjs updates idempotently. This helper only exposes \`messageId\` for caller-managed replay protection.
- Group membership changes must revoke device authorization and rotate the shared key *before* publishing additional updates. A removed member may retain old keys and historical plaintext. A server, membership service or database cannot derive revocation from a self-asserted epoch field.
- Compromised endpoints, malicious same-origin JavaScript, forged membership decisions, traffic metadata, sender-collusion and rollback remain outside this frame's confidentiality guarantee.
- Do **not** reuse the local encrypted draft-cache key as a group shared key. Draft cache and network-update domains/keys must be kept separate.

## Required integration before enabling private mode

1. Pin and review a proven group protocol (MLS or equivalent) with authenticated device provisioning, membership credentials, group epoch export, key updates, device removal, recovery, and cross-device interoperability. Do not invent key agreement or use a shared password.
2. Complete the ciphertext-only document store/relay with scoped Postgres row policies, append-only update IDs, bounded binary state, durable server acknowledgements and per-operation authorization. Public semantic draft endpoints, search, notifications, exports, logs and backups must never receive private plaintext.
3. Bind the WebSocket connection to existing trusted session/membership checks and a current authorized device, not an envelope-supplied device ID. Check membership both at receive time and before relay.
4. Implement key/wire version migrations, group rekey on removal, bounded replay history and authenticated snapshot recovery after reconnect and crash.
5. Test multiple independent clients on a real deployed topology: concurrent updates, reorders, replay, removal during in-flight work, wrong keys/epochs, server compromise, disk/backup canaries, migration rollback and cross-device restore. Record real deployment hash, physical authenticator and provider evidence where required.

## Evidence

\`tests/private-collaboration-crypto.test.mjs\` covers authenticated Yjs roundtrips, confidentiality of wire payload, nonce separation, wrong key, altered ciphertext/nonce/sequence, wrong context, oversized inputs, invalid envelope, and non-extractable-key policy. It is **unit evidence**, not an independently audited MLS implementation or production E2EE acceptance.

Source status: **partial implementation**. DCE-003/DCE-008 operational acceptance remains unverified.

The pinned OpenMLS endpoint contribution now exercises standard group messages,
complete client-pinned rosters and member-removal rotation natively and in isolated
browsers. See MLS_ENDPOINT.md for actual scope and integration gates. Production
private paths, durable encrypted state, device/pin distribution, recovery and
complete DCE-003/DCE-008 acceptance remain unverified.

The encrypted-state contribution adds version/device/scope-bound WebCrypto
checkpoints, real IndexedDB compare-and-swap continuity, durable outgoing frames
and incoming events, and serialization before exposing wire/plaintext results.
See MLS_STATE_VAULT.md for the actual browser/crash/race scope and whole-profile
rollback limitation. Production unlock/device binding, recovery/witness, relay and
private application acceptance remain unfinished; no planned unit is completed.
