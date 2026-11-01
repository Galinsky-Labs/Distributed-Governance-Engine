import { createLegalDocument, validateLegalDocument } from "../src/legal-structure.mjs";

const PRODUCTS = new Set(["civic", "charter"]);
const PUBLIC_TENANT = "public-demo";
const MAX_IMPORT_BYTES = 3_000_000;

function productId(product) {
  if (!PRODUCTS.has(product)) throw new Error("Unknown Quill product");
  return "sample-" + product;
}

/** A local, explicitly public working copy. This is never a private tenant document. */
export function createLocalWorkingCopy(product, title) {
  if (typeof title !== "string" || !title.trim() || title.trim().length > 200)
    throw new Error("A public draft title is required (200 characters maximum)");
  return createLegalDocument({
    id: productId(product),
    tenantId: PUBLIC_TENANT,
    title: title.trim(),
  });
}

/** Import a JSON working-copy export without granting server identity or workspace authority. */
export function importLocalWorkingCopy(json, product) {
  const id = productId(product);
  if (typeof json !== "string" || new TextEncoder().encode(json).length > MAX_IMPORT_BYTES)
    throw new Error("Invalid or oversized working copy");
  const parsed = validateLegalDocument(JSON.parse(json));
  if (
    parsed.id !== id ||
    parsed.tenantId !== PUBLIC_TENANT ||
    parsed.mode !== "collaboration" ||
    parsed.lifecycle !== "draft"
  ) throw new Error("Only public, local working copies from this Quill product may be imported");
  return parsed;
}
