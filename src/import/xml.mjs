import {fail} from './errors.mjs';

export const XML_DEFAULT_LIMITS=Object.freeze({
 maxDepth:256,
 maxNodes:500000,
 maxAttributes:256,
 maxAttributeLength:65536,
 maxTextLength:10*1024*1024
});
const XML_NS='http://www.w3.org/XML/1998/namespace',XMLNS_NS='http://www.w3.org/2000/xmlns/';
const PREDEFINED={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
const NAME=/[A-Za-z_:\u00C0-\uFFFF][-A-Za-z0-9_.:\u00B7\u00C0-\uFFFF]*/y;
const SPACE=/[ \t\n]*/y;
const INVALID_CHAR=/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});
const invalid=message=>fail('XML_INVALID',message);
const tooLarge=message=>fail('DOCUMENT_TOO_LARGE',message);

function decodeInput(input) {
 if(typeof input==='string')return input.charCodeAt(0)===0xfeff?input.slice(1):input;
 if(!(input instanceof Uint8Array))throw new TypeError('parseXml expects bytes or a string');
 if((input[0]===0xfe&&input[1]===0xff)||(input[0]===0xff&&input[1]===0xfe))invalid('Only UTF-8 XML is supported');
 try{return utf8.decode(input);}catch{invalid('XML is not valid UTF-8');}
}

function validCodePoint(cp) {
 return cp===0x9||cp===0xa||cp===0xd||(cp>=0x20&&cp<=0xd7ff)||(cp>=0xe000&&cp<=0xfffd)||(cp>=0x10000&&cp<=0x10ffff);
}

function decodeReferences(raw) {
 if(!raw.includes('&'))return raw;
 let out='',from=0;
 for(let amp=raw.indexOf('&');amp!==-1;amp=raw.indexOf('&',from)) {
  const semi=raw.indexOf(';',amp);
  if(semi===-1||semi-amp>12)invalid('Malformed character reference');
  const name=raw.slice(amp+1,semi);
  let value;
  if(name[0]==='#') {
   const hex=name[1]==='x';
   const digits=name.slice(hex?2:1);
   if(!(hex?/^[0-9A-Fa-f]{1,6}$/:/^[0-9]{1,7}$/).test(digits))invalid('Malformed numeric character reference');
   const cp=parseInt(digits,hex?16:10);
   if(!validCodePoint(cp))invalid('Character reference to an invalid code point');
   value=String.fromCodePoint(cp);
  } else {
   value=PREDEFINED[name];
   if(value===undefined)invalid('Undeclared entity reference');
  }
  out+=raw.slice(from,amp)+value;from=semi+1;
 }
 return out+raw.slice(from);
}

function splitName(name) {
 const colon=name.indexOf(':');
 if(colon===-1)return {prefix:null,local:name};
 if(colon===0||colon===name.length-1||name.indexOf(':',colon+1)!==-1)invalid('Malformed qualified name');
 return {prefix:name.slice(0,colon),local:name.slice(colon+1)};
}

/**
 * Strict, non-validating XML parser. DOCTYPE is always refused, so no entity can be
 * declared or expanded; only the five predefined entities and numeric references decode.
 * Elements are {name,prefix,local,uri,attributes:[{name,prefix,local,uri,value}],children};
 * text (including CDATA) is a string child. Comments and processing instructions are dropped.
 */
