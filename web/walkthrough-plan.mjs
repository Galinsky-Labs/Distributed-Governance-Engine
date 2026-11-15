// DCE-031: pure walkthrough planning and resume state (no React), shared by
// web/walkthrough.jsx and Node tests.
const MANAGERS = ["owner", "admin"];
const CONTRIBUTORS = ["owner", "admin", "editor", "participant"];

/** [target, title, body, {roles?, modes?, feedbackBody?}] */
export const WALKTHROUGH_STEPS = Object.freeze([
  ["mode", "Know which edition you are reading", "Working drafts can be edited here. A public-input source is frozen: editor transactions that would change it are rejected.", {}],
  ["editor", "Work with actual legal structure", "Sections, paragraphs, references and tables keep stable identities, so renumbering never changes which clause they represent.", { modes: ["collaboration"] }],
  ["toolbar", "Format with a focused set of tools", "Text styles, undo and redo, legal sections, lists and tables work the same way in both Quill products.", { modes: ["collaboration"] }],
  ["outline", "Follow the legal outline", "The outline follows the semantic section hierarchy. The federal profile uses section, (a), (1), (A), (i), and (I).", {}],
  ["save", "Know whether your wording is saved", "Saved versions are public. A failed or conflicting save keeps your local wording visible until you retry or download it.", { roles: CONTRIBUTORS, modes: ["collaboration"] }],
  ["suggest", "Propose exact replacement wording", "Highlight text within one paragraph and choose Suggest replacement. The proposal keeps its exact saved version and source quote.", { roles: CONTRIBUTORS,
    feedbackBody: "This source is fixed for public input. Suggestions are feedback to the sponsor: they are recorded and answered, but they cannot change this text." }],
  ["proposals", "Review the exact suggested change", "Compare before and after wording and the rationale. A revised suggestion is a new proposal; earlier ballots never carry over.", {}],
  ["points", "Build an organized argument", "Keep supporting, opposing and clarifying points separate. Replies say whether they support, challenge or clarify their parent.", {}],
  ["point-vote", "Rank the point itself", "Rate points up or down. Rankings explain their sort, and argument ratings never change any decision ballot or the source wording.", { roles: CONTRIBUTORS }],
  ["ballot", "Vote on frozen wording", "A decision freezes the exact wording, electorate and rule before voting. Your ballot counts only for that snapshot; this tour never casts one.", { roles: CONTRIBUTORS,
    feedbackBody: "In public-input mode the result is advisory: it is published with any support floor, but it can never adopt or change the source." }],
  ["signatures", "Sign an exact edition", "Signatures bind to one immutable edition. Execution signatures need a passkey confirmation; this tour never signs.", { roles: CONTRIBUTORS }],
  ["history", "Inspect earlier public versions", "Each saved version stays available. Pending blockchain anchoring is not shown as a verified receipt.", {}],
  ["recovery", "Choose whether to keep this public sample", "Optional device recovery applies only to explicitly public samples. Confidential drafts use the encrypted private workspace.", {}],
  ["export", "Take an exact working copy", "Download structured JSON or plain text of the exact edition you are reading.", {}],
  ["admin", "Manage rules without breaking invariants", "Settings can change prices, quotas and defaults, but never an active electorate, policy, ballot wording or public-input immutability.", { roles: MANAGERS }],
]);

/** Pure planner: which steps apply, with mode-specific explanations. */
/**
 * Pure planner. `role` undefined means the page does not know the viewer's
 * role; the presence of each rendered control (which panels already gate by
 * role) then decides alone.
 */
export function planWalkthrough({ steps = WALKTHROUGH_STEPS, role, mode = "collaboration", present = () => true }) {
  if (!["collaboration", "public-input"].includes(mode)) throw Error("Invalid document mode");
  return steps
    .filter(([target, , , o]) => (!o.roles || role === undefined || o.roles.includes(role)) && (!o.modes || o.modes.includes(mode)) && present(target))
    .map(([target, title, body, o]) => ({ target, title, body: mode === "public-input" && o.feedbackBody ? o.feedbackBody : body }));
}

const storageKey = (id) => "dge-walkthrough:" + id;
/** Resume position; storage failures (private mode, quotas) fall back to step 0. */
export function savedStep(id, count, storage = globalThis.localStorage) {
  try {
    const value = Number(storage?.getItem(storageKey(id)));
    return Number.isInteger(value) && value >= 0 && value < count ? value : 0;
  } catch { return 0; }
}
export function rememberStep(id, step, storage = globalThis.localStorage) {
  try { step === null ? storage?.removeItem(storageKey(id)) : storage?.setItem(storageKey(id), String(step)); } catch { /* best effort */ }
}
export const resetWalkthrough = (id, storage) => rememberStep(id, null, storage);

