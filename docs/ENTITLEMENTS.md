# Entitlements, quotas, credits and exemptions (DCE-029)

Status: implemented on branch `feature/admin-billing` with PGlite tests; not deployed and not
wired into `server/start.mjs`. Files: `server/entitlement-store.mjs`,
`migrations/025-entitlements-and-payments.sql`, the optional hook in `server/document-store.mjs`,
`server/billing-http.mjs` (routes) and `web/billing-panel.jsx`.

## Principles

* Entitlements only gate **creating a new document**. Reading, discussing, proposing and voting
  never consult this service, and nothing here changes memberships, decisions, ballots or
  documents. When a subscription or grant ends, existing documents and every member's
  participation stay exactly as they were (tested by reading and voting after expiry).
* Grants are independent of payment providers. A provider event only ever creates or ends a
  grant or a ledger entry through provider-neutral functions (`entitlements.within`).
* No price or quota is fixed in code: allowance, order, time zone and official caps come from
  the settings registry (`docs/SETTINGS.md`), prices from `billing.catalog`.
* Nothing charges anyone automatically. A "paid offer" is information returned to the client.

## Model

**Grant** (`dge_billing.grants`): subject (exactly one account or one workspace), resource
(`document-create`, `storage-bytes`, `seats`), quantity per period or unlimited (`null`),
period (`none`, `week`, `month`, `year`), effective and optional expiry time, provenance
(`subscription`, `single-document`, `credit-pack`, `administrator`, `verified-official`,
`enterprise-license`), provenance reference, reason, creator and a unique idempotency key. A
trigger allows exactly one later change: setting `revoked_at`/`revoked_reason`. The weekly
allowance is not stored as a grant; it is computed from settings and reported as `allowance`.

**Credit ledger** (`dge_billing.credit_ledger`): append-only entries `purchase`, `reserve`,
`refund`, `revoke` with signed integer deltas, the resulting balance and a unique idempotency
key. `dge_billing.balances` holds the current balance per subject with `CHECK (credits >= 0)`;
it is only changed under a row lock together with a ledger entry. Reusing an idempotency key
with a different subject, kind, amount or grant fails with `409 IDEMPOTENCY_KEY_REUSED`; reusing
it identically returns the original entry. Purchased credits (credit packs and single-document
purchases) are a grant for provenance plus a `purchase` ledger entry.

**Usage** (`dge_billing.usage`): one row per created document (unique per workspace document and
per workspace command ID) naming the source used: `weekly-allowance`, `grants` (with the grant)
or `credits` (with the ledger entry). **Refunds** (`dge_billing.usage_refunds`) are separate rows
keyed by the usage ID, so a refund can happen at most once.

## What counts

| Action | Counts as a creation? |
| --- | --- |
| `documents.create` committing a new document | yes, exactly one unit |
| Replaying `create` with the same command ID | no (the document store returns the earlier result before the hook runs) |
| Saving, restoring an earlier revision, freezing as public input | no |
| Proposals, public-input suggestions, discussion points, ballots | no |
| A creation whose transaction fails (validation, ID conflict, storage limit, missing entitlement) | no: the reservation is in the same transaction and rolls back with it |
| A committed creation an administrator later classifies as failed | refunded once via `refundCreation` |

Copies, archived documents and reopened editions do not exist as engine operations yet; when
added they must decide explicitly whether to call the hook.

## Reservation

`createDocumentStore({…, entitlements})` calls
`entitlements.reserveDocumentCreation(db, {tenantId, accountId, documentId, commandId})` inside
the creation transaction, right after the document row is inserted. Without the option the
document store behaves exactly as before (all pre-existing tests run unchanged).

The reservation sets `dge.account_id`, reads effective settings in the same transaction, then
locks the creator's and the workspace's balance rows (`SELECT … FOR UPDATE`), which serializes
concurrent creations for the same account and workspace. Sources are tried in
`entitlements.consumptionOrder` (default `weekly-allowance`, `grants`, `credits`):

1. **weekly-allowance** — `quotas.weeklyFreeDocuments` per creator account per week;
2. **grants** — active, unrevoked `document-create` grants of the creator, then of the workspace,
   ordered by soonest expiry; each grant's usage is counted within its period (calendar
   week/month/year in the configured zone, or its whole validity for `none`);
