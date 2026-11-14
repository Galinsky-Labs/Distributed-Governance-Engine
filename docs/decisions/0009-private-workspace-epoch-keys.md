# ADR 0009 — private document content keys from the MLS exporter

Status: accepted for the private workspace path (PRIVATE_WORKSPACES=enabled);
not independently reviewed.

## Context

Private documents must be stored and relayed as ciphertext, readable after a
reload and by members who join later, and unreadable by removed devices for
new content. MLS application messages alone do not fit stored documents: with
`max_past_epochs=0` and consumed receive ratchets, a stored application
message cannot be decrypted again after reload or by a later member. The
repository already had authenticated AES-256-GCM envelopes for snapshots
(`src/private-crypto.mjs`) and Yjs frames (`src/private-collaboration-crypto.mjs`)
that explicitly required an externally distributed, non-extractable epoch key.

## Decision

- Derive per-document, per-epoch content keys with the RFC 9420 section 8.5
  MLS-Exporter of the pinned OpenMLS revision (`MlsGroup::export_secret`),
  labels `dge-private-snapshot-v1` / `dge-private-update-v1`, context bound to
  tenant and document. The native adapter restricts labels to the
  `dge-private-` namespace and exports only from an active group's current epoch.
- The browser binding imports the 32-byte exporter output straight into
  WebCrypto as a non-extractable AES-GCM key and zeroizes the transient copies;
  JavaScript never receives raw key bytes.
- Every membership change (one add or removal per commit) is followed by a full
  snapshot re-encryption under the new epoch. The service refuses appends and
  same-epoch snapshot writes while the document lags the group epoch, so no
  content is written under a key a removed device still holds after the commit
  is accepted.
- Endpoints cache the non-extractable per-epoch keys locally so older epochs
  they belonged to remain readable after reload.

## Consequences

No new cipher or protocol: MLS (OpenMLS) provides group key agreement and
membership authentication; existing AES-GCM envelopes provide content
encryption. Frames are authenticated to the group, not to an individual sender.
Removed members keep keys and plaintext for epochs they belonged to. New members
cannot read frame history from before their epoch, only the re-encrypted state.
