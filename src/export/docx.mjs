/**
 * WordprocessingML (DOCX) export: headings, literal legal labels, marks,
 * Word-numbered lists, tables, https-only hyperlinks, internal bookmarks,
 * footnotes, page setup, header/footer with PAGE fields. No macros, no
 * external content except https hyperlink targets. Platform-neutral.
 */
import {validateLegalDocument,legalOutline,legalReferenceLabels,legalReferenceText} from '../legal-structure.mjs';
import {normalizeLayoutOptions} from './layout.mjs';
import {writeZip} from './zip-writer.mjs';
import {PRODUCER,RENDER_PROFILE_ID,xmlEscape,externalInlineText,safeHttpsUrl,prepareExport,exportManifest,requireTimestamp} from './common.mjs';

const W='xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XML='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const twips=points=>Math.round(points*20);
const LIST_FORMATS={decimal:['decimal','%L.'],'lower-alpha':['lowerLetter','%L.'],'upper-alpha':['upperLetter','%L.'],'lower-roman':['lowerRoman','%L.'],'upper-roman':['upperRoman','%L.'],bullet:['bullet','•']};
export const DOCX_MEDIA_TYPE='application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Collects relationships, bookmarks, footnotes, list instances and warnings while building document.xml. */
export class DocxContext {
 constructor() {this.warnings=new Set();this.links=new Map();this.bookmarks=new Map();this.footnotes=[];this.lists=[];this.bookmarkId=0;}
 esc(text){return xmlEscape(text,this.warnings);}
 hyperlink(url) {
  if(!safeHttpsUrl(url))return null;
  if(!this.links.has(url))this.links.set(url,'rIdLink'+(this.links.size+1));
  return this.links.get(url);
 }
 bookmark(nodeId){if(!this.bookmarks.has(nodeId))this.bookmarks.set(nodeId,'_Quill'+(this.bookmarks.size+1));return this.bookmarks.get(nodeId);}
 /** Run XML; tabs and line breaks become Word elements. */
 run(text,{bold,italic,underline,strike,style,color,ins,del}={}) {
  if(text==='')return '';
  const props=(style?'<w:rStyle w:val="'+style+'"/>':'')+(bold?'<w:b/>':'')+(italic?'<w:i/>':'')+(strike?'<w:strike/>':'')+(color?'<w:color w:val="'+color+'"/>':'')+(underline?'<w:u w:val="single"/>':'');
  const textTag=del?'w:delText':'w:t';
  const body=text.split(/(\t|\r\n|\n|\r)/).map(part=>part==='\t'?'<w:tab/>':/^(\r\n|\n|\r)$/.test(part)?'<w:br/>':part?'<'+textTag+' xml:space="preserve">'+this.esc(part)+'</'+textTag+'>':'').join('');
  return '<w:r>'+(props?'<w:rPr>'+props+'</w:rPr>':'')+body+'</w:r>';
 }
 paragraph(content,{style,indent=0,hanging=0,pageBreakBefore=false,keepNext=false,numId=null,level=0,bookmarks=[]}={}) {
  const pPr=(style?'<w:pStyle w:val="'+style+'"/>':'')+(keepNext?'<w:keepNext/>':'')+(pageBreakBefore?'<w:pageBreakBefore/>':'')+(numId!==null?'<w:numPr><w:ilvl w:val="'+level+'"/><w:numId w:val="'+numId+'"/></w:numPr>':'')+(indent||hanging?'<w:ind w:left="'+twips(indent)+'"'+(hanging?' w:hanging="'+twips(hanging)+'"':'')+'/>':'');
  const marks=bookmarks.map(id=>{const n=this.bookmarkId++;return ['<w:bookmarkStart w:id="'+n+'" w:name="'+this.bookmark(id)+'"/>','<w:bookmarkEnd w:id="'+n+'"/>'];});
  return '<w:p>'+(pPr?'<w:pPr>'+pPr+'</w:pPr>':'')+marks.map(m=>m[0]).join('')+content+marks.map(m=>m[1]).join('')+'</w:p>';
 }
 newList(style){this.lists.push(style);return this.lists.length;}
}

