import React, { useEffect, useState } from "react";
import { importDocument } from "../src/import/index.mjs";
import { createAccountAPI } from "./account-api.mjs";

const api = createAccountAPI();
const MAX_BYTES = 50_000_000;

function useWorkspaceDocuments() {
  const [workspaces, setWorkspaces] = useState([]);
  const [tenantId, setTenantId] = useState("");
  const [documents, setDocuments] = useState([]);
  useEffect(() => { api("/api/workspaces?limit=100").then((r) => { setWorkspaces(r.items); setTenantId(r.items[0]?.tenantId ?? ""); }).catch(() => {}); }, []);
  useEffect(() => { if (tenantId) api("/api/workspaces/" + tenantId + "/documents?limit=100").then((r) => setDocuments(r.items)).catch(() => setDocuments([])); }, [tenantId]);
  return { workspaces, tenantId, setTenantId, documents };
}

/** Parsing happens in this browser; only an accepted, validated draft is saved. */
export function ImportPage() {
  const { workspaces, tenantId, setTenantId } = useWorkspaceDocuments();
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  async function choose(file) {
    setResult(null);
    if (!tenantId) return setStatus("Choose a workspace first.");
    if (file.size > MAX_BYTES) return setStatus("Files over 50 MB cannot be imported.");
    setBusy(true); setStatus("Converting in this browser…");
    try {
      const imported = await importDocument({
        bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name, mediaType: file.type,
        tenantId, documentId: crypto.randomUUID(), title: title || file.name.replace(/\.[^.]+$/, ""),
      });
      setResult(imported);
      setStatus(imported.report.provisional ? "Review required: this conversion is provisional." : "Review the conversion before saving.");
    } catch (error) {
      setStatus("This file could not be imported safely (" + (error.code ?? "unsupported") + "). Nothing was saved.");
    } finally { setBusy(false); }
  }
  async function accept() {
    setBusy(true);
    try {
      const saved = await api("/api/workspaces/" + tenantId + "/documents", { method: "POST", body: { document: result.document, commandId: crypto.randomUUID(), disclosure: "publish-all-revisions-v1" } });
      setStatus("Saved as a new public draft.");
      window.location.assign("/?document=" + saved.document.id);
    } catch (error) { setStatus("The draft could not be saved (" + (error.code ?? "error") + ")."); }
    finally { setBusy(false); }
  }
  const r = result?.report;
  return (
    <>
      <section className="console-card">
        <h2>Import a document</h2>
        <p>Word (.docx), OpenDocument (.odt), HTML and plain text are converted into an editable legal draft. PDF text extraction is provisional and never treated as exact legal text; scanned PDFs need OCR, which is not available. Macros, scripts, embedded objects and remote content are discarded, never run.</p>
        <p className="console-notice">Saved drafts are published to everyone. Do not import confidential material into a public workspace.</p>
        <div className="console-form">
          <label>Workspace
            <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              {workspaces.map((w) => <option key={w.tenantId} value={w.tenantId}>Workspace {w.tenantId.slice(0, 8)} · {w.role}</option>)}
            </select>
          </label>
          <label>Title (optional)<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={1000} /></label>
          <label>File<input type="file" disabled={busy} accept=".docx,.odt,.html,.htm,.txt,.md,.pdf" onChange={(e) => e.target.files[0] && choose(e.target.files[0])} /></label>
        </div>
        <p role="status" aria-live="polite">{status}</p>
      </section>
      {r && (
        <section className="console-card" aria-labelledby="import-review">
          <h2 id="import-review">Conversion review ({r.format})</h2>
          {r.provisional && <p className="console-notice">{r.provisionalReason}</p>}
          <dl className="console-facts">
            <dt>Structure</dt><dd>{r.structure.sections} sections · {r.structure.paragraphs} paragraphs · {r.structure.lists} lists · {r.structure.tables} tables · {r.structure.footnotes} footnotes · {r.structure.links} links</dd>
            <dt>Discarded</dt><dd>{Object.entries(r.discarded).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(", ") || "Nothing"}</dd>
            <dt>Numbering</dt><dd>{r.numbering.note}{r.numbering.sourceLabels.length ? " Original labels: " + r.numbering.sourceLabels.slice(0, 12).join(", ") : ""}</dd>
          </dl>
          {r.warnings.length > 0 && <ul>{r.warnings.map((w, i) => <li key={i}>{w.message}{w.count ? ` (${w.count})` : ""}</li>)}</ul>}
          <button disabled={busy} onClick={accept}>Accept and save as a draft</button>{" "}
          <button disabled={busy} onClick={() => { setResult(null); setStatus("Import discarded."); }}>Discard</button>
        </section>
      )}
    </>
  );
}

