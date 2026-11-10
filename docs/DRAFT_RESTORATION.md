# Restore public draft content as a new revision — partial DCE-019

An owner or administrator can load public version history and choose **Restore
version N as new draft** on an earlier edition. The confirmation saves the
current working copy first, then appends the selected edition's content and
metadata as a new public working revision. The earlier and intervening editions
remain available. This never reverses an immutable history record or executes
an amendment. Public-input/final sources have no restoration control and the
server refuses their modification.

The endpoint is:

`POST /api/workspaces/:tenantId/documents/:documentId/restore`

```json
{
  "commandId": "a UUID",
  "expectedVersion": 7,
  "sourceVersion": 3,
  "sourceDigest": "the selected edition's 64-character lowercase SHA-256 digest",
  "disclosure": "restore-public-revision-v1"
}
```

It requires current owner/admin membership, a primary OIDC session authenticated
within five minutes, exact-Origin/session-bound CSRF, bounded strict JSON, and
an older edition of the same document/workspace. The server verifies both stored
content digests and the selected source digest, locks the current head and
checks `expectedVersion`. Competing edits/restores cannot overwrite each other;
only one transition from the expected head can commit. Request identity,
selected source/digest and expected head bind the replay-safe command. Another
actor or payload cannot reuse it.

Only content and document metadata are copied. Current document identity,
workspace, mode, lifecycle, schema and provenance remain current; the semantic
revision and storage version advance. Crossing schema versions is refused until
an explicit supported migration is performed. A restored working draft gains
no signature, adoption authority, challenge finality or public anchor. Existing
proposal decisions remain bound to their original base version; restoration
does not rebase them or grant an old ballot new authority.

Migration **019-public-draft-restorations.sql** adds a tenant-fenced append-only
provenance row linking the new revision to its exact selected source. Historical
version rows, new source pointer/digest, byte accounting, restoration provenance
and pending commitment outbox are one transaction. Failure rolls back all of
them. The runtime cannot update/delete/truncate provenance. Public history adds
`restoration:{sourceVersion,sourceDigest}` only on restored versions, without
internal author IDs. Actor/command audit data remain in the ordinary scoped
version ledger. The public commitment is still pending, not an external receipt.

Restoration events use the new domain `public-document-restoration-v1`, binding
the ordinary version event fields plus that restoration object. Ordinary writes
retain `public-document-version-v1`; legal document canonical digest formats do
not change. No historical CRDT state is attached to the new head: old Yjs
checkpoints remain in history, while a fresh authorized live room starts from
the restored current content. Existing rooms recheck version authority.

The editor locks while saving/restoring. A lost response retains the exact
command for retry, including after an authorization denial that cannot establish
whether the original uncertain request committed. A known committed response
followed by a failed head reload retries the read. Success reopens the freshly
read current head, so a later concurrent edit survives recovery of an older
restoration receipt. Uncertain copies remain downloadable; leaving warns that
it cannot cancel a restoration that may already have committed.

Use the existing privileged migrator, least-privileged runtime role, provider
binding and TLS/session configuration. No new dependency, secret, provider or
paid service is required. Deploy migration and compatible runtime together.
Rollback disables the writer/UI while preserving migration 019 and its readers;
the strict startup guard intentionally refuses an older binary expecting only
18 migrations. Do not delete provenance, undo applied migrations or rewrite
historical document digests to roll back.

Local evidence includes real PostgreSQL multi-connection duplicate/competing
writes, storage-failure rollback, immutable/tenant-fenced provenance, stale
provider authentication, CSRF and source/schema boundaries. The browser holds
a real pending save acknowledgment, drops a real committed restoration response,
changes roles, records another owner's later edit, then recovers without losing
that edit. It also joins real WebSocket editing and reopens a fixed source with
no restore control. Hosted operations, branches, richer attribution/redlines,
private history verification and full DCE-019 acceptance remain outstanding.