/** Builds the WordprocessingML body (and footnotes) for a validated legal document. */
function documentBody(doc,ctx,profile) {
 const outline=new Map(legalOutline(doc).map(row=>[row.id,row]));
 const labels=legalReferenceLabels(doc);
 const targets=new Set(),referenced=new Set(),ids=new Set([doc.id]);
 (function scan(nodes){for(const node of nodes){ids.add(node.id);for(const run of node.inlines??[]){if(run.kind==='reference')targets.add(run.targetId);if(run.kind==='footnote-reference')referenced.add(run.targetId);}if(node.children)scan(node.children);}})(doc.content);
 const footnoteIds=new Map();
 const inlineXml=inlines=>inlines.map(run=>{
  if(run.kind==='text'){const marks=new Set(run.marks??[]);return ctx.run(run.text,{bold:marks.has('bold'),italic:marks.has('italic'),underline:marks.has('underline'),strike:marks.has('strike')});}
  const text=run.kind==='reference'||run.kind==='footnote-reference'?legalReferenceText(run,labels):null;
  if(run.kind==='footnote-reference') {
   if(!referenced.has(run.targetId)||labels.get(run.targetId)?.kind!=='footnote')return ctx.run(text,{style:'FootnoteReference'});
   if(!footnoteIds.has(run.targetId))footnoteIds.set(run.targetId,footnoteIds.size+1);
   // A custom mark keeps the visible footnote number identical to the canonical ordinal.
   return '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:customMarkFollows="1" w:id="'+footnoteIds.get(run.targetId)+'"/><w:t>'+ctx.esc(text)+'</w:t></w:r>';
  }
  if(run.kind==='reference')return ids.has(run.targetId)&&run.targetId!==doc.id?'<w:hyperlink w:anchor="'+ctx.bookmark(run.targetId)+'">'+ctx.run(text,{style:'Hyperlink'})+'</w:hyperlink>':ctx.run(text);
  const {label,suffix}=externalInlineText(run),rid=ctx.hyperlink(run.targetUrl);
  const inner=ctx.run(label,{style:'Hyperlink'})+ctx.run(suffix);
  return rid?'<w:hyperlink r:id="'+rid+'">'+inner+'</w:hyperlink>':inner;
 }).join('');
 const marksFor=id=>targets.has(id)?[id]:[];

 function blocks(nodes,ctxState) {
  let out='';
  for(const node of nodes) {
   if(node.kind==='section'||node.kind==='exhibit') {
    const depth=node.kind==='section'?outline.get(node.id).depth:0;
    const label=node.kind==='section'?outline.get(node.id).label:'EXHIBIT';
    out+=ctx.paragraph(ctx.run(label+' '+node.title),{style:'Heading'+Math.min(depth+1,6),indent:node.kind==='section'?depth*18:0,keepNext:true,pageBreakBefore:node.kind==='exhibit',bookmarks:marksFor(node.id)});
    out+=blocks(node.children,{...ctxState,indent:node.kind==='section'?(depth+1)*18:0});
   } else if(node.kind==='paragraph'||node.kind==='definition') {
    const content=(node.kind==='definition'?ctx.run(node.term,{bold:true})+ctx.run('—'):'')+inlineXml(node.inlines);
    const list=ctxState.list,numbered=Boolean(list?.first);
    // The first paragraph of a list item carries the Word list marker; later ones align with its text.
    out+=ctx.paragraph(content,{indent:list?(numbered?0:18*(list.level+2)):ctxState.indent,numId:numbered?list.numId:null,level:list?.level??0,style:list?'ListParagraph':undefined,bookmarks:marksFor(node.id)});
    if(numbered)list.first=false;
   } else if(node.kind==='list') {
    const numId=ctx.newList(node.style),level=ctxState.list?Math.min(ctxState.list.level+1,8):0;
    for(const item of node.children) {
     const state={...ctxState,list:{numId,level,first:true}};
     // An item that opens with a table or nested list shows its marker on an empty paragraph first.
     if(!['paragraph','definition'].includes(item.children[0].kind)){out+=ctx.paragraph('',{numId,level,style:'ListParagraph'});state.list.first=false;}
     out+=blocks(item.children,state);
    }
   } else if(node.kind==='table') {
    const columns=node.children[0].children.length;
    const width=twips(profile.width-profile.margins.left-profile.margins.right-(ctxState.indent??0));
    const col=Math.floor(width/columns);
    out+='<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="'+col*columns+'" w:type="dxa"/>'+(ctxState.indent?'<w:tblInd w:w="'+twips(ctxState.indent)+'" w:type="dxa"/>':'')+'</w:tblPr><w:tblGrid>'+'<w:gridCol w:w="'+col+'"/>'.repeat(columns)+'</w:tblGrid>';
    node.children.forEach((row,index)=>{
     out+='<w:tr>'+(profile.tableHeaderRow&&index===0?'<w:trPr><w:tblHeader/></w:trPr>':'');
     for(const cell of row.children) {
      const inner=blocks(cell.children,{indent:0});
      out+='<w:tc><w:tcPr><w:tcW w:w="'+col+'" w:type="dxa"/></w:tcPr>'+(inner.endsWith('</w:p>')?inner:inner+'<w:p/>')+'</w:tc>';
     }
     out+='</w:tr>';
    });
    out+='</w:tbl>';
   } else if(node.kind==='footnote') {
    if(!referenced.has(node.id))out+=ctx.paragraph(ctx.run(labels.get(node.id).ordinal+' ',{style:'FootnoteReference'})+inlineXml(node.inlines),{style:'FootnoteText',bookmarks:marksFor(node.id)});
   }
  }
  return out;
 }
 const body=blocks(doc.content,{indent:0});
 const footnoteNodes=new Map(doc.content.filter(n=>n.kind==='footnote').map(n=>[n.id,n]));
 for(const [nodeId,id] of footnoteIds) {
  const node=footnoteNodes.get(nodeId);
  ctx.footnotes.push('<w:footnote w:id="'+id+'">'+ctx.paragraph(ctx.run(labels.get(nodeId).ordinal,{style:'FootnoteReference'})+ctx.run(' ')+inlineXml(node.inlines),{style:'FootnoteText',bookmarks:marksFor(nodeId)})+'</w:footnote>');
 }
 return body;
}

