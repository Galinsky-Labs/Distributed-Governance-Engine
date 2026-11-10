# Distributed Governance Engine

Reusable legal-document drafting, proposal, deliberation and governance engine.

**Status: real multiuser governance application implemented in code; production deployment and legal execution are not certified.** The authenticated /governance interface now includes workspace membership, public documents, exact-version amendment proposals, nested pro/con discussion, frozen-electorate member votes, tally/closure records, automatic application of passed unchanged amendments to a new public draft revision, and redacted public checksum receipts. These are verified in PostgreSQL and isolated Chrome/OIDC fixtures, not a customer-hosted service. Private encryption activation, corporate share-weighted identity, signatures, payments, independent blockchain finality and external acceptance remain separate work.

- [Architecture, product differences and editor features](docs/ARCHITECTURE.md)
- [Development plan](docs/DEVELOPMENT_PLAN.md) and [canonical PR registry](registry/prs.json)
- [Security and truthful claim boundaries](docs/SECURITY.md)
- [Private ciphertext store](docs/PRIVATE_CIPHERTEXT_STORE.md), [encrypted update ledger](docs/PRIVATE_UPDATE_LEDGER.md), [private WebSocket relay](docs/PRIVATE_COLLABORATION_WSS.md) and [client encryption frames](docs/PRIVATE_COLLABORATION_FRAMES.md)
- [Operations and credential requirements](docs/OPERATIONS.md), [candidate production runbook](docs/PRODUCTION_RUNBOOK.md), and [public decision receipt verification](docs/DECISION_RECEIPT.md)
- [Identity and organization access](docs/IDENTITY_FOUNDATION.md), [account HTTP/UI](docs/ACCOUNT_HTTP.md)
- [New TLS-only Keycloak provider candidate](docs/IDENTITY_PROVIDER.md) and [native passkeys](docs/PASSKEY_VERIFIER.md)
- [Saved public documents and failure recovery](docs/PUBLIC_DOCUMENTS.md)
- [Exact text proposals](docs/TEXT_PROPOSALS.md) and [structured discussion/rating](docs/STRUCTURED_DISCUSSION.md)
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

The shared React/ProseMirror editor preview serves http://127.0.0.1:4173 and demonstrates the CivicQuill/CharterQuill family, real drafting/formatting, legal sections, tables, outline, working-copy exports and anchored walkthroughs. Changes stay in memory unless you opt into public-sample device recovery. The account-enabled HTTPS service additionally implements OIDC, workspace membership, explicit public publication, durable public save/reopen/history and fixed public-input sources. It requires configured provider/database/TLS secrets; see operations. Exact-version replacement suggestions and rationales have a saved slide-out interface. Structured pro/con points, typed replies and independent argument ratings are connected. An opt-in, fail-closed private ciphertext persistence layer, authenticated encrypted Yjs frame codec, durable update ledger and dedicated private WebSocket relay have passing local/CI integration tests, including a real TLS-to-database two-user simulated-device journey. They are **not enabled by the production bootstrap**, and no reviewed group MLS key management or verified physical device authorization is provided yet. Authenticated, persisted equal-member decision voting and guarded application of passed amendments to the public **draft** are implemented. Private organization workflow, legally binding signing/adoption and production acceptance remain unfinished. The earlier conceptual walkthrough remains available through npm run demo.


## Actual collaborative governance application

The hosted application requires PostgreSQL, external OIDC, direct application TLS and runtime least privilege. After migrations and credentials are configured, run:

    npm ci --ignore-scripts
    npm run build
    npm start

Open /governance to create and browse workspaces, review document amendments, discuss pro/con points, and vote on frozen proposed language. Only workspace members can cast votes; visitors may view the public directory and deliberation. /account manages membership; / opens the legal editor. The closure process will apply a passed, unchanged amendment to a new public working revision; it never claims to enact law or execute a corporate resolution.

The **real app container** builds with:

    docker build -t quill-governance .

The image has no bundled passwords, database, OIDC client, certificate or customer data. See the linked runbook for exact environment variables, migration credential separation and external validation. A green CI result is code evidence, not evidence of live customer access. The offline HTML files above remain intentionally narrower and must not be used as a substitute for this application.

Actual PR mappings are recorded in registry/prs.json; bootstrap commits alone do not establish product acceptance. Follow the dependency-ready PR specifications to implement the full product. Human review is the final deployed handoff; actual failed technical gates remain blockers.
