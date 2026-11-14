# Frozen electorates, weighted decisions, challenges and finality

Units: DCE-011 (frozen electorates and eligibility evidence), DCE-012 (durable ballots, exact weighted tallies), DCE-013 (closure, challenges, certificates) and DCE-014 (atomic adoption and conflicts). Schema: `migrations/021-electorates-and-challenges.sql` (`dge_electorates` plus additive changes to `dge_decisions.decisions`).

## Rosters

A roster belongs to one workspace and has a kind:

| Kind | Entries come from | Units |
| --- | --- | --- |
| `membership-derived` | `syncMembership`: one `default`-class entry per active owner/admin/editor/participant; departed or demoted members get a zero-unit version | 1 |
| `unit-register` | Managers record entries (share, unit or seat registers) | any canonical decimal integer, `numeric(78,0)` |
| `verified-person-cohort` | Managers record entries with a person-uniqueness key | exactly 1 (or 0 to end eligibility) |

Entries are append-only versions keyed by (principal account, class). Each version stores voting units, class (`^[a-z0-9][a-z0-9-]{0,39}$`, default `default`), `validFrom`/`validTo`, an optional opaque evidence reference (`^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$`), the recorder and the recording time. Optimistic concurrency uses `expectedVersion`. A principal must be an active member of the workspace when an entry is recorded.

### Person-uniqueness keys

The raw key (for example an identifier issued by a verification provider) is accepted once in the request body and immediately reduced to `HMAC-SHA256(personKeySecret, "dge-person-key-v1" ‖ tenantId ‖ rosterSalt ‖ key)`. Only that digest is stored. The raw key never enters the idempotency digest, an event, a log or a response. Each roster has its own random salt, so the same person cannot be linked across rosters by digest. Without a configured `personKeySecret` (32 bytes or more) cohort writes fail with `PERSON_KEY_UNAVAILABLE`.

## Record-date snapshots

`createSnapshot(recordDate)` (and every roster-based decision) freezes the roster as of an explicit record date `R`, which must be in the past:

1. For every (principal, class), take the latest version **recorded at or before `R`**. Anything recorded later is ignored, so a snapshot is a pure function of append-only rows and can be recomputed forever.
2. Exclude, with counted reasons: `zero-units`, `not-yet-eligible` (`validFrom > R`), `eligibility-expired` (`validTo <= R`), `missing-person-key` (cohorts).
3. In a verified-person cohort, principals sharing a person-key digest are duplicates. The principal whose first included entry was recorded earliest is kept (ties: lowest account ID); every entry of the others is excluded as `duplicate-person-key`.
4. Store members (principal → class → units) with a summary: `entriesConsidered`, `entriesIncluded`, `exclusions`, `principals`, `classTotals`, `totalUnits`. `entriesIncluded + Σ exclusions = entriesConsidered` and `Σ classTotals = totalUnits` hold exactly.

Snapshots are unique per (roster, record date); concurrent creators converge on one row and digest (`ON CONFLICT DO NOTHING`, deterministic computation). Writers take an exclusive per-roster advisory lock before reading the clock and snapshot readers take the shared lock, so an entry is either visible to a snapshot or recorded after it. Snapshot summaries returned by the API carry counts, class totals and the digest only: no principal IDs, key digests or evidence references.

## Decisions (schemaVersion 2)

`POST …/proposals/{proposalId}/decision` keeps its version 1 behaviour (frozen workspace members, one vote each, `policySettings` as before) unless any of these fields is present, in which case a schemaVersion 2 decision is opened:

| Field | Meaning |
| --- | --- |
| `electorate` | `{source:"membership"}` (default) or `{source:"roster",rosterId,recordDate}` |
| `weighting` | `equal` (default) or `units` (roster only) |
| `policySettings.classRequirements` | up to 16 `{class,quorum:{numerator,denominator},approval:{basis,comparison,numerator,denominator}}` (roster only) |
| `policySettings.quorum.kind` | `count`, `fraction-count`, and for unit weighting `weight`, `fraction-weight` |
| `challengeWindowHours` | 0–720; 0 means closing is immediately final |
| `bundle` | ordered proposal IDs (first = route proposal, at most 20) on the same base edition |

The snapshot (`src/weighted-governance.mjs`, `createWeightedSnapshot`) binds proposals and digests, the policy, the frozen electorate (members with class units plus exclusion counts) and is digest-bound. If the document has clause permissions (see `CLAUSE_PERMISSIONS.md`), only principals holding `vote` on every targeted section remain, and the rest are counted as `no-section-vote-right`. Later roster, membership or grant changes never alter an opened decision; a changed electorate needs a new decision.

### Exact evaluation

