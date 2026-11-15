# Integration: governance feature area (feature/governance)

Everything below is implemented and tested on this branch but not wired into `server/start.mjs`, `server/application.mjs`, `web/app.jsx` or `web/governance-home.jsx`. Migrations 021 and 022 are already registered in `server/identity-store.mjs`. Behaviour and limits: `docs/ELECTORATES.md`, `docs/CLAUSE_PERMISSIONS.md`, `docs/MODERATION.md`.

## Store factories

| Factory | Module | Options (defaults) |
| --- | --- | --- |
| `createDecisionStore` (changed) | `server/decision-store.mjs` | `identity` (required), `transaction` (required for `publicReceipt`), `clock=Date.now`, `maxElectors=1000`, `maxVoteVersions=50`, **new** `maxChallengesPerVoter=3`, **new** `maxChallenges=100` |
| `createElectorateStore` | `server/electorate-store.mjs` | `identity` (required), `clock=Date.now`, `personKeySecret` (Buffer ≥ 32 bytes; required only for person-uniqueness keys), `maxRosters=100`, `maxRosterEntries=100000`, `maxEntryVersions=1000`, `maxActiveGrants=20` |
| `createSectionGrantStore` | `server/section-grants.mjs` | `identity` (required), `clock=Date.now`, `maxGrantsPerDocument=500` |
| `createModerationStore` | `server/moderation-store.mjs` | `identity` (required), `transaction` (required for `publicLog`), `clock=Date.now`, `maxReportsPerHour=10`, `maxReportsPerDay=50`, `flagWindowMs=3600000`, `newAccountMs=604800000`, `coordinatedThreshold=3` |

`createProposalStore` and `createDiscussionStore` keep their factory options; they now enforce clause permissions and honour moderation visibility internally (no new options). Discussion `mine()` adds `canReport: true`; public proposal and point views add a `moderation` field only for hidden items.

Methods: decision store `open, read, publicReceipt, cast, close, challenge, listChallenges, resolveChallenge, finalize`; electorate store `createRoster, listRosters, readRoster, recordEntry, syncMembership, createSnapshot, readSnapshot, grantProxy, revokeProxy, listProxies`; section grant store `list, grant, revoke, setRestricted`; moderation store `report, queue, act, appeal, resolveAppeal, mine, publicLog`.

## Route factories and body limits

| Routes factory | Body-limit export | Module | Paths |
| --- | --- | --- | --- |
| `createDecisionRoutes({decisions})` (changed) | `decisionBodyLimit(path)` (16384 for decision paths, else 8192) | `server/decision-http.mjs` | existing `/decision`, `/decision/ballots` (+ `onBehalfOf`), `/decision/close`, public receipt; new `/decision/finalize`, `/decision/challenges` (GET, POST), `/decision/challenges/{challengeId}/resolve` |
| `createElectorateRoutes({electorates})` | `electorateBodyLimit(path)` (8192) | `server/electorate-http.mjs` | `/api/workspaces/{t}/rosters`, `…/rosters/{r}`, `…/rosters/{r}/entries`, `…/rosters/{r}/sync-membership`, `…/rosters/{r}/snapshots`, `…/rosters/{r}/snapshots/{s}`, `/api/workspaces/{t}/proxies`, `…/proxies/{g}/revoke` |
| `createSectionGrantRoutes({sectionGrants})` | `sectionGrantBodyLimit(path)` (8192) | `server/section-grants-http.mjs` | `/api/workspaces/{t}/documents/{d}/section-grants`, `…/section-grants/{g}/revoke`, `…/section-grants/access` |
| `createModerationRoutes({moderation})` | `moderationBodyLimit(path)` (8192) | `server/moderation-http.mjs` | `/api/workspaces/{t}/reports`, `/api/workspaces/{t}/moderation`, `…/moderation/actions`, `…/moderation/mine`, `…/moderation/appeals`, `…/moderation/appeals/{a}/resolve`, `/api/public/documents/{d}/moderation` |

All are standard account-handler extensions (`async ({request,url,credentials,write,method}) => result | null`) and convert `DocumentError` to `HttpError`. They do not overlap with each other or with existing routes. `tests/governance-fixture.mjs` shows a complete wiring.

## Components

| Component | Module | Props |
| --- | --- | --- |
| `DecisionPanel` (changed) | `web/decision-panel.jsx` | `tenantId, documentId, proposalId, role` (unchanged) |
| `ProposalPanel` (changed) | `web/proposal-panel.jsx` | unchanged; shows moderator placeholders and a Report control when `record` is present |
| `DiscussionPanel` (changed) | `web/discussion-panel.jsx` | unchanged; shows placeholders and Report for members |
| `ElectoratePanel` | `web/electorate-panel.jsx` | `tenantId, role` |
| `ModerationPanel` | `web/moderation-panel.jsx` | `tenantId, role` |
| `ReportButton` | `web/moderation-panel.jsx` | `tenantId, targetKind ("proposal"|"point"), targetId` |
| `RemovedNotice` | `web/moderation-panel.jsx` | `moderation` (the public `moderation` field, may be undefined) |
| `SectionGrantsPanel` | `web/section-grants-panel.jsx` | `tenantId, documentId, role, sections` (optional `[{id,title,label?}]`, e.g. from `legalOutline(document)`) |

The new panels reuse existing `decision-panel`/`point-card`/`proposal-list` styles; `web/style.css` was not changed.

## New configuration

- **Person-uniqueness key secret** (new): pass `personKeySecret` to `createElectorateStore` as a Buffer of at least 32 random bytes from a secret store. Suggested environment variable: `DGE_PERSON_KEY_SECRET` (base64). Rotating it changes all future digests, so duplicate detection only works within one secret generation; keep it stable per deployment. Without it, verified-person cohort entries are refused with `PERSON_KEY_UNAVAILABLE` (503) and everything else works.
- No other environment variables, ports or services.

## Optional

- `src/weighted-governance.mjs` (pure evaluator, `verifyWeightedDecisionReceipt`) and `src/proposal-bundles.mjs` could be added to `package.json` `exports` if external verifiers need them.
