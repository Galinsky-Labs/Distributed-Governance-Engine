# Exact saved-edition comparison — partial DCE-019

Load **Public version history**, then choose **Compare saved versions**. Select
any two loaded saved versions, including the same edition or reverse order.
Earlier history pages remain available through the existing history control.
The dialog reads those exact immutable editions; local unsaved wording and
unacknowledged live updates are excluded. Comparing never replaces the open
editor, restores an edition, edits source or applies a proposal.

Each response must match the selected document, workspace, version and history
digest. Browser SHA-256 recomputes the existing `dce-c14n-v0-dev` canonical legal
document checksum with its schema-version domain before a comparison appears.
Failures clear the result and prevent report download; interrupted or superseded
reads cannot restore an older selection. These are content checksum checks,
not proof of publisher identity, an independent witness, external anchor,
signature, adoption or legal effect.

Comparison matches stable semantic IDs. It lists added/removed nodes, changes
to each node's own fields (including marks, URL targets and citation metadata),
parent moves and reordered siblings. A deterministic longest increasing
subsequence identifies a minimal set of reordered surviving siblings; insertion
or deletion alone does not falsely mark the remaining siblings as moved. It
cannot infer which physical editing gesture an author performed. Recreated IDs
are additions/removals, never guessed matches.

Numbering labels, automatic reference wording, definition names and footnote
ordinals derive separately from each edition. A numbering change can therefore
appear even when the reference's source target ID stays unchanged. Document
mode, lifecycle, schema, metadata and provenance differences are explicit.
A change only to the revision counter does not fabricate semantic changes.
Tables, lists and nested sections retain their structural IDs and local fields;
parent text is not repeated as a concatenation of every descendant.

Text highlighting uses a single contiguous replacement span per changed node,
with exact common prefix/suffix and Unicode-safe boundaries. Unchanged words
inside that span remain highlighted. It is not a word-minimal redline or a
rendered-page/layout diff. Structured before/after source is available beside
each change so formatting and target-only changes remain inspectable. Work is
bounded by the existing 3 MB / 10,000-node / depth-16 legal schema; sibling
reordering uses O(n log n), not a quadratic whole-document diff. The dialog shows
100 changed nodes at a time, with an explicit button for further pages.

**Download comparison JSON** records the comparison profile, document/workspace,
exact saved version numbers, both content digests and the semantic changes.
`verification:content-checksums-only` and `legallyExecuted:false` are explicit.
Reports contain public source text and prior wording. This is not a redaction
or confidentiality tool. The modal traps focus through native dialog behavior,
closes with Escape and returns focus to its trigger; narrow layouts wrap long
IDs, checksums and source fields.

No dependency, credential, schema migration, digest-format or authorization
change is required. Existing history and exact-edition APIs remain unchanged.
The full engine and both hosted applications remain unfinished: authorship/proposal attribution, branches,
minimal semantic/text redlines, private history verification, immutable signed
execution workflows and deployment acceptance are separate work.

A separate explicit manager operation now restores content as a new public draft revision; see [DRAFT_RESTORATION.md](DRAFT_RESTORATION.md). The comparison dialog itself remains read-only.
