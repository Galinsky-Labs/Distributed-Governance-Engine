import test from 'node:test';
import assert from 'node:assert/strict';
import {legalPlainText,legalDocumentDigest,validateLegalDocument} from '../src/legal-schema.mjs';
import {parseTrueType} from '../src/export/truetype.mjs';
import {layoutDocument} from '../src/export/layout.mjs';
import {legalFixture,smallFixture,fonts,GENERATED_AT,OVERLONG} from './support/export-fixture.mjs';

const parsed=Object.fromEntries(Object.entries(fonts).map(([style,bytes])=>[style,parseTrueType(bytes)]));
const lay=(document,options={})=>layoutDocument({document,fonts:parsed,editionDigest:legalDocumentDigest(document),version:2,options:{generatedAt:GENERATED_AT,...options}});
const collapse=text=>text.replace(/\s+/g,' ').trim();
const fixture=legalFixture();
const layout=lay(fixture,{lineNumbers:'page'});
const {elements}=layout.structure;

const item=ref=>layout.pages[ref.page].items[ref.item];
function contents(id,out=[]) {for(const kid of elements[id].kids)kid.content?out.push(kid.content):contents(kid.element,out);return out;}
function find(id,predicate,out=[]) {if(predicate(elements[id]))out.push(elements[id]);for(const kid of elements[id].kids)if(kid.element!==undefined)find(kid.element,predicate,out);return out;}
function text(id,{skipLbl=false}={},lay=layout) {
 const els=lay.structure.elements;let out='';
 for(const kid of els[id].kids) {
  if(kid.content)out+=lay.pages[kid.content.page].items[kid.content.item].text;
  else{const child=els[kid.element];if(skipLbl&&child.type==='Lbl')continue;const inner=text(kid.element,{skipLbl},lay);out+=['Link','Span'].includes(child.type)?inner:' '+inner+' ';}
 }
 return out;
}
const body=elements.find(e=>e.type==='Part');

test('golden pagination of the multi-page legal fixture',()=>{
 assert.equal(layout.pageCount,8);
 assert.deepEqual(Object.fromEntries(layout.headingPages),{s1:3,s2:3,s2a:3,s2a1:3,s2a1A:3,s2b:3,s3:4,s4:6,'ex-a':8,'ex-s1':8});
 assert.deepEqual(layout.usedStyles,['regular','bold','italic']);
});

test('every source character appears exactly once, in reading order',()=>{
 assert.equal(collapse(text(body.id,{skipLbl:true})),collapse(legalPlainText(fixture)));
 // Presentation-only labels (list markers, footnote numbers) are tagged Lbl and are the only additions.
 const labels=find(body.id,e=>e.type==='Lbl').map(e=>collapse(text(e.id)));
 assert.deepEqual(labels,['a.','b.','c.','1','2']);
});

test('headings stay with the first lines of the following block',()=>{
 for(const heading of find(body.id,e=>/^H\d$/.test(e.type))) {
  const parent=elements[heading.parent];
  const siblings=parent.kids.map(k=>k.element);
  const next=siblings[siblings.indexOf(heading.id)+1];
  if(next===undefined)continue;
  const last=contents(heading.id).at(-1),first=contents(next)[0];
  assert.equal(first.page,last.page,'heading '+collapse(text(heading.id))+' is separated from its content');
 }
});

test('no widows or orphans: split paragraphs keep at least two lines per page',()=>{
 let splits=0;
 for(const p of find(body.id,e=>e.type==='P')) {
  const perPage=new Map();
  for(const ref of contents(p.id)){const baselines=perPage.get(ref.page)??new Set();baselines.add(Math.round(item(ref).y));perPage.set(ref.page,baselines);}
  if(perPage.size>1){splits++;for(const [page,lines] of perPage)assert(lines.size>=2,'paragraph has a single line on page '+(page+1));}
 }
 assert(splits>=1,'fixture exercises at least one paragraph split');
});

test('line numbers restart per page, or run continuously, and are absent by default',()=>{
 const numbers=l=>l.pages.map(p=>p.items.filter(i=>i.lineNumber).map(i=>i.lineNumber));
 for(const page of numbers(layout))page.forEach((n,i)=>assert.equal(n,i+1));
 const continuous=numbers(lay(fixture,{lineNumbers:'continuous'})).flat();
 continuous.forEach((n,i)=>assert.equal(n,i+1));
 assert.equal(continuous.length,numbers(layout).flat().length);
 assert(continuous.length>80);
 assert.equal(numbers(lay(fixture)).flat().length,0);
});

