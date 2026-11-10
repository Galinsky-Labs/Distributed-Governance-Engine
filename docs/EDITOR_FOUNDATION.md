# Shared Quill editor foundation — DCE-005 contribution

The React/ProseMirror editor uses the same portable legal-structure validator as the engine. Semantic IDs, references, section titles, basic marks, lists, rectangular tables, definitions, exhibits and footnotes survive the editor adapter. New/split blocks receive unique IDs. Editor transactions that would directly change public-input, published, adopted or signed editions are rejected at both state and controller boundaries.

Included controls: bold/italic/underline/strike; undo/redo and keyboard shortcuts; numbered/bulleted lists; safe external-link and citation creation, editing and removal; section insertion and bounded table row/column editing with keyboard cell navigation; outline navigation; native spellcheck; working-copy JSON/plain-text download; print styling; mode-specific read-only preview; accessible live status and anchored walkthrough. The same entry point can demonstrate CivicQuill and CharterQuill with related branding. The brand selector has no authorization authority.

Find/replace now searches literal body text, including words spanning formatting runs. It does not search section-title attributes or cross paragraph/reference boundaries. Match-case and wraparound next-match selection are available in fixed public-input editions too. Replace-selected checks the current selection against current text; replace-all is one undoable transaction. IDs and formatting outside the replaced range survive. The replacement inherits the starting text style. Literal replacement text is never interpreted as markup or replacement expressions.

Search returns at most 1,000 matches. A truncated search cannot execute replace-all; narrow the search first. Queries are limited to 256 characters, replacement text to 10,000 characters, and resulting body text to one million UTF-16 units for this command. Full semantic/byte limits still apply before an edit is accepted. Failed editor transactions report failure instead of allowing a control to claim success. These bounds keep an accidental broad replacement from allocating unbounded work on a user's device.

Recovery is opt-in and restricted to the explicitly public sample. Storage failure/corruption and tenant/product/document mismatches remain visible. Private organization drafts require the planned encrypted cache adapter; this code does not claim an E2EE or confidential storage implementation. No account, payment, real proposal/vote, legally finalized signature or network save is offered in the preview.

Build: `npm ci --ignore-scripts`, `npm run check`, `npm run build`. The output is dist/. CI installs the exact lockfile, runs real model/DOM tests and the domain/property suites, then compiles the browser bundle. npm audit is run during development and its scope is recorded; a clean dependency audit is not a general security guarantee. The bundle contains no Node-only hashing imports.

The link and citation controls write schema v2 inline atoms rather than presentation-only HTML. Only canonical HTTPS targets without URL credentials are accepted; unsafe schemes fail without changing the document. Selected text becomes the link label, while citations require an explicit label. Citations may also carry bounded structured publisher, publication date, pinpoint and access-date metadata; dates use strict real `YYYY-MM-DD` calendar values, empty/unknown fields fail closed, and links cannot masquerade as citations by carrying that metadata. Plain-text exports include the structured citation values. Authors can select an existing external atom to revise its canonical address, label, optional title and citation metadata, or remove the semantic link while preserving the visible label as ordinary text. Those transactions participate in local undo/redo and remain unavailable for immutable editions. Existing schema v1 documents require the explicit deterministic migration before these atoms can be saved.

This is a contribution to DCE-005, not a claim that all editor acceptance criteria are complete. Remaining editor work includes citation import/resolution against DCE-007, broader operating-system IME and accessibility coverage, private encrypted recovery, measured rendering checks and production integration. Human review remains deferred per the owner. Browser visual/screen-reader QA has not been completed in this environment. DOM integration tests verify mounting, text changes and read-only enforcement without claiming actual browser layout validation.

## Real-browser input and interrupted-save acceptance

The authenticated Chrome journey now commits CJK text, a multi-code-point emoji sequence and a combining-mark grapheme through Chrome's text-input path between composition start/end events, then waits for that exact Unicode text to reach a saved public version. The same journey aborts the next real document `PUT` as an internet-disconnection failure, verifies that the unsaved wording and visible failure state remain, restores connectivity, explicitly retries and observes the next acknowledged version before reload.

The real-Chrome journey also verifies that the editor exposes a named multiline textbox, the grouped controls expose toolbar semantics, keyboard focus has a visible three-pixel outline, and the document reflows at 320 CSS pixels without page-level horizontal scrolling.

This is browser evidence for the current Chromium/fixture-provider/PostgreSQL path. It does not establish every operating-system IME, manual screen-reader behavior, assistive-technology interoperability, offline editing across reloads, private encrypted drafts, production networking or deployment acceptance.

## Table editing and concurrent text

See [Table editing](TABLE_EDITING.md) for limits, structural commands, stable-ID behavior, read-only enforcement and authenticated two-browser WSS evidence. The contextual controls stay in the side panel so selecting a cell does not move the editor under the pointer. Narrow-layout and print behavior remain covered by the browser journey.

## Legal numbering settings

[Previewed numbering settings](NUMBERING_EDITOR.md) adds profile, scoped starting ordinals and reserved numbers to the ordinary draft editor, with reference-impact preview and one-step undo/redo. Settings use the existing authenticated save/version path and remain disabled in live and immutable editors.

## Section hierarchy

[Previewed section indent/outdent](SECTION_HIERARCHY.md) preserves IDs, text and selection, shows destination and dependent-reference changes before application, and uses existing undo/autosave. These structured moves remain disabled in live, view-only and immutable editors.
