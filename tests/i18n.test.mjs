import test from "node:test";
import assert from "node:assert/strict";
import {
  CATALOGS,SUPPORTED_LOCALES,createTranslator,formatMessage,messageShape,negotiateLocale,parseAcceptLanguage,textDirection,
} from "../src/i18n.mjs";

test("every locale has exactly the English keys with matching arguments and complete plural categories",()=>{
  const keys=Object.keys(CATALOGS.en).sort();
  for(const locale of SUPPORTED_LOCALES){
    const catalog=CATALOGS[locale];
    assert.deepEqual(Object.keys(catalog).sort(),keys,locale+" key set");
    const categories=new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    for(const key of keys){
      const source=messageShape(CATALOGS.en[key]),shape=messageShape(catalog[key]);
      assert.deepEqual(shape.args,source.args,`${locale} ${key} arguments`);
      assert.deepEqual(Object.keys(shape.plurals).sort(),Object.keys(source.plurals).sort(),`${locale} ${key} plural arguments`);
      for(const selectors of Object.values(shape.plurals))
        for(const category of categories)assert.ok(selectors.includes(category),`${locale} ${key} lacks plural category ${category}`);
      assert.ok(catalog[key].trim().length>0,`${locale} ${key} is empty`);
    }
  }
});

test("plural rules follow each locale, including Arabic dual and few/many forms",()=>{
  const ar=createTranslator("ar"),en=createTranslator("en"),fr=createTranslator("fr");
  assert.equal(en("search.resultCount",{count:0}),"No results shown");
  assert.equal(en("search.resultCount",{count:1}),"1 result shown");
  assert.equal(en("search.resultCount",{count:1234}),"1,234 results shown");
  assert.equal(fr("notifications.digestItems",{count:1}),"1 nouveauté");
  assert.equal(fr("notifications.digestItems",{count:2}),"2 nouveautés");
  assert.equal(ar("notifications.digestItems",{count:2}),"تحديثان");
  assert.match(ar("notifications.digestItems",{count:3}),/تحديثات$/);
  assert.match(ar("notifications.digestItems",{count:11}),/تحديثًا$/);
  assert.equal(ar("proposals.count",{count:0}),"لا توجد اقتراحات");
  assert.equal(ar("proposals.count",{count:5}),new Intl.NumberFormat("ar").format(5)+" اقتراحات");
});

test("direction, negotiation and Intl formatting",()=>{
  assert.equal(textDirection("ar"),"rtl");assert.equal(textDirection("ar-EG"),"rtl");assert.equal(textDirection("he-IL"),"rtl");
  assert.equal(textDirection("fr-CA"),"ltr");assert.equal(textDirection(undefined),"ltr");
  assert.equal(createTranslator("ar").dir,"rtl");assert.equal(createTranslator("es").dir,"ltr");
  assert.deepEqual(parseAcceptLanguage("fr-CA;q=0.8, ar;q=0.9, en;q=0, bogus tag, de"),["de","ar","fr-CA"]);
  assert.deepEqual(parseAcceptLanguage("x".repeat(2000)),[]);
  assert.equal(negotiateLocale({acceptLanguage:"de-DE, fr;q=0.5"}),"fr");
  assert.equal(negotiateLocale({preference:"es-MX",acceptLanguage:"fr"}),"es");
  assert.equal(negotiateLocale({acceptLanguage:"de",documentLocale:"ar-SA"}),"ar");
  assert.equal(negotiateLocale({acceptLanguage:"*",preference:"zz"}),"en");
  assert.equal(createTranslator("es-AR").locale,"es");
  assert.equal(createTranslator("es").number(1234.5),"1234,5");
  assert.equal(createTranslator("en").date(Date.UTC(2026,10,14,12),{dateStyle:"long",timeZone:"UTC"}),"November 14, 2026");
  assert.equal(formatMessage("{n, number} on {d, date}",{n:2,d:Date.UTC(2026,0,2)},"en").startsWith("2 on Jan"),true);
});

test("missing keys and arguments fall back without ever showing raw keys",()=>{
  const missing=[];
  const partial={en:CATALOGS.en,es:{"common.retry":"Reintentar"}};
  const t=createTranslator("es",{catalogs:partial,onMissing:m=>missing.push(m)});
  assert.equal(t("common.retry"),"Reintentar");
  assert.equal(t("common.close"),"Close","falls back to English");
  assert.equal(t("no.such.key"),"Text unavailable");
  assert.equal(createTranslator("fr")("no.such.key"),"Texte indisponible");
  assert.equal(createTranslator("en")("search.result.open"),"Open ");
  assert.deepEqual(missing.map(m=>m.key),["common.close","no.such.key"]);
  assert.equal(t.has("common.close"),true);assert.equal(t.has("no.such.key"),false);
  assert.throws(()=>formatMessage("{count, plural, one {x}}",{count:1}),/other branch/);
  assert.throws(()=>formatMessage("{a, select, x {y}}",{a:"x"}),/Unsupported/);
  assert.equal(formatMessage("<b>{name}</b>",{name:"<script>"}),"<b><script></b>","formatting is plain text; rendering escapes it");
});