export function ExportPage() {
  const { workspaces, tenantId, setTenantId, documents } = useWorkspaceDocuments();
  const [documentId, setDocumentId] = useState(new URLSearchParams(location.search).get("document") ?? "");
  const [history, setHistory] = useState([]);
  const [version, setVersion] = useState("");
  const [compare, setCompare] = useState("");
  const [options, setOptions] = useState({ pageSize: "letter", lineNumbers: "none", toc: false });
  useEffect(() => { if (!documentId && documents[0]) setDocumentId(documents[0].id); }, [documents]);
  useEffect(() => {
    if (!documentId) return;
    api("/api/public/documents/" + documentId + "/history?limit=100").then((h) => { setHistory(h.items); setVersion(String(h.items[0]?.version ?? "")); }).catch(() => setHistory([]));
  }, [documentId]);
  const base = "/api/public/documents/" + documentId;
  const q = (format) => base + "/export?" + new URLSearchParams({ format, version, pageSize: options.pageSize, lineNumbers: options.lineNumbers, toc: String(options.toc), ...(compare ? { compare } : {}) });
  return (
    <section className="console-card">
      <h2>Download an exact edition</h2>
      <p>Every file is rendered from the chosen saved version and carries its edition digest and render profile. Redlines compare two saved versions.</p>
      <div className="console-form">
        <label>Workspace<select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>{workspaces.map((w) => <option key={w.tenantId} value={w.tenantId}>Workspace {w.tenantId.slice(0, 8)}</option>)}</select></label>
        <label>Document<select value={documentId} onChange={(e) => setDocumentId(e.target.value)}>{documents.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
        <label>Version<select value={version} onChange={(e) => setVersion(e.target.value)}>{history.map((h) => <option key={h.version} value={h.version}>Version {h.version}</option>)}</select></label>
        <label>Compare with (redline)<select value={compare} onChange={(e) => setCompare(e.target.value)}><option value="">No comparison</option>{history.filter((h) => String(h.version) !== version).map((h) => <option key={h.version} value={h.version}>Version {h.version}</option>)}</select></label>
        <label>Page size<select value={options.pageSize} onChange={(e) => setOptions({ ...options, pageSize: e.target.value })}><option value="letter">Letter</option><option value="legal">Legal</option><option value="a4">A4</option></select></label>
        <label>Line numbers<select value={options.lineNumbers} onChange={(e) => setOptions({ ...options, lineNumbers: e.target.value })}><option value="none">None</option><option value="page">Restart each page</option><option value="continuous">Continuous</option></select></label>
        <label className="console-check"><input type="checkbox" checked={options.toc} onChange={(e) => setOptions({ ...options, toc: e.target.checked })} /> Table of contents</label>
      </div>
      {documentId && version && (
        <p>
          <a className="governance-action" href={q("pdf")}>PDF</a>{" "}
          <a href={q("docx")}>Word</a> · <a href={q("html")}>HTML</a>{!compare && <> · <a href={q("text")}>Plain text</a> · <a href={q("json")}>JSON</a></>}
          {" · "}<a href={base + "/read?version=" + version}>Low-bandwidth reading page</a>
          {" · "}<a href={base + "/verification-package?version=" + version}>Verification package</a>
        </p>
      )}
    </section>
  );
}
