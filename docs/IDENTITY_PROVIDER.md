# New Quill identity provider — DCE-002 contribution

The owner requested a new provider. The deployment candidate uses upstream
Keycloak 26.8.2 (stable release published November 5, 2026), pinned to image digest
`sha256:723b1d6e254c0fc96d5cffec860c7e0744d6a3277822b865bb538cf891575e41`.
The image performs the upstream optimized PostgreSQL build and runs as an
unprivileged user. HTTP is disabled; application and inherited management TLS
use TLS 1.3. Neither the image nor the realm template contains users or passwords.

## Realms, clients and MFA

`deploy/identity/realm.mjs` creates the `quill` realm and distinct confidential
`quill-civic` and `quill-charter` clients. Each client has only its exact
application `/auth/callback` redirect, an exact web origin, authorization-code
flow and S256 PKCE. Implicit, password and service-account grants are disabled.
The two client secrets must be independent random 32-byte values, supplied as
private files. The generator writes an unused private output file with mode 0600,
refuses source-checkout outputs, and does not print secrets. An import contains
client credentials: do not commit it, upload it as a CI artifact, or put it into
an image.

The browser authentication flow requires password and OTP. Keycloak's actual
completed-authenticator AMR mapper supplies `pwd` and `mfa` only from those
executions, with a five-minute freshness window. It is not a hardcoded MFA claim.
OTP codes are not reusable. Enrollment is a separate required action: initial
OTP setup can still produce a primary-assurance session. A new password-plus-OTP
login must occur before MFA-only engine operations such as issuing recovery
codes. The engine continues to enforce its own recent-authentication rules.
This does not claim hardware assurance, proof of a unique natural person,
verified office/constituency, or private-document device authorization.

Self-registration and email-based reset are disabled for the initial controlled
rollout. Named operators create ordinary accounts through Keycloak and users
configure OTP themselves. SMTP/verified-email self-enrollment and operator recovery
must be deliberately configured and tested before claiming open public onboarding.
No mail provider or paid identity subscription has been provisioned.

## Production configuration still required

Use `deploy/identity/provider.env.example` as a names-only inventory. Supply:

- A stable public HTTPS issuer hostname whose TLS path reaches the Keycloak
  process without an undocumented plaintext hop; do not enable HTTP or trust
  arbitrary forwarding headers to make a deployment appear ready.
- Separate PostgreSQL credentials/database for the identity provider. Set a JDBC
  URL using `sslmode=verify-full` and a trusted `sslrootcert`; retain
  `-Djdk.tls.client.protocols=TLSv1.3`. The provider must not share the governance
  runtime's database role or receive private document/device/recovery keys.
- Properly issued server certificate/chain and private-key files mounted from a
  secret store. Fixture certificates and bootstrap users are not production inputs.
- Independent confidential-client secrets and the exact CivicQuill/CharterQuill
  public origins; configure the engine's OIDC issuer as the provider hostname
  followed by `/realms/quill`, with its respective client ID and secret.
- Named MFA-protected operators, removal of the temporary bootstrap account,
  durable database storage, encrypted backups and restore/upgrade drills, rate
  controls, patch review and deployment acceptance. Do not route customer users
  through the master administration realm or expose test fixture accounts.

Create the import with `node deploy/identity/realm.mjs PRIVATE_OUTPUT_PATH`,
using `CIVIC_PUBLIC_ORIGIN`, `CHARTER_PUBLIC_ORIGIN`,
`CIVIC_OIDC_CLIENT_SECRET_FILE` and `CHARTER_OIDC_CLIENT_SECRET_FILE` from secure
configuration. Build the candidate from `deploy/identity`. Inject the private
provider environment and mount TLS files plus the realm import read-only at
`/opt/keycloak/data/import/quill-realm.json`. Start with the image's production
command. Import is bootstrap-only and ignores an existing realm: use audited
administrative changes for subsequent client-secret/policy rotation, never
assume replacing an import updates a running database. Sign-in discovery must
report the exact configured issuer.

## Reproducible local acceptance

Run these commands from a full source checkout. This test runs the real upstream provider, not a synthetic token issuer. It creates
only disposable Docker resources with random credentials, a private local CA,
separate certificate-verified TLS 1.3 PostgreSQL sessions, and one local integration
user. Private files remain outside the checkout and containers carry ownership
labels so cleanup cannot target unrelated services. It does not create cloud
resources or send email.

1. Install locked dependencies and run `npm run build`.
2. Set `DGE_IDENTITY_TEST_STATE` to an unused file in a private temporary directory.
3. Run `python scripts/identity-provider-fixture.py --state "$DGE_IDENTITY_TEST_STATE"`.
4. Set `DGE_BROWSER_EXECUTABLE` to the repository-pinned Chrome Headless Shell.
5. Run `node scripts/run-identity-provider-test.mjs`. Its child adds the local
   fixture CA to inherited trust without disabling Node certificate verification.
6. Always run `python scripts/identity-provider-fixture.py --state "$DGE_IDENTITY_TEST_STATE" --stop`.

The browser test uses an isolated local browser context with the fixture's
self-issued certificates. The Node OIDC client and provider/database clients
verify their TLS peers. The journey creates no claim of publicly trusted browser
certificates: real public DNS/certificate/provider-host acceptance is separate.
The journey proves that primary-assurance enrollment cannot issue recovery
codes, fresh real password/OTP authentication yields an MFA engine session, and
that session can perform an authorized workspace/recovery operation. Unit tests
also exercise exact callback scope, grant restrictions, distinct secrets and
private/non-overwriting CLI output.

Upstream basis: `keycloak/keycloak` tag `26.8.2`, specifically
`AmrProtocolMapper.java`, `AmrUtils.java`, `Constants.java` and
`login-config-totp.ftl`. No upstream cryptographic primitive or token verifier
is replaced. This is a prepared/local-tested provider candidate, not a hosted
service, a completed DCE-002 unit, or independent certification.

The CI provider container is allocated 2 GiB for bootstrap and uses an ordinary
UID with the upstream image's group-0 file-access convention. That group does
not grant container UID 0 or host administration rights. This is a startup-test
allocation, not a measured production capacity claim. The managed local Docker
daemon runs rootless without cgroups, so local runs do not establish enforcement
of a memory limit; the dedicated CI runner must validate that environment.
Failure diagnostics expose only exit/OOM state and bounded error lines after
removing all generated fixture credentials. Never dump container environments.

Fixture CAs include critical certificate-signing usage and subject key identifiers;
leaves include authority/subject identifiers and critical end-entity constraints.
Python's strict X.509 verification is explicitly enabled locally as well as in
CI. A certificate verification error fails immediately instead of being treated
as a warming-up endpoint or bypassed. This corrects the older local Python versus
newer CI Python trust-policy difference without disabling verification.
