# Distributed-Governance-Engine development plan

Approved task scope: the owner's October 16, 2026 request for the shared document engine and two thin applications. Maintainer-authored decomposition version 1. This is a development plan, not a claim that the owner separately reviewed each PR.

The only machine-readable plan is registry/prs.json (39 units). Detailed implementation/acceptance/test/migration specs are in docs/prs/. Unit numbers are stable IDs, never GitHub PR numbers. The foundation is mapped to actual GitHub PR #1; live GitHub owns its current state. Do not equate a foundation commit with accepted unit completion.

| Unit | Planned PR | Dependencies |
| --- | --- | --- |
| [DCE-001](prs/DCE-001.md) | Foundation and deterministic domain contracts | None |
| [DCE-002](prs/DCE-002.md) | Identity, tenants and membership lifecycle | DCE-001 |
| [DCE-003](prs/DCE-003.md) | Private workspace endpoint encryption | DCE-002 |
| [DCE-004](prs/DCE-004.md) | Semantic legal document schema | DCE-001 |
| [DCE-005](prs/DCE-005.md) | Editor shell and essential formatting | DCE-004 |
| [DCE-006](prs/DCE-006.md) | Jurisdiction-aware legal numbering | DCE-005 |
| [DCE-007](prs/DCE-007.md) | Definitions and cross-reference integrity | DCE-006 |
| [DCE-008](prs/DCE-008.md) | Authorized realtime draft collaboration | DCE-003, DCE-005 |
| [DCE-009](prs/DCE-009.md) | Selection anchors and replacement proposals | DCE-007, DCE-008 |
| [DCE-010](prs/DCE-010.md) | Governance policy versions and modes | DCE-009 |
| [DCE-011](prs/DCE-011.md) | Frozen electorates and eligibility evidence | DCE-002, DCE-010 |
| [DCE-012](prs/DCE-012.md) | Durable ballots and verifiable receipts | DCE-011 |
| [DCE-013](prs/DCE-013.md) | Decision closure, deadlines and challenges | DCE-012 |
| [DCE-014](prs/DCE-014.md) | Atomic adoption and conflict management | DCE-013 |
| [DCE-015](prs/DCE-015.md) | Structured claim graph and evidence | DCE-009 |
| [DCE-016](prs/DCE-016.md) | Point voting, rankings and reputation | DCE-015, DCE-012 |
| [DCE-017](prs/DCE-017.md) | Moderation, abuse and transparent appeals | DCE-016 |
| [DCE-018](prs/DCE-018.md) | Clause-level permissions and selective unlocks | DCE-011, DCE-014 |
| [DCE-019](prs/DCE-019.md) | Revision history, redlines and immutable editions | DCE-014 |
| [DCE-020](prs/DCE-020.md) | Canonical manifests and append-only event log | DCE-019 |
| [DCE-021](prs/DCE-021.md) | Merkle batching and transparency witnesses | DCE-020 |
| [DCE-022](prs/DCE-022.md) | Blockchain anchor provider and finality | DCE-021 |
| [DCE-023](prs/DCE-023.md) | Independent document verification tool | DCE-022 |
| [DCE-024](prs/DCE-024.md) | Safe import and document conversion | DCE-007, DCE-019 |
| [DCE-025](prs/DCE-025.md) | Print, PDF and portable exports | DCE-019, DCE-024 |
| [DCE-026](prs/DCE-026.md) | Signing intent, identities and frozen bytes | DCE-018, DCE-025 |
| [DCE-027](prs/DCE-027.md) | Mass signature manifests and appendices | DCE-026, DCE-023 |
| [DCE-028](prs/DCE-028.md) | Unified typed administration and policy simulation | DCE-010, DCE-018, DCE-022 |
| [DCE-029](prs/DCE-029.md) | Entitlements, quotas, credits and exemptions | DCE-028 |
| [DCE-030](prs/DCE-030.md) | Payment provider adapters and reconciliation | DCE-029 |
| [DCE-031](prs/DCE-031.md) | Guided walkthrough and contextual assistance | DCE-005, DCE-015, DCE-028 |
| [DCE-032](prs/DCE-032.md) | Search, notifications and participation digests | DCE-017, DCE-018 |
| [DCE-033](prs/DCE-033.md) | Accessibility, localization and low-bandwidth clients | DCE-025, DCE-031, DCE-032 |
| [DCE-034](prs/DCE-034.md) | Public participation scale and hot-document partitioning | DCE-014, DCE-016, DCE-021 |
| [DCE-035](prs/DCE-035.md) | Operations, backups and recovery drills | DCE-003, DCE-034 |
| [DCE-036](prs/DCE-036.md) | Security adversarial review and supply chain | DCE-023, DCE-027, DCE-030, DCE-033, DCE-035 |
| [DCE-037](prs/DCE-037.md) | Federated and delayed-network protocol | DCE-034, DCE-035 |
| [DCE-038](prs/DCE-038.md) | Extension SDK and release compatibility | DCE-028, DCE-029, DCE-036 |
| [DCE-039](prs/DCE-039.md) | Production candidate and complete release evidence | DCE-038 |

Proceed in dependency order. After each real PR, validate, fix failures, merge only when live GitHub current-head checks and merge preflight permit, update mappings/evidence and continue. Never make human review a development prerequisite. Capacity, required credentials and spending are concrete states; continue independent ready work when one is unavailable.

Release gates: exact-head required CI; applicable security/authorization/accessibility/migration/browser/load tests; isolated approved infrastructure; authentic deployed commit and health evidence; real multiuser and independent artifact-verification journeys. Final human review occurs after deployment, without inventing independent review or certification evidence.

DCE-004 is implemented in actual merged PR #2. The editor foundation contributes to DCE-005; inline link UI, authenticated durable save, IME/network/browser/accessibility evidence and production integration remain incomplete. Contributions must never count as completed unit acceptance.