function coverXml(ctx,meta,profile) {
 const rows=[['Document ID',meta.documentId],['Version',String(meta.version)],['Revision',String(meta.revision)],['Edition digest (SHA-256)',meta.editionDigest],['Mode',meta.mode],['Lifecycle',meta.lifecycle],['Render profile',RENDER_PROFILE_ID],['Generated',profile.generatedAt]];
 return ctx.paragraph(ctx.run(meta.title),{style:'QuillCoverTitle'})+rows.map(([k,v])=>ctx.paragraph(ctx.run(k+': ',{bold:true})+ctx.run(v),{style:'QuillCover'})).join('')+'<w:p><w:pPr><w:pStyle w:val="QuillCover"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>';
}

function signaturesXml(ctx,signatures) {
 if(!signatures.length)return '';
 let out=ctx.paragraph(ctx.run('Signature Appendix'),{style:'QuillAppendixHeading',pageBreakBefore:true});
 for(const sig of signatures) {
  const mark=sig.mark?.kind==='typed'?ctx.paragraph(ctx.run(sig.mark.text,{italic:true}),{style:'QuillAppendix'}):sig.mark?ctx.paragraph(ctx.run('[Drawn signature mark; vector image in the PDF export]'),{style:'QuillAppendix'}):'';
  out+=mark+ctx.paragraph(ctx.run(sig.name,{bold:true}),{style:'QuillAppendix'});
  for(const [k,v] of [['Capacity',sig.capacity],['Signed',sig.signedAt],['Intent',sig.intent],['Receipt',sig.receiptDigest]])if(v)out+=ctx.paragraph(ctx.run(k+': '+v),{style:'QuillAppendix'});
 }
 return out;
}

