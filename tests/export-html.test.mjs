import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {legalPlainText,legalDocumentDigest,validateLegalDocument} from '../src/legal-schema.mjs';
import {exportDocument,ExportError} from '../src/export/index.mjs';
import {legalFixture,smallFixture,fonts,GENERATED_AT} from './support/export-fixture.mjs';

const collapse=text=>text.replace(/\s+/g,' ').trim();
const run=(document,format,options={})=>exportDocument({document,format,editionDigest:legalDocumentDigest(document),version:2,fonts,options:{generatedAt:GENERATED_AT,...options}});
const decode=bytes=>new TextDecoder().decode(bytes);
const BLOCK=new Set(['P','H1','H2','H3','H4','H5','H6','LI','TD','TH','TR','SECTION','ASIDE','MAIN','TABLE','OL','UL']);
function readable(node) {
 let out='';
 for(const child of node.childNodes) {
  if(child.nodeType===3)out+=child.data;
  else if(child.nodeType===1&&!child.classList.contains('note-label'))out+=BLOCK.has(child.tagName)?' '+readable(child)+' ':readable(child);
 }
 return out;
}

const hostile=()=>{
 const doc=structuredClone(smallFixture());
 doc.metadata.title='Memo <script>alert(1)</script>';
 doc.content[0].title='" onmouseover="alert(1)';
 doc.content[0].children[0].inlines=[{kind:'text',text:'<script>alert(1)</script> & <img src=x onerror=alert(1)>'},{kind:'link',targetUrl:'https://example.org/a?b=1&c=%22x%22',label:'" onclick="steal()'}];
 return validateLegalDocument(doc);
};

test('HTML is static, self-contained and semantic, with labels as text',async()=>{
 const fixture=legalFixture();
 const out=await run(fixture,'html',{watermark:'DRAFT'});
 const html=decode(out.bytes);
 assert.equal(out.mediaType,'text/html; charset=utf-8');
 assert(!/<script/i.test(html));assert(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(html));
 assert(!/\s(src|srcset|action|formaction)\s*=/i.test(html)&&!/url\(/i.test(html)&&!/<link\b/i.test(html)&&!/<iframe|<object|<embed|<form/i.test(html));
 const {window}=new JSDOM(html);const d=window.document;
 assert.equal(d.documentElement.lang,'en-US');assert.equal(d.documentElement.dir,'ltr');
 assert.equal(collapse(readable(d.querySelector('main'))),collapse(legalPlainText(fixture)));
 for(const a of d.querySelectorAll('a[href]')) {
  const href=a.getAttribute('href');
  if(href.startsWith('#'))assert(d.getElementById(href.slice(1)),'dangling anchor '+href);
  else{assert.match(href,/^https:\/\//);assert.equal(a.getAttribute('rel'),'noopener noreferrer');}
 }
 assert.equal(d.querySelector('#n-s2a1A h4').textContent,'(A) Exceptions');
 assert(d.querySelector('ol[type="a"] > li'));assert(d.querySelector('table td'));assert(d.querySelector('aside[role="note"]'));
 assert(d.querySelector('section.exhibit'));assert(d.querySelector('cite'));
 assert.match(html,/@page\{size:letter;margin:72pt 72pt 72pt 72pt\}/);assert.match(html,/break-before:page/);
 assert.equal(d.querySelector('meta[name="quill-edition-digest"]').content,legalDocumentDigest(fixture));
 assert.equal(d.querySelector('.watermark').getAttribute('aria-hidden'),'true');
});

test('hostile strings are escaped in text, attributes and the title',async()=>{
 const html=decode((await run(hostile(),'html')).bytes);
 assert(!/<script/i.test(html));assert(!/<img/i.test(html));assert(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(html),'no event handler attribute in any tag');
 assert(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
 assert(html.includes('&quot; onmouseover=&quot;alert(1)'));
 assert(html.includes('href="https://example.org/a?b=1&amp;c=%22x%22"'));
 const {window}=new JSDOM(html);
 assert.equal(window.document.querySelectorAll('[onmouseover],[onclick],[onerror]').length,0);
 assert.equal(window.document.title,'Memo <script>alert(1)</script>');
});

test('right-to-left locales set dir="rtl"',async()=>{
 for(const locale of ['he-IL','ar']) {
  const doc=structuredClone(smallFixture());doc.metadata.locale=locale;doc.content[0].children[0].inlines=[{kind:'text',text:'שלום עולם'}];
  const html=decode((await run(validateLegalDocument(doc),'html')).bytes);
  assert.match(html,new RegExp('<html lang="'+locale+'" dir="rtl">'));
 }
});

test('text export equals legalPlainText; JSON export carries the validated document and binding',async()=>{
 const doc=smallFixture();
 const text=await run(doc,'text');
 assert.equal(decode(text.bytes),legalPlainText(doc));assert.equal(text.mediaType,'text/plain; charset=utf-8');
 assert.equal(text.fileName,'short-memo-r1-v2.txt');
 const json=await run(doc,'json');
 const parsed=JSON.parse(decode(json.bytes));
 assert.deepEqual(parsed.document,JSON.parse(JSON.stringify(doc)));
 assert.equal(parsed.manifest.editionDigest,legalDocumentDigest(doc));assert.equal(parsed.manifest.artifactSha256,undefined);
 assert.equal(json.manifest.artifactSha256.length,64);
 const {artifactSha256,...rest}=json.manifest;assert.deepEqual(parsed.manifest,rest);
});

test('exports refuse unbound or invalid requests with stable error codes',async()=>{
 const doc=smallFixture();
 const call=extra=>exportDocument({document:doc,format:'html',editionDigest:legalDocumentDigest(doc),version:1,fonts,options:{generatedAt:GENERATED_AT},...extra});
 for(const [extra,code] of [[{format:'rtf'},'UNSUPPORTED_FORMAT'],[{editionDigest:'f'.repeat(64)},'EDITION_DIGEST_MISMATCH'],[{editionDigest:'nope'},'INVALID_EDITION_DIGEST'],[{version:0},'INVALID_VERSION'],[{options:{}},'INVALID_GENERATED_AT'],[{document:{...doc,extra:1}},'INVALID_DOCUMENT'],[{format:'text',compareTo:doc},'UNSUPPORTED_FORMAT']])
  await assert.rejects(call(extra),error=>error instanceof ExportError&&error.code===code,code);
});