export function parseXml(input,limits={}) {
 const caps={...XML_DEFAULT_LIMITS,...limits};
 const source=decodeInput(input);
 if(/<!DOCTYPE/i.test(source))fail('XML_DOCTYPE_FORBIDDEN','XML document type declarations are forbidden');
 if(INVALID_CHAR.test(source))invalid('XML contains characters that are not allowed');
 const s=source.includes('\r')?source.replace(/\r\n?/g,'\n'):source;
 const stack=[];let root=null,nodes=0,pos=0;
 const scopes=[new Map([['xml',XML_NS],['xmlns',XMLNS_NS]])];
 const count=()=>{if(++nodes>caps.maxNodes)tooLarge('XML has too many nodes');};
 const readName=()=>{NAME.lastIndex=pos;const m=NAME.exec(s);if(!m)invalid('Expected an XML name');pos=NAME.lastIndex;return m[0];};
 const skipSpace=()=>{SPACE.lastIndex=pos;SPACE.exec(s);const moved=SPACE.lastIndex!==pos;pos=SPACE.lastIndex;return moved;};
 const addText=text=>{
  if(text.length>caps.maxTextLength)tooLarge('XML text node is too large');
  if(!stack.length){if(/[^ \t\n]/.test(text))invalid('Text outside the root element');return;}
  count();stack.at(-1).children.push(text);
 };
 while(pos<s.length) {
  if(s[pos]!=='<') {
   let end=s.indexOf('<',pos);if(end===-1)end=s.length;
   const raw=s.slice(pos,end);
   if(raw.includes(']]>'))invalid('Unexpected CDATA terminator');
   addText(decodeReferences(raw));pos=end;continue;
  }
  if(s.startsWith('<?',pos)) {
   const end=s.indexOf('?>',pos+2);if(end===-1)invalid('Unterminated processing instruction');
   const body=s.slice(pos+2,end);
   if(/^xml(?:[ \t\n]|$)/i.test(body)) {
    if(pos!==0)invalid('Misplaced XML declaration');
    const encoding=/encoding[ \t\n]*=[ \t\n]*["']([^"']*)["']/.exec(body);
    if(encoding&&!/^utf-?8$/i.test(encoding[1]))invalid('Only UTF-8 XML is supported');
   }
   pos=end+2;continue;
  }
  if(s.startsWith('<!--',pos)) {
   const end=s.indexOf('-->',pos+4);if(end===-1)invalid('Unterminated comment');
   pos=end+3;continue;
  }
  if(s.startsWith('<![CDATA[',pos)) {
   if(!stack.length)invalid('CDATA outside the root element');
   const end=s.indexOf(']]>',pos+9);if(end===-1)invalid('Unterminated CDATA section');
   addText(s.slice(pos+9,end));pos=end+3;continue;
  }
  if(s[pos+1]==='!')invalid('Unsupported markup declaration');
  if(s[pos+1]==='/') {
   pos+=2;const name=readName();skipSpace();
   if(s[pos]!=='>')invalid('Malformed end tag');
   pos++;
   const open=stack.pop();
   if(!open||open.name!==name)invalid('Mismatched end tag');
   scopes.pop();continue;
  }
  pos++;
  const name=readName();
  const rawAttributes=[];
  for(;;) {
   const spaced=skipSpace();
   if(s[pos]==='>'||s.startsWith('/>',pos))break;
   if(!spaced)invalid('Attributes must be separated by whitespace');
   const attrName=readName();skipSpace();
   if(s[pos]!=='=')invalid('Attribute without a value');
   pos++;skipSpace();
   const quote=s[pos];
   if(quote!=='"'&&quote!=="'")invalid('Unquoted attribute value');
   const end=s.indexOf(quote,pos+1);
   if(end===-1)invalid('Unterminated attribute value');
   const raw=s.slice(pos+1,end);
   if(raw.includes('<'))invalid('Attribute value contains <');
   if(raw.length>caps.maxAttributeLength)tooLarge('XML attribute value is too large');
   if(rawAttributes.some(a=>a.name===attrName))invalid('Duplicate attribute');
   if(rawAttributes.length>=caps.maxAttributes)tooLarge('XML element has too many attributes');
   rawAttributes.push({name:attrName,value:decodeReferences(raw.replace(/[\t\n]/g,' '))});
   pos=end+1;
  }
  const selfClosing=s[pos]==='/';
  pos+=selfClosing?2:1;
  const scope=new Map(scopes.at(-1));
  for(const {name:attrName,value} of rawAttributes) {
   if(attrName==='xmlns')scope.set('',value);
   else if(attrName.startsWith('xmlns:')){if(!value)invalid('Empty namespace binding');scope.set(attrName.slice(6),value);}
  }
  const resolve=(prefix,isAttribute)=>{
   if(prefix===null)return isAttribute?null:scope.get('')||null;
   const uri=scope.get(prefix);
   if(uri===undefined)invalid('Unbound namespace prefix');
   return uri;
  };
  const {prefix,local}=splitName(name);
  const attributes=rawAttributes.map(a=>{const parts=splitName(a.name);return {name:a.name,prefix:parts.prefix,local:parts.local,uri:resolve(parts.prefix,true),value:a.value};});
  const element={name,prefix,local,uri:resolve(prefix,false),attributes,children:[]};
  count();
  if(stack.length)stack.at(-1).children.push(element);
  else if(root)invalid('Multiple root elements');
  else root=element;
  if(!selfClosing) {
   if(stack.length>=caps.maxDepth)tooLarge('XML nesting is too deep');
   stack.push(element);scopes.push(scope);
  }
 }
 if(stack.length)invalid('Unclosed element');
 if(!root)invalid('Missing root element');
 return root;
}

export const isElement=(node,uri,local)=>typeof node==='object'&&node!==null&&(uri===undefined||node.uri===uri||(Array.isArray(uri)&&uri.includes(node.uri)))&&(local===undefined||node.local===local);
export const elementChildren=(element,uri,local)=>element.children.filter(node=>isElement(node,uri,local));
export const firstChild=(element,uri,local)=>element.children.find(node=>isElement(node,uri,local))??null;
export function attribute(element,uri,local) {
 const found=element.attributes.find(a=>a.local===local&&(uri===undefined||a.uri===uri||(Array.isArray(uri)&&uri.includes(a.uri))));
 return found?found.value:null;
}
/** Local-name matching for callers that deliberately ignore namespaces. */
export const localName=name=>name.slice(name.indexOf(':')+1);
export function textContent(element) {
 let out='';const pending=[element];
 while(pending.length) {
  const node=pending.pop();
  if(typeof node==='string')out+=node;
  else for(let i=node.children.length-1;i>=0;i--)pending.push(node.children[i]);
 }
 return out;
}
