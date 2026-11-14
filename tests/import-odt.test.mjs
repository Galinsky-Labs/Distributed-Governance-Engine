import test from 'node:test';
import assert from 'node:assert/strict';
import {importOdt} from '../src/import/odt.mjs';
import {ImportError} from '../src/import/errors.mjs';
import {validateLegalDocument} from '../src/legal-structure.mjs';
import {odt,zip,prng,mutateText,mutateBytes,outline} from './support/import-fixtures.mjs';

const options=()=>{let n=0;return {tenantId:'org',documentId:'doc',idFactory:()=>'n'+(++n)};};
const rejects=(promise,code)=>assert.rejects(promise,error=>error instanceof ImportError&&error.code===code);

const AUTOMATIC_STYLES='<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>'
 +'<style:style style:name="T2" style:family="text" style:parent-style-name="Emphasis"><style:text-properties style:text-underline-style="solid"/></style:style>'
 +'<style:style style:name="T3" style:family="text"><style:text-properties style:text-line-through-style="solid" fo:font-weight="normal"/></style:style>'
 +'<text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-format="a"/><text:list-level-style-number text:level="2" style:num-format="1"/><text:list-level-style-number text:level="3" style:num-format="i"/></text:list-style>'
 +'<text:list-style style:name="L2"><text:list-level-style-bullet text:level="1"/></text:list-style>';
const COMMON_STYLES='<style:style style:name="Emphasis" style:family="text"><style:text-properties fo:font-style="italic"/></style:style>';

function hostileOdt() {
 const body=[
  '<text:sequence-decls/><text:tracked-changes><text:changed-region text:id="c1"><text:deletion><office:change-info/><text:p>deleted secret</text:p></text:deletion></text:changed-region><text:changed-region text:id="c2"><text:insertion><office:change-info/></text:insertion></text:changed-region></text:tracked-changes>',
  '<text:h text:outline-level="1">Article I Definitions</text:h>',
  '<text:p>The <text:span text:style-name="T1">Board</text:span> means <text:span text:style-name="T2">the board</text:span><text:s text:c="2"/>as <text:span text:style-name="T3">struck</text:span>.<text:note text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p>See the charter.</text:p></text:note-body></text:note></text:p>',
  '<text:list text:style-name="L1"><text:list-item><text:p>first</text:p><text:list><text:list-item><text:p>second</text:p><text:list><text:list-item><text:p>third</text:p></text:list-item></text:list></text:list-item></text:list></text:list-item><text:list-item><text:p>back</text:p></text:list-item></text:list>',
  '<text:list text:style-name="L2"><text:list-item><text:p>bullet</text:p></text:list-item></text:list>',
  '<text:h text:outline-level="2">(a) Links</text:h>',
  '<text:p>See <text:a xlink:type="simple" xlink:href="https://law.example.gov/code">the code</text:a>, <text:a xlink:href="javascript:alert(1)">bad</text:a> and <text:a xlink:href="../relative.odt">relative</text:a>.<text:change-start text:change-id="c2"/>Inserted.<text:change-end text:change-id="c2"/><text:change text:change-id="c1"/></text:p>',
  '<text:p>Media<draw:frame><draw:image xlink:href="Pictures/a.png"/></draw:frame><draw:frame><draw:object xlink:href="./Object 1"/></draw:frame><draw:frame><draw:text-box><text:p>boxed</text:p></draw:text-box></draw:frame><office:annotation><text:p>comment text</text:p></office:annotation> and a <text:date>2026-01-01</text:date> field<text:line-break/>next<text:tab/>tab</text:p>',
  '<text:section text:name="S"><text:p>In section</text:p></text:section>',
  '<table:table table:name="T"><table:table-column table:number-columns-repeated="2"/><table:table-header-rows><table:table-row><table:table-cell><text:p>Term</text:p></table:table-cell><table:table-cell><text:p>Meaning</text:p></table:table-cell></table:table-row></table:table-header-rows><table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>spanned</text:p></table:table-cell><table:covered-table-cell/></table:table-row><table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="2"><text:p>r</text:p></table:table-cell></table:table-row></table:table>'
 ].join('');
 return odt({body,automaticStyles:AUTOMATIC_STYLES,styles:COMMON_STYLES,parts:{
  'Basic/Standard/Module1.xml':'<script>Shell("calc")</script>','Basic/script-lc.xml':'<x/>','Scripts/python/evil.py':'import os','Pictures/a.png':'PNG','Object 1/content.xml':'<x/>'
 }});
}