test('every page carries "Page N of M" and a running header',()=>{
 layout.pages.forEach((page,i)=>{
  const furniture=page.items.filter(x=>x.artifact==='Pagination').map(x=>x.text);
  assert.deepEqual(furniture,['Municipal Data Transparency Act','Page '+(i+1)+' of '+layout.pageCount]);
 });
});

test('table of contents page numbers equal the pages where headings are drawn',()=>{
 const entries=find(elements[0].id,e=>e.type==='TOCI');
 assert.equal(entries.length,9);
 for(const entry of entries) {
  const t=collapse(text(entry.id)),[,title,number]=/^(.*?)(\d+)$/.exec(t.replace(/\s+(\d+)$/,'$1'));
  const heading=find(body.id,e=>/^H\d$/.test(e.type)&&collapse(text(e.id))===title.trim())[0];
  assert(heading,title);
  assert.equal(Number(number),contents(heading.id)[0].page+1,title);
 }
});

test('tables split across pages, including rows taller than a page',()=>{
 const table=find(body.id,e=>e.type==='Table')[0];
 assert(new Set(contents(table.id).map(r=>r.page)).size>=2);
 const tall=validateLegalDocument({...structuredClone(smallFixture()),content:[{kind:'table',id:'t',children:[{kind:'table-row',id:'r',children:[{kind:'table-cell',id:'c1',children:[{kind:'paragraph',id:'p1',inlines:[{kind:'text',text:'Clause text that keeps going. '.repeat(400)}]}]},{kind:'table-cell',id:'c2',children:[{kind:'paragraph',id:'p2',inlines:[{kind:'text',text:'Short'}]}]}]}]}]});
 const l=lay(tall,{cover:false,toc:false});
 const td=l.structure.elements.find(e=>e.type==='TD');
 const refs=[];(function walk(id){for(const kid of l.structure.elements[id].kids)kid.content?refs.push(kid.content):walk(kid.element);})(td.id);
 assert(new Set(refs.map(r=>r.page)).size>=3,'a row taller than a page continues over several pages');
 assert.equal(collapse(refs.map(r=>l.pages[r.page].items[r.item].text).join('')),collapse(tall.content[0].children[0].children[0].children[0].inlines[0].text));
 for(const page of l.pages)for(const it of page.items)if(it.type==='text'&&!it.artifact)assert(it.y>=72-1&&it.y<=792-72,'text stays inside the margins');
});

test('footnotes print at the bottom of the referencing page and continue when they overflow',()=>{
 for(const note of find(body.id,e=>e.type==='Note')) {
  const id=note.id,first=contents(id)[0];
  const ordinal=collapse(text(find(id,e=>e.type==='Lbl')[0].id));
  const reference=find(body.id,e=>e.type==='Link').find(link=>contents(link.id).some(r=>item(r).text===ordinal&&item(r).size<parsed.regular.unitsPerEm));
  assert.equal(first.page,contents(reference.id)[0].page);
  const bodyLowest=Math.min(...layout.pages[first.page].items.filter(i=>i.type==='text'&&!i.artifact&&i.size>9).map(i=>i.y));
  assert(item(first).y<bodyLowest,'footnote sits below the body text');
 }
 const long=structuredClone(smallFixture());
 long.content[0].children.unshift({kind:'paragraph',id:'filler',inlines:[{kind:'text',text:'Filler sentence for the page. '.repeat(120)}]});
 long.content.at(-1).inlines[0].text='Long note. '.repeat(400);
 const l=lay(validateLegalDocument(long),{cover:false,toc:false});
 const note=l.structure.elements.find(e=>e.type==='Note');
 const refs=[];(function walk(id){for(const kid of l.structure.elements[id].kids)kid.content?refs.push(kid.content):walk(kid.element);})(note.id);
 assert(new Set(refs.map(r=>r.page)).size>=2,'overflowing footnote continues on the next page');
 assert.equal(collapse(refs.map(r=>l.pages[r.page].items[r.item].text).join('')),collapse('1 '+long.content.at(-1).inlines[0].text));
});

