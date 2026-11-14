# Moderation, abuse controls and transparent appeals

Unit: DCE-017. Schema: `dge_moderation.reports`, `visibility`, `actions`, `appeals`, `events` in `migrations/022-moderation-and-clause-permissions.sql`. Code: `server/moderation-store.mjs`, `server/moderation-http.mjs`, `web/moderation-panel.jsx`.

## Principles

- Moderation changes **visibility** only. Nothing is deleted. Ballots, decision snapshots and certificates, point scores and point votes are never touched.
- A hidden proposal or point stays in public listings with its digest and position, its wording replaced by the placeholder `Removed by moderator` and a `moderation: {state:"removed", placeholder, reasonCategory}` field. Public readers therefore see that something was removed and why (by category).
- Every action is an append-only record, an audit event and a transparency-log entry (`appendLedgerEvent`, kind `moderation-action`, digest over document, target, action, category and time; never the moderator). A public log is available per document without moderator identity.
- Disagreement alone is not abuse; reports never act on their own.

## Reports and rate budgets

Any workspace member (viewers included) may report a proposal or point once, with a category (`spam|harassment|off-topic|private-information|illegal-content|impersonation|other`) and an optional private note (≤1000 characters, shown only to moderators as inert text). Each account has an hourly and a daily budget (defaults 10 and 50, `REPORT_RATE_LIMITED`), checked under a per-reporter advisory lock. Commands are idempotent by `commandId`.

## Moderator queue and actions

Owners and admins see targets with open report counts by category, private notes, the current visibility version and last action, plus pending appeals. Reporter identities are never listed. Actions (`hide` with a report category, `restore` with `review-reversed`) need recent authentication and `expectedVersion` of the target's visibility state.

### Coordinated-flagging signal

For each target the queue reports how many reports inside the window ending at the latest report (default 60 minutes) came from accounts that joined the workspace within the preceding period (default 7 days; join time from the identity `joined`/`tenant-created` event). It is flagged when at least `coordinatedThreshold` (default 3) such reports exist and they are at least half of the window. The flag is shown to moderators with `automaticAction: false`; it never hides anything.

## Appeals

The author of hidden content sees a removal notice (`GET …/moderation/mine`) and may appeal the latest hide action once (≤2000 characters). An owner or admin resolves it. The appellant can never decide their own appeal, and the moderator who hid the content cannot decide it while another active owner or admin exists. Granting restores the content through a `restore` action with category `appeal-granted`; denying keeps it hidden. Appeals transition exactly once (trigger-enforced).

## API

- `POST /api/workspaces/{t}/reports` — `{targetKind, targetId, reasonCategory, note?, commandId}`
- `GET /api/workspaces/{t}/moderation` — queue (owner/admin)
- `POST /api/workspaces/{t}/moderation/actions` — `{targetKind, targetId, action, reasonCategory, expectedVersion, commandId}`
- `GET /api/workspaces/{t}/moderation/mine` — removal notices for the caller's content
- `POST /api/workspaces/{t}/moderation/appeals` — `{actionId, statement, commandId}`
- `POST /api/workspaces/{t}/moderation/appeals/{appealId}/resolve` — `{decision: grant|deny, note?, commandId}`
- `GET /api/public/documents/{d}/moderation` — public moderation log

## Limits

- Only proposals and discussion points are moderatable; document text, evidence links and accounts are not.
- Hiding is not redaction of history: earlier public digests, the transparency log and anyone's prior copies still exist, so this is not an erasure claim. Leaked private material that must be purged needs an operator procedure outside this API.
- The coordinated-flagging heuristic is simple and gameable (aged accounts evade it); it is a prompt for human review, not detection.
- There is no duplicate-proposal detection or notification delivery here; removal notices are pull-based.
