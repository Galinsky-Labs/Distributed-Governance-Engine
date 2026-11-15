import { DiscussionPanel } from "./discussion-panel.jsx";
import React, { useEffect, useRef, useState } from "react";
import { createAccountAPI } from "./account-api.mjs";
import { RemovedNotice, ReportButton } from "./moderation-panel.jsx";
const api = createAccountAPI();
const short = (value) =>
  Array.from(value).slice(0, 90).join("") +
  (Array.from(value).length > 90 ? "…" : "");
export function ProposalPanel({
  document: doc,
  controller,
  record,
  version,
  saveState,
  notify,
}) {
  const [open, setOpen] = useState(false),
    [items, setItems] = useState([]),
    [cursor, setCursor] = useState(null),
    [selected, setSelected] = useState(null),
    [composer, setComposer] = useState(null),
    [replacement, setReplacement] = useState(""),
    [rationale, setRationale] = useState(""),
    [disclosed, setDisclosed] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const pending = useRef(null);
  useEffect(() => {
    setComposer(null);
    setSelected(null);
    pending.current = null;
    setError("");
  }, [doc.id]);
  useEffect(() => {
    if (!open || !record) {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setItems([]);
    setCursor(null);
    api(`/api/public/documents/${doc.id}/proposals`, { signal: abort.signal })
      .then((result) => {
        setItems(result.items);
        setCursor(result.nextCursor);
      })
      .catch((cause) => {
        if (cause.name !== "AbortError")
          setError("Suggested changes could not be loaded.");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [open, doc.id, refresh]);
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener("quill-open-documents", close);
    return () => window.removeEventListener("quill-open-documents", close);
  }, []);
  function suggest() {
    if (!record) return;
    if (saveState && (saveState.dirty || saveState.state === "saving")) {
      notify(
        "Wait for this version to finish saving before selecting a change.",
      );
      return;
    }
    try {
      const selection = controller.current.getTextSelection();
      setComposer({ selection, baseVersion: version });
      setReplacement("");
      setRationale("");
      setDisclosed(false);
      setSelected(null);
      setError("");
      pending.current = null;
      setOpen(true);
    } catch {
      notify(
        "Highlight text within one body paragraph, then choose Suggest replacement. Legal references must be selected separately.",
      );
    }
  }
  async function submit(event) {
    event.preventDefault();
    if (busy || !disclosed) return;
    setBusy(true);
    setError("");
    if (!pending.current)
      pending.current = {
        baseVersion: composer.baseVersion,
        selection: composer.selection,
        replacement,
        rationale,
        commandId: crypto.randomUUID(),
        disclosure: "publish-proposal-v1",
      };
    try {
      const result = await api(
        `/api/workspaces/${doc.tenantId}/documents/${doc.id}/proposals`,
        { method: "POST", body: pending.current },
      );
      pending.current = null;
      setComposer(null);
      setSelected(result);
      setRefresh((x) => x + 1);
      notify("Suggested change published. The source text is unchanged.");
    } catch (cause) {
      if (cause.status >= 400 && cause.status < 500) pending.current = null;
      setError(
        cause.code === "AUTHENTICATION_REQUIRED" ||
          cause.code === "SIGN_IN_AGAIN"
          ? "Sign in using Account & workspaces, then try again."
          : cause.code === "ACCESS_DENIED"
            ? "A workspace contributor role is required to publish a suggestion in this development version."
            : cause.code === "INVALID_TEXT_SELECTION_OR_REPLACEMENT"
              ? "The selected wording does not match that saved version. Close this draft and select the text again."
              : cause.code?.endsWith("_LIMIT_REACHED")
                ? "A workspace resource limit has been reached."
                : pending.current
                  ? "The result is uncertain. Retry publication to retrieve the same suggestion safely."
                  : "The suggestion could not be published. Your wording is preserved.",
      );
    } finally {
      setBusy(false);
    }
  }
  const inputLocked = busy || !!pending.current;
  return (
    <>
      <section className="proposal-controls" data-tour="suggest">
        <button
          disabled={!record}
          onMouseDown={(event) => event.preventDefault()}
          onClick={suggest}
        >
          Suggest replacement
        </button>
        <button disabled={!record} onClick={() => setOpen((value) => !value)}>
          Suggested changes
        </button>
      </section>
      {open && record && (
        <aside
          className="proposal-panel account-panel"
          aria-label="Suggested changes"
          data-tour="proposals"
        >
          <div className="account-title">
            <h2>Suggested changes</h2>
            <button onClick={() => setOpen(false)}>Close suggestions</button>
          </div>
          <p className="proposal-mode">
            {doc.mode === "public-input"
              ? "Public input · Source text stays fixed"
              : "Collaboration · Suggestions do not directly edit the source"}
          </p>
          <p role="status">
            {busy ? "Publishing…" : loading ? "Loading suggestions…" : error}
          </p>
          {composer && (
            <form className="proposal-composer" onSubmit={submit}>
              <h3>Propose exact wording</h3>
              <p>Based on saved version {composer.baseVersion}</p>
              <p className="eyebrow">BEFORE</p>
              <blockquote>{composer.selection.quote}</blockquote>
              <label>
                Replacement text
                <textarea
                  value={replacement}
                  maxLength={100000}
                  disabled={inputLocked}
                  onChange={(event) => setReplacement(event.target.value)}
                />
              </label>
              <p className="small">
                Leave empty to propose removing the selected text.
              </p>
              <label>
                Why this change?
                <textarea
                  value={rationale}
                  required
                  maxLength={4000}
                  disabled={inputLocked}
                  onChange={(event) => setRationale(event.target.value)}
                />
              </label>
              <div className="replacement-preview">
                <span>
                  Before: <del>{composer.selection.quote}</del>
                </span>
                <span>
                  After: <ins>{replacement || "(remove selected text)"}</ins>
                </span>
              </div>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={disclosed}
                  disabled={inputLocked}
                  onChange={(event) => setDisclosed(event.target.checked)}
                />
                Publish this suggestion and rationale publicly.
              </label>
              <button
                disabled={
                  busy ||
                  !disclosed ||
                  !rationale.trim() ||
                  replacement === composer.selection.quote
                }
              >
                {pending.current
                  ? "Retry suggestion publication"
                  : "Publish suggestion"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setComposer(null);
                  pending.current = null;
                }}
              >
                Discard suggestion draft
              </button>
            </form>
          )}
          {selected && (
            <section className="proposal-detail">
              <h3>Exact proposed change</h3>
              <p>
                Based on saved version {selected.baseVersion}
                {selected.stale
                  ? " · Source has changed since this proposal"
                  : ""}
              </p>
              <p className="eyebrow">BEFORE</p>
              <blockquote>{selected.proposal.selection.quote}</blockquote>
              <p className="eyebrow">AFTER</p>
              <blockquote>
                {selected.proposal.replacement || "(remove selected text)"}
              </blockquote>
              <h3>Rationale</h3>
              <p className="proposal-rationale">
                {selected.proposal.rationale}
              </p>
              <RemovedNotice moderation={selected.moderation} />
              {record && !selected.moderation && (
                <ReportButton
                  tenantId={doc.tenantId}
                  targetKind="proposal"
                  targetId={selected.proposal.id}
                />
              )}
              <p className="small">
                Proposal commitment:{" "}
                <code className="digest">{selected.digest}</code>Blockchain
                anchoring pending.
              </p>
              <DiscussionPanel
                key={selected.proposal.id}
                document={doc}
                proposal={selected.proposal}
              />
            </section>
          )}
          <h3>All suggestions</h3>
          <button
            disabled={busy || loading}
            onClick={() => setRefresh((x) => x + 1)}
          >
            Refresh suggestions
          </button>
          <ul className="proposal-list">
            {items.map((item) => (
              <li key={item.proposal.id}>
                <button
                  disabled={busy || loading}
                  onClick={() => {
                    setSelected(item);
                    setComposer(null);
                  }}
                >
                  {item.moderation
                    ? "Suggestion removed by moderator"
                    : <>Replace “{short(item.proposal.selection.quote)}” with “
                      {short(item.proposal.replacement) || "(remove)"}”</>}
                </button>
                <span className="small">
                  Version {item.baseVersion}
                  {item.stale ? " · Source changed" : ""}
                </span>
              </li>
            ))}
          </ul>
          {!busy && items.length === 0 && (
            <p>
              No suggestions yet. Highlight source text to propose a change.
            </p>
          )}
          {cursor && (
            <button
              disabled={busy || loading}
              onClick={async () => {
                setLoading(true);
                try {
                  const result = await api(
                    `/api/public/documents/${doc.id}/proposals?after=${cursor}`,
                  );
                  setItems((old) => [...old, ...result.items]);
                  setCursor(result.nextCursor);
                } catch {
                  setError("More suggestions could not be loaded.");
                } finally {
                  setLoading(false);
                }
              }}
            >
              More suggestions
            </button>
          )}
        </aside>
      )}
    </>
  );
}
