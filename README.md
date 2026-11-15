# Distributed Governance Engine

Reusable legal-document drafting, proposal, deliberation and governance engine.

**Status (2026-11): 23 of 39 roadmap units are implemented in source with tests; 16 are partial (see `registry/prs.json`). No unit has operational acceptance, and there has been no independent security review or owner acceptance.** The engine serves CivicQuill (https://civicquill.onrender.com) and CharterQuill (https://charterquill.onrender.com). Both are hosted on Render's free plan with Neon PostgreSQL and use passkey sign-in. `/healthz` reports the exact deployed commit and `/readyz` checks the database.

Implemented in source:
- Workspaces and public documents with version history and restore.
- Exact-text proposals and structured discussion.
- Frozen and weighted electorates with proxies and class approvals.
- Challenge windows and finality, with adoption into a new public draft.
- Moderation, editions, import and export.
- Support, approval and execution signatures with Merkle manifests.
- A transparency log with OpenTimestamps anchoring.
- Federation, settings, entitlements and payments behind configuration.
- Search, notifications and localization (en, es, fr, ar, with RTL).
- An end-to-end encrypted private workspace with an OpenMLS endpoint module.

Partial units:
- Identity assurance (DCE-002).
- Private E2EE activation and review (003).
- Editor acceptance (005–009).
- Policy modes (010): tie rules, time-zone cutoffs and support floors exist as helpers but are not yet selectable through the API.
- Realtime (015, 016).
- Walkthrough (031).
- Accessibility (033): automated axe audit only, with no manual screen-reader record.
- Operations (035): restore-drill tooling exists, but no drill has been recorded.
- Security review (036).
- The extension SDK (038): a versioned manifest contract exists, but there is no OpenAPI document yet.
- The production release package (039).

- [Architecture, product differences and editor features](docs/ARCHITECTURE.md)
- [Development plan](docs/DEVELOPMENT_PLAN.md) and [canonical PR registry](registry/prs.json)
- [Security and truthful claim boundaries](docs/SECURITY.md)
- [Private ciphertext store](docs/PRIVATE_CIPHERTEXT_STORE.md), [encrypted update ledger](docs/PRIVATE_UPDATE_LEDGER.md), [private WebSocket relay](docs/PRIVATE_COLLABORATION_WSS.md) and [client encryption frames](docs/PRIVATE_COLLABORATION_FRAMES.md)
- [Operations and credential requirements](docs/OPERATIONS.md), [candidate production runbook](docs/PRODUCTION_RUNBOOK.md), and [public decision receipt verification](docs/DECISION_RECEIPT.md)
- [Identity and organization access](docs/IDENTITY_FOUNDATION.md), [account HTTP/UI](docs/ACCOUNT_HTTP.md)
- [New TLS-only Keycloak provider candidate](docs/IDENTITY_PROVIDER.md) and [native passkeys](docs/PASSKEY_VERIFIER.md)
- [Saved public documents and failure recovery](docs/PUBLIC_DOCUMENTS.md)
- [Exact text proposals](docs/TEXT_PROPOSALS.md) and [structured discussion/rating](docs/STRUCTURED_DISCUSSION.md)
- [Live deployment verification](docs/LIVE_VERIFICATION.md), [federation](docs/FEDERATION.md), [scale measurements](docs/SCALE.md)
- Feature references: [electorates](docs/ELECTORATES.md), [editions](docs/EDITIONS.md), [signatures](docs/SIGNATURES.md), [settings](docs/SETTINGS.md), [entitlements](docs/ENTITLEMENTS.md), [payments](docs/PAYMENTS.md), [search](docs/SEARCH.md), [notifications](docs/NOTIFICATIONS.md), [localization](docs/LOCALIZATION.md), [moderation](docs/MODERATION.md), [clause permissions](docs/CLAUSE_PERMISSIONS.md), [private workspaces](docs/INTEGRATION-private.md)
- [Extension SDK and compatibility](docs/EXTENSION_SDK.md), [policy lifecycle helpers](docs/VOTE_POLICY_SETTINGS.md)
- [Repository agent instructions](AGENTS.md)

Requires Node 24.19.0 (tested). Install the exact lockfile before running the editor and tests.

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm run build:offline
npm run preview
```


For **offline document editing only (not the governance application)**, `npm run build:offline` creates `dist/offline/CivicQuill.html` and `dist/offline/CharterQuill.html`. Open either file directly in a current browser. The repository's GitHub Actions `verify` job also publishes both files as a downloadable `civicquill-charterquill-offline` artifact after browser tests pass. In that limited offline editor you can create a new draft, format, import an exported local working-copy JSON file, export JSON/plain text and print. **Do not enter confidential information**: this is an explicitly public preview with optional unencrypted device recovery, no cross-device synchronization, and no production voting, signing, private workspace or blockchain features. Download a JSON copy before closing the file.

The shared React/ProseMirror editor preview serves http://127.0.0.1:4173 and demonstrates the CivicQuill/CharterQuill family, real drafting/formatting, legal sections, tables, outline, working-copy exports and anchored walkthroughs. Changes stay in memory unless you opt into public-sample device recovery. The account-enabled HTTPS service additionally implements OIDC, workspace membership, explicit public publication, durable public save/reopen/history and fixed public-input sources. It requires configured provider/database/TLS secrets; see operations. Exact-version replacement suggestions and rationales have a saved slide-out interface. Structured pro/con points, typed replies and independent argument ratings are connected. Private workspaces (MLS-encrypted, server holds ciphertext only) are enabled in both hosted Quills; their cryptographic design has not had independent review. Authenticated, persisted decision voting and guarded application of passed amendments to the public **draft** are implemented; legally binding adoption is not claimed. The earlier conceptual walkthrough remains available through npm run demo.


## Actual collaborative governance application

The hosted application requires PostgreSQL, either external OIDC or first-party passkey sign-in (`SIGNIN_PASSKEYS=enabled`), TLS (direct, or `TRANSPORT_MODE=edge-tls` behind a TLS-terminating edge) and runtime least privilege. After migrations and credentials are configured, run:

    npm ci --ignore-scripts
    npm run build
    npm start

Open /governance to create and browse workspaces, review document amendments, discuss pro/con points, and vote on frozen proposed language. Only workspace members can cast votes; visitors may view the public directory and deliberation. /account manages membership; / opens the legal editor. The closure process will apply a passed, unchanged amendment to a new public working revision; it never claims to enact law or execute a corporate resolution.

The **real app container** builds with:

    docker build -t quill-governance .

The image has no bundled passwords, database, OIDC client, certificate or customer data. See the linked runbook for exact environment variables, migration credential separation and external validation. A green CI result is code evidence, not evidence of live customer access. The offline HTML files above remain intentionally narrower and must not be used as a substitute for this application.

Actual PR mappings are recorded in registry/prs.json; bootstrap commits alone do not establish product acceptance. Follow the dependency-ready PR specifications to implement the full product. Human review is the final deployed handoff; actual failed technical gates remain blockers.