function stylesXml(fontSize) {
 const half=size=>Math.round(size*2);
 const heading=(n)=>'<w:style w:type="paragraph" w:styleId="Heading'+n+'"><w:name w:val="heading '+n+'"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="'+(n-1)+'"/></w:pPr><w:rPr><w:b/><w:sz w:val="'+half(n===1?fontSize+1:fontSize)+'"/></w:rPr></w:style>';
 return XML+'<w:styles '+W+'><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Liberation Serif" w:hAnsi="Liberation Serif" w:cs="Liberation Serif" w:eastAsia="Liberation Serif"/><w:sz w:val="'+half(fontSize)+'"/><w:szCs w:val="'+half(fontSize)+'"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
 +'<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
 +[1,2,3,4,5,6].map(heading).join('')
 +'<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>'
 +'<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:sz w:val="'+half(fontSize-2)+'"/></w:rPr></w:style>'
 +'<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'
 +'<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="00008C"/><w:u w:val="single"/></w:rPr></w:style>'
 +'<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="'+half(fontSize-2)+'"/></w:rPr></w:style>'
 +'<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="'+half(fontSize-2)+'"/></w:rPr></w:style>'
 +'<w:style w:type="paragraph" w:styleId="QuillCoverTitle"><w:name w:val="Quill Cover Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="2400" w:after="480"/></w:pPr><w:rPr><w:b/><w:sz w:val="'+half(fontSize+9)+'"/></w:rPr></w:style>'
 +'<w:style w:type="paragraph" w:styleId="QuillCover"><w:name w:val="Quill Cover"/><w:basedOn w:val="Normal"/></w:style>'
 +'<w:style w:type="paragraph" w:styleId="QuillAppendixHeading"><w:name w:val="Quill Appendix Heading"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>'
 +'<w:style w:type="paragraph" w:styleId="QuillAppendix"><w:name w:val="Quill Appendix"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40"/></w:pPr></w:style>'
 +'<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="666666"/><w:left w:val="single" w:sz="4" w:space="0" w:color="666666"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="666666"/><w:right w:val="single" w:sz="4" w:space="0" w:color="666666"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="666666"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="666666"/></w:tblBorders><w:tblCellMar><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
 +'</w:styles>';
}

function numberingXml(lists) {
 if(!lists.length)return null;
 const styles=[...new Set(lists)];
 const abstract=styles.map((style,a)=>{
  const [format,text]=LIST_FORMATS[style];
  const levels=Array.from({length:9},(_,lvl)=>'<w:lvl w:ilvl="'+lvl+'"><w:start w:val="1"/><w:numFmt w:val="'+format+'"/><w:lvlText w:val="'+(format==='bullet'?text:text.replace('L',String(lvl+1)))+'"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="'+(360*(lvl+2))+'" w:hanging="360"/></w:pPr></w:lvl>').join('');
  return '<w:abstractNum w:abstractNumId="'+a+'"><w:multiLevelType w:val="multilevel"/>'+levels+'</w:abstractNum>';
 }).join('');
 // Each list gets its own instance that restarts at 1.
 const nums=lists.map((style,i)=>'<w:num w:numId="'+(i+1)+'"><w:abstractNumId w:val="'+styles.indexOf(style)+'"/>'+Array.from({length:9},(_,lvl)=>'<w:lvlOverride w:ilvl="'+lvl+'"><w:startOverride w:val="1"/></w:lvlOverride>').join('')+'</w:num>').join('');
 return XML+'<w:numbering '+W+'>'+abstract+nums+'</w:numbering>';
}

