# Mounting federation and edge-cacheable editions

Nothing in this branch is wired into `server/platform.mjs` or `server/runtime.mjs`; both features are platform
extensions that an application (CivicQuill, CharterQuill or the engine entry point) opts into. This keeps existing
deployments unchanged until an operator enables them.

## 1. Migration

`migrations/028-federation.sql` is listed in `server/identity-store.mjs` (`migrationRecords`, applied as identity
migration version 27 because the list is positional) and `dge_federation` is in the schema list that
`verifyIdentityRuntime` checks for ownership. Run the normal migration step with the migration credential
(`npm run migrate`); the runtime then refuses to start against a database without it. The migration also adds the
public-read indexes and drops a ballots index that duplicated its primary key prefix (DCE-034). If another branch adds
`027-*.sql`, insert it before 028 in the list before either is applied anywhere, or the positional versions will clash.

## 2. Platform extensions

Federation needs the transparency ledger, so `LOG_ID` and `LOG_SIGNING_KEY` must be configured (they already are for
signed checkpoints). The instance identity is that log id and key.

```js
import { runPlatform } from "@distributed-governance/engine/runtime"; // server/runtime.mjs
import { loadLogSigningKey } from "./server/ledger.mjs";
import { createFederationExtension } from "./server/federation-http.mjs";
import { createImmutableEditionExtension } from "./server/public-edition-cache-http.mjs";

const env = process.env;
await runPlatform({
  extensions: [
    createImmutableEditionExtension(),
    createFederationExtension({
      origin: env.PUBLIC_ORIGIN,
      signingKey: loadLogSigningKey(env.LOG_SIGNING_KEY), // the same key the ledger uses
      intervalMs: 10_000,          // worker cadence
      maxMergeDelayMs: 3_600_000,  // receipts must be in a checkpoint within this delay
    }),
  ],
});
```

Or directly with `createPlatform({ …, logId, logSigningKey, extensions: [...] })`. Each extension follows the platform
contract `{ id, createRoutes(services) => [{ routes, bodyLimit }], createWorkers(services) => [{ name, intervalMs, tick }] }`:

| Extension | Routes | Worker |
|---|---|---|
| `edition-cache` | `GET /api/public/documents/:id?version=N` with `Cache-Control: public, max-age=31536000, immutable` and a digest `ETag`; everything else falls through to the document routes | none |
| `federation` | `/api/federation/*` and three workspace routes (below); body limit 4 MiB for the peer inbox, 64 KiB for other federation posts | `federation` (`tick()`: export checkpoints and snapshots, apply inbox in order, deliver outbox with backoff, audit relayed receipts) |

`services.isPlatformAdmin(credentials)` must be provided by the application for peer registration routes, exactly as
for ledger witness registration; without it they return 403.

## 3. Routes

| Route | Authentication | Purpose |
|---|---|---|
| `GET /api/federation/instance` | none | instance id, origin, log public key and key id (verify out of band before pinning) |
| `POST /api/federation/peers` `{instanceId, origin, publicKey, maxDelayMs?}` | session + CSRF + platform admin | pin a peer |
| `POST /api/federation/peers/:id/status` `{status}` | session + CSRF + platform admin | `active` / `suspended` |
| `POST /api/federation/rotations` | the rotation's own signatures | follow a peer key rotation signed by its pinned key |
| `POST /api/federation/inbox` `{messages}` | Ed25519 signed request from a pinned peer, single-use nonce | store-and-forward delivery |
| `POST /api/federation/ballots` | envelope + authority-signed key binding | submit a delayed ballot (authority decides; mirror relays) |
| `GET /api/federation/receipts/:envelopeId` | none | authority receipt, or mirror's signed relay statement and receipt |
| `GET /api/federation/decisions/:decisionId` | none | signed decision descriptor (delay class, cutoff) |
| `GET /api/federation/documents/:documentId` | none | signed snapshot; mirrors label it `readOnly` with its `authority` |
| `GET /api/federation/evidence?limit=` | none | split views, conflicts, omissions, equivocation |
| `POST /api/workspaces/:t/documents/:d/federation` `{replicas}` | session + CSRF, owner/admin, recent auth | claim authority, name mirrors |
| `POST /api/workspaces/:t/documents/:d/proposals/:p/decision/federation` `{delayClass}` | session + CSRF, owner/admin, recent auth | disclose the cutoff before any ballot |
| `POST /api/workspaces/:t/documents/:d/proposals/:p/decision/federation/keys` `{publicKey}` | session + CSRF, frozen-electorate member | bind a participant device key |
| `POST …/decision/close` | (existing) | intercepted with 409 `FEDERATED_CUTOFF_PENDING` before the cutoff; otherwise falls through |

## 4. Operations

- Pin peers only after comparing `GET /api/federation/instance` through an independent channel.
- Watch `GET /api/federation/evidence`; any entry needs an operator decision (it is never resolved automatically).
- `dge_federation.outbox` rows are retained so a peer restored from backup can be resent its channel; there is no
  pruning yet. `nonces` are pruned on use.
- The worker makes outbound HTTPS calls to registered peer origins only (injectable `fetch`), outside database
  transactions. Peer origins must be reachable from the deployment network.
- The CDN must key the edition cache on the full URL including `?version=`; unversioned reads stay `no-store`.
