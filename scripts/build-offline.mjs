import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Build a standalone, network-free drafting preview from the exact tested
 * React/ProseMirror bundle. This is not the authenticated Quill SaaS service.
 * It must never be used to author or store confidential corporate material.
 */
const root = new URL("../dist/", import.meta.url);
const [template, javascript, stylesheet] = await Promise.all([
  readFile(new URL("index.html", root), "utf8"),
  readFile(new URL("app.js", root), "utf8"),
  readFile(new URL("app.css", root), "utf8"),
]);
if (
  !template.includes('data-quill-product="civic"') ||
  !template.includes('<link rel="stylesheet" href="/app.css">') ||
  !template.includes('<script type="module" src="/app.js"></script>')
) throw Error("Unexpected editor template");
if (!javascript.includes("CivicQuill") || !javascript.includes("CharterQuill"))
  throw Error("Shared Quill bundle is incomplete");

const csp = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";
const output = new URL("offline/", root);
await mkdir(output, { recursive: true });
for (const product of ["civic", "charter"]) {
  const name = product === "civic" ? "CivicQuill" : "CharterQuill";
  const html = template
    .replace('data-quill-product="civic"', 'data-quill-product="' + product + '"')
    .replace("<head>", '<head><meta http-equiv="Content-Security-Policy" content="' + csp + '"><meta name="referrer" content="no-referrer">')
    .replace('<link rel="stylesheet" href="/app.css">', "<style>" + stylesheet.replace(/<\/style/gi, "<\\/style") + "</style>")
    .replace('<script type="module" src="/app.js"></script>',
      "<script type=\"module\">" + javascript.replace(/<\/script/gi, "<\\/script").replace(/\/\/# sourceMappingURL=.*$/gm, "") + "</script>")
    .replace("The shared Quill legal editor development preview.", "Offline public drafting preview. No accounts, network sync or private-storage security.");
  // The source bundle itself may contain literal asset-tag snippets, so only
  // verify that both template slots were replaced. Chrome's offline test
  // additionally detects any attempted HTTP requests.
  if (!html.includes("<style>") || !html.includes('<script type="module">'))
    throw Error("Offline asset slots were not populated");
  await writeFile(new URL(name + ".html", output), html, "utf8");
  console.log("Built " + name + " standalone public-drafting preview (no backend).");
}