3. **credits** — the creator's balance, then the workspace's.

If nothing covers the creation it fails with `402 ENTITLEMENT_REQUIRED` and the transaction
(including the document row) rolls back.

### Weekly and monthly boundaries

Weeks start Monday 00:00 and months on the 1st at 00:00 in `quotas.weekTimeZone` (IANA, default
UTC). `periodWindow` in `src/settings-registry.mjs` finds local midnight with a two-pass offset
correction, so windows are 167 or 169 hours long across DST changes. Tests cover the US spring
change (a creation at 23:59:59 Sunday local time and another at 00:00:00 Monday local time fall
in different weeks) and the European autumn change.

## Officials, caps and paid offers

Platform administrators grant `verified-official` entitlements with resource `document-create`,
period `month` and a required expiry (the term end). Proof of office stays outside this
service; the grant reason records only the administrator's note.

* `officials.grantPolicy = {mode: "unlimited"}` (default): the grant's own quantity applies
  (`null` = unlimited).
* `{mode: "monthly-cap", monthlyCap: n}`: at most `min(quantity, n)` per calendar month.
* `officials.heavyUseMonthlyThreshold`: at or above it, `status()` returns
  `paidOffer: {reason: "official-heavy-use", automaticCharge: false}` while creation continues.
* When the cap is reached, creation from that grant stops for the month (other sources still
  apply) and `paidOffer.reason` is `official-monthly-cap-reached`.
* After expiry the grant reports `state: "expired"` with its `expiresAt`, so a downgrade is
  always explained.

## Operations

| Function | Who | Notes |
| --- | --- | --- |
| `status(credentials)` | any signed-in account | allowance (`limit, used, remaining, periodStart, resetsAt, timeZone`), own credits, grants with state and current-period use, official usage, `paidOffer`, consumption order |
| `tenantStatus(credentials, tenantId)` | workspace owner/admin | workspace credits, grants, last 50 reservations with refund times |
| `createGrant(credentials, {subject, resource, quantity, period, effectiveAt?, expiresAt?, provenance, reason, idempotencyKey})` | platform administrator, recent sign-in | provenance `administrator`, `verified-official` or `enterprise-license` |
| `revokeGrant(credentials, grantId, {reason})` | platform administrator | administrator-provenance grants only; once |
| `refundCreation(credentials, {usageId, reason})` | platform administrator | exactly once (advisory lock + primary key); credits return to the subject they came from; allowance/grant usage stops counting |
| `reserveDocumentCreation(db, …)` | document store hook | see above |
| `within.purchaseCredits / grantPeriod / revokeCredits / endGrants` | billing service in billing-worker mode | provider-neutral ledger operations |

Routes: `GET /api/entitlements`, `GET /api/workspaces/{tenantId}/entitlements`,
`POST /api/entitlements/grants`, `POST /api/entitlements/grants/{grantId}/revoke`,
`POST /api/entitlements/refunds`, plus the manual-payment routes in `docs/PAYMENTS.md`.

## Database controls

Every subject table has ENABLE + FORCE row security with one policy: a row is visible and
writable when its `tenant_id` equals `dge.tenant_id`, its `account_id` equals `dge.account_id`,
or the transaction declared `dge.worker = 'billing'`. The billing-worker mode is entered only by
verified provider processing, reconciliation and platform-administrator operations after their
checks. The request role has `SELECT, INSERT` plus column-limited `UPDATE` grants
(grant revocation, balance, checkout and subscription state); ledger, usage, refunds and provider
links reject `UPDATE`/`DELETE` with triggers even for the table owner.

## Limitations

* `storage-bytes` and `seats` grants can be recorded and are reported, but nothing enforces
  them yet; the document store still uses its configured `maxStoredBytes`.
* Tests use PGlite, which serializes transactions. Under real Postgres, double spending is
  prevented by the balance row locks and `CHECK (credits >= 0)`; this was not exercised against
  a multi-connection server in this branch.
* `dge.account_id` and `dge.tenant_id` are set by trusted server code; row security is defense
  in depth, not a substitute for the store checks.
* Grants and allowances are per account and per workspace; there is no per-document or
  per-product entitlement scope.
