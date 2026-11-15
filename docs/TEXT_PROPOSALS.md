# Exact text proposals — partial DCE-009

Saved public documents now support highlighting a range within one body paragraph, publishing replacement wording and a concise rationale, and reviewing suggestions in a slide-out panel. Suggestions are stored independently and do not edit the source. Public-input sources remain fixed at every layer. Existing account/workspace roles authorize creation; open-public participation, structured points/ranking are added by the later STRUCTURED_DISCUSSION.md contribution; decision ballots and adoption remain pending.

## Selection and integrity contract

The version 1 text-replacement proposal binds document/workspace IDs, the exact legal source digest and revision, stable block ID, start/end positions, original quote, 32-character context on both sides, replacement text and rationale. Positions use UTF-16 units, the indexing used by JavaScript/editor text. A supplementary Unicode character uses two units; neither edge may split that pair. Combining sequences remain exact and are not normalized. A legal reference occupies one structural position and cannot be consumed as ordinary selected text.

Selections can cross text formatting within one paragraph, definition or footnote. Replacement preserves unaffected legal structure and reference identities, inherits the text marks at insertion, and always merges adjacent text fragments with the same formatting in the same way. Insert/delete primitives are tested in the engine; the UI currently requires highlighted text. Multi-clause packages, move operations and positions that track concurrent edits remain unfinished.

A proposal can refer to an earlier saved edition; the server validates the quote against that exact immutable edition. Later source changes mark it stale. Matching nearby or unique wording never authorizes adoption: candidate locations require explicit confirmation, a new proposal/decision binding and a new vote. The content-transform helper is a pure function, not an authority or an exposed adoption endpoint. Public-input content rejects that transformation.

## HTTP, storage and disclosure

| Route | Behavior |
| --- | --- |
| POST /api/workspaces/:workspace/documents/:document/proposals | Current owner/admin/editor/participant; baseVersion, selection, replacement, rationale, commandId and publish-proposal-v1 disclosure |
| GET /api/public/documents/:document/proposals | Bounded public directory; after/limit up to 100 |
| GET /api/public/documents/:document/proposals/:proposal | Exact public wording/digest/base version and stale status |

Mutations use the common exact-Origin, session-bound header proof and request budget. Proposal bodies are bounded to 1.25 MB; selection/replacement are at most 100,000 UTF-16 units each, rationale at most 4,000. JSON fields are exact. Authority and the write share the membership transaction, so removal and concurrent writes serialize. Current limits are 500 suggestions/document and 50/author/document, with logical content charged to the existing 30 MB workspace budget. The limits are safety parameters, not pricing. Unified admin/entitlement integration remains planned.

Migration 005 adds immutable proposal rows, source-edition foreign keys, actor-bound retry records (the same command produces one result rather than a duplicate) and an atomic anchoring outbox. Runtime can insert/read but cannot update/delete proposals or pending commitments. Creation commits proposal, logical storage accounting and outbox together. A repeated command returns its original proposal; altered reuse fails. Current stale status can change when the source advances, without changing the proposal. Runtime startup checks the new migration and rejects elevated/schema-owning credentials across all application schemas. Roll back by disabling new routes, retaining records and prior migration files.

The author explicitly publishes the proposed wording and rationale. Public responses disclose proposal/document/workspace IDs, exact wording, source bindings and times; they omit internal account/command identifiers. No private proposal payload is accepted. Anchoring stays pending with no invented blockchain evidence. Synthetic browser evidence does not establish personhood, reputation, legal authority or production security acceptance.

## UI and recovery

Use Find next or highlight body text, then Suggest replacement. Pending draft saves must complete first so the proposal names the correct saved version. The panel shows before/after, rationale and disclosure before publishing. A lost response retains the same command for safe retry. Source edits, permission errors and rejected selections preserve the user's draft fields. The proposal draft is in memory; closing/reloading can discard unsent text. Published suggestions reopen from the public directory. The tour adds balloons for real saved-document, suggestion and history controls when present.

Tests cover Unicode, text marks, reference boundaries, ambiguous/stale/deleted targets, exact quotes/context, insert/delete, wrong tenant/role/removal, unchanged public-input source, replay, quotas, immutable row permissions, hidden author IDs and malformed input. Real Chrome exercises source selection, suggestion publication, unchanged fixed text and anonymous suggestion discovery. PostgreSQL CI adds duplicate-command and membership-removal races using separate connections. Desktop/mobile screenshots are inspected. Remaining DCE-009 scope and production acceptance stay pending; no unit-completion or independent-review claim is made.

## Proposal revisions (DCE-009 increment)

`POST …/proposals` accepts an optional `revises` (the prior proposal ID). Only
the prior proposal's author may revise it, once (history is linear), and never
while it is under an open vote or a provisional decision
(`409 VOTE_IN_PROGRESS`). The prior wording stays immutable. Public reads show
`revisionOf` and `revisedBy`. A superseded proposal cannot be put to a vote
(`409 PROPOSAL_SUPERSEDED`), and ballots never carry over: the new wording
needs its own decision. Migration 031 adds the append-only revision links.

Still not done: positions that track concurrent realtime edits (relative
anchors) and move operations.
