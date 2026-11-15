# Extension SDK and compatibility (DCE-038, partial)

Application repositories extend the engine through `createPlatform({extensions})`.
`src/extension-sdk.mjs` (`@distributed-governance/engine/extension-sdk`) defines
the versioned contract those extensions build against.

## Contract version

- `ENGINE_CONTRACT_VERSION` (currently `1.1.0`) versions the extension, HTTP
  and ledger-event contract independently of the package version.
- `MIN_SUPPORTED_CONTRACT` (`1.0.0`) is the oldest contract still served.
- Manifests name a range: exact `1.1.0`, caret `^1.0.0` or tilde `~1.1.0`.
  Any other range syntax is rejected.

## Manifest

```js
import { defineExtension } from "@distributed-governance/engine/extension-sdk";
export const civicExtension = defineExtension({ id: "civic", migrations, createRoutes, pagePaths }, {
  engine: "^1.1.0", profile: "civic",
  capabilities: ["identity", "documents:read", "decisions", "notifications"],
  surfaces: ["routes", "migrations", "pages"],
});
```

- `capabilities` map to the engine services passed to `createRoutes` and
  `createWorkers` (see `CAPABILITIES`). An extension with a manifest receives a
  frozen object holding only those services.
- `tally`, `adoption`, `crypto`, `ledger:write`, `private-keys` and
  `migrations:engine` are forbidden: those remain engine-owned and an extension
  that requests them fails at startup.
- `profile` (`civic`, `charter` or `any`) must match the running product;
  a mismatch fails at startup with `Incompatible extension profile`.
- `surfaces` must list every surface the extension actually provides.

Extensions without a manifest are treated as contract `1.0.0` consumers and
still receive the full service object, so existing deployments keep working
during a rolling upgrade. New extensions should always declare a manifest.

## Ledger event contract

`docs/sdk/event-contract.json` lists every kind the engine sequences into its
transparency log, with scope, finalization and subject. The SDK test fails if
engine source and this file drift. Adding a kind is a minor change; removing
or renaming one is a major change.

## HTTP contract and OpenAPI

`src/http-contract.mjs` (`@distributed-governance/engine/http-contract`)
lists every engine route with its method, authentication class and tag.
`npm run build:openapi` generates `docs/sdk/openapi.json` (OpenAPI 3.1) from
it. `tests/http-contract.test.mjs` sends every documented method and path to
the real platform handler and fails if one is not served, and fails if the
committed OpenAPI file differs from the generated one. Extension routes
(federation, CivicQuill, CharterQuill) are documented by their owners.

## Rolling compatibility policy

1. Minor contract bumps only add capabilities, event kinds or optional fields.
2. A major bump is announced by raising `MIN_SUPPORTED_CONTRACT` one release
   after both Quills ship manifests for the new major.
3. Rollback: a consumer pinned to `^1.0.0` validates on every 1.x engine, so
   reverting the engine pin within the major keeps both Quills booting.

## Not yet done

- Request and response *schemas* in the OpenAPI document are generic objects;
  field-level schemas are still described per feature in `docs/*.md`.
- The engine is consumed as an integrity-pinned Git tarball, not a published
  registry package; supply-chain provenance is the commit pin plus the npm
  lockfile integrity hash.
