# GitHub PR registry reconciliation (October 18, 2026)

The canonical \`registry/prs.json\` now explicitly maps merged partial source work to DCE-003 (#24, #30), DCE-006 (#22), DCE-007 (#25), and DCE-008 (#26–#30). This changes those units to **partial**, never implemented/operationally accepted. Previously completed work DCE-001/004 remains as recorded. Actual PR #18 and #21 merge statuses have been refreshed.

The structured \`pullRequests\` observation array still lacks records for some newer GitHub PRs because the available connector returns the PR number and state, **not** the required immutable numeric GitHub PR ID. A fabricated ID must never be substituted; these absent snapshots do not mean the PRs are absent from GitHub. The unit mappings use confirmed merge evidence, and the \`pullRequests\` array is explicitly not a full live-GitHub census until reconciled.

Run \`GITHUB_TOKEN=... node scripts/refresh-pr-registry.mjs --write\` in a scoped environment with genuine GitHub pull-request read access, then commit the resulting \`registry/prs.json\`. This is the only authorized route to fill missing numeric PR IDs. Without \`--write\`, the command validates a complete live observation and prints a bounded count summary **without modifying files**.

The reconciliation code:
- Requests every page from the repository's own REST PR listing, rejecting transport errors, malformed fields, duplicates, foreign URLs or incomplete pagination.
- Keeps the approved 39-unit roadmap and explicit PR/contribution mappings intact. It **never** infers completed units from closed/merged PRs.
- Validates the new registry through the shared parser before atomic replacement.
- Writes no tokens into files or logs. Do not inject a token into a shell command that will be retained in a repository or CI output.

Production and security acceptance remain unverified. Never use a stale snapshot as evidence that no newer PR exists. Obtain live GitHub evidence before any merge.

The repository transfer to Galinsky-Labs preserves immutable GitHub repository ID 1422876391. The canonical registry, retired-roadmap marker and security identity now use the actual GitHub owner; the pinned standard revision and all incomplete security/operational states are preserved. PR observations through #53 come from the real API, with partial contributions kept separate from accepted units.
