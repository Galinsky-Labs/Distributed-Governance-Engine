import React, {useState} from "react";
import {CATALOGS,SUPPORTED_LOCALES,textDirection} from "../src/i18n.mjs";
import {useT} from "./i18n-react.mjs";

/** Each language is listed by its own name, marked with its lang and dir. */
export function LanguagePicker({value,onChange,locales=SUPPORTED_LOCALES,id="language-picker"}) {
  const t=useT();
  const [announcement,setAnnouncement]=useState("");
  function choose(event) {
    const next=event.target.value;
    onChange(next);
    setAnnouncement(t("language.changed",{language:CATALOGS[next]?.["language.name"]??next}));
  }
  return <div className="language-picker">
    <label htmlFor={id}>{t("language.label")}</label>
    <select id={id} value={value} onChange={choose}>
      {locales.map(locale=><option key={locale} value={locale} lang={locale} dir={textDirection(locale)}>
        {CATALOGS[locale]?.["language.name"]??locale}
      </option>)}
    </select>
    <span className="status" role="status" aria-live="polite">{announcement}</span>
  </div>;
}
