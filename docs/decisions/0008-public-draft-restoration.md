# Decision: restoration is a fresh, fenced public draft transition

A saved edition must not be rewritten to undo an edit. Restore selected content
and metadata by appending a new working revision, with an immutable source
version/digest link and a typed pending public commitment in the same transaction.
Current identity, schema/provenance and document mode/lifecycle stay authoritative;
frozen/final sources remain unwritable. Schema rollback is not content restore.

Require recent primary OIDC owner/admin authentication, matching current version,
verified same-document source/digest and explicit public restoration disclosure.
This creates a named managerial operation; it does not expand ordinary editor
rights, reinterpret a decision ballot or grant legal effect. Existing tenant,
CSRF, budget and transaction fences remain in force.

An uncertain command can have committed even if a later retry is denied after a
role change. Keep the exact request and lock the copy until recovery or explicit
reopening. Read the current head after recovering the immutable receipt; never
silently treat that older receipt as the latest head. Historical CRDT snapshots
must not be reattached as the current collaborative state.

Migration 019 adds append-only provenance. Existing canonical document domains
and ordinary version events remain unchanged; a new restoration event domain
binds the source link. The strict migration guard requires a compatible runtime
on rollout/rollback. Disable the operation rather than deleting data or relaxing
the guard. No new credential, paid resource or independent-review claim follows.
