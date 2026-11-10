import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  mountLegalEditor,
  commands,
  appendSection,
  appendTable,
  canDirectlyEdit,
  insertExternalLink,
  insertCitation,
  selectedExternalInline,
  updateExternalInline,
  removeExternalInline,
} from "../editor/model.mjs";
import {
  createLegalDocument,
  publicInputEdition,
  legalOutline,
  legalPlainText,
  documentIssues,
} from "../src/legal-structure.mjs";
import { createPublicDraftCache } from "../editor/draft-cache.mjs";
import "./style.css";
import { TableTools } from "./table-tools.jsx";
import { selectedTable } from "../editor/tables.mjs";
import { SearchTools } from "./search-tools.jsx";
import { AccountPanel } from "./account-panel.jsx";
import { GovernanceHome } from "./governance-home.jsx";
import { DocumentLibrary } from "./document-library.jsx";
import { ProposalPanel } from "./proposal-panel.jsx";
import { createAccountAPI } from "./account-api.mjs";
import { createDocumentSession } from "../editor/document-session.mjs";
import { createLocalWorkingCopy, importLocalWorkingCopy } from "./local-drafts.mjs";
import { mountPublicRealtimeEditor } from "../editor/realtime-editor.mjs";

const brands = {
  civic: {
    name: "CivicQuill",
    audience: "Legislation, written together",
    color: "#275c49",
  },
  charter: {
    name: "CharterQuill",
    audience: "Better language. Accountable decisions.",
    color: "#334a72",
  },
};
function sample(product) {
  const corporate = product === "charter",
    doc = structuredClone(
      createLegalDocument({
        id: "sample-" + product,
        tenantId: "public-demo",
        title: corporate
          ? "Member Reporting Resolution"
          : "Community Reporting Act",
      }),
    );
  doc.content = [
    {
      kind: "section",
      id: "section-1",
      title: corporate ? "Reporting resolution" : "Short title",
      children: [
        {
          kind: "paragraph",
          id: "p1",
          inlines: [
            {
              kind: "text",
              text: corporate
                ? "RESOLVED, that the organization shall provide its members with regular reports."
                : "This Act may be cited as the “Community Reporting Act”.",
            },
          ],
        },
      ],
    },
    {
      kind: "section",
      id: "section-2",
      title: "Public reporting",
      children: [
        {
          kind: "paragraph",
          id: "p2",
          inlines: [
            { kind: "text", text: "The agency shall report annually." },
          ],
        },
        {
          kind: "section",
          id: "section-2a",
          title: "Publication",
          children: [
            {
              kind: "paragraph",
              id: "p3",
              inlines: [
                {
                  kind: "text",
                  text: "Each report shall be available in an accessible format.",
                },
              ],
            },
          ],
        },
      ],
    },
  ];
  return doc;
}

