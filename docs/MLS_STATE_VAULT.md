# Encrypted MLS endpoint state — partial DCE-003

MLS sender and receive ratchets must survive a browser crash without reusing
old send state or losing an already-consumed incoming message. The optional
`web/mls-state-vault.mjs` coordinator stores a sealed protocol checkpoint and
durable inbox/outbox before releasing wire data or received plaintext.
This is endpoint persistence infrastructure; the private product UI and backend
routes remain disabled pending device authorization, workspace/epoch and relay
integration, recovery and deployment acceptance.

## Keys, scope and representation

The caller supplies a separately unlocked, nonextractable AES-256-GCM CryptoKey.
The module does not generate an operator recovery key, store an unwrapped key,
request an account token or send network traffic. Account login/recovery is not
content-key authorization. Production device verification/unlock is a separate
required boundary. Test-only IndexedDB key cloning is not hardware/device or
production recovery evidence.

The Wasm API seals/restores the endpoint internally through native browser
WebCrypto; it never exposes unwrapped protocol keys or a raw snapshot method.
The authenticated context contains a distinct versioned checkpoint purpose,
exact tenant/account/device UUIDs, expected device identity/signature-key pin
and positive generation. A fresh 96-bit nonce is drawn from the provider's
cryptographic entropy for each seal. The private representation binds the exact
upstream revision and state format. Unsupported formats fail closed rather than
silently migrating live cryptographic state.

Restoration validates the original public identity/key, private/public signing-key
consistency with a real signature check, unique group scopes/handles, group
ownership, pending commits, package/handle bounds and application mailbox schema.
Only a fully validated new endpoint is returned. Invalid decryption/scope/state
cannot partially replace a running endpoint. Temporary serialized/decrypted
buffers are zeroized where controllable; physical memory erasure, hardware
confinement and protection from live client compromise are not claimed.

## Atomic delivery and continuity

`openMlsStateStore` opens two IndexedDB stores: trusted local continuity metadata
and sealed checkpoint records. One read/write transaction compares the stored
generation and device pin before atomically replacing both records. There is no
local reset/delete or automatic missing-state fallback. A missing half-record,
changed device pin, stale generation, failed transaction or closed database fails.
A second tab with the same starting checkpoint may compute a candidate, but only
one compare-and-swap can commit and release it. The loser locks and discards its
private in-memory endpoint.

`initializeMlsState` takes ownership of the raw Wasm endpoint and invalidates the
old object synchronously after capturing its checkpoint. `reopenMlsState` requires
the expected identity/key and separately unlocked wrapping key. Every mutation
is serialized within an instance. The coordinator commits advanced state before
returning a key package, membership message, application ciphertext or plaintext
event. A persistence failure locks the instance before exposing the result;
reopen reads only the latest committed state.

Outgoing key packages and encrypted application/membership frames are in a durable
outbox, with stable IDs, before the caller receives them. `outgoing()` recovers a
frame whose original return/delivery was interrupted. `acknowledgeSent(id)` removes
it only after the caller has confirmed durable transport acceptance. It is not
independent proof of recipient delivery. `mergePending(group)` refuses local
membership merge while that group's commit remains in the outbox. Group inventory
exposes handles and pending state so interrupted create/join/commit operations can
be resumed without inventing a new group.

The incoming plaintext event and advanced receive ratchet are sealed together in
a durable inbox. `pending()` returns stable event IDs after reopening. The caller
must apply events idempotently and durably before `acknowledge(id)`. This supplies
at-least-once application delivery; it is not a claim of exactly-once UI, CRDT or
remote storage processing. The protocol still rejects a replayed wire message.

The generation cannot wrap. Exhaustion fails, requiring an explicit future
migration/new-device policy. Limits: 3 MB core state, 24 MB sealed checkpoint,
2 MB total inbox/outbox wire/plaintext, 1,000 mailbox items, 32 groups and 128
key packages per endpoint. Capacity failure locks instead of emitting a frame
whose advanced state could not be saved.

## Threat limits and operational use

A substituted old ciphertext record is rejected against the retained local
continuity marker, including by the generation-bound AEAD when its metadata is
relabelled. This does not detect malicious rollback of the entire local browser
profile, marker and key together. Restoring an old profile/backup as a live sender
can reuse old MLS send state and is prohibited without a separate authenticated
continuity witness or fresh verified rejoin procedure. No server-backup import or
lost-marker override is provided. A service cannot be treated as that independent
witness merely because it stores the ciphertext.

The browser origin/client software, local continuity store, wrapping-key unlock
and approved device pins remain trusted prerequisites. A malicious authorized
client or software update can access endpoint plaintext; metadata/traffic secrecy,
full forward secrecy/PCS, private-key hardware protection and entire-profile
rollback resistance do not follow from this module. No unwrapped client key may
be placed in server environment settings or metadata KMS.

The existing native protocol, browser and dedicated MLS CI checks also cover the
new checkpoint path. Browser tests use actual WebCrypto, nonextractable CryptoKey
structured cloning, context loss and native IndexedDB transactions; source-bound
evidence records the tested scope. This does not replace device/hardware,
independent implementation, backup/recovery, compromised-service or hosted
acceptance. Human/cryptographic review remains pending under the owner's deferred
review policy. No server schema migration, hosting resource or paid service is
created. An upgrade must preserve old ciphertext and refuse unsupported state;
rolling an old snapshot back into a live sender is not a rollback strategy.
