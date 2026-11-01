# Shared account HTTP and UI — partial DCE-002

The same engine supplies CivicQuill and CharterQuill sign-in, workspace membership and invitations. The account drawer is enabled only by the account server, not the static editor preview. The later public saved-document contribution is described in PUBLIC_DOCUMENTS.md. Private organization storage remains unavailable until endpoint encryption is implemented.

## Routes and authority

| Route | Behavior |
| --- | --- |
| GET /auth/start, /auth/callback | Browser-bound real OIDC authorization-code flow, fixed callback and account landing page |
| GET /api/session | Internal account ID and session times; no session/CSRF token JSON |
| POST /api/logout, /api/logout-all | Protected session or account-wide revocation |
| POST /api/passkeys/enrollment/options, /api/passkeys/enrollment/verify | Begin/finish a verifier-backed, session-bound passkey enrollment |
| POST /api/passkeys/authentication/options, /api/passkeys/authentication/verify | Begin/finish local passkey step-up with user verification and counter checks |
| GET/POST /api/devices, DELETE /api/devices/:id | List, authorize after fresh passkey step-up, or revoke encrypted-device key thumbprints |
| GET, POST /api/workspaces | Own bounded directory, or create workspace |
| GET /api/workspaces/:id/members | Authorized members and viewer role |
| PATCH /api/workspaces/:id/members/:account | Role change or removal using role:null |
| GET, POST /api/workspaces/:id/invitations | Pending invitation metadata, or one-time secret creation |
| DELETE /api/workspaces/:id/invitations/:invitation | Cancel pending invitation |
| POST /api/workspaces/:id/join | Accept an account-bound invitation |

All mutations require an exact configured Origin, an authenticated Secure/HttpOnly host session cookie and a session-bound CSRF proof in the x-dge-csrf header. The separate Secure/SameSite=Strict CSRF cookie is readable by the app solely to deliver that proof. Setting that cookie alone grants no authority; the stored session binding is checked. JSON never supplies trusted account, role, origin or session context. There is no cross-origin API access. Same-origin script compromise remains a risk requiring CSP and secure dependency deployment.

Request bodies are JSON with exact allowed fields, at most 8 KiB. Lists accept unique after/limit parameters, at most 200 entries. The socket peer, never a forwarding header, selects the per-process request budget. Defaults are 120 requests/peer/minute and 2,000 total/minute with at most 4,096 peer buckets. These availability limits are not identity verification or distributed abuse prevention. Server parameters also limit active sessions to 20/account, owned workspaces to 10/account, and pending invitations to 500/workspace. Configurable limits cannot bypass last-owner, origin or role invariants. The future entitlement/admin layer will control paid creation policies separately from participation rights.

Workspace administration requires authentication within five minutes, measured by verified provider auth_time. Reads and protected logout remain available after that window. Sign in again to make access changes. Invitation codes carry the workspace and private one-use token; the UI shows them once, recipients must already have an account, and only that account can join. No invitation mail/discovery adapter is present. Member removal denies subsequent transactions; access and the operation share the workspace lock. A trusted server-only withTenant extension is not callable through HTTP.

## Startup and rollout

Build the app, configure the exact HTTPS PUBLIC_ORIGIN and a real provider, register PUBLIC_ORIGIN/auth/callback, apply migrations with the separate migration credential, and grant a dedicated login the dge_identity_runtime group. Runtime startup verifies exact migration checksums and rejects schema owners and elevated or inherited administrator roles. Configure independent identity keys and direct TLS files as described in OPERATIONS.md. Provider verification must support fresh authentication and verified signatures; there is no production test-login shortcut.

Static serving has an explicit asset allowlist, no-store responses, no source/environment file serving, CSP, no-referrer and no-frame policies. The Node listener validates Host, bounds headers/body/time and uses TLS 1.3. Database certificates and hostnames are verified. TLS termination at any separate edge/proxy needs its own verified encrypted-hop design; this increment does not establish that deployment. Health is liveness, not production readiness.

Account migration 003 preserves applied 001/002, splits member read/write row policies for the own-account directory, adds invitation IDs/creator metadata and an active-session index. It grants read-only migration history to the runtime for startup checks. Historical invitations get generated IDs and null creator metadata; no historical identity/ballot/document is rewritten. Roll back by disabling routes, preserving schema and records.

## Evidence and remaining scope

npm run check covers scoped row access, invitation secrecy/cancellation, forbidden HTTP writes, session replay, exact fields and budget controls. The networked PostgreSQL suite adds real parallel acceptance/cancellation and final-owner races. npm run test:browser exercises the actual UI over local TLS with real openid-client validation against a synthetic signed-token provider: sign in, create workspace, invite/join, change role, reject forged promotion, remove member and revoke sessions. It also checks desktop/mobile layouts for horizontal overflow. Chrome sandbox/certificate exceptions exist only in that isolated fixture. No real provider, account or production credential is used.

Recovery-code issuance uses authenticated `POST /api/recovery-codes`; redemption uses `POST /api/recovery-session` with an exact configured `Origin`. Redemption returns only a short restricted session cookie and a same-site CSRF cookie. It revokes prior sessions and cannot mutate workspace state, satisfy recent-login checks, enroll a passkey or authorize an encrypted device. A restricted session may run authentication against an already-enrolled passkey only as one input to the trusted provider-restoration adapter; that proof does not elevate the session. Codes are shown once and must be stored outside the application. Issuing them requires a recent OIDC session with verified `amr` evidence for multifactor or hardware-key authentication; primary-only sessions receive `STEP_UP_REQUIRED`.

Passkey verification payloads have an explicit 64 KiB ceiling and exact top-level fields. Challenges are one-use, expire after five minutes, and are bound to the initiating account and session. The configured verifier must validate origin, relying-party ID, challenge, user verification, attestation/assertion and the stored credential public key. The engine rejects a missing verifier rather than treating client data as proof. Device authorization stores only a SHA-256 public-key thumbprint after a fresh assertion; it never accepts or returns private key material.

Account JSON requests reject duplicate keys at every nesting level, including escaped-equivalent names, before schema checks or identity writes. Malformed, excessively nested or nonfinite numeric input returns `INVALID_JSON`; this parser guard is not provider or device verification.

The local request budget rejects zero, nonfinite or out-of-range configuration and fails closed if its clock is invalid. It remains a per-process availability guard; fleet-wide abuse protection requires a separately reviewed deployment control.

Source-bound evidence is in security/e2eesa-evidence/DCE-002-account-http-local.json. The engine now has a server-only dual-proof provider-restoration transaction, but no browser route accepts replacement identity claims: only the configured OIDC adapter may supply them. Real callback/UI integration, browser/authenticator interoperability, production verifier/attestation policy, private-content key recovery/rekeying, account discovery, retention, fleet-wide abuse protection and production deployment remain incomplete. Login and recovery never enroll an encryption device or prove private-content authorization. No production security conformance or independent-review claim is made.