function Tour({ onClose }) {
  const [step, setStep] = useState(0),
    [position, setPosition] = useState({ left: 20, top: 100 });
  const title = useRef(null);
  const [steps] = useState(() =>
    [
      [
        "mode",
        "Know which edition you are reading",
        "Working drafts can be edited here. The public-input preview freezes the source and rejects editor transactions that would change it.",
      ],
      [
        "editor",
        "Work with actual legal structure",
        "Edit the sample text. Sections, paragraphs, references and tables have stable identities so numbering changes do not change which clause they represent.",
      ],
      [
        "toolbar",
        "Format with a focused set of tools",
        "Use basic text styles, undo and redo, legal sections, lists and tables. These controls operate on the same editor in both Quill products.",
      ],
      [
        "outline",
        "Follow the legal outline",
        "The outline follows the semantic section hierarchy. The federal profile uses section, (a), (1), (A), (i), and (I).",
      ],
      [
        "recovery",
        "Choose whether to keep this public sample",
        "Optional device recovery applies only to this explicitly public sample. Confidential organization content will require the encrypted cache adapter.",
      ],
      [
        "export",
        "Take an exact working copy",
        "Download structured JSON or plain text. This development preview does not produce an executed or legally finalized document.",
      ],
      [
        "save",
        "Know whether your wording is saved",
        "Saved versions are public. A failed or conflicting save preserves your local wording; download it before reopening.",
      ],
      [
        "suggest",
        "Propose exact replacement wording",
        "Highlight text within one paragraph and choose Suggest replacement. The proposal preserves its exact saved version and source quote.",
      ],
      [
        "proposals",
        "Review the exact suggested change",
        "Compare before and after wording and the rationale. Public-input source text remains fixed.",
      ],
      ['points','Build an organized argument','Keep supporting, opposing and clarifying points separate. Replies explain whether they support, challenge or clarify their parent.'],
      ['point-vote','Rank the point itself','Upvotes minus downvotes determine the net score. These argument ratings leave the source wording unchanged.'],
      [
        "history",
        "Inspect earlier public versions",
        "Each saved version remains available through public history. Pending blockchain work is not a verified receipt.",
      ],
    ].filter(([target]) =>
      document.querySelector('[data-tour="' + target + '"]'),
    ),
  );
  useEffect(() => {
    const selector = '[data-tour="' + steps[step][0] + '"]';
    const target = document.querySelector(selector);
    const previous = document.activeElement;
    target?.classList.add("tour-target");
    target?.scrollIntoView({ block: "center" });
    const place = () => {
      const r = target?.getBoundingClientRect();
      if (!r) return;
      setPosition({
        left: Math.max(12, Math.min(r.left, window.innerWidth - 352)),
        top: Math.max(12, Math.min(r.bottom + 14, window.innerHeight - 280)),
      });
    };
    place();
    title.current?.focus();
    const key = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("keydown", key);
    return () => {
      target?.classList.remove("tour-target");
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("keydown", key);
      if (previous?.isConnected) previous.focus();
    };
  }, [step]);
  return (
    <aside
      className="tour"
      role="region"
      aria-label="Editor walkthrough"
      style={position}
    >
      <p className="eyebrow">
        STEP {step + 1} OF {steps.length}
      </p>
      <h2 ref={title} tabIndex={-1}>
        {steps[step][1]}
      </h2>
      <p>{steps[step][2]}</p>
      <div>
        <button onClick={onClose}>Close</button>
        <button disabled={step === 0} onClick={() => setStep(step - 1)}>
          Back
        </button>
        <button
          onClick={() =>
            step === steps.length - 1 ? onClose() : setStep(step + 1)
          }
        >
          {step === steps.length - 1 ? "Finish" : "Next"}
        </button>
      </div>
    </aside>
  );
}
const api = createAccountAPI();
const mayEdit = (record) =>
  !record || ["owner", "admin", "editor"].includes(record.viewerRole);
const saveMessage = (state) =>
  state.state === "conflict"
    ? "Saving stopped: this source changed or your access ended. Your local text is preserved. Download it before reopening."
    : state.state === "error"
      ? "Save failed. Your local text is preserved; retry when the service is available."
      : state.state === "saving"
        ? "Saving public document…"
        : state.dirty
          ? "Unsaved changes."
          : "Saved version " +
            state.version +
            " · Blockchain anchoring pending.";
