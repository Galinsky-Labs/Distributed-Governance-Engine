# AI-assisted source review notes (DCE-036, November 2026)

This is an **AI-assisted review performed by the development agent**. It is not an independent security review, audit or certification, and it does not replace one. Owner and independent human review stay deferred until deployment, as the owner directed.

## Scope and method

- **Code reviewed:** `server/`, `src/`, `editor/` and `web/` at the head of this PR, together with the lockfiles.
- **Pattern sweep:**
  - HTML sinks (`innerHTML`, `dangerouslySetInnerHTML`);
  - dynamic code (`eval`, `new Function`);
  - process spawning (`child_process`);
  - SQL built by string interpolation;
  - logging calls;
  - dependency specs, lockfile sources, integrity hashes and install scripts.
- **Targeted reading:**
  - each interpolated SQL site;
  - each logging site;
  - the paste path of the editor;
  - the code added this cycle: decision tie rules and casting votes, proposal revisions, discussion ranking, CharterQuill enterprise integrations and CivicQuill billing settings.
- **Automated gates now in `npm run check`:**
  - `scripts/supply-chain.mjs check`: exact versions or commit pins, sha512 integrity, the npm registry as the only source, no new install scripts, and crate checksums or full-commit OpenMLS pins;
  - the generated SBOM (`security/sbom.cdx.json`, CycloneDX 1.5);
  - the axe-core accessibility audit;
  - the HTTP contract and OpenAPI drift test;
  - the ledger event contract test.

## Findings

| # | Finding | Severity (agent estimate) | Status |
|---|---|---|---|
| 1 | Editor paste sanitization parsed untrusted HTML with `innerHTML` on an element owned by the **live** document. In a live document, `<img src onerror>` starts loading during parsing, so its handler can run before the script, iframe and other element filtering. ProseMirror's own clipboard path uses `transformPastedHTML` → `cleanPastedHTML`, so a real paste reached this path. | High (user-initiated XSS when pasting crafted HTML) | **Fixed**: parsing now happens in an inert `createHTMLDocument` document. A regression test proves the live document creates no elements. |
| 2 | `axe-core` was added as a `^` range by an earlier PR in this cycle. | Low | **Fixed**: pinned exactly, and the supply-chain gate now rejects ranges. |
| 3 | Interpolated SQL in `ledger.mjs` (outbox union and update), `entitlement-store.mjs` (`usedBetween` filter), `identity-store.mjs` (lock mode) and `restore-reconcile.mjs` (table names). | None found | Reviewed. Every interpolated fragment is a code constant or a pattern-checked identifier, and caller data always goes through bind parameters. |
| 4 | Startup and release logging. | None found | `startupFailureSummary` emits only SQLSTATE or code values, or messages that match a narrow safe pattern and contain no URL, password or key text. No request content is logged. |
| 5 | Dynamic code and process spawning in server or shared source. | None found | No `eval`, no `new Function` and no `child_process`. |
| 6 | Six OpenMLS crates come from Git, not crates.io. | Informational | They are pinned to a full 40-hex commit. The supply-chain gate refuses any other Git source or a branch reference. |

## Not covered

- No fuzzing beyond the existing `npm run test:fuzz` corpus.
- No dynamic scanning (DAST) of the deployed services.
- No review of the Rust/OpenMLS cryptography beyond pinning.
- No penetration test.
- No independent reproduction of builds: the Docker build is deterministic in inputs but has not been bit-for-bit reproduced.
