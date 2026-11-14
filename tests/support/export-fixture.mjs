import {readFileSync} from 'node:fs';
import {validateLegalDocument,legalDocumentDigest} from '../../src/legal-schema.mjs';

const fontDir=new URL('../../assets/fonts/liberation/',import.meta.url);
const read=name=>new Uint8Array(readFileSync(new URL(name,fontDir)));
export const fonts=Object.freeze({
 regular:read('LiberationSerif-Regular.ttf'),bold:read('LiberationSerif-Bold.ttf'),
 italic:read('LiberationSerif-Italic.ttf'),boldItalic:read('LiberationSerif-BoldItalic.ttf')
});
export const GENERATED_AT='2026-11-14T12:00:00Z';

const sentences=[
 'The municipal records officer shall publish each dataset within thirty days after its approval.',
 'Nothing in this section authorizes the disclosure of personal information protected by law.',
 'Each agency shall maintain an inventory of the datasets it collects, stores or distributes.',
 'The council may, by resolution, extend any deadline under this Act for good cause shown.',
 'Data published under this section shall be machine-readable, non-proprietary and free of charge.'
];
const prose=(seed,count)=>Array.from({length:count},(_,i)=>sentences[(seed+i)%sentences.length]).join(' ');
const text=(value,marks)=>marks?{kind:'text',text:value,marks}:{kind:'text',text:value};
const para=(id,...inlines)=>({kind:'paragraph',id,inlines:inlines.map(x=>typeof x==='string'?text(x):x)});
const cell=(id,value)=>({kind:'table-cell',id,children:[para(id+'-p',value)]});

export const SECRET='Confidential informant Marisol Quintero-Vance';
export const MISSING_GLYPH='中';
export const OVERLONG='Pneumonoultramicroscopicsilicovolcanoconiosis'.repeat(3);

/** A multi-page legal document exercising every block kind the exporter supports. */
export function legalFixture() {
 const rows=[{kind:'table-row',id:'row-h',children:[cell('c-h1','Dataset'),cell('c-h2','Agency'),cell('c-h3','Publication schedule')]}];
 for(let i=1;i<=34;i++)rows.push({kind:'table-row',id:'row-'+i,children:[cell('c'+i+'a','Dataset '+i),cell('c'+i+'b','Department '+(i%5+1)),cell('c'+i+'c',i===20?prose(2,14):'Quarterly, within '+(10+i)+' days')]});
 return validateLegalDocument({
  schemaVersion:2,id:'act-2026-17',tenantId:'city-council',mode:'collaboration',lifecycle:'draft',revision:4,
  metadata:{title:'Municipal Data Transparency Act',locale:'en-US',numberingProfile:'us-federal-v1'},
  content:[
   {kind:'section',id:'s1',title:'Definitions',children:[
    {kind:'definition',id:'d-dataset',term:'Dataset',inlines:[text(' means a collection of related records held by an agency.')]},
    {kind:'definition',id:'d-agency',term:'Agency',inlines:[text(' means any department, board or office of the city.')]},
    para('p-intro','This Act applies to every ',text('agency',['italic']),' and is ',text('binding',['bold']),' on contractors.',{kind:'footnote-reference',targetId:'fn1'},' Greek ',text('Ελληνικά'),', Cyrillic Привет, Hebrew שלום, naïve café § 12 — and a missing glyph '+MISSING_GLYPH+'.')
   ]},
   {kind:'section',id:'s2',title:'Publication duties',children:[
    para('p2-0',prose(0,6)),
    {kind:'section',id:'s2a',title:'General rule',children:[
     para('p2a-0',prose(1,5),{kind:'footnote-reference',targetId:'fn2'}),
     {kind:'section',id:'s2a1',title:'Timing',children:[
      para('p2a1-0',prose(2,4)),
      {kind:'section',id:'s2a1A',title:'Exceptions',children:[para('p2a1A-0','An overlong token follows: '+OVERLONG+' and the clause continues after it.')]}
     ]}
    ]},
    {kind:'section',id:'s2b',title:'Formats',children:[
     para('p2b-0','Publish in open formats as described at ',{kind:'link',targetUrl:'https://data.example.gov/formats',label:'the open data portal'},' and consistent with ',{kind:'citation',targetUrl:'https://law.example.gov/code/12#s34',label:'12 Mun. Code 34',citationMetadata:{publisher:'City Clerk',pinpoint:'§ 34(a)'}},'. See ',{kind:'reference',targetId:'s2a1'},' for timing.'),
     {kind:'list',id:'list1',style:'lower-alpha',children:[
      {kind:'list-item',id:'li1',children:[para('li1-p','comma-separated values;')]},
      {kind:'list-item',id:'li2',children:[para('li2-p','JSON documents with a published schema; and')]},
      {kind:'list-item',id:'li3',children:[para('li3-p','any successor format approved by the council.')]}
     ]}
    ]}
   ]},
   {kind:'section',id:'s3',title:'Dataset schedule',children:[para('p3-0','The following schedule is adopted:'),{kind:'table',id:'schedule',children:rows}]},
   {kind:'section',id:'s4',title:'Effective date',children:[para('p4-0',prose(3,9)),para('p4-1',prose(4,40)),para('p4-2',prose(0,9))]},
   {kind:'exhibit',id:'ex-a',title:'Exhibit A — Model notice',children:[
    {kind:'section',id:'ex-s1',title:'Notice text',children:[para('ex-p1','Notice is hereby given that the dataset described below is available.')]}
   ]},
   {kind:'footnote',id:'fn1',inlines:[text('Contractors include subcontractors at every tier.')]},
   {kind:'footnote',id:'fn2',inlines:[text(prose(0,7))]}
  ]
 });
}

export const editionDigest=document=>legalDocumentDigest(document);

/** A small document for fast format tests. */
export function smallFixture(overrides={}) {
 return validateLegalDocument({
  schemaVersion:2,id:'memo-1',tenantId:'org-1',mode:'collaboration',lifecycle:'draft',revision:1,
  metadata:{title:'Short memo',locale:'en-US',numberingProfile:'us-federal-v1',...overrides.metadata},
  content:overrides.content??[
   {kind:'section',id:'m1',title:'Purpose',children:[para('mp1','The board ',text('shall',['bold']),' meet ',text('monthly',['italic']),'.',{kind:'footnote-reference',targetId:'mfn'}),para('mp2','See ',{kind:'reference',targetId:'m2'},' and ',{kind:'link',targetUrl:'https://example.org/minutes',label:'minutes'},'.')]},
   {kind:'section',id:'m2',title:'Quorum',children:[para('mp3','A majority constitutes a quorum.'),{kind:'table',id:'mt',children:[{kind:'table-row',id:'mr1',children:[cell('mc1','Seats'),cell('mc2','Quorum')]},{kind:'table-row',id:'mr2',children:[cell('mc3','7'),cell('mc4','4')]}]}]},
   {kind:'footnote',id:'mfn',inlines:[text('Meetings may be held remotely.')]}
  ]
 });
}
