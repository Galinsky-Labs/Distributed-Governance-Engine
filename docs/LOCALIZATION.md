# Localization and accessibility infrastructure (DCE-033)

Status: infrastructure implemented and locally tested (`tests/i18n.test.mjs`, `tests/discovery-ui.test.mjs`). The existing screens in `web/app.jsx`, `web/governance-home.jsx` and the other existing panels still render their hard-coded English strings; their catalog keys exist but those files have not been converted. No axe run, manual screen-reader, keyboard, contrast, text-scaling or low-bandwidth testing has been performed. Translations were drafted by an AI model and have not been reviewed by native speakers.

## Runtime: `src/i18n.mjs`

Browser-safe (no Node APIs); catalogs are plain modules in `src/locales/{en,es,fr,ar}.mjs`.

| Export | Behaviour |
| --- | --- |
| `createTranslator(locale, {catalogs?, onMissing?})` | returns `t(key, params)` plus `t.locale`, `t.dir`, `t.number(value, options)`, `t.date(value, options)`, `t.has(key)` |
| `negotiateLocale({preference, acceptLanguage, documentLocale, available})` | explicit user preference → `Accept-Language` (q-ordered) → document locale → `en`; matches exact tag, then language (`es-MX` → `es`) |
| `parseAcceptLanguage(header)` | bounded parser (≤ 1 KiB, ≤ 32 ranges); malformed ranges and `q=0` are dropped |
| `textDirection(locale)` | `rtl` for Arabic, Hebrew, Persian, Urdu and other RTL scripts, else `ltr` |
| `formatMessage(pattern, params, locale)` / `messageShape(pattern)` | formatting and parity introspection |
| `SUPPORTED_LOCALES`, `CATALOGS`, `DEFAULT_LOCALE` | `["en","es","fr","ar"]` |

Message syntax is an ICU MessageFormat subset: `{name}`, `{n, number}`, `{d, date}` and `{count, plural, =0 {…} one {# …} other {# …}}`, with plural categories chosen by `Intl.PluralRules` and `#` formatted by `Intl.NumberFormat`. Arabic messages provide `zero`, `one`, `two`, `few`, `many` and `other`; Spanish and French provide `many`. `select`, nested arguments other than inside plural branches, and apostrophe quoting are not supported and throw.

Fallback never shows a raw key: requested locale → English → the locale's "Text unavailable" message. `onMissing({key, locale, argument?})` reports fallbacks without parameter values. Missing arguments render as empty text. Formatting returns plain strings; React escapes them on render.

The document's own language is separate from the UI language: documents carry `metadata.locale`, and content should be rendered with `lang={doc.metadata.locale}` and `dir={textDirection(doc.metadata.locale)}` even when the surrounding UI uses another locale.

## Catalogs

Keys cover the governance home (`home.*`), document library (`library.*`), proposal, discussion and decision panels (`proposals.*`, `discussion.*`, `decision.*`), account basics (`account.*`), document modes (`mode.*`), shared messages (`common.*`), search (`search.*`), notifications and notification emails (`notifications.*`) and the language picker (`language.*`). English is the source. `tests/i18n.test.mjs` enforces that every locale has exactly the English keys, the same argument names, the same plural arguments and every plural category its locale requires. To add a locale: add `src/locales/<tag>.mjs`, register it in `CATALOGS`/`SUPPORTED_LOCALES`, and run the parity test.

## React: `web/i18n-react.mjs`

- `<I18nProvider locale catalogs? onMissing? applyToDocument?>` supplies the translator. With `applyToDocument` it sets `<html lang dir>`; leave it off for a localized island inside another page.
- `useT()` returns the active `t`.
- `browserLocale(preference?)` negotiates from `navigator.languages`.

`web/language-picker.jsx` — `<LanguagePicker value onChange locales? id?>`: a labelled `<select>` listing each language by its own name with `lang` and `dir` on the option, and a polite live region announcing the change. Persisting the choice is the caller's job (for notification emails it is the `locale` notification preference).

## Accessibility checks: `tests/support/a11y.mjs`

`auditAccessibility(root, {requireLandmark = true, requireLiveRegion = true})` returns `{rule, element}` violations for: form controls without a label (`label[for]`, wrapping label, `aria-label`, `aria-labelledby`, `title`), buttons and links without an accessible name, skipped heading levels and empty headings, duplicate IDs, `aria-labelledby`/`aria-describedby` references to missing IDs, positive `tabindex`, a missing landmark and a missing live region (`aria-live`, `role=status|alert|log`). It is a structural subset of WCAG 2.2 criteria 1.3.1, 2.4.3, 2.4.6, 4.1.2 and 4.1.3 — it does not compute contrast, focus visibility, reflow or target size and does not replace axe or manual assistive-technology testing.

The new components (search panel, notification center, follow button, unsubscribe and verification pages, language picker) are rendered in jsdom (the search panel in English and Arabic, the unsubscribe page in French, the rest in English) and pass these checks, including after results load and state changes. All status changes are announced through `role="status"` regions; every action is a native `<button>`, `<a>` or form control, so the flows are keyboard operable without custom key handling.