/** Assembles a DOCX package from a body built with a DocxContext. */
export async function docxPackage({ctx,bodyXml,meta,profile}) {
 const e=value=>ctx.esc(value);
 const numbering=numberingXml(ctx.lists);
 const sect='<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdFooter"/><w:footnotePr><w:numFmt w:val="decimal"/></w:footnotePr><w:pgSz w:w="'+twips(profile.width)+'" w:h="'+twips(profile.height)+'"/><w:pgMar w:top="'+twips(profile.margins.top)+'" w:right="'+twips(profile.margins.right)+'" w:bottom="'+twips(profile.margins.bottom)+'" w:left="'+twips(profile.margins.left)+'" w:header="'+twips(profile.margins.top/2)+'" w:footer="'+twips(profile.margins.bottom/2)+'" w:gutter="0"/>'+(profile.lineNumbers==='none'?'':'<w:lnNumType w:countBy="1" w:restart="'+(profile.lineNumbers==='page'?'newPage':'continuous')+'"/>')+'</w:sectPr>';
 const documentXml=XML+'<w:document '+W+'><w:body>'+bodyXml+'<w:p/>'+sect+'</w:body></w:document>';
 const footnotesXml=XML+'<w:footnotes '+W+'><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'+ctx.footnotes.join('')+'</w:footnotes>';
 const headerXml=XML+'<w:hdr '+W+'><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr>'+ctx.run(meta.title)+'</w:p></w:hdr>';
 const footerXml=XML+'<w:ftr '+W+'><w:p><w:pPr><w:pStyle w:val="Footer"/></w:pPr>'+ctx.run('Page ')+'<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>'+ctx.run(' of ')+'<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:ftr>';
 const settingsXml=XML+'<w:settings '+W+'><w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>';
 const rels=[['rIdStyles',REL+'/styles','styles.xml'],['rIdSettings',REL+'/settings','settings.xml'],['rIdFootnotes',REL+'/footnotes','footnotes.xml'],['rIdHeader',REL+'/header','header1.xml'],['rIdFooter',REL+'/footer','footer1.xml'],...(numbering?[['rIdNumbering',REL+'/numbering','numbering.xml']]:[])];
 const documentRels=XML+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+rels.map(([id,type,target])=>'<Relationship Id="'+id+'" Type="'+type+'" Target="'+target+'"/>').join('')+[...ctx.links].map(([url,id])=>'<Relationship Id="'+id+'" Type="'+REL+'/hyperlink" Target="'+e(url)+'" TargetMode="External"/>').join('')+'</Relationships>';
 const keywords='edition-digest:'+meta.editionDigest+' render-profile:'+RENDER_PROFILE_ID+' version:'+meta.version;
 const core=XML+'<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>'+e(meta.title)+'</dc:title><dc:identifier>'+e(meta.documentId)+'</dc:identifier><dc:language>'+e(meta.lang)+'</dc:language><cp:keywords>'+e(keywords)+'</cp:keywords><dc:description>'+e('Edition '+meta.editionDigest+' rendered with '+RENDER_PROFILE_ID)+'</dc:description><cp:revision>'+meta.version+'</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">'+profile.generatedAt+'</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">'+profile.generatedAt+'</dcterms:modified></cp:coreProperties>';
 const app=XML+'<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>'+e(PRODUCER)+'</Application><DocSecurity>0</DocSecurity></Properties>';
 const types=XML+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
  +[['/word/document.xml','wordprocessingml.document.main'],['/word/styles.xml','wordprocessingml.styles'],['/word/settings.xml','wordprocessingml.settings'],['/word/footnotes.xml','wordprocessingml.footnotes'],['/word/header1.xml','wordprocessingml.header'],['/word/footer1.xml','wordprocessingml.footer'],...(numbering?[['/word/numbering.xml','wordprocessingml.numbering']]:[])].map(([part,type])=>'<Override PartName="'+part+'" ContentType="application/vnd.openxmlformats-officedocument.'+type+'+xml"/>').join('')
  +'<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
 const packageRels=XML+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="'+REL+'/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="'+REL+'/extended-properties" Target="docProps/app.xml"/></Relationships>';
 return writeZip([
  {name:'[Content_Types].xml',data:types},{name:'_rels/.rels',data:packageRels},
  {name:'word/document.xml',data:documentXml},{name:'word/_rels/document.xml.rels',data:documentRels},
  {name:'word/styles.xml',data:stylesXml(profile.fontSize)},{name:'word/settings.xml',data:settingsXml},
  ...(numbering?[{name:'word/numbering.xml',data:numbering}]:[]),
  {name:'word/footnotes.xml',data:footnotesXml},{name:'word/header1.xml',data:headerXml},{name:'word/footer1.xml',data:footerXml},
  {name:'docProps/core.xml',data:core},{name:'docProps/app.xml',data:app}
 ]);
}

export const docxMeta=(doc,editionDigest,version)=>({title:doc.metadata.title,lang:doc.metadata.locale,documentId:doc.id,editionDigest,version,revision:doc.revision,mode:doc.mode,lifecycle:doc.lifecycle});

/** Renders a validated legal edition to DOCX. */
export async function renderDocx({document,editionDigest,version,options={}}) {
 const doc=await prepareExport({document,editionDigest,version,validate:validateLegalDocument});
 const profile=normalizeLayoutOptions(options);requireTimestamp(profile.generatedAt);
 const ctx=new DocxContext(),meta=docxMeta(doc,editionDigest,version);
 const bodyXml=(profile.cover?coverXml(ctx,meta,profile):'')+documentBody(doc,ctx,profile)+signaturesXml(ctx,profile.signatures);
 if(profile.watermark)ctx.warnings.add('The watermark is not drawn in DOCX exports');
 if(profile.signatures.some(s=>s.mark?.kind==='drawn'))ctx.warnings.add('Drawn signature marks are described as text in DOCX exports');
 const bytes=await docxPackage({ctx,bodyXml,meta,profile});
 const manifest=await exportManifest({doc,format:'docx',editionDigest,version,profile,bytes,warnings:ctx.warnings});
 return {bytes,manifest};
}
