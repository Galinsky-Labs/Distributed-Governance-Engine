# Unified settings and policy simulation (DCE-028)

Status: implemented on branch `feature/admin-billing` with PGlite tests. Not deployed, not
wired into `server/start.mjs` (see `docs/INTEGRATION-admin-billing.md`), and not independently
reviewed. Passing tests do not establish security compliance.

## Pieces

| File | Role |
| --- | --- |
| `src/settings-registry.mjs` | Pure, browser-safe registry: definitions, value validation, change validation, effective resolution, diffs and calendar periods. |
| `migrations/024-settings-registry.sql` | `dge_settings` schema: platform administrators, append-only versions, row policies, deployment impact function. |
| `server/settings-store.mjs` | Authorization, validation, simulation, versioning, rollback, history verification. Also exports `createPlatformAccess`. |
| `server/settings-http.mjs` | Routes inside the common account handler. |
| `scripts/grant-platform-admin.mjs` | The only way to grant or revoke platform administration (migration credential). |
| `web/admin-console.jsx` | Role-aware editor (see the integration guide for props). |

## The registry

Every parameter has a key, label, group, type, range or allowed values, a default, the scopes at
which it may be set, a mutability class, an invariant class and a `consumer` that says honestly
who reads it today:

* `entitlements` / `billing` — enforced by the entitlement and billing services in this branch;
* `settings` — enforced by the settings service itself (public-anchoring invariant);
* `consumer-integration` — validated, versioned and resolvable, but **no engine code reads it
  yet**. The owning feature must call `settings.resolveWithin(db, …)` to apply it;
* `invariant` — a fixed rule, shown for transparency, never changeable.

Types: `boolean`, `integer`, `decimal` (canonical decimal string, exact comparison by scaled
`BigInt`, normalized by stripping trailing zeros), `enum`, `string` (trimmed, no control
characters, optional pattern or IANA `time-zone` format), `duration-hours` (whole hours),
`money` (`{currency: ISO 4217, amountMinor: safe integer}`), `list` (dense, bounded, optionally
unique), and `record` (closed set of fields, optional cross-field check). Values must be plain
data; accessors, symbols, sparse arrays and unknown fields are rejected without invoking getters.

Scopes: `platform` → `product` (`civic` | `charter`) → `tenant` (workspace) → `document`.

| Key | Type | Default | Scopes | Mutability | Consumer |
| --- | --- | --- | --- | --- | --- |
| documents.modesAllowed | list of enum | collaboration, public-input | platform–tenant | mutable | consumer-integration |
| votes.quorumFraction | decimal (0,1] | 0.5 | all | locked while a vote is active | consumer-integration |
| votes.approvalFraction | decimal (0,1] | 0.5 | all | locked while a vote is active | consumer-integration |
| votes.approvalComparison | enum gt/gte | gt | all | locked while a vote is active | consumer-integration |
| votes.deliberationHours | duration 0–720 | 0 | all | locked while a vote is active | consumer-integration |
| votes.challengeHours | duration 0–720 | 48 | all | locked while a vote is active | consumer-integration |
| trust.tiersAllowed | list of primary/multifactor/hardware-bound | all three | all | locked while a vote is active | consumer-integration |
| points.rankingProfile | enum | wilson-lower-bound | all | mutable | consumer-integration |
| abuse.pointsPerHour / abuse.proposalsPerDay | integer | 30 / 20 | platform–tenant | mutable | consumer-integration |
| abuse.requestsPerMinute | integer 10–10000 | 120 | platform, product | mutable | consumer-integration |
| organization.privacyDefault | enum private/public | private | platform–tenant | mutable | consumer-integration |
| anchoring.enabled | boolean | false | all | mutable; invariant class public-anchoring-required | settings |
| anchoring.cadenceMinutes | integer 5–10080 | 60 | platform–tenant | mutable | consumer-integration |
| export.fontsAllowed | list of font names | Source Serif 4, Inter | platform–tenant | mutable | consumer-integration |
| export.watermark | enum none/unadopted-drafts/always | unadopted-drafts | all | mutable | consumer-integration |
| billing.catalog | list of catalog records | `[]` (no prices in code) | platform, product | mutable | billing |
| quotas.weeklyFreeDocuments | integer 0–1000 | 1 | platform, product | mutable | entitlements |
| quotas.weekTimeZone | IANA time zone | UTC | platform, product | mutable | entitlements |
| quotas.storageBytes | integer | 30000000 | platform, product | mutable | consumer-integration |
| entitlements.consumptionOrder | permutation of weekly-allowance, grants, credits | that order | platform, product | mutable | entitlements |
| officials.grantPolicy | record `{mode: unlimited \| monthly-cap, monthlyCap?}` | unlimited | platform, product | mutable | entitlements |
| officials.heavyUseMonthlyThreshold | integer | 200 | platform, product | mutable | entitlements |
| roles.capabilities | record of capability lists per role | see source | platform–tenant | mutable | consumer-integration |
| notifications.defaults | record | proposals, decisions on; weekly digest | all | mutable | consumer-integration |
| retention.auditDays / retention.draftCacheDays | integer | 2555 / 30 | platform–tenant | mutable | consumer-integration |
| invariants.* (five keys) | — | fixed | none | invariant | invariant |

