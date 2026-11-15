// DCE-038: extension SDK contract. Application repositories (CivicQuill,
// CharterQuill) describe their extension with a manifest that names the
// engine contract range it was built against and the capabilities it needs.
// The platform refuses incompatible manifests explicitly and hands each
// extension only the services its capabilities allow. Tally, adoption,
// cryptography and ledger sequencing are never delegable capabilities.

/** Version of the extension/HTTP/event contract, independent of package version. */
export const ENGINE_CONTRACT_VERSION = "1.1.0";
/** Oldest contract version this engine still serves to extensions. */
export const MIN_SUPPORTED_CONTRACT = "1.0.0";

/** Capability -> engine services an extension may receive. */
export const CAPABILITIES = Object.freeze({
  "identity": Object.freeze(["identity", "transaction", "clock", "origin", "product"]),
  "documents:read": Object.freeze(["documents"]),
  "proposals:read": Object.freeze(["proposals"]),
  "discussion": Object.freeze(["discussion"]),
  "decisions": Object.freeze(["decisions"]),
  "electorates": Object.freeze(["electorates"]),
  "editions": Object.freeze(["editions"]),
  "signatures": Object.freeze(["signatures"]),
  "search": Object.freeze(["search"]),
  "notifications": Object.freeze(["notifications"]),
  "settings": Object.freeze(["settings"]),
  "billing": Object.freeze(["billing", "entitlements"]),
  "moderation": Object.freeze(["moderation"]),
  "ledger:read": Object.freeze(["ledger"]),
  "admin": Object.freeze(["isPlatformAdmin"]),
});
/** Requests that are refused outright: these stay engine-owned. */
export const FORBIDDEN_CAPABILITIES = Object.freeze(["tally", "adoption", "crypto", "ledger:write", "private-keys", "migrations:engine"]);
const SURFACES = ["routes", "workers", "migrations", "pages"];

const SEMVER = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
export function parseVersion(text) {
  const m = SEMVER.exec(text ?? "");
  if (!m) throw Error("Invalid contract version");
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Supports exact "1.2.3", caret "^1.2.3" and tilde "~1.2.3" ranges only. */
export function satisfies(version, range) {
  const v = parseVersion(version);
  if (typeof range !== "string") throw Error("Invalid contract range");
  const op = range[0] === "^" || range[0] === "~" ? range[0] : "";
  const r = parseVersion(op ? range.slice(1) : range);
  if (!op) return compare(v, r) === 0;
  if (compare(v, r) < 0) return false;
  if (op === "~") return v[0] === r[0] && v[1] === r[1];
  return r[0] > 0 ? v[0] === r[0] : r[1] > 0 ? v[0] === 0 && v[1] === r[1] : compare(v, r) === 0;
}

/**
 * Validates a manifest. Fails with explicit, stable messages so a consumer
 * built for a different contract cannot silently run with a partial surface.
 */
export function validateManifest(manifest, { engineContract = ENGINE_CONTRACT_VERSION } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw Error("Invalid extension manifest");
  const allowed = ["engine", "capabilities", "surfaces", "profile"];
  for (const key of Object.keys(manifest)) if (!allowed.includes(key)) throw Error("Unknown extension manifest field: " + key);
  if (typeof manifest.engine !== "string") throw Error("Extension manifest must name its engine contract range");
  if (!satisfies(engineContract, manifest.engine))
    throw Error("Incompatible extension: requires engine contract " + manifest.engine + ", this engine provides " + engineContract);
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length > 32) throw Error("Invalid extension capabilities");
  const seen = new Set();
  for (const capability of manifest.capabilities) {
    if (FORBIDDEN_CAPABILITIES.includes(capability)) throw Error("Forbidden extension capability: " + capability);
    if (!Object.hasOwn(CAPABILITIES, capability)) throw Error("Unknown extension capability: " + capability);
    if (seen.has(capability)) throw Error("Duplicate extension capability");
    seen.add(capability);
  }
  for (const surface of manifest.surfaces ?? []) if (!SURFACES.includes(surface)) throw Error("Unknown extension surface: " + surface);
  if (manifest.profile !== undefined && !["civic", "charter", "any"].includes(manifest.profile)) throw Error("Invalid extension profile");
  return manifest;
}

/** Checks a manifest against the running product profile. */
export function assertProfile(manifest, product) {
  if (manifest.profile && manifest.profile !== "any" && manifest.profile !== product)
    throw Error("Incompatible extension profile: built for " + manifest.profile + ", running " + product);
}

/** Returns only the services the manifest's capabilities allow (frozen). */
export function boundServices(services, manifest) {
  const keys = new Set(manifest.capabilities.flatMap((c) => CAPABILITIES[c]));
  const bounded = {};
  for (const key of keys) if (Object.hasOwn(services, key)) bounded[key] = services[key];
  return Object.freeze(bounded);
}

/** Convenience for extension authors: attaches and validates a manifest. */
export function defineExtension(extension, manifest) {
  validateManifest(manifest);
  const surfaces = [];
  if (extension.createRoutes) surfaces.push("routes");
  if (extension.createWorkers) surfaces.push("workers");
  if (extension.migrations?.length) surfaces.push("migrations");
  if (extension.pagePaths?.length) surfaces.push("pages");
  for (const surface of surfaces)
    if (manifest.surfaces && !manifest.surfaces.includes(surface)) throw Error("Extension surface not declared: " + surface);
  return Object.freeze({ ...extension, manifest: Object.freeze({ ...manifest, capabilities: Object.freeze([...manifest.capabilities]) }) });
}