test('exhibits start on a new page and overlong tokens are force-broken within the margins',()=>{
 const exhibitPage=layout.headingPages.get('ex-a')-1;
 const firstText=layout.pages[exhibitPage].items.filter(i=>i.type==='text'&&!i.artifact).sort((a,b)=>b.y-a.y)[0];
 assert.equal(firstText.text,'EXHIBIT ');
 const right=612-72;
 for(const page of layout.pages)for(const it of page.items)
  if(it.type==='text'&&!it.artifact&&!it.lineNumber)assert(it.x+parsed[it.style].textWidth(it.text.trimEnd(),it.size)<=right+0.01,'text overflows the right margin: '+it.text.slice(0,40));
 const pieces=layout.pages.flatMap(p=>p.items).filter(i=>i.type==='text'&&/Pneumono|coniosis/.test(i.text));
 assert(pieces.length>=2);assert(collapse(pieces.map(i=>i.text).join('')).includes(OVERLONG));
});

test('missing glyphs are reported, never silently dropped',()=>{
 assert.deepEqual(layout.warnings,['Character U+4E2D is not in font Liberation Serif; rendered as .notdef']);
});

test('page sizes, cover metadata, watermark and signature appendix',()=>{
 const a4=lay(smallFixture(),{pageSize:'a4',watermark:'CONFIDENTIAL',signatures:[
  {name:'Ana Ruiz',signedAt:'2026-11-14T12:00:00Z',intent:'Approve',receiptDigest:'c'.repeat(64),mark:{kind:'drawn',width:10,height:4,strokes:[[{x:0,y:0},{x:10,y:4}]]}},
  {name:'Bo Li',capacity:'Clerk',signedAt:'2026-11-14T12:01:00Z',intent:'Attest',receiptDigest:'d'.repeat(64),mark:{kind:'typed',text:'Bo Li'}}]});
 assert.equal(a4.pages[0].width,595.28);assert.equal(lay(smallFixture(),{pageSize:'legal'}).pages[0].height,1008);
 const cover=a4.pages[0].items.filter(i=>i.type==='text').map(i=>i.text).join('');
 for(const value of ['Short memo','memo-1',legalDocumentDigest(smallFixture()),'collaboration','draft',GENERATED_AT])assert(cover.includes(value),value);
 for(const page of a4.pages){const mark=page.items.find(i=>i.artifact==='Watermark');assert.equal(mark.text,'CONFIDENTIAL');assert(mark.rotate>0.5&&mark.rotate<1.2);assert.deepEqual(mark.color,[0.85,0.85,0.85]);}
 const last=a4.pages.at(-1).items;
 const path=last.find(i=>i.type==='path');
 const xs=path.strokes.flat().map(p=>p[0]),ys=path.strokes.flat().map(p=>p[1]);
 assert(Math.max(...xs)-Math.min(...xs)>=100,'a tiny drawn mark is scaled up to a legible size');
 assert(Math.max(...ys)-Math.min(...ys)>=30);
 assert.equal(last.find(i=>i.text==='Bo Li'&&i.style==='italic')?.style,'italic');
 assert(last.some(i=>i.type==='text'&&i.text.startsWith('cccc')));
 const figure=a4.structure.elements.find(e=>e.type==='Figure');assert.equal(figure.alt,'Drawn signature mark of Ana Ruiz');
});

test('invalid options and signatures fail with stable codes',()=>{
 for(const [options,code] of [[{pageSize:'tabloid'},'INVALID_OPTIONS'],[{margins:{top:5}},'INVALID_OPTIONS'],[{lineNumbers:'yes'},'INVALID_OPTIONS'],[{watermark:''},'INVALID_OPTIONS'],
  [{signatures:[{name:'A',signedAt:'x',intent:'y',receiptDigest:'nope'}]},'INVALID_SIGNATURES'],[{signatures:[{name:'A',signedAt:'x',intent:'y',receiptDigest:'e'.repeat(64),mark:{kind:'drawn',width:0,height:1,strokes:[]}}]},'INVALID_SIGNATURES']])
  assert.throws(()=>lay(smallFixture(),options),{code});
 assert.throws(()=>layoutDocument({document:smallFixture(),fonts:{regular:parsed.regular},editionDigest:'0'.repeat(64),version:1,options:{}}),{code:'FONT_MISSING'});
});
