// Public edition exports and the low-bandwidth reading page. Every artifact
// is rendered from an exact stored version whose digest is re-checked by the
// export library, and carries a manifest binding edition and render profile.
import { readFile } from "node:fs/promises";
import { HttpError } from "./account-http.mjs";
import { DocumentError } from "./document-store.mjs";
import { exportDocument, EXPORT_FORMATS, ExportError } from "../src/export/index.mjs";

const FONT_DIR = new URL("../assets/fonts/liberation/", import.meta.url);
let fontCache = null;
export const loadExportFonts = () => (fontCache ??= Promise.all(
  ["Regular", "Bold", "Italic", "BoldItalic"].map((s) => readFile(new URL(`LiberationSerif-${s}.ttf`, FONT_DIR)).then((b) => new Uint8Array(b))),
).then(([regular, bold, italic, boldItalic]) => ({ regular, bold, italic, boldItalic })));

export const exportBodyLimit = () => 4096;
const route = /^\/api\/public\/documents\/([a-f0-9-]{36})\/(export|read)$/;
const OPTIONS = ["format", "version", "compare", "pageSize", "lineNumbers", "watermark", "cover", "toc"];
// Reading pages carry only inline CSS: no scripts, frames or remote loads.
const READ_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * @param documents engine document store (publicRead verifies stored digests)
 * @param maxConcurrent bounds CPU spent rendering on one instance
 */
export function createExportRoutes({ documents, clock = Date.now, maxConcurrent = 2 }) {
  let active = 0;
  return async ({ url, method }) => {
    const match = url.pathname.match(route);
    if (!match) return null;
    method(["GET"]);
    for (const key of url.searchParams.keys())
      if (!OPTIONS.includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "INVALID_QUERY");
    const [, documentId, action] = match;
    const format = action === "read" ? "html" : url.searchParams.get("format") ?? "pdf";
    if (!Object.hasOwn(EXPORT_FORMATS, format)) throw new HttpError(400, "UNSUPPORTED_FORMAT");
    const versionOf = (key) => {
      if (!url.searchParams.has(key)) return null;
      const v = Number(url.searchParams.get(key));
      if (!Number.isSafeInteger(v) || v < 1) throw new HttpError(400, "INVALID_QUERY");
      return v;
    };
    const pageSize = url.searchParams.get("pageSize") ?? "letter";
    const lineNumbers = url.searchParams.get("lineNumbers") ?? "none";
    if (!["letter", "legal", "a4"].includes(pageSize) || !["none", "page", "continuous"].includes(lineNumbers)) throw new HttpError(400, "INVALID_QUERY");
    if (active >= maxConcurrent) throw new HttpError(429, "EXPORT_BUSY", { "retry-after": "5" });
    active++;
    try {
      const edition = await documents.publicRead(documentId, { version: versionOf("version") });
      const compareVersion = versionOf("compare");
      const before = compareVersion === null ? undefined : (await documents.publicRead(documentId, { version: compareVersion })).document;
      const watermark = url.searchParams.get("watermark");
      const result = await exportDocument({
        document: edition.document, format, editionDigest: edition.digest, version: edition.version,
        fonts: format === "pdf" ? await loadExportFonts() : undefined,
        compareTo: before,
        options: {
          generatedAt: new Date(clock()).toISOString(),
          pageSize,
          lineNumbers,
          cover: url.searchParams.get("cover") !== "false",
          toc: url.searchParams.get("toc") === "true",
          ...(watermark ? { watermark: watermark.slice(0, 60) } : edition.document.mode === "public-input" ? { watermark: "PUBLIC INPUT — SOURCE FIXED" } : {}),
        },
      });
      const headers = {
        "content-type": result.mediaType,
        "x-quill-edition-digest": edition.digest,
        "x-quill-artifact-sha256": result.manifest.artifactSha256,
        "cache-control": "public, max-age=300",
      };
      if (action === "read") headers["content-security-policy"] = READ_CSP;
      else headers["content-disposition"] = `attachment; filename="${result.fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`;
      return new Response(result.bytes, { headers });
    } catch (cause) {
      if (cause instanceof DocumentError) throw new HttpError(cause.status, cause.code);
      if (cause instanceof ExportError) throw new HttpError(422, cause.code);
      throw cause;
    } finally { active--; }
  };
}
