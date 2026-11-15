# Structured discussion and point voting — partial DCE-015 / DCE-016

The suggestion panel now separates supporting points, opposing points and clarifications. Each point is a concise thesis with optional HTTPS evidence links. Replies explicitly support, challenge or clarify a parent, rather than becoming a chronological comment board. Readers can choose highest net scores or newest points and inspect ranked replies. Net score means upvotes minus downvotes. Point votes never approve document changes, alter decision-vote weight or establish factual truth.

## Content, graph and disclosure

A point binds document/workspace/proposal IDs, its own stable ID, stance, optional parent/relation, exact text and normalized evidence links. Text is capped at 1,000 UTF-16 units; up to five credential-free HTTPS links have bounded labels/URLs. Links are displayed as text with hostnames, opened with no opener/referrer, and never fetched by the server or auto-previewed. A point/reply needs explicit public disclosure. The current implementation keeps published points immutable, so wording cannot be swapped underneath existing votes. Editable point revisions, duplicate merging and moderation/retraction history remain later work.

Parents must already exist in the same proposal. New points cannot reference themselves, depth is bounded to eight edges, and the API cannot modify parent links. Public responses omit internal author IDs. A current contributor can inspect their own point IDs and votes through a separate authorized endpoint. The current identity boundary is an account, not proof of one unique human. Profiles, reputation and organized-abuse detection remain unfinished.

## Votes, concurrency and privacy

Current workspace owners/admins/editors/participants may publish and vote; viewers and anonymous readers may read. One account has one current up/down/withdraw value per immutable point. Self-voting fails. Each change names its expected prior vote version and a payload-bound command ID. Simultaneous differing changes cannot silently overwrite each other; identical retries count once. A lost browser response retains its command for retry before another vote. Creation, counters, audit, byte accounting and pending public commitments commit atomically.

Vote history and individual voter IDs/choices are visible to the scoped identity/governance service and database, not the public API. Public clients see only totals. These are argument ratings, not secret decision ballots. Pending public log entries contain point commitments or aggregate score changes, without person-attributed votes. Small-group counts and timing can still reveal information; no anonymity or compromised-service protection is claimed. Full receipts, private encryption, anti-ring controls and independent verification remain pending.

Removal/demotion denies later contribution transactions; previously cast argument ratings remain historical rather than being silently erased. The last-owner/session controls are unchanged. Default safety bounds are 1,000 points/proposal, 100/author, 100,000 active point ratings, and 100 changes/account/point. One final withdrawal is permitted after that change cap. Logical payload accounting shares the existing 30 MB workspace budget; this is not billing or a physical storage measurement. Unified admin policies and entitlement integration remain planned.

## Ranking and endpoints

Top pages sort by net score and stable ID; newest pages sort by creation time and stable ID. An opaque cursor binds the filters and ordering generation. If relevant content/ranking changes, the server rejects the stale cursor and asks for refresh. Newest pagination continues across score-only changes, so minority/new-point discovery is usable during active voting. Reads obtain the generation and rows from one database snapshot. Lists are bounded to 100 entries and support stance/parent filters.

| Route | Behavior |
| --- | --- |
| POST /api/workspaces/:workspace/documents/:document/proposals/:proposal/points | Contributor; text, stance, optional typed parent/evidence, commandId, disclosure |
| PUT .../point-votes/:point | Contributor; value -1/0/1, expectedVoteVersion, commandId |
| GET .../my-point-votes?points=IDs | Current member; at most 100 requested point IDs, own vote versions/point IDs and contribution capability |
| GET /api/public/documents/:document/proposals/:proposal/points | Public bounded ranking/reply pages |

All writes retain the common session, exact-Origin and session-bound header checks. Point bodies are at most 32 KiB; votes remain 8 KiB. JSON containing null characters fails as a client error because PostgreSQL JSON cannot store those strings; literal escaped text remains valid. No caller can assert author identity, role, score or vote weight.

Migration 006 adds scoped immutable points, public score/order projections, private current votes and append-only vote events/outbox. Runtime cannot edit/delete points or histories. Ordinary public context cannot read individual vote rows or events. Startup checks the new schema/history and rejects owning/elevated service credentials. Apply with the separate migration credential; rollback disables routes while preserving records and prior migration files.

## Evidence and remaining scope

Focused tests cover typed graph bounds, same-proposal parents, evidence validation, author privacy, self-votes, up/down/withdraw conservation, replay, stale vote versions, live pagination, removal/roles, budget rollback and request protections. Real Chrome covers two OIDC users, support/opposition, a typed counterclaim, all rating changes, self-vote controls, anonymous read-only discovery and unchanged public-input text. Desktop/mobile layouts are inspected. A delayed-read browser regression also verifies that background document/suggestion loading cannot disable active draft fields or drop typed characters; background loading and publication now have separate UI state. Networked PostgreSQL CI races duplicate and conflicting votes on separate connections and verifies counters against stored votes.

These are partial DCE-015/016 contributions. Open-public contribution policy, editable point history, duplicate merging, reputation, moderation/appeals, abuse/personhood controls, decision ballots/adoption, private content and production acceptance remain incomplete. All chain work is pending; no blockchain receipt, full unit acceptance or independent security review is implied.

## Confidence ranking and anti-ring bound (DCE-016 increment)

- `sort=confidence` orders points by the lower bound of the 95% Wilson score
  interval for the share of up ratings (stable tie-break: point ID). Each item
  carries `confidence` (0–1) alongside its `up`/`down`/`net` counts, and every
  list response includes a `ranking` sentence that states the sort and that
  ratings never change any decision ballot or weight.
- One account may hold at most 20 active ratings (`maxVotesPerAuthor`) on a
  single author's points within one proposal (`429 AUTHOR_RATING_LIMIT_REACHED`).
  Changing or withdrawing an existing rating is never blocked.
- Not done: reputation events and rollback, organized-ring detection beyond
  the per-author bound, editable point revisions and duplicate merging.

## Point revisions and duplicate merges (DCE-015 increment)

- **Revisions:** a point's author revises it by posting a new point with `revises: <pointId>`. The new point must keep the same stance, parent and relation. Each point can be revised once, so history is linear.
- **Duplicate merges:** an owner or admin merges a duplicate into another point of the same stance with `POST …/point-merges/{pointId} {duplicateOf, commandId}`. Merges are idempotent and never point at an already-superseded point.
- **Listings and history:** superseded points drop out of rankings. Public history is available at `GET /api/public/documents/{doc}/proposals/{proposal}/points/{point}/history`, and it keeps every version's wording and counts.
- **Ratings:** ratings stay with the wording they were cast on and never transfer. A superseded point accepts no new ratings, but withdrawing an existing rating still works.
- **Storage:** migration 032 adds the append-only `point_links` table.
- **Not done:** document-quote evidence integrity.
