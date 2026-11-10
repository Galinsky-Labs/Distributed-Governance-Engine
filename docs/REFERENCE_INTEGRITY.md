# Legal reference integrity and defined terms (partial DCE-007)

The shared legal-document model now analyzes cross-reference backlinks, missing targets, duplicate or empty defined terms, and cycles between definition nodes. The editor displays bounded, accessible diagnostics with stable section/definition IDs. Publication and domain-level finalization now reject ambiguous or cyclic defined terms as well as missing references.

Definition diagnostics compare NFC case-folded term keys under the document locale **without changing the original term text**. The analyzer uses bounded, iterative graph traversal to avoid recursion limits on long reference chains. Cycles only implicate nodes actually in the cycle, not upstream definitions that point into one.

previewLegalNodeMove checks proposed section relocations without writing anything, reporting before/after labels and all affected inbound reference sources. Semantic IDs and target IDs never change merely because labels change.

This is source-level integrity, not an authorized final adoption endpoint. Full DCE-007 acceptance also needs citation import and resolution, richer citation-provider metadata, verified cross-document import/clipboard identity, more jurisdiction-specific citation presentation, broader assistive-technology testing, migration review and production evidence. The currently stored schema still accepts old adopted content; the new checks gate **new** finalize/publication domain transitions rather than rewriting immutable historical editions.

Validation: npm run check runs legal-schema duplicate term, empty term, directed cycle, inbound reference impact, invalid move and unresolved-target tests. Production acceptance is pending.

[Internal reference editor](INTERNAL_REFERENCES_EDITOR.md) adds stable-target creation, explicit repair, read-only navigation, definition/footnote controls and derived full-path display/export labels without rewriting reference identity. Move/numbering previews include full-path `referenceChanges` while retaining their existing local-heading fields.
