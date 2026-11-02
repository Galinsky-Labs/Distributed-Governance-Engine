# Quill governance application: deployable runtime candidate

This package runs the actual shared CivicQuill/CharterQuill governance application, not the offline editor. Routes: /governance for workspaces, public documents, proposals, discussions and voting; /account for identity and membership; / for document editing; /api/public/documents for anonymous discovery.

## Prerequisites

1. A public hostname and **end-to-end TLS 1.3** to the Node process. This application serves HTTPS itself: do not place it behind a load balancer that silently sends plaintext HTTP to the container. PUBLIC_ORIGIN must exactly match the browser HTTPS origin. Mount the server private key and chain certificate from a secret store; never commit either.
2. PostgreSQL 17 or compatible, with CA-verified TLS 1.3. Use separate privileged MIGRATION_DATABASE_URL and least-privileged DATABASE_URL runtime logins. Do not use a table owner/superuser for the application.
3. An external OIDC identity provider supporting https://YOUR_HOST/auth/callback, exact issuer, client ID and client secret. In-process fixture identities are tests only and cannot be used on the public internet.
4. Two distinct cryptographically random 32-byte lowercase hex secrets for SESSION_KEY and OIDC_STATE_KEY, injected from a secure secret manager, not included in source, images, or logs.
5. A firewall and protected origin, migration/recovery process, backup/restore policy, rate limits, monitoring, and genuine deployment acceptance. Public documents are public; do not use them for private organizational information.

## Database migration and roles

Using a separate privileged migration-only database login, set MIGRATION_DATABASE_URL and run:

    node scripts/migrate-identity.mjs

The migrator applies checksummed migrations transactionally, and refuses an inconsistent history. It creates the NOLOGIN permissions group dge_identity_runtime with forced tenant row-level security. An administrator must create a separate LOGIN role for the application, grant only the intended group membership/table access, and verify it has no SUPERUSER, CREATEDB, CREATEROLE, BYPASSRLS, REPLICATION or table/schema ownership powers. Never grant this login migration credentials. Startup runs verifyIdentityRuntime and fails closed if roles or migrations are wrong.

## Runtime environment

| Key | Required value |
| --- | --- |
| PUBLIC_ORIGIN | Exact public HTTPS origin |
| DATABASE_URL | Verified-TLS PostgreSQL application login |
| OIDC_ISSUER | Trusted OIDC provider issuer |
| OIDC_CLIENT_ID | Registered provider client |
| OIDC_CLIENT_SECRET | Injected client secret |
| SESSION_KEY | 64 lowercase hex chars, independently random |
| OIDC_STATE_KEY | Separate 64 lowercase hex chars |
| TLS_KEY_FILE | Mounted private-key file |
| TLS_CERT_FILE | Mounted chain certificate file |
| QUILL_PRODUCT | civic or charter |
| PORT | HTTPS port, default 8443 |
| BIND_ADDRESS | Explicit bind address; default 127.0.0.1 |

The Docker image includes the compiled governance client, server logic and migrations. It starts node server/start.mjs as an unprivileged user. It is designed to fail when required credentials or TLS files are unavailable. Build with:

    docker build -t quill-governance .

A publicly accessible container needs an approved direct-TLS network ingress and securely mounted secret files. The artifact does not register a domain, provision the database, configure external OIDC or activate accounts by itself.

GET /healthz checks process liveness. GET /readyz checks the configured runtime database connection. Neither proves the identity provider is reachable or that the product is legally certified.

## Acceptance required before customer launch

- Exact release SHA passes lint, unit and fuzz checks, real PostgreSQL RLS/migration tests, two-account browser voting, anonymous discovery and Docker negative-boot tests.
- External staging proves real OIDC login, TLS verification, least privilege, CSRF and hostile-input defense, backup/restore and dependency/source integrity.
- Governance ballots, applied public drafts and checksum receipts remain separate from legally executed legislation or resolutions, externally qualified identity, organization-private encryption, signing, and blockchain finality.
- Membership currently verifies authenticated accounts, **not necessarily unique natural persons**. Corporate share-weighted electorates, delegated proxies and voter identity qualifications remain separate release gates.

The CI release Quill-Governance-Engine.tgz is the actual source+compiled runtime **candidate**, not a hosted service URL. Audit and pin the container base image digest before production release. Rehearse schema upgrades and backups; reverting the container alone cannot reverse database migrations.