test('ODT with macros, tracked changes, styles, lists, notes, links and tables maps to the semantic tree',async()=>{
 const {document,report}=await importOdt(hostileOdt(),options());
 validateLegalDocument(document);
 assert.deepEqual(outline(document.content),[
  ['section','Definitions',
   'The Board means the board  as struck.^footnote-reference',
   ['list','lower-alpha',['list-item','first',['list','decimal',['list-item','second',['list','lower-roman',['list-item','third']]]]],['list-item','back']],
   ['list','bullet',['list-item','bullet']],
   ['section','Links',
    'See [the code](https://law.example.gov/code), bad and relative.Inserted.',
    'Media and a 2026-01-01 field\nnext\ttab',
    'In section',
    ['table',['table-row',['table-cell','Term'],['table-cell','Meaning']],['table-row',['table-cell','spanned'],['table-cell','']],['table-row',['table-cell','r'],['table-cell','r']],['table-row',['table-cell','r'],['table-cell','r']]]]],
  ['footnote','See the charter.']
 ]);
 const marks=document.content[0].children[0].inlines.filter(run=>run.marks).map(run=>[run.text,run.marks]);
 assert.deepEqual(marks,[['Board',['bold']],['the board',['italic','underline']],['struck',['strike']]]);
 assert.deepEqual(report.discarded,{macros:1,scripts:1,images:1,embeddedObjects:1,externalReferences:0,comments:1,trackedDeletions:1,unsupportedElements:2});
 const codes=report.warnings.map(w=>w.code);
 for(const code of ['MACROS_DISCARDED','TRACKED_DELETIONS_DROPPED','TRACKED_INSERTIONS_ACCEPTED','LINK_NOT_HTTPS','TEXT_BOXES_DISCARDED','FIELDS_FLATTENED'])assert(codes.includes(code),code);
 assert.deepEqual(report.numbering.sourceLabels,['Article I','(a)']);
 const json=JSON.stringify(document);
 for(const forbidden of ['deleted secret','alert','javascript','Shell','boxed','comment text','Pictures'])assert(!json.includes(forbidden),forbidden);
});

test('mimetype, structure and XML safety are enforced',async()=>{
 await rejects(importOdt(odt({body:'<text:p>x</text:p>',mimetype:'application/vnd.oasis.opendocument.spreadsheet'}),options()),'UNSUPPORTED_FORMAT');
 await rejects(importOdt(odt({body:'<text:p>x</text:p>',mimetype:null}),options()),'UNSUPPORTED_FORMAT');
 await rejects(importOdt(odt({body:'',parts:{'content.xml':null}}),options()),'UNSUPPORTED_FORMAT');
 await rejects(importOdt(odt({body:'',parts:{'content.xml':'<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>'}}),options()),'XML_DOCTYPE_FORBIDDEN');
 await rejects(importOdt(odt({body:'<text:p>'}),options()),'XML_INVALID');
 await rejects(importOdt(zip([{name:'mimetype',data:'application/vnd.oasis.opendocument.text',method:0},{name:'content.xml',data:'<a/>',crc:1}]),options()),'ARCHIVE_INVALID');
 await rejects(importOdt(odt({body:'<table:table><table:table-row table:number-rows-repeated="5000"><table:table-cell/></table:table-row></table:table>'}),options()),'DOCUMENT_TOO_LARGE');
 const empty=await importOdt(odt({body:''}),options());
 assert.equal(empty.report.warnings[0].code,'EMPTY_DOCUMENT');
});

test('mutation fuzzing of content XML and package bytes yields a document or ImportError only',async()=>{
 const random=prng(1234);
 const body='<text:h text:outline-level="1">Title</text:h><text:p>A <text:span text:style-name="T1">b</text:span><text:note><text:note-body><text:p>n</text:p></text:note-body></text:note></text:p><text:list text:style-name="L1"><text:list-item><text:p>i</text:p></text:list-item></text:list><table:table><table:table-row><table:table-cell><text:p>c</text:p></table:table-cell></table:table-row></table:table><text:p><text:a xlink:href="https://e.example/">l</text:a></text:p>';
 const check=async(bytes,label)=>{
  try{validateLegalDocument((await importOdt(bytes,options())).document);}
  catch(error){assert(error instanceof ImportError,`${label}: ${error?.stack}`);}
 };
 for(let i=0;i<200;i++)await check(odt({body:mutateText(body,random),automaticStyles:AUTOMATIC_STYLES}),`xml case ${i}`);
 const seed=odt({body,automaticStyles:AUTOMATIC_STYLES});
 for(let i=0;i<150;i++)await check(mutateBytes(seed,random),`byte case ${i}`);
});
