# Integrating settings, entitlements and billing

This branch does not edit `server/start.mjs`, `server/application.mjs`, `web/app.jsx` or
`web/governance-home.jsx`. This guide is what the integrator wires. See `docs/SETTINGS.md`,
`docs/ENTITLEMENTS.md` and `docs/PAYMENTS.md` for behaviour.

## Database

Migrations `024-settings-registry.sql` and `025-entitlements-and-payments.sql` are already
registered in `server/identity-store.mjs` and run with `npm run migrate`
(`MIGRATION_DATABASE_URL`). They create `dge_settings` and `dge_billing`, grant the request role
`dge_identity_runtime` only what the stores need, and add read-only `settings_impact_owner`
policies for the migration owner on `dge_identity.tenants`, `dge_documents.documents` and
`dge_decisions.decisions` (used by `dge_settings.platform_impact()`).

`verifyIdentityRuntime` does not list `dge_settings`/`dge_billing` in its ownership check; the
request credential must not own them either.

Grant the first platform administrator with the migration credential:

```sh
MIGRATION_DATABASE_URL=… node scripts/grant-platform-admin.mjs grant <account-uuid> "Initial operator"
```

## Server wiring

```js
import {createSettingsStore} from "./settings-store.mjs";
import {createSettingsRoutes,settingsBodyLimit} from "./settings-http.mjs";
import {createEntitlementStore} from "./entitlement-store.mjs";
import {createBillingStore} from "./billing-store.mjs";
import {createBillingRoutes,billingBodyLimit} from "./billing-http.mjs";
import {stripeProviderFromEnvironment} from "./payment-providers/stripe.mjs";
import {manualProviderFromEnvironment} from "./payment-providers/manual.mjs";

const transaction=pgTransactions(pool);
const product=process.env.QUILL_PRODUCT ?? "civic";
const settings=createSettingsStore({identity:store,transaction,product});
const entitlements=createEntitlementStore({identity:store,transaction,settings});
const billing=createBillingStore({identity:store,transaction,settings,entitlements,origin,
  providers:[stripeProviderFromEnvironment(),manualProviderFromEnvironment()]});
const documents=createDocumentStore({identity:store,transaction,entitlements}); // omit `entitlements` to keep creation free
// extensions: [...existing, createSettingsRoutes({settings}), createBillingRoutes({entitlements,billing})]
// bodyLimit: path => Math.max(...existing, settingsBodyLimit(path), billingBodyLimit(path))
```

### Factories and options

| Factory | Required | Optional (default) |
| --- | --- | --- |
| `createSettingsStore` | `identity`, `transaction` | `product` (`"civic"`), `clock` (`Date.now`), `reauthenticationSeconds` (300), `platformAccess` |
| `createPlatformAccess` | `identity` | `clock`, `reauthenticationSeconds` |
| `createEntitlementStore` | `identity`, `transaction`, `settings` | `clock`, `platformAccess`, `reauthenticationSeconds` |
| `createBillingStore` | `identity`, `transaction`, `settings`, `entitlements`, `origin` (exact `https://` origin) | `providers` (`[]`), `clock`, `platformAccess`, `reauthenticationSeconds` |
| `createStripeProvider` | — (unavailable without keys) | `secretKey`, `webhookSecret`, `fetch` (`globalThis.fetch`), `apiBase`, `apiVersion`, `toleranceSeconds` (300, range 30–900), `clock` |
| `createManualProvider` | — | `enabled` (`false`) |
| `createDocumentStore` | as before | new `entitlements` (`null`): any object with `reserveDocumentCreation(db, {tenantId, accountId, documentId, commandId})` |
| `reconcilePayments` | `transaction`, `provider` | `limit` (200, max 1000), `clock` |

Environment helpers: `stripeProviderFromEnvironment(env = process.env, options)` reads
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_API_VERSION`;
`manualProviderFromEnvironment(env)` reads `BILLING_MANUAL_INVOICING`.

### Routes and body limits

| Export | Paths | Limit |
| --- | --- | --- |
| `createSettingsRoutes({settings})`, `settingsBodyLimit(path)` | `/api/settings[/simulate\|/history\|/rollback]`, `/api/workspaces/{t}/settings[…]`, `/api/workspaces/{t}/documents/{d}/settings[…]` | 65536 for settings paths, else 8192 |
| `createBillingRoutes({entitlements,billing})`, `billingBodyLimit(path)` | `/api/entitlements…`, `/api/workspaces/{t}/entitlements`, `/api/billing/checkout`, `/api/billing/webhooks/{provider}` | 65536 for webhook paths, else 8192 |

Both factories return `null` for paths they do not own, so their order relative to the existing
extensions does not matter. Successful `POST`s return 200 (the account handler only uses 201 for
`/documents`, `/proposals` and `/points`).

Webhook requests come from the provider without cookies, `Origin` or `Sec-Fetch-Site`, so the
account handler lets them through; the route authenticates them by signature. Configure the
Stripe endpoint as `PUBLIC_ORIGIN + /api/billing/webhooks/stripe` with events
`checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`,
`customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created`. Checkout returns to
`PUBLIC_ORIGIN/account?billing=success` or `?billing=cancelled`.

The per-peer request budget in the account handler also applies to webhook deliveries.

## Browser components

```jsx
import {AdminConsole} from "./admin-console.jsx";
import {BillingPanel,formatMoney} from "./billing-panel.jsx";

<AdminConsole target={{scope:"platform"}}/>
<AdminConsole target={{scope:"product",product:"charter"}}/>
<AdminConsole target={{scope:"tenant",tenantId}}/>
<AdminConsole target={{scope:"document",tenantId,documentId}}/>
<BillingPanel tenantId={tenantId /* optional */}/>
```

| Component | Props |
| --- | --- |
| `AdminConsole` | `target` (as above, required); `api` (default `createAccountAPI()` from `web/account-api.mjs`) |
| `BillingPanel` | `tenantId` (optional; workspace data shows only to owners/admins); `api` (default `createAccountAPI()`); `navigate(url)` (default `window.location.assign`) |
| `formatMoney({currency, amountMinor}, locale?)` | exact formatting from integer minor units |

The console only renders edit controls for `editableKeys` returned by the server; the server
re-checks everything. The panel shows purchase buttons only for providers the server reports as
available and only when the catalog is not empty.

## Environment variables

| Name | Used by | Required |
| --- | --- | --- |
| `MIGRATION_DATABASE_URL` | `scripts/grant-platform-admin.mjs` | for administrator changes |
| `DATABASE_URL` | `scripts/reconcile-payments.mjs` (request credential) | for reconciliation |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe adapter | no; absent means unavailable |
| `STRIPE_API_VERSION` | Stripe adapter | no |
| `BILLING_MANUAL_INVOICING` | manual provider | no; `enabled` to turn on |

No new npm dependency is used.
