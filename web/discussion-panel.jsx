import React, { useEffect, useRef, useState } from "react";
import { createAccountAPI } from "./account-api.mjs";
import { RemovedNotice, ReportButton } from "./moderation-panel.jsx";
const api = createAccountAPI(),
  names = {
    support: "Supporting points",
    oppose: "Opposing points",
    clarify: "Clarifications",
  };
const empty = () =>
  Object.fromEntries(
    Object.keys(names).map((key) => [key, { items: [], nextCursor: null }]),
  );
export function DiscussionPanel({ document: doc, proposal }) {
  const [groups, setGroups] = useState(empty),
    [sort, setSort] = useState("top"),
    [threadStack, setThreadStack] = useState([]),
    [children, setChildren] = useState({ items: [], nextCursor: null }),
    [rights, setRights] = useState({
      canContribute: false,
      ownPointIds: [],
      items: [],
    }),
    [form, setForm] = useState(null),
    [text, setText] = useState(""),
    [position, setPosition] = useState("support"),
    [relation, setRelation] = useState("challenges"),
    [evidence, setEvidence] = useState([]),
    [disclosed, setDisclosed] = useState(false),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [refresh, setRefresh] = useState(0);
  const pendingPoint = useRef(null),
    pendingVote = useRef(null),
    mounted = useRef(true),
    formNode = useRef(null);
  const thread = threadStack.at(-1),
    base = `/api/workspaces/${doc.tenantId}/documents/${doc.id}/proposals/${proposal.id}`,
    publicBase = `/api/public/documents/${doc.id}/proposals/${proposal.id}/points`;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (form) {
      formNode.current?.querySelector("textarea")?.focus();
      formNode.current?.scrollIntoView({ block: "nearest" });
    }
  }, [form]);
  async function ownInfo(rows, signal) {
    const ids = [...new Set(rows.map((item) => item.point.id))];
    try {
      return await api(
        base +
          "/my-point-votes" +
          (ids.length ? "?points=" + ids.join(",") : ""),
        { signal },
      );
    } catch (cause) {
      if (cause.name === "AbortError") throw cause;
      return { canContribute: false, ownPointIds: [], items: [] };
    }
  }
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    (async () => {
      const entries = await Promise.all(
        Object.keys(names).map(async (key) => [
          key,
          await api(publicBase + `?position=${key}&sort=${sort}`, {
            signal: abort.signal,
          }),
        ]),
      );
      const next = Object.fromEntries(entries);
      const replies = thread
        ? await api(publicBase + `?parent=${thread.point.id}&sort=${sort}`, {
            signal: abort.signal,
          })
        : { items: [], nextCursor: null };
      const own = await ownInfo(
        [
          ...Object.values(next).flatMap((group) => group.items),
          ...replies.items,
          ...(thread ? [thread] : []),
        ],
        abort.signal,
      );
      if (abort.signal.aborted) return;
      setGroups(next);
      setChildren(replies);
      setRights(own);
    })()
      .catch((cause) => {
        if (cause.name !== "AbortError")
          setMessage("Points could not be loaded. Refresh to try again.");
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [doc.id, proposal.id, sort, thread?.point.id, refresh]);
  function start(stance, parent = null) {
    if (pendingPoint.current) return;
    setForm({ parent });
    setPosition(stance);
    setRelation("challenges");
    setText("");
    setEvidence([]);
    setDisclosed(false);
    setMessage("");
  }
  function failure(cause) {
    return cause.code === "POINT_RANKING_CHANGED"
      ? "Points or scores changed while you were paging. Refresh the ranking."
      : cause.code === "POINT_VOTE_CONFLICT"
        ? "Your vote changed in another window. The latest vote is loading; choose again."
        : cause.code === "SELF_POINT_VOTE_FORBIDDEN"
          ? "You cannot vote on your own point."
          : cause.code === "AUTHENTICATION_REQUIRED" ||
              cause.code === "ACCESS_DENIED" ||
              cause.code === "SIGN_IN_AGAIN"
            ? "Sign in with a workspace contributor role to add points or vote."
            : cause.code?.endsWith("_LIMIT_REACHED")
              ? "A workspace resource limit has been reached."
              : cause.code === "INVALID_POINT"
                ? "Use one concise point and complete HTTPS evidence links."
                : "This request could not be completed. Your draft is preserved.";
  }
  async function publish(event) {
    event.preventDefault();
    if (busy || !disclosed) return;
    setBusy(true);
    setMessage("");
    if (!pendingPoint.current)
      pendingPoint.current = {
        position,
        parentId: form.parent?.point.id ?? null,
        relation: form.parent ? relation : null,
        text,
        evidence: evidence.filter((link) => link.label || link.url),
        commandId: crypto.randomUUID(),
        disclosure: "publish-point-v1",
      };
    try {
      await api(base + "/points", {
        method: "POST",
        body: pendingPoint.current,
      });
      pendingPoint.current = null;
      if (!mounted.current) return;
      setForm(null);
      setMessage(
        "Point published. Argument votes rank it without changing the source.",
      );
      setRefresh((value) => value + 1);
    } catch (cause) {
      if (cause.status >= 400 && cause.status < 500)
        pendingPoint.current = null;
      if (mounted.current)
        setMessage(
          pendingPoint.current
            ? "The response is uncertain. Retry publishing the same point safely."
            : failure(cause),
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function cast(item, value) {
    if (busy || loading) return;
    const mine = rights.items.find((vote) => vote.pointId === item.point.id);
    if (!pendingVote.current)
      pendingVote.current = {
        pointId: item.point.id,
        body: {
          value,
          expectedVoteVersion: mine?.voteVersion ?? 0,
          commandId: crypto.randomUUID(),
        },
      };
    setBusy(true);
    setMessage("");
    const pending = pendingVote.current;
    try {
      await api(base + "/point-votes/" + pending.pointId, {
        method: "PUT",
        body: pending.body,
      });
      pendingVote.current = null;
      if (mounted.current) {
        setMessage("Argument vote recorded.");
        setRefresh((value) => value + 1);
      }
    } catch (cause) {
      if (cause.status >= 400 && cause.status < 500) pendingVote.current = null;
      if (mounted.current) {
        setMessage(
          pendingVote.current
            ? "The vote response was lost. Retry the same vote before making another change."
            : failure(cause),
        );
        if (!pendingVote.current) setRefresh((value) => value + 1);
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function more(key) {
    const group = key === "children" ? children : groups[key];
    if (!group.nextCursor || busy) return;
    setBusy(true);
    try {
      const result = await api(
        publicBase +
          `?sort=${sort}` +
          (key === "children"
            ? `&parent=${thread.point.id}`
            : `&position=${key}`) +
          "&after=" +
          group.nextCursor,
      );
      if (!mounted.current) return;
      const merged = { ...result, items: [...group.items, ...result.items] };
      if (key === "children") setChildren(merged);
      else setGroups((old) => ({ ...old, [key]: merged }));
      const own = await ownInfo(result.items);
      if (mounted.current)
        setRights((old) => ({
          ...own,
          items: [
            ...old.items.filter(
              (vote) =>
                !own.items.some((next) => next.pointId === vote.pointId),
            ),
            ...own.items,
          ],
          ownPointIds: [...new Set([...old.ownPointIds, ...own.ownPointIds])],
        }));
    } catch (cause) {
      if (mounted.current) setMessage(failure(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function card(item) {
    const own = rights.ownPointIds.includes(item.point.id),
      mine = rights.items.find((vote) => vote.pointId === item.point.id),
      disabled =
        busy ||
        loading ||
        !rights.canContribute ||
        own ||
        !!pendingVote.current;
    return (
      <article
        className="point-card"
        key={item.point.id}
        data-point-id={item.point.id}
      >
        <p className="point-position">
          {item.point.position === "support"
            ? "Supports the change"
            : item.point.position === "oppose"
              ? "Opposes the change"
              : "Clarifies the change"}
          {item.point.parentId
            ? " · " + item.point.relation + " its parent point"
            : ""}
        </p>
        <p className="point-thesis">{item.point.text}</p>
        <RemovedNotice moderation={item.moderation} />
        {item.point.evidence.length > 0 && (
          <ul className="point-evidence">
            {item.point.evidence.map((link, index) => (
              <li key={index}>
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {link.label}
                </a>
                <span className="small">{new URL(link.url).hostname}</span>
              </li>
            ))}
          </ul>
        )}
        {rights.canReport && !item.moderation && (
          <ReportButton
            tenantId={doc.tenantId}
            targetKind="point"
            targetId={item.point.id}
          />
        )}
        <div className="point-voting" data-tour="point-vote">
          <button
            disabled={disabled}
            aria-label="Upvote this point"
            aria-pressed={mine?.value === 1}
            onClick={() => cast(item, 1)}
          >
            ↑ {item.up}
          </button>
          <span className="point-score">Net {item.net}</span>
          <button
            disabled={disabled}
            aria-label="Downvote this point"
            aria-pressed={mine?.value === -1}
            onClick={() => cast(item, -1)}
          >
            ↓ {item.down}
          </button>
          {mine?.value !== undefined && mine.value !== 0 && (
            <button disabled={disabled} onClick={() => cast(item, 0)}>
              Withdraw point vote
            </button>
          )}
          {own && (
            <span className="small">Your point · self-voting is disabled</span>
          )}
        </div>
        <div className="point-actions">
          <button
            disabled={busy || loading}
            onClick={() => setThreadStack((stack) => [...stack, item])}
          >
            View replies
          </button>
          <button
            disabled={
              busy || loading || !rights.canContribute || !!pendingPoint.current
            }
            onClick={() =>
              start(
                item.point.position === "support" ? "oppose" : "support",
                item,
              )
            }
          >
            Reply with a point
          </button>
        </div>
      </article>
    );
  }
  const locked = busy || !!pendingPoint.current;
  return (
    <section className="discussion" data-tour="points">
      <h3>Debate the change</h3>
      <p className="small">
        Argument votes rank concise points. They do not approve wording or
        change anyone's decision-vote weight.
      </p>
      <p className="small">
        Net score equals upvotes minus downvotes. Each contributor account can
        cast one current vote per point.
      </p>
      <div className="discussion-sort">
        <label>
          Show
          <select
            value={sort}
            disabled={busy || loading}
            onChange={(event) => setSort(event.target.value)}
          >
            <option value="top">Highest net scores</option>
            <option value="new">Newest points</option>
          </select>
        </label>
        <button
          disabled={busy || loading}
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh points
        </button>
      </div>
      <p className="discussion-status" role="status">
        {loading ? "Loading points…" : message}
      </p>
      {!loading && !rights.canContribute && (
        <p className="small">
          Sign in with a workspace contributor role to add points or vote.
          Reading is public.
        </p>
      )}
      {pendingVote.current && (
        <button
          disabled={busy || loading}
          onClick={() =>
            cast(
              { point: { id: pendingVote.current.pointId } },
              pendingVote.current.body.value,
            )
          }
        >
          Retry last point vote
        </button>
      )}
      {form && (
        <form ref={formNode} className="point-form" onSubmit={publish}>
          <h4>{form.parent ? "Reply to a point" : "Add a concise point"}</h4>
          {form.parent && <blockquote>{form.parent.point.text}</blockquote>}
          <label>
            Position on the proposed change
            <select
              value={position}
              disabled={locked}
              onChange={(event) => setPosition(event.target.value)}
            >
              <option value="support">Support</option>
              <option value="oppose">Oppose</option>
              <option value="clarify">Clarify</option>
            </select>
          </label>
          {form.parent && (
            <label>
              Relation to the parent point
              <select
                value={relation}
                disabled={locked}
                onChange={(event) => setRelation(event.target.value)}
              >
                <option value="challenges">Challenges</option>
                <option value="supports">Supports</option>
                <option value="clarifies">Clarifies</option>
              </select>
            </label>
          )}
          <label>
            One concise point
            <textarea
              value={text}
              maxLength={1000}
              required
              disabled={locked}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <p className="small">{text.length} / 1,000</p>
          {evidence.map((link, index) => (
            <div className="evidence-input" key={index}>
              <label>
                Evidence label
                <input
                  value={link.label}
                  maxLength={200}
                  required={!!link.url}
                  disabled={locked}
                  onChange={(event) =>
                    setEvidence((old) =>
                      old.map((value, at) =>
                        at === index
                          ? { ...value, label: event.target.value }
                          : value,
                      ),
                    )
                  }
                />
              </label>
              <label>
                HTTPS evidence URL
                <input
                  type="url"
                  value={link.url}
                  maxLength={2048}
                  required={!!link.label}
                  disabled={locked}
                  onChange={(event) =>
                    setEvidence((old) =>
                      old.map((value, at) =>
                        at === index
                          ? { ...value, url: event.target.value }
                          : value,
                      ),
                    )
                  }
                />
              </label>
              <button
                type="button"
                disabled={locked}
                onClick={() =>
                  setEvidence((old) => old.filter((_, at) => at !== index))
                }
              >
                Remove evidence link
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={locked || evidence.length >= 5}
            onClick={() =>
              setEvidence((old) => [...old, { label: "", url: "" }])
            }
          >
            Add evidence link
          </button>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={disclosed}
              disabled={locked}
              onChange={(event) => setDisclosed(event.target.checked)}
            />
            Publish this point and its evidence links publicly.
          </label>
          <button disabled={busy || !disclosed || !text.trim()}>
            {pendingPoint.current ? "Retry point publication" : "Publish point"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setForm(null);
              pendingPoint.current = null;
            }}
          >
            Discard point draft
          </button>
        </form>
      )}
      {thread ? (
        <section className="point-thread">
          <button
            disabled={busy || loading}
            onClick={() => setThreadStack((stack) => stack.slice(0, -1))}
          >
            Back to previous points
          </button>
          <h4>Replies to this point</h4>
          <blockquote>{thread.point.text}</blockquote>
          {children.items.map(card)}
          {children.items.length === 0 && !loading && <p>No replies yet.</p>}
          {children.nextCursor && (
            <button disabled={busy || loading} onClick={() => more("children")}>
              More replies
            </button>
          )}
          <button
            disabled={busy || loading || !rights.canContribute}
            onClick={() =>
              start(
                thread.point.position === "support" ? "oppose" : "support",
                thread,
              )
            }
          >
            Add a reply point
          </button>
        </section>
      ) : (
        Object.entries(names).map(([key, label]) => (
          <section className={"point-group point-group-" + key} key={key}>
            <h4>{label}</h4>
            {groups[key].items.map(card)}
            {!loading && groups[key].items.length === 0 && (
              <p className="small">No points on this side yet.</p>
            )}
            {groups[key].nextCursor && (
              <button disabled={busy || loading} onClick={() => more(key)}>
                More {label.toLowerCase()}
              </button>
            )}
            <button
              disabled={
                busy ||
                loading ||
                !rights.canContribute ||
                !!pendingPoint.current
              }
              onClick={() => start(key)}
            >
              Add{" "}
              {key === "support"
                ? "a supporting point"
                : key === "oppose"
                  ? "an opposing point"
                  : "a clarification"}
            </button>
          </section>
        ))
      )}
    </section>
  );
}
