# Live deployment verification — November 15, 2026

Recorded from real requests to the deployed services, not from fixtures. It proves what the run below exercised and nothing more. It is not an independent review, a certification or a capacity claim.

## What is deployed

| Service | URL | Deployed application commit (`/healthz` release) | Engine commit (integrity-pinned) |
| --- | --- | --- | --- |
| CivicQuill | https://civicquill.onrender.com | Galinsky-Labs/CivicQuill `e065b103f368076d96b95d0c1eb818594a6e49c5` | `4a9a2e8f9dc0edd11123401fb6f871e7b6441670` |
| CharterQuill | https://charterquill.onrender.com | Galinsky-Labs/CharterQuill `0a8ea2e36dd5733a0d3ebf848511a6044265ebd8` | `4a9a2e8f9dc0edd11123401fb6f871e7b6441670` |

Infrastructure:
- **Hosting:** Render free web services in the Galinsky Labs workspace (Ohio), Docker runtime.
- **Database:** Neon PostgreSQL 17 project `quill-governance` in the Galinsky Labs organization (aws-us-east-2, free plan), with one database per product.
- **Monthly cost at deployment:** $0.

How each service runs:
- **Transport:** `TRANSPORT_MODE=edge-tls`. Render's edge terminates public TLS. The service refuses any request whose `X-Forwarded-Proto` is not `https`; only health probes are exempt.
- **Database connection:** TLS 1.3 with a verified certificate.
- **Database credentials:** the boot-time release step migrates as the database owner, then serves as the unprivileged `*_runtime` login. That login must pass `verifyIdentityRuntime`: no superuser, role-creation, database-creation, replication or RLS-bypass powers, and no schema ownership.
- **Sign-in:** first-party passkeys (`SIGNIN_PASSKEYS=enabled`). No external OIDC provider is configured.
- **Transparency log:** signed with each service's own Ed25519 key. Anchoring uses the public OpenTimestamps Bitcoin calendars (`ANCHOR_PROVIDERS=opentimestamps`), which cost nothing.
- **Private workspaces:** enabled (`PRIVATE_WORKSPACES=enabled`), with the OpenMLS Wasm module built in the image.
- **Not configured:**
  - Email delivery (no Postmark token): notifications are in-app only.
  - Payments (no Stripe keys): purchase options are hidden and drafting uses the free weekly allowance or administrator grants.
  - Federation (`FEDERATION` unset).

## Live journey (`scripts/live-journey.mjs`)

Two independent Chrome profiles each used a virtual CTAP2 authenticator with user verification. A third profile acted as an outsider.

| Check | CivicQuill | CharterQuill |
| --- | --- | --- |
| Two members create pseudonymous accounts through `/signin` with passkeys | pass | pass |
| Workspace created; second member joins by invitation | pass | pass |
| Civic: bill drafted from the `us-local` template (labelled "not introduced or filed"). Charter: resolution published and organization profile configured | pass | pass |
| Exact-text amendment proposal bound to version 1 | pass | pass |
| Supporting argument; argument up-vote by the other member | pass | pass |
| Decision opened on a frozen electorate of 2; ballot cast with a receipt digest | pass | pass |
| Non-member ballot refused (403) | pass | pass |
| Public bound PDF export of the exact edition | pass (432 KB) | pass (430 KB) |
| Script-free reading page; public full-text search | pass | pass |
| Edition included in the Ed25519-signed transparency log (inclusion proof) | pass | pass |
| Downloaded verification package recomputed offline: content and log inclusion **verified**; signature and witnesses **limited** (key not pinned out of band, no witness yet); anchor **unverified** | consistent | consistent |
| Checkpoint submitted to OpenTimestamps calendars (Bitcoin confirmation follows within hours) | submitted | submitted |

Results: 16/16 checks passed on CivicQuill and 17/17 on CharterQuill.

## Not verified live, and why

- **Decision closure and automatic amendment application.** The shortest vote window is one hour. This path is covered by the PostgreSQL and browser suites, not by this run.
- **Bitcoin finality of the anchor.** Calendar submission happened. Confirmation and six-block finality take hours, and the queue records each state transition.
- **Private workspace journey on the deployed host.** Covered by `tests/private-workspace.browser.mjs` in CI, not by this run.
- **Email notifications, payments and federation.** Not configured, as listed above.
- **Platform admin actions** (official verification review, settings). They need an operator to grant platform admin with `scripts/grant-platform-admin.mjs` using the migration credential, which has not been done.
- **Load, backup/restore drill and long-running soak.** See `docs/benchmarks/` for local measurements only.

## Known deployment limitations

- Render free instances sleep after inactivity, so the first request can take up to a minute.
- The migration owner credential is present in the service environment until the release step removes it at boot. A dedicated release job would avoid this but needs a paid plan.
- Render auto-deploy needs the Render GitHub app on these repositories. Until then, deploys are triggered through the Render API.