Catalog records: `{id, kind: subscription | credit-pack | single-document, label, price: money,
quantity?, unlimited?, interval?: month | year, subject?: account | tenant | either}`. A
subscription has an interval and either a per-period `quantity` or `unlimited: true`; a credit
pack has a `quantity`; a single-document purchase grants exactly one creation. Prices must be
positive. `roles.capabilities` must keep `manage-settings` for owners and `read` for every role.

## Hard invariants

No scope can set these keys; every attempt fails closed with HTTP 403 and the listed code.

| Invariant | Key | Error code |
| --- | --- | --- |
| Public anchoring required | invariants.publicAnchoringRequired | INVARIANT_PUBLIC_ANCHORING_REQUIRED |
| Public-input sources immutable | invariants.publicInputImmutable | INVARIANT_PUBLIC_INPUT_IMMUTABLE |
| Signed content immutable | invariants.signedContentImmutable | INVARIANT_SIGNED_CONTENT_IMMUTABLE |
| Frozen ballots immutable | invariants.frozenBallotsImmutable | INVARIANT_FROZEN_BALLOTS_IMMUTABLE |
| Cryptographic profile | invariants.cryptoProfile | INVARIANT_CRYPTO_PROFILE |

`anchoring.enabled` controls anchoring of organization (non-public) documents. Resolution for a
public document always yields `{value: true, source: "invariant", locked: true}`, and writing
`false` at a public document's scope fails with `INVARIANT_PUBLIC_ANCHORING_REQUIRED`. Every
document in `dge_documents` is public today, so document-scope views always show the invariant.

These keys describe guarantees implemented elsewhere (frozen public-input editions in the
document store, frozen decision snapshots in the decision store, append-only tables). The
registry makes them visible and unchangeable through configuration; it does not itself
implement those guarantees.

## Resolution and sources

`resolveEffectiveSettings(layers, {product, visibility})` returns, for every key,
`{value, source, locked}`. Sources: `default`, `platform`, `product:civic` / `product:charter`,
`tenant`, `document`, `invariant`. A layer only contributes keys allowed at its scope. Stored
overrides that no longer validate (for example after a registry change) are skipped and listed
in `ignoredOverrides` rather than applied. Workspace and higher views resolve with organization
visibility so the stored `anchoring.enabled` value is shown; document views resolve as public.

## Permissions

| Scope | Read effective values | Simulate / change / rollback / history |
| --- | --- | --- |
| platform, product | any signed-in account | listed platform administrator; changes need an identity-provider session authenticated within the last 300 s |
| tenant | any workspace member | owner, admin (changes need recent authentication) |
| document | any workspace member | owner, admin, editor (changes need recent authentication) |

Platform administrators are rows in `dge_settings.platform_admins`, writable only by the
migration owner. `node scripts/grant-platform-admin.mjs grant|revoke <account-uuid> "<reason>"`
uses `MIGRATION_DATABASE_URL`; each change also writes an append-only
`platform_admin_events` row. There is no self-service or HTTP path.

## Change workflow

1. **Validate** — the browser and the server run `validateSettingsChange` with the same registry.
   `changes` maps keys to new values, or to `null` to remove the override and inherit.
2. **Simulate** — `POST …/settings/simulate {changes, expectedVersion}` returns
   `{valid, errors[], currentVersion, stale, diff[], affected, frozenDecisionNotice}`. `diff`
   lists effective before/after values with sources. `affected` counts documents and open
   decisions in the workspace (tenant scope), the document and its open decisions (document
   scope), or deployment-wide tenants/documents/open decisions (platform and product scope).
   Open decisions keep the policy frozen when they opened; the notice says so when vote rules
   change. Simulation writes nothing.
3. **Change** — `POST …/settings {changes, expectedVersion, reason}`. The target is locked with an
   advisory lock, the current version must equal `expectedVersion` (else
   `409 SETTINGS_VERSION_CONFLICT`), the change is re-validated, and a new version row stores the
   complete override map, the delta, reason, actor and time. A no-op fails with
   `NO_SETTINGS_CHANGE`.
