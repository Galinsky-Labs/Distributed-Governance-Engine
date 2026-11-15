import test from 'node:test';
import assert from 'node:assert/strict';
import {importHtml,decodeHtmlReferences} from '../src/import/html.mjs';
import {ImportError} from '../src/import/errors.mjs';
import {validateLegalDocument} from '../src/legal-structure.mjs';
import {prng,mutateText,outline} from './support/import-fixtures.mjs';

const options=()=>{let n=0;return {tenantId:'org',documentId:'doc',idFactory:()=>'n'+(++n)};};

test('headings, paragraphs, marks, lists, tables and HTTPS links map to the legal tree',()=>{
 const html=`<!DOCTYPE html><html><head><title>Ignored title</title><meta charset="utf-8"></head><body>
  <h1>Section 1. Purpose</h1><p>The <b>Board</b> shall <i>act</i> <u>now</u> <s>never</s>.<br>Next line</p>
  <h2>(a) Scope</h2><div>See <a href="https://example.gov/act?x=1&amp;y=2">the <em>Act</em></a> and <a href="http://insecure.example">this</a>.</div>
  <ol type="a"><li>first<ol><li>nested</li></ol></li><li>second</ol>
  <ul><li>bullet</ul>
  <table><caption>Fees</caption><thead><tr><th>Item<th>Fee</tr></thead><tbody><tr><td colspan="2">Waived</td></tr></tbody></table>
  <blockquote>Quoted &sect; 2 &mdash; text&nbsp;&hellip;</blockquote><pre>  keep   spacing
 here</pre><h1>Effective date</h1><p>Today.</p></body></html>`;
 const {document,report}=importHtml(html,options());
 validateLegalDocument(document);
 assert.deepEqual(outline(document.content),[
  ['section','Purpose','The Board shall act now never.\nNext line',
   ['section','Scope','See [the Act](https://example.gov/act?x=1&y=2) and this.',
    ['list','lower-alpha',['list-item','first',['list','decimal',['list-item','nested']]],['list-item','second']],
    ['list','bullet',['list-item','bullet']],
    'Fees',
    ['table',['table-row',['table-cell','Item'],['table-cell','Fee']],['table-row',['table-cell','Waived'],['table-cell','']]],
    'Quoted \u00A7 2 \u2014 text\u00A0\u2026','  keep   spacing\n here']],
  ['section','Effective date','Today.']
 ]);
 const marks=document.content[0].children[0].inlines.map(run=>[run.text,run.marks??[]]);
 assert.deepEqual(marks.filter(([,m])=>m.length),[['Board',['bold']],['act',['italic']],['now',['underline']],['never',['strike']]]);
 assert.deepEqual(report.numbering.sourceLabels,['Section 1.','(a)']);
 assert.equal(report.structure.links,1);
 assert(report.warnings.some(w=>w.code==='LINK_NOT_HTTPS'));
 assert.equal(report.discarded.unsupportedElements,1);
});

const PAYLOADS=[
 '<script>alert("pwned")</script>',
 '<SCRIPT type="module">alert(1)</SCRIPT >',
 '<script>document.write("</scr"+"ipt>alert(2)")</script>',
 '<<script>alert(3)//<</script>',
 '<style>body{background:url(javascript:alert(4))}</style>',
 '<img src=x onerror=alert(5)>',
 '<img src="x" onerror="alert(6)"/>',
 '<svg onload=alert(7)><script>alert(8)</script><text>svgtext</text></svg>',
 '<svg><a xlink:href="javascript:alert(9)"><text>x</text></a></svg>',
 '<math><mtext><script>alert(10)</script></mtext></math>',
 '<iframe src="javascript:alert(11)">alert(12)</iframe>',
 '<iframe srcdoc="<script>alert(13)</script>"></iframe>',
 '<object data="data:text/html,<script>alert(14)</script>">alert(15)</object>',
 '<embed src="javascript:alert(16)">',
 '<a href="javascript:alert(17)">click</a>',
 '<a href=" JaVaScRiPt:alert(18)">click</a>',
 '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxOSk8L3NjcmlwdD4=">data</a>',
 '<a href="vbscript:msgbox(20)">vb</a>',
 '<a href="/relative">rel</a>',
 '<div onclick="alert(21)" style="behavior:url(alert22.htc)">handler</div>',
 '<body onload=alert(23)>',
 '<p onmouseover=\'alert(24)\'>hover</p>',
 '<template><script>alert(25)</script>tpl</template>',
 '<noscript><img src=x onerror=alert(26)></noscript>',
 '<textarea><script>alert(27)</script></textarea>',
 '<title><script>alert(28)</script></title>',
 '<form action="https://evil.example"><input name=x value="alert(29)"><button onclick=alert(30)>b</button>label</form>',
 '<select><option>alert(31)</option></select>',
 '<!--<script>alert(32)</script>-->',
 '<!--><script>alert(33)</script>',
 '<![CDATA[x]]><script>alert(34)</script>',
 '<link rel=stylesheet href="https://evil.example/x.css"><meta http-equiv="refresh" content="0;url=javascript:alert(35)">',
 '<base href="javascript:alert(36)//">',
 '<a href="https://ok.example/" onclick="alert(37)">safe link</a>',
 '<div style="width: expression(alert(38))">css</div>',
 '<xmp><script>alert(39)</script></xmp>',
 '<plaintext><script>alert(40)</script>',
 '<video><source onerror="alert(41)"></video><audio src=x onerror=alert(42)>',
 '<script',
 '<script>alert(43)',
 '<img src="x" onerror="alert(44)"',
 '<details open ontoggle=alert(46)>toggle</details>',
 '<isindex action=javascript:alert(47) type=image>',
 '<frameset onload=alert(48)>'
];

