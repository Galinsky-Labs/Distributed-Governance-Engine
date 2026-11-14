// DCE-033 localization runtime. Browser-safe: no Node APIs, catalogs are
// plain modules. Messages use a small ICU MessageFormat subset:
//   {name}                       plain argument
//   {name, number} / {name, date} Intl-formatted argument
//   {count, plural, =0 {…} one {…} other {…}}  with # for the formatted count
// Lookups fall back from the requested locale to English and then to the
// localized "text unavailable" message, so a raw key is never shown.
import en from "./locales/en.mjs";
import es from "./locales/es.mjs";
import fr from "./locales/fr.mjs";
import ar from "./locales/ar.mjs";

export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = Object.freeze(["en", "es", "fr", "ar"]);
export const CATALOGS = Object.freeze({ en, es, fr, ar });
const RTL_LANGUAGES = new Set(["ar", "fa", "he", "ps", "ur", "yi", "dv", "ckb", "sd", "ug"]);
const TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

const languageOf = (tag) => String(tag).split("-")[0].toLowerCase();

/** Writing direction for a UI locale or a document's content locale. */
export function textDirection(locale) {
  return RTL_LANGUAGES.has(languageOf(locale ?? "")) ? "rtl" : "ltr";
}

/** Language ranges from an Accept-Language header, best first; malformed ranges are ignored. */
export function parseAcceptLanguage(header) {
  if (typeof header !== "string" || header.length > 1024) return [];
  const ranges = [];
  header.split(",").slice(0, 32).forEach((part, index) => {
    const [range, ...parameters] = part.trim().split(";").map((s) => s.trim());
    if (!range || (range !== "*" && !TAG.test(range))) return;
    let quality = 1;
    for (const parameter of parameters) {
      const match = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.exec(parameter);
      if (!match) return;
      quality = Number(match[1]);
    }
    if (quality > 0) ranges.push({ range, quality, index });
  });
  return ranges.sort((a, b) => b.quality - a.quality || a.index - b.index).map((r) => r.range);
}

/** Closest supported locale for one tag: exact, then same language. */
export function matchLocale(tag, available = SUPPORTED_LOCALES) {
  if (typeof tag !== "string" || !TAG.test(tag)) return null;
  const lower = tag.toLowerCase();
  return available.find((l) => l.toLowerCase() === lower) ??
    available.find((l) => languageOf(l) === languageOf(tag)) ?? null;
}

/**
 * UI locale: an explicit user preference wins, then the browser's
 * Accept-Language, then the document's own locale, then English.
 */
export function negotiateLocale({ preference = null, acceptLanguage = null, documentLocale = null, available = SUPPORTED_LOCALES } = {}) {
  const candidates = [preference, ...parseAcceptLanguage(acceptLanguage ?? ""), documentLocale];
  for (const candidate of candidates) {
    if (candidate === "*") continue;
    const match = matchLocale(candidate, available);
    if (match) return match;
  }
  return available.includes(DEFAULT_LOCALE) ? DEFAULT_LOCALE : available[0];
}

// --- message parsing ------------------------------------------------------

const parsed = new Map();
function parse(pattern) {
  if (parsed.has(pattern)) return parsed.get(pattern);
  let i = 0;
  const nodes = (inPlural) => {
    const out = [];
    let text = "";
    while (i < pattern.length) {
      const ch = pattern[i];
      if (ch === "}") break;
      if (ch === "{") {
        if (text) out.push(text), (text = "");
        out.push(argument());
        continue;
      }
      if (ch === "#" && inPlural) {
        if (text) out.push(text), (text = "");
        out.push({ type: "count" });
        i++;
        continue;
      }
      text += ch;
      i++;
    }
    if (text) out.push(text);
    return out;
  };
  const word = () => {
    while (pattern[i] === " ") i++;
    const start = i;
    while (i < pattern.length && /[A-Za-z0-9_=.-]/.test(pattern[i])) i++;
    const value = pattern.slice(start, i);
    while (pattern[i] === " ") i++;
    return value;
  };
  const expect = (ch) => {
    if (pattern[i] !== ch) throw Error("Malformed message pattern");
    i++;
  };
  const argument = () => {
    expect("{");
    const name = word();
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw Error("Malformed message argument");
    if (pattern[i] === "}") { i++; return { type: "arg", name }; }
    expect(",");
    const format = word();
    if (format === "number" || format === "date") { expect("}"); return { type: format, name }; }
    if (format !== "plural") throw Error("Unsupported message format");
    expect(",");
    const branches = {};
    for (;;) {
      const selector = word();
      if (!selector) break;
      if (!/^(=\d+|zero|one|two|few|many|other)$/.test(selector) || Object.hasOwn(branches, selector)) throw Error("Malformed plural selector");
      expect("{");
      branches[selector] = nodes(true);
      expect("}");
    }
    expect("}");
    if (!branches.other) throw Error("Plural messages require an other branch");
    return { type: "plural", name, branches };
  };
  const result = nodes(false);
  if (i !== pattern.length) throw Error("Malformed message pattern");
  parsed.set(pattern, result);
  return result;
}

