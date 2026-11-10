# ADR 0005 — integrate released OpenMLS at endpoints

Status: accepted for a partial, disabled DCE-003/DCE-008 contribution.

The existing AES-GCM frame adapter does not provide group key agreement,
authenticated sender identity, membership rotation or protocol interoperability.
Choose RFC 9420 the pinned OpenMLS maintenance commit and RustCrypto 0.6.0 with a single standardized
classical ciphersuite. Pin registry checksums/toolchain, exclude draft and sensitive
logging features, and compile a narrow endpoint-only Wasm API from source.

Validate independently authorized identity/key pins and complete rosters; a
signed MLS Welcome or commit alone cannot authorize a substituted recipient.
Keep explicit local commit delivery/merge distinct. Stage receive/Welcome state
so rejected input does not consume authentic receive state or key packages.
Do not expose group keys through the browser bridge or introduce an operator
recovery secret. Current state is in-memory and no server/private UI is enabled.

This adds Rust/Wasm build and audit maintenance and a roughly 2 MB optional module.
It does not settle durable encrypted state, device verification/transparency,
backup/recovery, transport, crash consistency or product acceptance. See
../MLS_ENDPOINT.md for bounds, local tests, limitations and integration gates.
Rollback removes the optional module without changing stored identity, document,
ballot or audit records. No schema/data migration is introduced.
