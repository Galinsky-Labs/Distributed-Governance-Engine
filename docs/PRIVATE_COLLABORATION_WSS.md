# Dedicated private WebSocket ciphertext relay — partial DCE-008

Update: with `PRIVATE_WORKSPACES=enabled` the runtime now attaches this hub to the main server through `routeUpgrades` (the public hub keeps `/ws/public/*`, this hub owns `/ws/private/*`), with the MLS roster/epoch authorizer installed in the ledger and an explicit `transport: 'edge-tls'` option for the declared managed-edge boundary. Statements below that it is not mounted describe the state before INTEGRATION-private.md.

\`attachPrivateCollaborationHub\` adds an optional, bounded WebSocket transport to the already-persisted private ciphertext update ledger. It **never reads, stores or transmits plaintext Yjs payloads**, document bodies, private application keys or passkey secrets. It is **not mounted by \`server/start.mjs\`** and no production private collaboration mode is enabled.

## Deployment boundary

The private hub **requires a dedicated TLS 1.3 HTTPS server** with no existing WebSocket upgrade listener. This avoids unsafe routing conflicts with the public collaboration hub, which currently owns all upgrade paths on its server. Do not simply attach both hubs to the same server. The exact configured origin and Host must match; WebSocket subprotocol is \`dge-private-v1\`, credentials must include the existing signed-in account cookie and CSRF cookie, and the handshake path supplies three UUIDs (tenant, document and claimed recipient device).

A claimed path/device ID is not proof of device authority. Every handshake, update append, historical pull and fanout read calls the private ledger, which re-checks the OIDC session, workspace permissions, independently verified authorized device and current cryptographic epoch. A viewer can receive ciphertext but cannot append; a removed member cannot receive a subsequent encrypted frame even while an old socket remains connected.

The server never constructs, sees or distributes group keys. Configure an independently reviewed device/MLS authorizer in the ledger **before** installing this hub. Synthetic test identities and authorizers must not be deployed.

## Frames and recovery

Clients send one of:
- \`{"kind":"update","frame":{...authenticated encrypted update...}}\` with 65,536-byte inbound limit. Sender device must match the authenticated socket device. Only after the transaction commits is \`{"kind":"ack","position":N,"replayed":false}\` sent. Identical duplicate retries receive \`replayed:true\` and are not broadcast again.
- \`{"kind":"pull","after":N,"limit":10}\` to request up to 10 stored current-epoch updates. Responses contain \`kind:updates\`, \`keyEpoch\`, \`nextCursor\` and an array of \`{position,frame}\` ciphertext records.

A successful upgrade sends a \`kind:ready\` message with the current epoch. The client must pull the authoritative history on connect/reconnect; an open socket does not imply a saved draft. Only authorized current-epoch history is visible. Where a client has an old epoch or no snapshot key, reviewed MLS recovery is required.

The relay does not perform CRDT decryption, merge, semantic document validation or snapshot compaction: those are strictly endpoint-side operations. A frame's server position is **not part of its WebCrypto envelope** and must be removed before calling \`openPrivateYjsUpdate\`. Group-key and sender credentials must be supplied by a reviewed MLS subsystem.

Realtime fanout is limited to clients on the same dedicated service instance. Cross-instance delivery is not promised; clients can recover stored frames using pull. Full cluster fanout, verified backup/restore, encrypted snapshots, browser editor opt-in, device revocation/rekey, end-to-end membership tests and production load evidence remain required.

## Security bounds

- WebSocket inbound payloads capped at 64 KiB, no per-message compression, max 32 rooms/12 connections per room, 16 queued messages per room, outbound backpressure capped at 1 MiB.
- No plaintext fallback. Invalid frames, forgery, revoked devices, changed epoch or lost authority cause generic connection closure.
- Server operators can still observe metadata, record ciphertext timing/volume and attempt omission or rollback. The separate audit/transparency/MLS protocols must provide authenticated completeness, sender integrity and replay recovery; symmetric AES-GCM alone does not establish authorship.
- The group-key provider is NOT implemented, so no deployment/certification claim is made.

\`tests/private-collaboration-hub.test.mjs\` exercises actual TLS 1.3 WebSocket handshakes, Yjs/WebCrypto encrypted document update transit, post-commit ACK, read-only reader fanout, replay deduplication, reconnect polling, origin/device denial, revocation before fanout, epoch invalidation and dedicated-server-only requirements.

**Status:** source implementation partial; private collaboration production acceptance unverified.
