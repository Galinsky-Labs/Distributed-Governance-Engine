// React bindings for src/i18n.mjs. Plain .mjs (no JSX) so it can be imported
// anywhere the bundle runs.
import React, { createContext, useContext, useEffect, useMemo } from "react";
import { createTranslator, negotiateLocale, DEFAULT_LOCALE } from "../src/i18n.mjs";

const I18nContext = createContext(createTranslator(DEFAULT_LOCALE));

/**
 * Supplies t() to descendants. With applyToDocument the <html> element gets
 * the resolved lang and dir, which is what screen readers and bidirectional
 * layout rely on; leave it off for a localized island inside another page.
 */
export function I18nProvider({ locale = DEFAULT_LOCALE, catalogs, onMissing, applyToDocument = false, children }) {
  const t = useMemo(
    () => createTranslator(locale, { ...(catalogs ? { catalogs } : {}), ...(onMissing ? { onMissing } : {}) }),
    [locale, catalogs, onMissing],
  );
  useEffect(() => {
    if (!applyToDocument) return;
    document.documentElement.lang = t.locale;
    document.documentElement.dir = t.dir;
  }, [t, applyToDocument]);
  return React.createElement(I18nContext.Provider, { value: t }, children);
}

/** The active translator: call t(key, params); t.locale, t.dir, t.number(), t.date(). */
export const useT = () => useContext(I18nContext);

/** Locale for a first render: saved preference, then the browser's language list. */
export function browserLocale(preference = null) {
  const languages = typeof navigator === "undefined" ? [] : (navigator.languages ?? [navigator.language]);
  return negotiateLocale({ preference, acceptLanguage: languages.filter(Boolean).join(",") });
}
