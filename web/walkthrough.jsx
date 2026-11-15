// DCE-031: role- and mode-aware walkthrough anchored to real controls. It only
// explains: it never clicks, submits, casts a ballot or signs. Steps whose
// target is absent (feature unavailable to this role/mode) are skipped, so the
// tour never describes something the viewer cannot use.
import React, { useEffect, useRef, useState } from "react";

import { planWalkthrough, savedStep, resetWalkthrough, rememberStep } from "./walkthrough-plan.mjs";
export { WALKTHROUGH_STEPS, planWalkthrough, savedStep, resetWalkthrough } from "./walkthrough-plan.mjs";

export function Walkthrough({ id = "editor", role, mode, onClose, storage = globalThis.localStorage }) {
  const [steps] = useState(() => planWalkthrough({ role, mode, present: (t) => Boolean(document.querySelector('[data-tour="' + t + '"]')) }));
  const [step, setStep] = useState(() => savedStep(id, steps.length, storage));
  const [position, setPosition] = useState({ left: 20, top: 100 });
  const title = useRef(null), opener = useRef(typeof document !== "undefined" ? document.activeElement : null);
  const close = (finished) => {
    rememberStep(id, finished ? null : step, storage);
    onClose();
    if (opener.current?.isConnected) opener.current.focus();
  };
  useEffect(() => {
    if (!steps.length) return undefined;
    rememberStep(id, step, storage);
    const target = document.querySelector('[data-tour="' + steps[step].target + '"]');
    target?.classList.add("tour-target");
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    target?.scrollIntoView?.({ block: "center", behavior: reduced ? "auto" : "smooth" });
    const place = () => {
      const r = target?.getBoundingClientRect();
      if (!r) return;
      setPosition({ left: Math.max(12, Math.min(r.left, window.innerWidth - 352)), top: Math.max(12, Math.min(r.bottom + 14, window.innerHeight - 280)) });
    };
    place();
    title.current?.focus();
    const key = (e) => { if (e.key === "Escape") close(false); };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("keydown", key);
    return () => {
      target?.classList.remove("tour-target");
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("keydown", key);
    };
  }, [step]);
  if (!steps.length) return <aside className="tour" role="dialog" aria-label="Walkthrough"><p>No guided steps apply to this page.</p><button onClick={() => close(true)}>Close</button></aside>;
  const last = step === steps.length - 1;
  return (
    <aside className="tour" role="dialog" aria-modal="false" aria-labelledby="walkthrough-title" style={position}>
      <p className="eyebrow" aria-live="polite">STEP {step + 1} OF {steps.length}</p>
      <h2 id="walkthrough-title" ref={title} tabIndex={-1}>{steps[step].title}</h2>
      <p>{steps[step].body}</p>
      <div>
        <button onClick={() => close(false)}>Close</button>
        <button onClick={() => { resetWalkthrough(id, storage); setStep(0); }} disabled={step === 0}>Start over</button>
        <button disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
        <button onClick={() => (last ? close(true) : setStep(step + 1))}>{last ? "Finish" : "Next"}</button>
      </div>
    </aside>
  );
}