/** Argument names and plural selectors of a pattern, for catalog parity checks. */
export function messageShape(pattern) {
  const args = new Set(), plurals = {};
  const walk = (list) => {
    for (const node of list) {
      if (typeof node === "string" || node.type === "count") continue;
      args.add(node.name);
      if (node.type === "plural") {
        plurals[node.name] = Object.keys(node.branches).sort();
        Object.values(node.branches).forEach(walk);
      }
    }
  };
  walk(parse(pattern));
  return { args: [...args].sort(), plurals };
}

const formatters = new Map();
const cached = (kind, locale, options, make) => {
  const key = kind + "|" + locale + "|" + JSON.stringify(options ?? {});
  if (!formatters.has(key)) formatters.set(key, make());
  return formatters.get(key);
};
export const formatNumber = (locale, value, options) =>
  cached("number", locale, options, () => new Intl.NumberFormat(locale, options)).format(value);
export const formatDate = (locale, value, options = { dateStyle: "medium", timeStyle: "short" }) =>
  cached("date", locale, options, () => new Intl.DateTimeFormat(locale, options)).format(value instanceof Date ? value : new Date(value));
const pluralRules = (locale) => cached("plural", locale, null, () => new Intl.PluralRules(locale));

/** Formats one pattern. Missing arguments render empty and are reported. */
export function formatMessage(pattern, params = {}, locale = DEFAULT_LOCALE, onMissingArgument = () => {}) {
  const render = (list, count) => list.map((node) => {
    if (typeof node === "string") return node;
    if (node.type === "count") return formatNumber(locale, count);
    const value = params[node.name];
    if (value === undefined || value === null) { onMissingArgument(node.name); return ""; }
    if (node.type === "number") return formatNumber(locale, Number(value));
    if (node.type === "date") return formatDate(locale, value);
    if (node.type === "plural") {
      const n = Number(value);
      const branch = node.branches["=" + n] ?? node.branches[pluralRules(locale).select(n)] ?? node.branches.other;
      return render(branch, n);
    }
    return String(value);
  }).join("");
  return render(parse(pattern));
}

/**
 * Creates t(key, params) for one locale. `onMissing({key, locale, argument})`
 * receives lookups that fell back, so integrators can count them; it never
 * receives parameter values.
 */
export function createTranslator(locale = DEFAULT_LOCALE, { catalogs = CATALOGS, onMissing = () => {} } = {}) {
  const resolved = matchLocale(locale, Object.keys(catalogs)) ?? DEFAULT_LOCALE;
  const own = catalogs[resolved] ?? {}, base = catalogs[DEFAULT_LOCALE] ?? {};
  const t = (key, params = {}) => {
    let pattern = own[key], patternLocale = resolved;
    if (typeof pattern !== "string") {
      onMissing({ key, locale: resolved });
      pattern = base[key];
      patternLocale = DEFAULT_LOCALE;
    }
    if (typeof pattern !== "string") {
      pattern = own["common.textUnavailable"] ?? base["common.textUnavailable"] ?? "";
      patternLocale = resolved;
    }
    return formatMessage(pattern, params, patternLocale, (argument) => onMissing({ key, locale: resolved, argument }));
  };
  t.locale = resolved;
  t.dir = textDirection(resolved);
  t.number = (value, options) => formatNumber(resolved, value, options);
  t.date = (value, options) => formatDate(resolved, value, options);
  t.has = (key) => typeof own[key] === "string" || typeof base[key] === "string";
  return Object.freeze(t);
}
