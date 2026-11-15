// Page registry for the Quill browser application. The engine and each
// product (CivicQuill, CharterQuill) contribute pages; nothing else about the
// editor or governance surfaces is forked by an application.
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.jsx";
import { GovernanceHome } from "./governance-home.jsx";
import { I18nProvider, browserLocale } from "./i18n-react.mjs";
import { LanguagePicker } from "./language-picker.jsx";
import "./console.css";

const LOCALE_KEY = "quill.locale";
const storedLocale = () => { try { return localStorage.getItem(LOCALE_KEY); } catch { return null; } };

const PATH = /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;

export function validatePages(pages) {
  const seen = new Set();
  for (const page of pages) {
    if (!PATH.test(page.path ?? "") || typeof page.Component !== "function" || typeof page.title !== "string" || seen.has(page.path))
      throw Error("Invalid Quill page registration");
    seen.add(page.path);
  }
  return pages;
}

function ConsoleNavigation({ pages, current, product, locale, onLocale }) {
  const brand = product === "charter" ? "CharterQuill" : "CivicQuill";
  const groups = [...new Set(pages.filter((p) => p.nav).map((p) => p.nav))];
  return (
    <header className="console-navigation">
      <a className="governance-brand" href="/governance"><span aria-hidden="true">Q</span>{brand}</a>
      <nav aria-label="Primary">
        <a href="/governance">Workspaces</a>
        <a href="/">Document editor</a>
        {groups.map((group) => (
          <details key={group} className="console-menu">
            <summary>{group}</summary>
            <ul>
              {pages.filter((p) => p.nav === group).map((p) => (
                <li key={p.path}><a href={p.path} aria-current={p.path === current ? "page" : undefined}>{p.title}</a></li>
              ))}
            </ul>
          </details>
        ))}
        <a href="/account">Account</a>
        {onLocale && <LanguagePicker value={locale} onChange={onLocale} id="console-language" />}
      </nav>
    </header>
  );
}

export function ConsolePage({ page, pages, product }) {
  const Component = page.Component;
  const [locale, setLocale] = React.useState(() => browserLocale(storedLocale()));
  const changeLocale = (next) => { setLocale(next); try { localStorage.setItem(LOCALE_KEY, next); } catch {} };
  React.useEffect(() => { document.title = page.title + " — " + (product === "charter" ? "CharterQuill" : "CivicQuill"); }, [page, product]);
  return (
    <I18nProvider locale={locale} applyToDocument>
    <div className="governance-page console-page">
      <ConsoleNavigation pages={pages} current={page.path} product={product} locale={locale} onLocale={changeLocale} />
      <main className="console-body" id="main">
        <h1 className="console-title">{page.title}</h1>
        {page.description && <p className="console-description">{page.description}</p>}
        <Component product={product} />
      </main>
    </div>
    </I18nProvider>
  );
}

/** Mounts the application; unknown paths fall back to the document editor. */
export function bootQuill({ pages = [], root = document.getElementById("root") } = {}) {
  validatePages(pages);
  const product = document.documentElement.dataset.quillProduct === "charter" ? "charter" : "civic";
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const page = pages.find((p) => p.path === path);
  const element = path === "/governance" ? <GovernanceHome /> : page ? <ConsolePage page={page} pages={pages} product={product} /> : <App />;
  createRoot(root).render(element);
}
