# ADR 0006 — commit cryptographic state and delivery queues together

Status: partial endpoint persistence contribution; private product paths disabled.

A raw MLS state dump is insufficient for durable messaging. Sending before saving
advanced ratchets can reuse encryption state after a crash; saving receive state
before preserving plaintext can permanently consume an undelivered message.
A membership commit can also become unrecoverable if its return is interrupted.

Seal protocol state, sender outbox and receiver inbox with a caller-owned,
nonextractable WebCrypto key at the endpoint. Bind scope, device identity/key and
generation in AEAD. Compare-and-swap an independent local continuity marker and
ciphertext in one IndexedDB transaction before exposing the operation's result.
Serialize operations, fence concurrent writers, and discard the endpoint after
uncertain persistence. Keep explicit durable transport/application acknowledgments
and recover pending frames/events by stable IDs. No server application key or
account-only recovery shortcut is introduced.

The raw object is transferred/invalidated on initialization; the durable facade
is the intended sending interface. The caller must retain a genuinely verified
unlock key/device pin and use the real transactional store. Complete local-profile
rollback, copied endpoint state and malicious client/software remain outside this
local continuity proof; old backup ratchets cannot be blindly restored as senders.
External continuity/rejoin, device enrollment/recovery and actual relay integration
remain required before private product enablement. See ../MLS_STATE_VAULT.md.

No server migration is introduced. Future state upgrades require an explicit,
validated migration or verified rejoin, preserving the source/ciphertext audit
boundary and avoiding a destructive or stale-sender rollback.
