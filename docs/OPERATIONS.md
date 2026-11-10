# Operations and credential requirements

The shared editor and account service are implemented in part. Public saved documents and exact-version replacement proposals/discussion now have partial implementations; reviewed MLS group key management, production private collaboration, signing, payments and blockchain anchoring remain unfinished. See PUBLIC_DOCUMENTS.md and TEXT_PROPOSALS.md / STRUCTURED_DISCUSSION.md. No production service or paid resource has been created. The old `npm run demo` is an in-memory design demonstrator; never expose it as the application.

Private storage and websocket source exist but are deliberately not mounted by `server/start.mjs`. Do not install them with synthetic device authorizers, a shared password or a reused local cache key. Realtime private collaboration requires an independently verified, interoperable MLS group key provider, session-bound authenticators, device removal/epoch rotation and a dedicated TLS 1.3 WebSocket service. See `docs/PRIVATE_CIPHERTEXT_STORE.md`, `docs/PRIVATE_UPDATE_LEDGER.md`, `docs/PRIVATE_COLLABORATION_WSS.md` and the complete TLS/identity/Postgres/Yjs test `tests/private-end-to-end.test.mjs`. These are development integration tests only, not physical authenticator or production cryptographic acceptance.

Run `npm ci --ignore-scripts`, `npm run check` and `npm run build`. Ordinary checks need no credentials or network provider. `npm run test:postgres` requires a disposable loopback PostgreSQL database ending in `_test`. Browser checks require DGE_BROWSER_EXECUTABLE pointing to pinned Chrome Headless Shell 155.0.8059.84; CI installs it and runs the actual HTTPS account journey with synthetic identities.

For a controlled account-service deployment, follow [ACCOUNT_HTTP.md](ACCOUNT_HTTP.md). Use separate migration/runtime database credentials. Apply `npm run migrate:identity` under MIGRATION_DATABASE_URL, grant the dedicated ordinary login membership in dge_identity_runtime, migrations cover identity, public documents, and disabled private ciphertext document/update schemas; then start under DATABASE_URL with `npm start`. Startup rejects elevated/owning roles and schema history differing from checked-in migrations. Preserve applied migration files. Roll back by disabling affected routes, retaining identity and audit records; do not run destructive down migrations.

The current bootstrap terminates verified TLS directly, requires TLS 1.3, and defaults to loopback port 8443. PUBLIC_ORIGIN is an exact HTTPS origin; the provider callback is always that origin plus `/auth/callback`. It ignores forwarding headers. TLS_KEY_FILE/TLS_CERT_FILE reference deployed certificate files, never committed keys. Do not place it behind an unverified plaintext proxy hop or change trust based on X-Forwarded-For/Proto. A Render/Neon production topology still needs actual transport, readiness, backup and access evidence before acceptance. `/healthz` is liveness only.

Supply independent random 32-byte SESSION_KEY and OIDC_STATE_KEY values as 64 lowercase hexadecimal characters through secret configuration. Other required values are DATABASE_URL, PUBLIC_ORIGIN, OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET. QUILL_PRODUCT is civic or charter; BIND_ADDRESS/PORT select the listener. Database and migration clients require certificate verification and TLS 1.3. Do not print URLs, tokens, provider errors or secret values in deployment logs.

Passkey routes remain fail-closed unless the embedding service supplies both WebAuthn registration and authentication verifiers to `createIdentityStore`. The verifier must validate the exact configured HTTPS origin and relying-party hostname, the server challenge, user verification, credential public key and authenticator counter. The bootstrap now selects pinned SimpleWebAuthn verification when an explicit `PASSKEY_ATTESTATION_POLICY` allowlist is configured; without it the routes remain unavailable. See PASSKEY_VERIFIER.md for configuration, verified browser coverage and the limits of virtual-authenticator evidence. Physical device/vendor assurance and a production allowlist remain unverified. The server-only provider-restoration adapter additionally requires a restricted recovery session, fresh proof from an existing passkey and new claims already verified by the configured OIDC adapter; never expose it as a route accepting issuer/subject assertions. A hosted production recovery drill remains pending. Do not treat the persisted ceremony/device model as browser/authenticator acceptance or private-workspace encryption.

Future adapters need scoped object-storage credentials, verified mail configuration, payment/webhook test and live keys, anchor RPC and a protected signer reference with spend limits, plus deployment scopes. Content/device/recovery keys remain at authorized endpoints and cannot become server environment secrets. Request budgets and workspace/invitation/session limits are server parameters now; the versioned unified admin console will expose supported policy settings later.

Registration: repository neophilism/Distributed-Governance-Engine, immutable ID 1422876391, is owner-created with write access verified. Canonical registry/prs.json is on main. Engine Room/Boardroom registration is unverified until a real remote acknowledgment is retained; repository existence and tracking issue #112 do not establish registration.

Use dependency-ordered PRs, stable unit IDs and actual GitHub mappings. Planned specifications are reviewable documents; dependency-blocked empty PRs are unnecessary. Use scripts/verify-pr-merge.mjs with two fresh exact-head observations. Missing, pending, skipped, failed or incomplete required checks never count as passed.

Production acceptance requires exact deployed commit evidence, readiness/dependency checks, isolated identity, migration records, real multiuser journeys, anchor receipts, recovery drills and measured cost/scale assumptions. Human review is deferred to the deployed handoff; independent review/certification remain pending.

Candidate publication now runs only on main pushes in `publish-candidates.yml`.
Its release-source gate requires the verification workflow to finish successfully
for that exact main SHA before either existing candidate release is updated.
The PR verification workflow contains only the substantive verify/image jobs;
main-only publication jobs therefore do not appear as skipped PR checks. The
strict merge preflight remains unchanged. Tests cover wrong source/repository,
failed/skipped/cancelled/incomplete evidence and queued-to-completed transitions.

The new provider candidate and its private import generator are documented in
IDENTITY_PROVIDER.md. The identity-provider verification job exercises the real
pinned Keycloak image, certificate-verified TLS 1.3 discovery/database access,
TLS downgrade/untrusted-CA refusal and password/OTP login through the engine.
The disposable provider fixture is loopback-only and must never be exposed as a
customer service; the production image contains no fixture users or credentials.

The browser provider-restoration contribution now connects limited code redemption,
already-enrolled passkey verification and a purpose/session-bound fresh OIDC
callback. See PROVIDER_RESTORATION.md for current behavior, rollback and evidence.
Hosted recovery drills, physical devices, private-content
recovery and full DCE-002 acceptance remain unverified. No new deployment
credential is required beyond the configured issuer/client, independent session
and state keys, database/TLS credentials and explicit passkey policy.