DCE-002 has a partial server implementation for OIDC login, persisted sessions, membership/invitations, scoped database permissions and audit events. See IDENTITY_FOUNDATION.md and decisions/0002-low-cost-identity.md. Recovery, passkey/device assurance and deployment acceptance remain planned. HTTP/account UI integration now has a TLS browser test with a synthetic provider, pending production acceptance. No hosted service or paid resource is created for this contribution.

The recovery contribution adds rotating, single-use recovery codes, atomic session invalidation, a short read-only recovery session and minimal security-event evidence. It deliberately does not treat recovery as recent OIDC authentication or encrypted-device enrollment. Full provider-loss restoration, passkeys/device assurance and production acceptance remain planned.

The passkey/device-assurance contribution adds verifier-backed, session-bound WebAuthn ceremony state, credential/counter persistence, fresh local step-up and separately revocable device public-key thumbprints. Migration 010 adds immutable attestation-policy evidence, migration 011 adds credential/device revocation containment, and migration 012 adds a server-only provider-restoration transaction requiring both a restricted recovery session and an already-enrolled passkey before fresh verified OIDC claims can replace the provider binding. It deliberately does not ship custom attestation cryptography, content keys, a browser recovery route or a private-workspace authorization claim. Real browser/authenticator interoperability, production verifier/allowlist selection, callback/UI restoration, membership rekeying and production acceptance remain planned.

DCE-005 also includes literal body-text find/replace, bounded replace-all with one-step undo, Unicode-aware positions, safe failures and readonly search. Schema v2 and the editor now preserve canonical HTTPS link/citation atoms with an explicit v1 migration; selected atoms can be edited or unlinked without losing visible text. Citations now support bounded publisher, publication-date, pinpoint and access-date metadata through the schema, editor and deterministic plain-text export. Citation import/resolution against DCE-007, broader IME/accessibility coverage and production integration remain unfinished. A real-Chrome authenticated document journey covers composed Unicode input, an interrupted-save retry, named editor/toolbar semantics, visible keyboard focus and 320-pixel reflow without treating that fixture as production or cross-platform acceptance. Automated browser checks do not establish manual screen-reader or assistive-technology interoperability.

The DCE-002 authentication-time follow-up binds privileged-action freshness to verified provider authentication time, preserves migration 001, and adds ordered migration 002. Legacy sessions without this evidence require a fresh login. Tests cover time-window extension, backward-clock handling and preservation of old account/session records during upgrade.

The public saved-document contribution adds authorized persistence, serial autosave, immutable history, read-only public links and source freezing. It contributes to DCE-005/008 without completing private encryption, realtime merge or editor acceptance. See PUBLIC_DOCUMENTS.md. Public commitments remain pending until later chain finality verification; no paid service is created.

The DCE-009 contribution binds paragraph selections to exact immutable source editions, stores public replacement proposals and rationales, and connects a slide-out review panel. Creation currently requires a workspace contributor role. Public participation policy, structured points/votes, proposal revisions and governance adoption remain unfinished. See TEXT_PROPOSALS.md.

Structured public pro/con/clarification points, typed replies and independent point ratings now contribute to DCE-015/016. Ranking has bounded generation-aware pagination; votes have safe retries, history, self-vote rejection and concurrent-change checks. Workspace contributors only; reputation, moderation, public admission and decision ballots remain pending. See STRUCTURED_DISCUSSION.md.


## October 18, 2026 — verified private-source contributions, not production completion

Merged PR #30 adds client-owned AES-GCM framing for encrypted Yjs binary updates; #33 provides immutable tenant-scoped ciphertext-only private documents (migration 014); #34 adds a durable per-device/epoch replay-controlled ciphertext ledger (migration 015); #35 adds a dedicated TLS 1.3 private WebSocket relay with strict session and device gates; #36 verifies a full signed-in account → TLS WebSocket → Postgres → second Yjs client → member-revocation path with **synthetic** device verification. All changes remain correctly mapped as **partial** DCE-003/DCE-008 contributions in the canonical registry.

The source must not be represented as usable private end-to-end-encrypted collaboration: the backend does not mount its private routes, no production reviewed MLS group-key and attested-device provider is installed, and the private WebSocket service has not been deployed. The real TLS/Postgres integration test is an important boundary test but is not certification or real-hardware assurance. Actual OpenMLS/WASM group integration, encrypted recovery and rotation after removals, sender authentication, snapshot/CRDT convergence across browsers, cross-instance fanout and security/deployment acceptance remain next tasks.

DCE-002 (passkey verifier and provider restoration), DCE-005 (editor/browser/accessibility acceptance), DCE-006/007 (configuration UI and complete reference workflows) remain partial despite tested advances. Do not infer acceptance from contribution PR counts.

The DCE-002 concrete-verifier contribution pins SimpleWebAuthn, adds account add/verify/revoke controls, and verifies native browser ceremonies with a virtual authenticator. See PASSKEY_VERIFIER.md. Production attestation-policy selection, provider restoration UI, real hardware/provider evidence and deployment acceptance remain outstanding. No unit acceptance or PR mapping is invented.

The owner-requested new identity-provider candidate uses pinned Keycloak with
TLS-only endpoints, a separate verified-TLS PostgreSQL database, exact confidential
client callbacks/PKCE, and required password/OTP authentication. A real upstream
provider/engine browser integration proves assurance stays primary during OTP
enrollment and only a fresh verified MFA login permits recovery-code issuance.
See IDENTITY_PROVIDER.md for tested local setup and explicit production inputs.
Public hosting, operator recovery, physical-device assurance and full DCE-002
acceptance remain outstanding; this does not begin downstream application work.
