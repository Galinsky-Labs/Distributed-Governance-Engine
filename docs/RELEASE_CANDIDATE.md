# Production candidate checklist (DCE-039)

Status: **candidate, not accepted.** Each row states what evidence exists today. "Not done" rows block calling this a release; nothing here claims independent review or operational acceptance.

| Area | Evidence today | Status |
|---|---|---|
| Exact-head CI | The `verify`, OIDC, MLS and runtime-build jobs, plus networked PostgreSQL, run on every PR. Merges require all of them to pass on the exact head SHA. | Done for every merged PR |
| Deployed commit binding | `/healthz` returns `release` = `RENDER_GIT_COMMIT`. `/readyz` checks the database. Both Quills report their merge commit after an API-triggered deploy. | Done |
| Least-privilege runtime | The release step migrates as owner. The runtime refuses to start with elevated or schema-owning credentials. | Done |
| HTTP contract | `docs/sdk/openapi.json` is generated and drift-tested against the live handler. | Done (generic body schemas) |
| Supply chain | Pinned lockfiles, sha512 and crate checksums, and the CycloneDX SBOM `security/sbom.cdx.json`. `npm audit` reported 0 known vulnerabilities on 2026-11-15. | Done (point in time) |
| Accessibility | Automated axe-core WCAG A/AA audit and a keyboard/name check. | Partial: no manual screen-reader record |
| Restore | Content-free reconciliation manifests and a drill runbook. | Not done: no recorded drill on production data |
| Live multi-user journey | `scripts/live-journey.mjs` exists. It was not run against production in this cycle, because it creates accounts in production. | Not done |
| Anchoring finality | OpenTimestamps calendars are configured; Bitcoin confirmation evidence has not been recorded. | Not done |
| Load | The scale document gives local measurements only. | Not done (no production load report) |
| Independent review | No independent security review exists. AI-assisted notes are in `docs/AI_SOURCE_REVIEW.md`. | Deferred by the owner until deployment is complete |