function App() {
  const accountEnabled =
    document.documentElement.dataset.accountEnabled === "true";
  const [product, setProduct] = useState(
    document.documentElement.dataset.quillProduct === "charter"
      ? "charter"
      : "civic",
  );
  const [doc, setDoc] = useState(() =>
    sample(
      document.documentElement.dataset.quillProduct === "charter"
        ? "charter"
        : "civic",
    ),
  );
  const [generation, setGeneration] = useState(0),
    [title, setTitle] = useState(""),
    [tableSelection, setTableSelection] = useState(null),
    [status, setStatus] = useState(
      "Changes stay on this page unless you choose device recovery.",
    ),
    [tour, setTour] = useState(false),
    [save, setSave] = useState(false),
    [record, setRecord] = useState(null),
    [persistence, setPersistence] = useState(null),
    [freezing, setFreezing] = useState(false),
    [freezeUncertain, setFreezeUncertain] = useState(false),
    [freezeConfirmed, setFreezeConfirmed] = useState(false),
    [history, setHistory] = useState(null),
    [historyCursor, setHistoryCursor] = useState(null),
    [historyBusy, setHistoryBusy] = useState(false),
    [live, setLive] = useState(false),
    [liveReady, setLiveReady] = useState(false),
    [liveStatus, setLiveStatus] = useState("Not connected");
  const host = useRef(null),
    controller = useRef(null),
    saveEnabled = useRef(false),
    cache = useRef(null),
    session = useRef(null),
    saveTimer = useRef(null),
    freezeCommand = useRef(null),
    importFile = useRef(null);
  const brand = brands[product],
    editable =
      canDirectlyEdit(doc) && mayEdit(record) && !freezing && !freezeUncertain && (!live || liveReady);
  function selectionChanged(state) {
    const next = selectedTable(state);
    setTableSelection(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }
  useEffect(() => {
    document.title = brand.name + " — " + doc.metadata.title;
    document.documentElement.style.setProperty("--accent", brand.color);
    setTableSelection(null);
    saveEnabled.current = false;
    setSave(false);
    setFreezeConfirmed(false);
    freezeCommand.current = null;
    setFreezeUncertain(false);
    try {
      cache.current = createPublicDraftCache(window.localStorage, {
        namespace: brand.name.toLowerCase(),
        classification: "public",
      });
    } catch {
      cache.current = null;
    }
    if (live && record && accountEnabled && !record.historicalVersion &&
        canDirectlyEdit(doc)) {
      let active = true, mounted = null;
      session.current = null;
      setPersistence(null);
      setLiveReady(false);
      mountPublicRealtimeEditor(host.current, doc, {
        classification: "public",
        origin: window.location.origin,
        readOnly: !mayEdit(record),
        onChange(next) { if (active) setDoc(next); },
        onSelectionChange(state) { if (active) selectionChanged(state); },
        onStatus(message) {
          if (!active) return;
          setLiveStatus(message);
          setLiveReady(message.includes("connected") || message.includes("acknowledged"));
          setStatus(message);
        },
        onAcknowledged(version) {
          if (active) setRecord((prior) => prior ? { ...prior, version } : prior);
        },
        onError(message) { if (active) setStatus(message); },
      }).then((editor) => {
        if (!active) editor.destroy();
        else { mounted = editor; controller.current = editor; }
      }).catch(() => {
        if (active) {
          setLiveReady(false);
          setLiveStatus("Connection failed. Exit live mode to reopen the saved version.");
          setStatus("Live collaboration could not connect. No private or plaintext fallback was used.");
        }
      });
      return () => {
        active = false;
        mounted?.destroy();
        controller.current = null;
      };
    }
    if (record && mayEdit(record) && canDirectlyEdit(doc)) {
      session.current = createDocumentSession({
        snapshot: record,
        saveRequest: (body) =>
          api(`/api/workspaces/${doc.tenantId}/documents/${doc.id}`, {
            method: "PUT",
            body,
          }),
        onState: (state) => {
          setPersistence(state);
          setStatus(saveMessage(state));
        },
      });
      setPersistence(session.current.getState());
    } else {
      session.current = null;
      setPersistence(null);
    }
    const editor = mountLegalEditor(host.current, doc, {
      readOnly: !mayEdit(record),
      onChange(next) {
        setDoc(next);
        if (session.current) {
          session.current.change(next);
          clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(
            () => session.current?.save().catch(() => {}),
            900,
          );
        } else if (saveEnabled.current && cache.current) {
          const result = cache.current.save(next);
          setStatus(
            result.state === "saved"
              ? "Public sample saved on this device."
              : result.reason,
          );
        } else setStatus("Draft updated. Changes stay on this page.");
      },
      onError: setStatus,
      onSelectionChange: selectionChanged,
    });
    controller.current = editor;
    return () => {
      clearTimeout(saveTimer.current);
      session.current?.dispose();
      session.current = null;
      editor.destroy();
      controller.current = null;
    };
  }, [generation, product, live]);
  useEffect(() => {
    const warn = (event) => {
      if (session.current?.getState().dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  useEffect(() => {
    if (!accountEnabled) return;
    const params = new URLSearchParams(location.search),
      id = params.get("document");
    if (!id) return;
    if (!/^[a-f0-9-]{36}$/.test(id)) {
      setStatus("This public document link is invalid.");
      return;
    }
    const abort = new AbortController(),
      version = params.get("version");
    api(
      "/api/public/documents/" +
        id +
        (version ? "?version=" + encodeURIComponent(version) : ""),
      { signal: abort.signal },
    )
      .then((snapshot) =>
        openSaved({
          ...snapshot,
          viewerRole: "viewer",
          historicalVersion: version ? Number(version) : null,
        }),
      )
      .catch((cause) => {
        if (cause.name !== "AbortError")
          setStatus("The public document could not be opened.");
      });
    return () => abort.abort();
  }, []);
  function canLeave() {
    if (live) return window.confirm(
      "This live session has no durable WebSocket acknowledgement. Download a local copy if necessary before leaving. Leave the live editor?",
    );
    return (
      !session.current?.getState().dirty ||
      window.confirm(
        "This document has unsaved text. Download a copy before leaving if you need to keep it. Leave this working copy?",
      )
    );
  }
  function openSaved(snapshot) {
    if (!canLeave()) return false;
    setLive(false);
    setLiveReady(false);
    setDoc(snapshot.document);
    setRecord(snapshot);
    setGeneration((x) => x + 1);
    setHistory(null);
    setHistoryCursor(null);
    setStatus(
      snapshot.document.mode === "public-input"
        ? "Fixed public-input source. Suggestions will not alter this text."
        : "Public document opened · Blockchain anchoring pending.",
    );
    return true;
  }
  function restart(nextProduct = product) {
    if (!canLeave()) return;
    setLive(false);
    setLiveReady(false);
    setProduct(nextProduct);
    setDoc(sample(nextProduct));
    setRecord(null);
    setHistory(null);
    setGeneration((x) => x + 1);
    setStatus("A new sample working copy is open.");
  }
  async function toggleLive() {
    if (!record || record.historicalVersion || doc.mode !== "collaboration" ||
        doc.lifecycle !== "draft") return;
    if (live) {
      if (!canLeave()) return;
      try {
        const fresh = await api("/api/workspaces/" + doc.tenantId + "/documents/" + doc.id);
        openSaved(fresh);
      } catch { setStatus("Could not reload saved document. Download the current text before exiting."); }
      return;
    }
    try {
      if (session.current) await session.current.save();
      const fresh = await api("/api/workspaces/" + doc.tenantId + "/documents/" + doc.id);
      if (openSaved(fresh)) setLive(true);
    } catch {
      setStatus("Live collaboration requires a current authenticated saved document. Local unsaved text was preserved.");
    }
  }
  function newLocalDraft() {
    if (accountEnabled || !canLeave()) return;
    const name = window.prompt("Title for a new public local draft", "Untitled draft");
    if (name === null) return;
    try {
      setDoc(createLocalWorkingCopy(product, name));
      setRecord(null);
      setGeneration((x) => x + 1);
      setStatus("New public local draft. Export JSON to preserve your work; this is not a private or server-saved document.");
    } catch { setStatus("Enter a valid title, up to 200 characters."); }
  }
  async function importLocalDraft(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || accountEnabled || !canLeave()) return;
    if (file.size > 3000000) { setStatus("Working copy exceeds the import limit."); return; }
    try {
      const document = importLocalWorkingCopy(await file.text(), product);
      setDoc(document);
      setRecord(null);
      setGeneration((x) => x + 1);
      setStatus("Public local working copy imported. Export JSON to preserve later changes.");
    } catch { setStatus("Import rejected. Use a valid public working-copy JSON export from this Quill product."); }
  }
  function run(command, unavailable = "Place the cursor in a suitable paragraph to use this control.") {
    if (!controller.current?.command(command)) setStatus(unavailable);
  }
  function citationDetails(current = {}) {
    const title = window.prompt("Optional source title", current.title ?? "");
    if (title === null) return;
    const publisher = window.prompt("Optional publisher", current.citationMetadata?.publisher ?? "");
    if (publisher === null) return;
    const publishedOn = window.prompt("Optional publication date (YYYY-MM-DD)", current.citationMetadata?.publishedOn ?? "");
    if (publishedOn === null) return;
    const pinpoint = window.prompt("Optional pinpoint (page, section, or paragraph)", current.citationMetadata?.pinpoint ?? "");
    if (pinpoint === null) return;
    const accessedOn = window.prompt("Optional access date (YYYY-MM-DD)", current.citationMetadata?.accessedOn ?? "");
    if (accessedOn === null) return;
    const citationMetadata = { publisher, publishedOn, pinpoint, accessedOn };
    return { title: title || null, citationMetadata: Object.values(citationMetadata).some((value) => value.trim()) ? citationMetadata : null };
  }
  function addExternal(kind) {
    const targetUrl = window.prompt(kind === "link" ? "HTTPS link address" : "HTTPS citation source");
    if (targetUrl === null) return;
    const label = kind === "citation" ? window.prompt("Citation label") : undefined;
    if (kind === "citation" && label === null) return;
    const details = kind === "citation" ? citationDetails() : {};
    if (details === undefined) return;
    run(kind === "link" ? insertExternalLink(targetUrl) : insertCitation(targetUrl, label, details.title, details.citationMetadata));
  }
  function editExternal() {
    const current = controller.current
      ? selectedExternalInline(controller.current.view.state)
      : null;
    if (!current) {
      setStatus("Select an existing link or citation to edit it.");
      return;
    }
    const targetUrl = window.prompt("HTTPS source address", current.targetUrl);
    if (targetUrl === null) return;
    const label = window.prompt("Visible label", current.label);
    if (label === null) return;
    const title = current.kind === "link" ? window.prompt("Optional source title", current.title ?? "") : null;
    if (current.kind === "link" && title === null) return;
    const details = current.kind === "citation" ? citationDetails(current) : { title };
    if (details === undefined) return;
    run(
      updateExternalInline({
        targetUrl,
        label,
        title: details.title || null,
        ...(current.kind === "citation" ? { citationMetadata: details.citationMetadata } : {}),
      }),
    );
  }
  function previewInput() {
    setDoc(publicInputEdition(controller.current.getDocument()));
    setGeneration((x) => x + 1);
    setStatus("Public-input source preview: this edition is read-only.");
  }
  function exportFile(format) {
    const text =
        format === "json" ? JSON.stringify(doc, null, 2) : legalPlainText(doc),
      url = URL.createObjectURL(
        new Blob([text], {
          type:
            format === "json" ? "application/json" : "text/plain;charset=utf-8",
        }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download =
      brand.name + "-working-copy." + (format === "json" ? "json" : "txt");
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function freeze() {
    if (!session.current || !freezeConfirmed) return;
    setFreezing(true);
    controller.current.view.setProps({ editable: () => false });
    clearTimeout(saveTimer.current);
    try {
      if (!freezeCommand.current) {
        await session.current.save();
        freezeCommand.current = {
          commandId: crypto.randomUUID(),
          expectedVersion: session.current.getState().version,
        };
      }
      const snapshot = await api(
        `/api/workspaces/${doc.tenantId}/documents/${doc.id}/freeze-input`,
        { method: "POST", body: freezeCommand.current },
      );
      freezeCommand.current = null;
      setFreezeUncertain(false);
      openSaved({ ...snapshot, viewerRole: record.viewerRole });
    } catch (cause) {
      const uncertain = !cause.status || cause.status >= 500;
      if (!uncertain) {
        freezeCommand.current = null;
        setFreezeUncertain(false);
        controller.current?.view.setProps({ editable: () => true });
      } else setFreezeUncertain(true);
      setStatus(
        uncertain
          ? "The freeze response was lost. Editing is paused; retry freezing to recover the same result."
          : cause.code === "REAUTHENTICATION_REQUIRED"
            ? "Sign in again before freezing the source."
            : cause.code === "VERSION_CONFLICT"
              ? "A newer version exists. Your local text is preserved; reopen the current version."
              : "The source could not be frozen. Your working copy is preserved.",
      );
    } finally {
      setFreezing(false);
    }
  }
  async function loadHistory(more = false) {
    if (historyBusy) return;
    setHistoryBusy(true);
    try {
      const result = await api(
        `/api/public/documents/${doc.id}/history` +
          (more ? "?before=" + historyCursor : ""),
      );
      setHistory((previous) =>
        more ? [...previous, ...result.items] : result.items,
      );
      setHistoryCursor(result.nextCursor);
    } catch {
      setStatus("Version history could not be loaded.");
    } finally {
      setHistoryBusy(false);
    }
  }
  const outline = legalOutline(doc),
    issues = documentIssues(doc),
    storedVersion = persistence?.version ?? record?.version;
  const publicLink = record
    ? "/?document=" +
      doc.id +
      (record.historicalVersion ? "&version=" + record.historicalVersion : "")
    : null;
  return (
    <>
      <header>
        <a className="brand" href="#document">
          <span className="quill-icon" aria-hidden="true">
            Q
          </span>
          {brand.name}
        </a>
        <span className="family">THE QUILL FAMILY</span>
        <div className="brand-switch">
          <button
            aria-pressed={product === "civic"}
            onClick={() => restart("civic")}
          >
            CivicQuill
          </button>
          <button
            aria-pressed={product === "charter"}
            onClick={() => restart("charter")}
          >
            CharterQuill
          </button>
        </div>
        <a className="governance-header-link" href="/governance">Governance workspaces</a>
        <button onClick={() => setTour(true)}>Take a tour</button>
        {accountEnabled && (
          <>
            <AccountPanel />
            <DocumentLibrary
              currentDocument={doc}
              onOpen={openSaved}
              notify={setStatus}
            />
          </>
        )}
      </header>
      <div className="preview-banner">
        {record
          ? "PUBLIC DOCUMENT · ALL SAVED VERSIONS ARE PUBLIC · BLOCKCHAIN ANCHORING PENDING"
          : accountEnabled
            ? "PUBLIC SAMPLE · OPEN DOCUMENTS TO CREATE OR REOPEN A SAVED DOCUMENT"
            : "EDITOR DEVELOPMENT PREVIEW · PUBLIC SAMPLE DATA · NO ACCOUNT OR SERVER SAVE"}
      </div>
      <main>
        <nav
          className="outline"
          aria-label="Document outline"
          data-tour="outline"
        >
          <p className="eyebrow">{brand.audience}</p>
          <h2>{doc.metadata.title}</h2>
          {outline.map((item) => (
            <button
              key={item.id}
              style={{ paddingLeft: 12 + item.depth * 14 }}
              onClick={() => {
                host.current
                  .querySelector('[data-block-id="' + item.id + '"]')
                  .scrollIntoView({ block: "center" });
                controller.current.view.focus();
              }}
            >
              {item.label} {item.title}
            </button>
          ))}
          <p className="muted">
            One shared editor. Two purposes. Familiar controls across the Quill
            family.
          </p>
        </nav>
        <section className="workspace">
          <div className="document-heading">
            <div>
              <p className="eyebrow">
                {record ? "SAVED VERSION " + storedVersion : "WORKING COPY"} ·
                EDIT {doc.revision}
              </p>
              <h1>{doc.metadata.title}</h1>
            </div>
            <span className="edition" data-tour="mode">
              {doc.mode === "public-input"
                ? "Public-input · Fixed source"
                : record && !mayEdit(record)
                  ? "Public working draft · Read only"
                  : "Collaboration draft"}
            </span>
          </div>
          {record && (
            <div className="save-controls" data-tour="save">
              <span role="status">
                {live ? liveStatus : persistence
                  ? saveMessage(persistence)
                  : "Version " + storedVersion + " · Read only"}
              </span>
              {accountEnabled && !record.historicalVersion &&
                record.document.mode === "collaboration" &&
                record.document.lifecycle === "draft" && (
                <button aria-pressed={live} onClick={toggleLive}>
                  {live ? "Exit live editing" : "Join live editing"}
                </button>
              )}
              {!live && persistence && (
                <button
                  disabled={
                    freezing ||
                    persistence.state === "saving" ||
                    persistence.state === "conflict"
                  }
                  onClick={() => session.current?.save().catch(() => {})}
                >
                  Save now
                </button>
              )}
              <a href={publicLink} target="_blank" rel="noreferrer">
                Public document link
              </a>
            </div>
          )}
          <div
            className="toolbar"
            role="toolbar"
            aria-label="Legal editor tools"
            data-tour="toolbar"
          >
            {[
              ["bold", "Bold"],
              ["italic", "Italic"],
              ["underline", "Underline"],
              ["strike", "Strike"],
              ["undo", "Undo"],
              ["redo", "Redo"],
              ["numberedList", "Numbered list"],
              ["bulletList", "Bullets"],
            ].map(([name, label]) => (
              <button
                key={name}
                disabled={!editable}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(commands[name])}
              >
                {label}
              </button>
            ))}
            <button disabled={!editable} onMouseDown={(e) => e.preventDefault()} onClick={() => addExternal("link")}>
              Link
            </button>
            <button disabled={!editable} onMouseDown={(e) => e.preventDefault()} onClick={() => addExternal("citation")}>
              Citation
            </button>
            <button disabled={!editable} onMouseDown={(e) => e.preventDefault()} onClick={editExternal}>
              Edit source
            </button>
            <button disabled={!editable} onMouseDown={(e) => e.preventDefault()} onClick={() => run(removeExternalInline)}>
              Remove link
            </button>
            <button disabled={!editable} onClick={() => run(appendTable())}>
              Table
            </button>
          </div>
          <form
            className="section-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (title.trim()) {
                run(appendSection(title));
                setTitle("");
              }
            }}
          >
            <label htmlFor="section-title">New section</label>
            <input
              id="section-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              disabled={!editable}
              placeholder="Section title"
            />
            <button disabled={!editable || !title.trim()}>Add section</button>
          </form>
          {accountEnabled && !live && (
            <ProposalPanel
              document={doc}
              controller={controller}
              record={record}
              version={storedVersion}
              saveState={persistence}
              notify={setStatus}
            />
          )}
          <SearchTools
            controller={controller}
            editable={editable}
            notify={setStatus}
          />
          <article id="document" className="paper" data-tour="editor">
            <p className="paper-title">{doc.metadata.title}</p>
            <div ref={host} />
            <footer>
              {doc.mode === "public-input"
                ? "Public-input source · Text stays fixed"
                : "Working copy · Not an adopted or executed document"}
            </footer>
          </article>
          <p className="status" role="status">
            {status}
          </p>
          {issues.length > 0 && (
            <section role="alert" aria-label="Legal reference and definition issues">
              <p>{issues.length} legal reference or definition issue(s) must be resolved before finalization.</p>
              <ul>
                {issues.slice(0, 20).map((issue, index) => (
                  <li key={issue.code + issue.sourceId + index}>
                    {issue.code.replaceAll("_", " ").toLowerCase()}: {issue.sourceId}
                    {issue.targetId ? " refers to " + issue.targetId : ""}
                    {issue.otherId ? " conflicts with " + issue.otherId : ""}
                  </li>
                ))}
              </ul>
              {issues.length > 20 && <p>Additional issues are not shown.</p>}
            </section>
          )}
        </section>
        <aside className="side-panel">
          <TableTools selection={tableSelection} editable={editable} run={run} />
          <p className="eyebrow">EDITION CONTROLS</p>
          <h2>From language to decisions</h2>
          <p>
            {record
              ? "Saved versions preserve the exact wording. Public-input mode fixes the source permanently. Public-input source text stays fixed while people suggest changes."
              : "Edit this public sample, or use Documents to publish and save your own working copy."}
          </p>
          {!record && !accountEnabled && (
            <section>
              <h3>Local drafting</h3>
              <p>For public, nonconfidential drafts only. Nothing is saved to a server. Download JSON before leaving; no automatic recovery guarantee.</p>
              <button onClick={newLocalDraft}>New document</button>
              <button onClick={() => importFile.current?.click()}>Import working-copy JSON</button>
              <input ref={importFile} type="file" accept=".json,application/json" onChange={importLocalDraft} aria-label="Import public working-copy JSON" style={{display:"none"}} />
            </section>
          )}
          {!record && (
            <button onClick={previewInput} disabled={!editable}>
              Preview a fixed public-input edition
            </button>
          )}
          {record &&
            ["owner", "admin"].includes(record.viewerRole) &&
            canDirectlyEdit(doc) && !live && (
              <section>
                <h3>Open for public input</h3>
                <p>
                  Freeze the source for feedback. Future suggestions will leave
                  this text unchanged.
                </p>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={freezeConfirmed}
                    disabled={freezing}
                    onChange={(event) =>
                      setFreezeConfirmed(event.target.checked)
                    }
                  />
                  I understand this source will remain fixed.
                </label>
                <button
                  disabled={
                    !freezeConfirmed ||
                    freezing ||
                    persistence?.state === "conflict"
                  }
                  onClick={freeze}
                >
                  Freeze source for public input
                </button>
              </section>
            )}
          <button onClick={() => restart()}>Restart sample</button>
          {record ? (
            <section className="version-history" data-tour="history">
              <h3>Public version history</h3>
              <button disabled={historyBusy} onClick={() => loadHistory()}>
                Load version history
              </button>
              {history && (
                <ol>
                  {history.map((item) => (
                    <li key={item.version}>
                      <button
                        disabled={historyBusy}
                        onClick={async () => {
                          try {
                            const snapshot = await api(
                              `/api/public/documents/${doc.id}?version=${item.version}`,
                            );
                            openSaved({
                              ...snapshot,
                              viewerRole: "viewer",
                              historicalVersion: item.version,
                            });
                          } catch {
                            setStatus("That version could not be opened.");
                          }
                        }}
                      >
                        Version {item.version}
                      </button>
                      <span className="small">
                        {new Date(item.createdAt).toLocaleString()} · Anchoring
                        pending
                      </span>
                      <code className="digest">{item.digest}</code>
                    </li>
                  ))}
                </ol>
              )}
              {historyCursor && (
                <button
                  disabled={historyBusy}
                  onClick={() => loadHistory(true)}
                >
                  Earlier versions
                </button>
              )}
            </section>
          ) : (
            <section data-tour="recovery">
              <h3>Public sample recovery</h3>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={save}
                  disabled={!editable || !cache.current}
                  onChange={(event) => {
                    saveEnabled.current = event.target.checked;
                    setSave(event.target.checked);
                    if (event.target.checked) {
                      const result = cache.current.save(
                        controller.current.getDocument(),
                      );
                      setStatus(
                        result.state === "saved"
                          ? "Public sample saved on this device."
                          : result.reason,
                      );
                    }
                  }}
                />
                Save this public sample on this device
              </label>
              <button
                onClick={() => {
                  const result = cache.current?.load({
                    id: "sample-" + product,
                    tenantId: "public-demo",
                  });
                  if (result?.state === "available") {
                    setDoc(result.document);
                    setGeneration((x) => x + 1);
                    setStatus("Recovered your saved public sample.");
                  } else
                    setStatus(
                      result?.reason ?? "No saved public sample is available.",
                    );
                }}
              >
                Recover saved sample
              </button>
              <button
                onClick={() => {
                  saveEnabled.current = false;
                  setSave(false);
                  const result = cache.current?.clear({
                    id: "sample-" + product,
                    tenantId: "public-demo",
                  });
                  setStatus(
                    result?.state === "cleared"
                      ? "Saved public sample removed."
                      : (result?.reason ?? "Device storage is unavailable."),
                  );
                }}
              >
                Clear saved sample
              </button>
              <p className="small">
                Private organization drafts will use encrypted storage. This
                sample is public data only.
              </p>
            </section>
          )}
          <section data-tour="export">
            <h3>Working-copy export</h3>
            <button onClick={() => exportFile("json")}>
              Download structured JSON
            </button>
            <button onClick={() => exportFile("text")}>
              Download plain text
            </button>
            <button onClick={() => window.print()}>Print working copy</button>
          </section>
        </aside>
      </main>
      {tour && <Tour onClose={() => setTour(false)} />}
    </>
  );
}
createRoot(document.getElementById("root")).render(window.location.pathname === "/governance" ? <GovernanceHome /> : <App />);
