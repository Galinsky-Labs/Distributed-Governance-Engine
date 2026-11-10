# Authorized public draft collaboration

The Quill live editor binds ProseMirror to pinned Yjs/y-prosemirror libraries and an authenticated same-origin WSS hub. It is available only for explicitly public collaboration drafts. Signed-in workspace members choose Join live editing after the ordinary document session saves and reloads the current source. Viewers can observe; editor roles can send changes. Private documents, immutable editions and plaintext private fallbacks are excluded. This is a partial DCE-008 implementation, not production or E2EE acceptance.

## Authorization and wire boundary

The Node process requires TLS 1.3, an exact host/origin and the `dge-public-v1` subprotocol at `/ws/public/:workspaceUuid/:documentUuid`. Session and CSRF cookies bind the upgrade; tokens do not appear in URLs. Each incoming operation reauthenticates and checks the current public draft/version. Every receiver is reauthorized before a public update is forwarded. Revocation, stale versions, immutable source, malformed frames and unauthorized writes close or refuse access.

Binary frame kinds are 1 = initial snapshot/state response, 2 = Yjs update, 3 = state-vector query, and 4 = committed public-version acknowledgment. An acknowledgment contains one four-byte big-endian version in the existing valid version range. It is a database document version, not the browser's local semantic revision. The server sends it only after the document-store transaction commits. Duplicate Yjs updates are idempotent and may acknowledge the existing version.

WebSocket compression is disabled. Inbound frames are at most 65,536 bytes, leaving 65,535 bytes for an update. Snapshot responses are at most 3,000,000 payload bytes. The shared-draft adapter validates a candidate before accepting its legal projection. Room admission compares canonical editor-projected content, preserving text, semantic IDs, structure and formatting while allowing JSONB key order and ProseMirror empty/adjacent text normalization. Read-only admission does not rewrite source.

## Persistence and concurrent admission

Migration 013 stores bounded, tenant-scoped Yjs v13 state for the exact immutable public document version. Accepted state changes atomically advance the semantic version and store complete CRDT state with the existing version/outbox transaction. Quotas and forced row policies still apply. Failed or unauthorized transactions roll back. Newly opened rooms load and check that persisted state rather than independently reseeding the same wording.

Same-document admissions run one at a time, with authorization/version reads inside each queued turn, so simultaneous first joiners receive one history. A failed turn releases the next. Different documents initialize independently; the room budget is checked again after the asynchronous history read. Shutdown refuses pending raw sockets and completed reads cannot resurrect stopped rooms.

The in-process defaults are `maxRooms: 32`, `maxClientsPerRoom: 12`, `maxPending: 12` operations per room and `maxAdmissions: 32` pending upgrades. Each accepts an integer from 1 to 100. Upgrade overflow receives HTTP 503; message-queue overflow closes the sender. Pending capacity returns when a turn ends. These are per-process bounds, not fleet-wide quotas. Existing database connection/statement timeouts still apply; the admission queue cannot cancel an already running database operation.

## Client acknowledgment flow

The editor sends at most one unacknowledged update. It keeps a separate in-memory Yjs document containing the initial wire state, verified remote updates and locally sent updates only after their matching acknowledgment. Further local edits remain in the editor and coalesce into the next bounded delta after confirmation. Capturing the initial wire state before editor normalization also prevents skipping newly created Yjs clock entries in the first edit.

Confirmation compares Yjs snapshots including both clocks and deletion ranges. State vectors alone do not confirm delete sets: otherwise a previously saved deletion could be resent indefinitely. Remote updates received during a local save advance the confirmed copy without hiding queued local text. An unsolicited or regressing acknowledgment is refused. “Saved” is shown only when the confirmed snapshot covers current local edits; intermediate acknowledgments retain a pending-save message.

The default save-acknowledgment deadline is 15 seconds (`acknowledgementTimeoutMs`, 100–60,000 ms for the SDK). Handshake timeout remains 10 seconds by default (`timeoutMs`, the same bounds). Missing confirmation, oversized accumulated deltas, invalid input or disconnection locks further editing and preserves the current legal text for export. Late acknowledgments cannot turn a stopped session into a claimed save. `onConnectionChange(boolean)` reports actual connection readiness independently of human status wording, and the UI uses it to keep editing available while valid saves are pending.

This confirmed copy is not a durable client outbox or recovery record. A crash can still lose unsent edits. A disconnect after server commit but before acknowledgment remains uncertain to the browser; export local text before leaving and explicitly reopen the stored version. There is no automatic HTTP write, plaintext offline cache, reconnect replay or private fallback.

## Editor controls and evidence

[Table editing](TABLE_EDITING.md) preserves surviving cells during row/column operations and has a real two-user delayed-delivery text-preservation test. [Numbering settings](NUMBERING_EDITOR.md) remain disabled during live editing because a Yjs fragment does not synchronize root metadata; a transaction filter enforces fixed numbering attributes. [Section hierarchy](SECTION_HIERARCHY.md) uses previewed ordinary-draft moves and does not claim a safe concurrent subtree-move protocol. Exit live mode before these settings/structured moves.

Real TLS/native-WebSocket regressions cover authorization, persistence, replay, canonical projection, simultaneous admission, revocation while queued, capacity/retry, shutdown and concurrent room budgets. The real Chromium flow-control test delays the actual authenticated document-store save by 100 ms, types a burst and verifies complete immutable saved text with at most one update outstanding. The delay wraps the real save; it does not substitute persistence or relax server bounds. Model tests cover coalescing, delete-only confirmation, interleaved peers, historical normalization, timeout/late acknowledgment and invalid acknowledgment versions. Fixture OIDC/PGlite/local TLS evidence does not establish cloud production behavior.

No credential, dependency or database migration changes are needed for the acknowledgment flow. Full multi-instance fanout, reconnect/replay, idle-room expiry/heartbeat, adversarial load/compaction, private device/key rotation, independent review and operational acceptance remain incomplete. Do not scale multiple isolated hubs as though they share one authoritative active room.