`evaluateWeightedDecision` uses BigInt only. Under `equal` weighting each member is one head overall and one head in each class it holds; under `units` the weight is the sum of its class units. Each output names its denominator (`eligible-heads`, `eligible-weight`, `yes+no-weight`, `yes+no+abstain-weight`, `class-…`). The decision passes only if overall quorum, overall approval (with `minYes`) **and every class requirement** pass; the overall majority can never substitute for a class approval. A class with no eligible weight cannot be required (`UNATTAINABLE_VOTE_POLICY`). A deterministic 3000-case property campaign compares the evaluator with an independent naive reference.

### Ballots and proxies

Ballots carry only a choice; weight always comes from the snapshot, and the evaluator rejects any ballot that carries `weight`. Retries with the same `commandId` return the stored acknowledgment, which is produced only after commit; a different payload under the same command is `COMMAND_REUSED`. The decision row lock orders ballot replacement against closure.

A principal grants a proxy (`POST /api/workspaces/{tenantId}/proxies`) to another voting member for a roster or a single decision, optionally with a split allocation (`{class: units}`) and an expiry. Rules enforced in the store:

- No self-grants; a reciprocal active grant is rejected as a cycle. Proxy power is not transitive: a proxy ballot needs a grant whose grantee is the caller, so it can never be re-delegated.
- At grant time, active grants overlapping the same roster or decision (including the roster a decision was frozen from) must fit the grantor's holding. At ballot time every live grant of that principal reaching the decision must fit the **frozen** holding (`PROXY_OVER_ALLOCATION`). Equal-person decisions accept only whole-holding grants.
- A direct ballot by the principal supersedes all its proxies' ballots, regardless of order. Proxy ballots record both proxy and principal. A grant revoked before closure stops its ballot counting; expiry is checked at cast time.

### Closure, challenges and finality

`close` evaluates once under the decision lock. Two concurrent closers return the same certificate.

- **No window:** the decision becomes `final` immediately and passed collaboration wording is applied exactly as in version 1.
- **Window:** the decision becomes `provisional` with `challengeClosesAt`. Any member of the frozen electorate may file a challenge (category `eligibility|ballot-irregularity|procedure|conflict-of-interest|other`, 1–2000 characters) before the window ends; the decision becomes `held`. Owners/admins other than the challenger resolve: **dismiss** returns it to `provisional` (or finalizes immediately if the window has passed and nothing is pending); **uphold** makes it `void` and marks other pending challenges `moot`. `finalize` succeeds only for a provisional decision after the window.
- `final` and `void` are terminal: a trigger forbids changing finality, reopening, or altering snapshot bindings, and forbids the request role from rewriting a final or void certificate. A void decision frees its proposals for a **new** decision with a new snapshot (partial unique index), it never resumes.

Amendment text is applied only inside finalization (`finalizeWeighted`) for a final passed collaboration decision, once: finality is immutable afterwards and the new document version reuses the decision ID as its unique command ID. A stale base (another proposal adopted first) is recorded as `stale-source`; a bundle whose members overlap or fail their exact-base check is recorded as `conflicted` and nothing from it applies. A passing bundle produces exactly one new revision.

### Certificates and the transparency log

Each certificate (provisional, final, void) is stored in `dge_electorates.certificates` and appended to the transparency outbox with `appendLedgerEvent`: `decision-provisional` (finalization=false), `decision-certificate` and `decision-void` (finalization=true). Challenge resolutions log `decision-challenge-resolution`. A schemaVersion 2 certificate binds the snapshot, policy and electorate digests, electorate summary (counts and exclusions only), salted ballots digest (salt kept in a private closure event), full evaluation including class results and proxy counts, challenge summary (count, categories, outcome), finality, application result and the previous certificate digest. The public receipt for such a decision has `schemaVersion: 2`; verify it with `verifyWeightedDecisionReceipt` (the version 1 verifier only understands version 1).

## Limits and honest caveats

- Person-uniqueness is only as strong as the evidence source behind each key. A Sybil who obtains two distinct verified identifiers gets two votes; a stolen identifier can block the legitimate person (the earliest-recorded holder wins). This is not legal proof of identity.
- Record-date snapshots reflect what was recorded by that date. Backdated corrections recorded after the record date do not change it; that is deliberate.
- Proxy expiry is checked when a proxy ballot is cast, not again at closure. Revocation is checked at closure.
- Proxy grants are made by the authenticated principal only; custodial or beneficial-owner chains and imported proxy sources are not implemented.
- Challenges are filed by members of the frozen electorate only; public (non-member) challenges are not supported. A dismissed challenge does not reset the window.
- Casting a ballot (direct or as a proxy) still requires a current owner, admin, editor or participant role, as in version 1. A roster principal demoted to viewer, or removed from the workspace, cannot vote even though the snapshot still lists them; their weight then simply does not participate.
- Open-admission (non-frozen) electorates remain future work.
- Software records a configured entitlement; it does not create shareholder rights, enact law or execute a resolution.