4. **Rollback** — `POST …/settings/rollback {toVersion, expectedVersion, reason}` re-validates the
   old override map against current rules and appends it as a new version with `rollbackOf`.
   History is never rewritten.
5. **History** — `GET …/settings/history?before=&limit=` returns newest first with
   `verified: true` only if every returned row's digest
   (`digest('settings-version-v1', {target, version, overrides, changes, reason, actorId, createdAt, rollbackOf, previousDigest})`)
   recomputes and links to the next older row.

Document-scope changes to keys marked "locked while a vote is active" fail with
`409 SETTING_LOCKED_ACTIVE_VOTE` while the document has an open decision. Workspace-scope vote
rule changes are allowed and never alter open decisions, which keep their frozen snapshot.

Other errors: `UNKNOWN_SETTING` 400, `INVALID_SETTING_VALUE` 400, `SETTING_SCOPE_NOT_ALLOWED`
403, `PLATFORM_ADMIN_REQUIRED` 403, `REAUTHENTICATION_REQUIRED` 403,
`RECOVERY_SESSION_RESTRICTED` 403, `SETTINGS_VERSION_NOT_FOUND` 404, `INVALID_SETTINGS_SCOPE`
400, `DOCUMENT_NOT_FOUND` 404. Identity failures keep the account handler's mapping
(`AUTHENTICATION_REQUIRED` 401, `ACCESS_DENIED` 403).

## Routes

| Method and path | Purpose |
| --- | --- |
| `GET /api/settings?scope=platform` or `?scope=product&product=civic` | Read a platform or product layer with effective values |
| `POST /api/settings` `{scope, product?, changes, expectedVersion, reason}` | Change |
| `POST /api/settings/simulate` `{scope, product?, changes, expectedVersion}` | Simulate |
| `POST /api/settings/rollback` `{scope, product?, toVersion, expectedVersion, reason}` | Rollback |
| `GET /api/settings/history?scope=…&product=…&before=&limit=` | History |
| `GET/POST /api/workspaces/{tenantId}/settings[/simulate\|/history\|/rollback]` | Workspace layer |
| `GET/POST /api/workspaces/{tenantId}/documents/{documentId}/settings[/…]` | Document layer |

Read responses: `{target, version, overrides, effective, ignoredOverrides, editableKeys, role, activeVote}`.

## Storage and database controls

* `dge_settings.versions` — one row per version per target (`platform`, `product:<p>`,
  `tenant:<id>`, `document:<tenant>:<doc>`), primary key `(target, version)`, digest chain,
  `BEFORE UPDATE OR DELETE` trigger that rejects rewrites (also for the migration owner),
  ENABLE + FORCE row security. Requests read platform/product rows and their own workspace's
  rows; they insert workspace/document rows only for `dge.tenant_id` with
  `actor_id = dge.account_id`, and platform/product rows only when `actor_id` is an unrevoked
  platform administrator. The request role has `SELECT, INSERT` only.
* `dge_settings.platform_admins` / `platform_admin_events` — FORCE row security; a request can
  only see whether its own account (`dge.account_id`) is an administrator; only the migration
  owner can write.
* `dge_settings.platform_impact()` — `SECURITY DEFINER`, returns three counts and only when the
  caller's `dge.account_id` is an unrevoked administrator. To let it count, migration 024 adds
  read-only `settings_impact_owner` policies for the migration owner role on
  `dge_identity.tenants`, `dge_documents.documents` and `dge_decisions.decisions`. The request
  role gains nothing from those policies.

## Limitations

* Settings marked `consumer-integration` are not yet enforced by any engine code path (for
  example the decision store still takes its vote policy from the request; `quotas.storageBytes`
  does not change the document store's configured byte budget).
* Platform and product scopes have no workspace, and `identity-store.mjs` exposes no
  tenant-less in-transaction session check. These routes therefore authenticate with
  `identity.sessionInfo` in one transaction and check administrator status and write in a
  second. The route still requires the exact `Origin` and a well-formed CSRF header (`write()`),
  but the CSRF token is not compared with the session's stored digest for these scopes, and a
  session revoked between the two transactions could complete one in-flight request.
* Product-scope impact counts are deployment-wide: a deployment serves one product and tenants
  carry no product column.
* Simulation does not count tenants whose own overrides would shadow a platform change.
* Concurrency tests run on PGlite, which serializes transactions; real-Postgres races rely on
  the advisory lock plus the `(target, version)` primary key (unique violations map to 409).
