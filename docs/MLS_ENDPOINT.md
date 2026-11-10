# Endpoint MLS integration — partial DCE-003/DCE-008

`crypto/mls-endpoint` wraps OpenMLS at maintained upstream commit 28369d5b48608bef4ddf8371d91503b0f3852bb3 and its RustCrypto 0.6.0
provider. It implements RFC 9420 messages at authorized endpoints, with the fixed
MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 ciphersuite, versioned upstream TLS
serialization and system/browser cryptographic entropy. It introduces no custom
key agreement, cipher, signature or cryptographic wire format. Upstream source:
[28369d5b](https://github.com/openmls/openmls/commit/28369d5b48608bef4ddf8371d91503b0f3852bb3).
The older published 0.9.x provider graph failed the current dependency scan. The
maintained upstream migration uses patched RustCrypto/HPKE dependencies; it is
explicitly a pinned post-release source build, not a claim of a new stable release.

The engine supplies a narrow native Rust adapter and WebAssembly bindings compiled
from the immutable upstream commit and registry crates with checked-in Cargo.lock checksums. It does not
use the similarly named third-party npm package or copy the upstream experimental
Wasm example. Builds pin Rust 1.94.0 and wasm-bindgen/CLI 0.2.130; feature inspection
refuses unapproved protocol drafts, test helpers or sensitive logging modes.

## Authority and protocol state

An endpoint owns its signature key, key-package secrets, group state and message
ratchets in memory. Private keys and protocol state stay inside the native/Wasm
object; decrypted application bytes return to the authorized endpoint caller. Wire
outputs contain public signature keys/key packages and MLS ciphertexts. The application must supply independently
verified device identity/signature-key pins; a name, email address or routing
server's assertion is insufficient. Pins passed to the browser API are explicit
byte arrays in exact-field JSON, bounded to 1,000 members. This adapter is not a
new device directory, attestation mechanism or account-to-device binding.

Creation binds an exact opaque group ID. Admission validates the complete signed
key package against the expected identity and Ed25519 key, rejecting duplicate
identity/key admission. Welcome processing verifies the expected group ID, fixed
ciphersuite and full authorized roster before accepting the group. Received
application messages carry the protocol-authenticated sender credential; the
complete current roster must still match the client's approved pins.

Membership commits are accepted only when the resulting ratchet tree exactly
matches an explicitly supplied approved roster. A valid cryptographic signature
alone does not authorize an unexpected member or substituted key. An endpoint
that is itself removed may process its authenticated eviction without learning
the remaining private group state; it becomes inactive and cannot encrypt or
process later content. Explicitly requested local additions/removals produce a
pending commit. The client must deliver it before calling `mergePending`.
Failed delivery must not silently advance the local epoch.

Receive and Welcome processing stage private storage changes and publish them
only after protocol/scope/roster validation succeeds. A rejected ciphertext or
unapproved roster cannot consume the authentic frame's receive state or Welcome
key package. Snapshots remain in endpoint memory; superseded/discarded storage
buffers are zeroized. The endpoint is deliberately not Sync; concurrent
transactions cannot overwrite another group's memory snapshot. Browser operations
are synchronous and group handles belong to one endpoint instance.

Past epochs are not retained for decryption (`max_past_epochs=0`). Removal rotates
future access through the MLS commit; it cannot erase plaintext, keys or archives
already retained by a recipient. Ciphertext is padded to 256-byte boundaries;
traffic timing, routing, membership and approximate lengths are not concealed.
The bounds are 1 MB plaintext, 2 MB wire messages, 64 KiB key packages and 512-byte
opaque identities/group IDs. The browser additionally permits at most 32 live
groups and 128 generated key packages per endpoint instance.

## Build and checks

Install Rust 1.94.0 with wasm32-unknown-unknown, rustfmt and Clippy, and install
`wasm-bindgen-cli --version 0.2.130 --locked`. Run:

    npm run build:mls
    npm run test:mls

The second command requires DGE_BROWSER_EXECUTABLE. CI verifies SHA-256-pinned official Linux CLI archives before execution and pins Chrome Headless Shell
155.0.8059.84, runs formatting, Clippy, Cargo Audit 0.22.2 against current RustSec
data, locked builds, native protocol tests and three isolated browser contexts.
Native tests cover authenticated roundtrips, replay/tamper/cross-group rejection,
substituted credentials, unapproved rosters, atomic rejected-frame/Welcome handling,
member-removal epoch rotation and a deterministic 2,048-input malformed-wire corpus.
The browser journey tests the actual compiled upstream crypto, secure browser
entropy and three independent endpoint states. Its test TLS-certificate exception
is confined to the loopback fixture. This is not cross-implementation RFC-vector
or physical-device acceptance.

## Integration and remaining acceptance

The artifact is a protocol integration contribution. Production private routes and
private editor UI remain disabled. The runtime does not import this crate, hold
its keys or accept plaintext from it. The standalone CI artifact/source inventory
must not be presented as a deployed private-workspace product.

Still required: authenticated device/pin distribution and verification UI; MLS
membership commits bound to authoritative membership history; durable encrypted
client-state storage with crash-safe anti-rollback/commit acknowledgments; recovery,
backup and endpoint rejoin policy; ciphertext-only attachments/snapshots/Yjs relay
integration; cross-instance fanout; independent implementation interop, load,
service-compromise and deployed recovery drills. No key export, plaintext key
backup, server recovery root or automatic lost-device override is supplied.

Secrets are ephemeral in the current adapter. Reload/free loses access and does
not prove physical memory erasure or secure hardware confinement. Live endpoint,
software-update or approved-roster compromise is outside the local test result.
No general forward-secrecy, post-compromise-healing, backup, metadata-confidentiality,
compromised-service authorization or E2EESA conformance claim follows from MLS alone.
Independent cryptographic/human review remains pending under the owner's deferred
review policy. There is no migration, hosted service or paid resource creation.

The current dependency scan records RustSec RUSTSEC-2026-0173 for the
unmaintained build macro proc-macro-error2. This is retained as a maintenance
finding, with no scanner exclusion; current Cargo Audit reports zero security
vulnerabilities after the upstream crypto migration. It is not production
assurance or an independent risk acceptance. The previous crypto-bigint and
libcrux-kem advisory graph was rejected before source merge.
