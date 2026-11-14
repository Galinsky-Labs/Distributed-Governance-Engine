// Structural accessibility checks for rendered markup (jsdom). These are
// automated checks of a subset of WCAG 2.2 success criteria (1.3.1, 2.4.3,
// 2.4.6, 4.1.2, 4.1.3); they do not replace axe or manual screen-reader and
// keyboard testing.

const LANDMARKS = "main,nav,header,footer,aside,form[aria-label],form[aria-labelledby],section[aria-label],section[aria-labelledby],[role=main],[role=navigation],[role=search],[role=region],[role=complementary],[role=banner],[role=contentinfo],[role=form]";
const CONTROLS = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),select,textarea";
const BUTTONS = "button,[role=button],input[type=submit],input[type=button],input[type=reset]";

const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
const describe = (element) => element.outerHTML.slice(0, 160);

function labelledBy(element) {
  const ids = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
  return ids.map((id) => text(element.ownerDocument.getElementById(id))).join(" ").trim();
}

/** Accessible name per the common cases of the accname algorithm. */
export function accessibleName(element) {
  const byReference = labelledBy(element);
  if (byReference) return byReference;
  const aria = (element.getAttribute("aria-label") ?? "").trim();
  if (aria) return aria;
  if (element.matches(CONTROLS)) {
    const labels = [...(element.labels ?? [])].map(text).filter(Boolean);
    if (labels.length) return labels.join(" ");
  }
  if (element.matches("input[type=submit],input[type=button],input[type=reset]")) return (element.value ?? "").trim();
  if (element.matches("button,a,[role=button],[role=link],h1,h2,h3,h4,h5,h6")) {
    const content = text(element);
    if (content) return content;
  }
  return (element.getAttribute("title") ?? "").trim();
}

/**
 * Returns a list of {rule, element} violations under `root`. Options:
 * requireLandmark (default true) and requireLiveRegion (default true; set
 * false for components with no asynchronous status).
 */
export function auditAccessibility(root, { requireLandmark = true, requireLiveRegion = true } = {}) {
  const violations = [];
  const report = (rule, element) => violations.push({ rule, element: element ? describe(element) : null });

  for (const control of root.querySelectorAll(CONTROLS)) if (!accessibleName(control)) report("control-label", control);
  for (const button of root.querySelectorAll(BUTTONS)) if (!accessibleName(button)) report("button-name", button);
  for (const link of root.querySelectorAll("a[href]")) if (!accessibleName(link)) report("link-name", link);
  for (const element of root.querySelectorAll("[aria-labelledby],[aria-describedby]"))
    for (const attribute of ["aria-labelledby", "aria-describedby"])
      for (const id of (element.getAttribute(attribute) ?? "").split(/\s+/).filter(Boolean))
        if (!element.ownerDocument.getElementById(id)) report("broken-reference", element);

  let previous = 0;
  for (const heading of root.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
    const level = Number(heading.tagName[1]);
    if (previous && level > previous + 1) report("heading-order", heading);
    if (!accessibleName(heading)) report("empty-heading", heading);
    previous = level;
  }

  const seen = new Set();
  for (const element of root.querySelectorAll("[id]")) {
    if (seen.has(element.id)) report("duplicate-id", element);
    seen.add(element.id);
  }

  for (const element of root.querySelectorAll("[tabindex]"))
    if (Number(element.getAttribute("tabindex")) > 0) report("positive-tabindex", element);

  const self = root.matches?.(LANDMARKS) ? [root] : [];
  if (requireLandmark && !self.length && !root.querySelector(LANDMARKS)) report("landmark", null);
  const live = "[aria-live=polite],[aria-live=assertive],[role=status],[role=alert],[role=log]";
  if (requireLiveRegion && !root.querySelector(live)) report("live-region", null);
  return violations;
}
