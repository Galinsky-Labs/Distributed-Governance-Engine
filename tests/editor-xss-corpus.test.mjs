// DCE-005: XSS corpus through the editor's paste path and rendered output. The
// corpus covers handler attributes, scriptable URLs, SVG/MathML, templates,
// mutation-XSS shapes, entity tricks and CSS. Nothing may survive into the
// editor document or the DOM it renders.
import test from "node:test";
import assert from "node:assert/strict";
import {JSDOM} from "jsdom";
import {parsePastedHTML,cleanPastedHTML,mountLegalEditor} from "../editor/model.mjs";
import {createLegalDocument} from "../src/legal-structure.mjs";

const CORPUS = [
  `<script>window.pwned=1</script>`,
  `<img src=x onerror="window.pwned=1">`,
  `<svg onload="window.pwned=1"><circle r=1></circle></svg>`,
  `<svg><script>window.pwned=1</script></svg>`,
  `<math><mtext><table><mglyph><style><img src=x onerror=window.pwned=1></style></mglyph></table></mtext></math>`,
  `<iframe src="javascript:window.pwned=1"></iframe>`,
  `<iframe srcdoc="<script>parent.pwned=1</script>"></iframe>`,
  `<object data="javascript:window.pwned=1"></object>`,
  `<embed src="javascript:window.pwned=1">`,
  `<a href="javascript:window.pwned=1">link</a>`,
  `<a href="JaVaScRiPt:window.pwned=1">link</a>`,
  `<a href="&#106;avascript:window.pwned=1">entity</a>`,
  `<a href="  javascript:window.pwned=1">space</a>`,
  `<a href="data:text/html,<script>window.pwned=1</script>">data</a>`,
  `<a href="vbscript:msgbox(1)">vb</a>`,
  `<p style="background:url(javascript:window.pwned=1)">styled</p>`,
  `<p onclick="window.pwned=1" onmouseover="window.pwned=1">handlers</p>`,
  `<details open ontoggle="window.pwned=1">x</details>`,
  `<body onload="window.pwned=1">`,
  `<input autofocus onfocus="window.pwned=1">`,
  `<video><source onerror="window.pwned=1"></video>`,
  `<template><img src=x onerror=window.pwned=1></template>`,
  `<noscript><p title="</noscript><img src=x onerror=window.pwned=1>">`,
  `<form action="javascript:window.pwned=1"><button>go</button></form>`,
  `<meta http-equiv="refresh" content="0;url=javascript:window.pwned=1">`,
  `<link rel="stylesheet" href="javascript:window.pwned=1">`,
  `<style>@import "javascript:window.pwned=1";</style>`,
  `<base href="javascript:/">`,
  `<isindex action="javascript:window.pwned=1">`,
  `<div data-legal-reference='{"targetId":"forged"}'>forged reference</div>`,
  `<!--><img src=x onerror=window.pwned=1>-->`,
  `<p>Keep <strong>this</strong> text</p>`,
];

const unsafe = (root) => {
  const found = [];
  for (const el of root.querySelectorAll("*")) {
    if (/^(script|iframe|object|embed|svg|math|style|link|meta|base|form|template|input|video|source)$/i.test(el.localName)) found.push(el.localName);
    for (const attr of el.attributes) {
      if (/^on/i.test(attr.name) || attr.name === "srcdoc" || attr.name === "style") found.push(el.localName + "@" + attr.name);
      if (/^(href|src|action|data|formaction)$/i.test(attr.name) && /^\s*(javascript|vbscript|data):/i.test(attr.value.replace(/[\u0000-\u001f]/g, ""))) found.push(el.localName + "@" + attr.name + "=" + attr.value);
    }
  }
  return found;
};

test("every corpus payload is neutralized on paste and in the rendered editor DOM", () => {
  const dom = new JSDOM("<!doctype html><body><div id=host></div></body>", { runScripts: "outside-only" });
  const document = dom.window.document;
  for (const payload of CORPUS) {
    const cleaned = cleanPastedHTML(payload, document);
    assert.notEqual(cleaned.ownerDocument, document, "parsed outside the live page");
    const slice = parsePastedHTML(payload, document);
    const json = JSON.stringify(slice.content.toJSON() ?? []);
    assert.ok(!/javascript:|vbscript:|onerror|onload|onclick|srcdoc|<script/i.test(json), "editor model keeps no active content for " + payload + " → " + json);
    assert.ok(!/"forged"/.test(json), "untrusted markup cannot forge a legal reference");
  }
  assert.equal(dom.window.pwned, undefined);
});

test("pasting the corpus into a mounted editor keeps the live DOM free of active content", () => {
  const dom = new JSDOM("<!doctype html><body><div id=host></div></body>", { runScripts: "dangerously", pretendToBeVisual: true });
  const { document } = dom.window;
  for (const key of ["window", "document", "navigator", "Node", "HTMLElement", "MutationObserver", "getSelection", "requestAnimationFrame"])
    if (!(key in globalThis)) globalThis[key] = key === "window" ? dom.window : dom.window[key];
  // jsdom has no ClipboardEvent; ProseMirror's pasteHTML only needs the type.
  if (!("ClipboardEvent" in globalThis)) globalThis.ClipboardEvent = class extends dom.window.Event { constructor(type, init) { super(type, init); this.clipboardData = null; } };
  const doc = structuredClone(createLegalDocument({ id: "xss", tenantId: "org", title: "XSS corpus" }));
  const editor = mountLegalEditor(document.getElementById("host"), doc);
  try {
    for (const payload of CORPUS) {
      editor.view.pasteHTML(payload);
      assert.deepEqual(unsafe(document.getElementById("host")), [], "after pasting " + payload);
    }
    assert.match(document.getElementById("host").textContent, /Keep this text/);
    assert.equal(dom.window.pwned, undefined);
  } finally { editor.destroy?.(); dom.window.close(); }
});