test('malicious HTML corpus: no script text, handler or active URL survives anywhere',()=>{
 for(const payload of PAYLOADS) {
  const html=`<p>before</p>${payload}<p>after</p>`;
  const {document,report}=importHtml(html,options());
  validateLegalDocument(document);
  const json=JSON.stringify(document);
  assert.doesNotMatch(json,/alert|msgbox|javascript:|vbscript:|data:|onerror|onload|onclick|expression|<script|behavior/i,payload);
  assert.match(json,/before/,payload);
  for(const run of JSON.stringify(report).match(/https?:[^"]*/g)??[])assert.fail('report leaks a URL: '+run);
 }
 // Attribute-breaking quotes inside an HTTPS URL stay percent-encoded data in the canonical target.
 const quoted=importHtml('<a href="https://x.example/&quot;onmouseover=&quot;x">q</a>',options()).document;
 assert.equal(quoted.content[0].inlines[0].targetUrl,'https://x.example/%22onmouseover=%22x');
 const counts=importHtml(PAYLOADS.join(''),options()).report.discarded;
 assert(counts.scripts>=15);assert(counts.embeddedObjects>=4);assert(counts.images>=3);assert(counts.externalReferences>=3);
});

test('malformed tags and entity edge cases are tolerated without leaking markup semantics',()=>{
 assert.equal(decodeHtmlReferences('&amp;&lt;&gt;&quot;&apos;&copy;&reg;&para;&lsquo;x&rsquo;&ldquo;y&rdquo;&ndash;'),'&<>"\'\u00A9\u00AE\u00B6\u2018x\u2019\u201Cy\u201D\u2013');
 assert.equal(decodeHtmlReferences('&#0;&#xD800;&#x110000;&#65;&#x42;&#128;&#x2603;&ampx &amp &unknown; &hellip &#99999999999;'),'\uFFFD\uFFFD\uFFFDAB\u20AC\u2603&x & &unknown; &hellip \uFFFD');
 assert.equal(decodeHtmlReferences('?a=1&copy=2&amp;b',{attribute:true}),'?a=1&copy=2&b');
 const {document}=importHtml('<p>a < b && c > d<p>unclosed <b>bold<p>next</b> tail</i></div><h3>head <span>x</h3><li>stray</li><td>cell</td> 5 &lt;script&gt;',options());
 validateLegalDocument(document);
 assert.deepEqual(outline(document.content),[
  'a < b && c > d','unclosed bold','next tail',
  ['section','head x','stray','cell','5 <script>']
 ]);
 const empty=importHtml('<script>only</script>',options());
 assert.equal(empty.report.warnings.at(-1).code,'EMPTY_DOCUMENT');
});

test('deep nesting, oversize input and unpaired surrogates are bounded',()=>{
 const deep=importHtml('<div>'.repeat(5000)+'deep'+'</div>'.repeat(5000),options());
 assert.deepEqual(outline(deep.document.content),['deep']);
 assert(deep.report.warnings.some(w=>w.code==='HTML_NESTING_FLATTENED'));
 const lists=importHtml('<ul><li>'.repeat(40)+'x',options());
 validateLegalDocument(lists.document);
 assert(lists.report.warnings.some(w=>w.code==='LIST_NESTING_FLATTENED'));
 assert.throws(()=>importHtml('x'.repeat(100),{...options(),limits:{maxInputLength:10}}),error=>error instanceof ImportError&&error.code==='DOCUMENT_TOO_LARGE');
 assert.throws(()=>importHtml('<p>x</p>'.repeat(10001),options()),error=>error instanceof ImportError&&error.code==='DOCUMENT_TOO_LARGE');
 const surrogate=importHtml('<p>a'+String.fromCharCode(0xdc00)+'\0b</p>',options());
 assert.equal(surrogate.document.content[0].inlines[0].text,'a\uFFFD\uFFFDb');
});

test('mutation fuzzing yields a valid document or ImportError only',()=>{
 const seed='<h1>Title</h1><p>Text <b>bold <i>both</i></b> <a href="https://e.example/">link</a></p><ul><li>a<ol><li>b</li></ol></li></ul><table><tr><td>1</td><td>2</td></tr></table><script>alert(1)</script><svg><text>x</text></svg>';
 const random=prng(99);
 for(let i=0;i<500;i++) {
  const input=mutateText(seed,random);
  try {
   const {document}=importHtml(input,options());
   validateLegalDocument(document);
  } catch(error){assert(error instanceof ImportError,`case ${i}: ${error?.stack}`);}
 }
});
