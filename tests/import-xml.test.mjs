import test from 'node:test';
import assert from 'node:assert/strict';
import {parseXml,attribute,elementChildren,firstChild,textContent,localName,isElement} from '../src/import/xml.mjs';
import {ImportError} from '../src/import/errors.mjs';
import {prng,mutateText} from './support/import-fixtures.mjs';

const throwsCode=(fn,code)=>assert.throws(fn,error=>error instanceof ImportError&&error.code===code);

test('parses elements, namespaces, attributes, text, CDATA and references',()=>{
 const root=parseXml(new TextEncoder().encode('\uFEFF<?xml version="1.0" encoding="UTF-8"?><!-- c --><w:doc xmlns:w="urn:w" xmlns="urn:d" w:a="1 &amp; 2" b=\'x\'><?pi data?><w:p>A &lt;b&gt; &#65;&#x1F600; &quot;&apos;</w:p><item><![CDATA[<raw> & text]]></item><w:e/></w:doc>'));
 assert.equal(root.name,'w:doc');assert.equal(root.local,'doc');assert.equal(root.prefix,'w');assert.equal(root.uri,'urn:w');
 assert.equal(attribute(root,'urn:w','a'),'1 & 2');assert.equal(attribute(root,null,'b'),'x');assert.equal(attribute(root,undefined,'missing'),null);
 assert.equal(textContent(firstChild(root,'urn:w','p')),'A <b> A\u{1F600} "\'');
 assert.equal(firstChild(root,'urn:d','item').children[0],'<raw> & text');
 assert.equal(elementChildren(root,'urn:w').length,2);
 assert(isElement(root.children[2],['urn:x','urn:w'],'e'));
 assert.equal(localName('w:tbl'),'tbl');assert.equal(localName('tbl'),'tbl');
 assert.equal(textContent(parseXml('<a>x\r\ny</a>')),'x\ny');
});

test('DOCTYPE, XXE and billion-laughs payloads are refused before any expansion',()=>{
 const lol='<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>';
 throwsCode(()=>parseXml(lol),'XML_DOCTYPE_FORBIDDEN');
 throwsCode(()=>parseXml('<!DOCTYPE x SYSTEM "file:///etc/passwd"><x>&xxe;</x>'),'XML_DOCTYPE_FORBIDDEN');
 throwsCode(()=>parseXml('<x/><!doctype x>'),'XML_DOCTYPE_FORBIDDEN');
 throwsCode(()=>parseXml('<x><!ENTITY a "b"></x>'),'XML_INVALID');
 throwsCode(()=>parseXml('<x>&xxe;</x>'),'XML_INVALID');
 throwsCode(()=>parseXml('<x>&nbsp;</x>'),'XML_INVALID');
});

test('invalid references, characters and well-formedness errors are rejected',()=>{
 for(const bad of ['<x>&#0;</x>','<x>&#xD800;</x>','<x>&#x110000;</x>','<x>&#xFFFE;</x>','<x>&#;</x>','<x>& </x>','<x>&#99999999;</x>','<x>\u0001</x>','<x>\uD800</x>',
  '<x>','<x></y>','</x>','<x/><y/>','text<x/>','<x a="1" a="2"/>','<x a=1/>','<x a="<"/>','<x a="1"b="2"/>','<p:x/>','<x><!-- open</x>','<x><![CDATA[open</x>','<x>]]></x>',
  '<x><?xml version="1.0"?></x>','<?xml version="1.0" encoding="ISO-8859-1"?><x/>','',' ','<1x/>','<x:/>','<x xmlns:p=""/>'])
  throwsCode(()=>parseXml(bad),'XML_INVALID');
 throwsCode(()=>parseXml(Uint8Array.of(0x3c,0x78,0x3e,0xff,0x3c,0x2f,0x78,0x3e)),'XML_INVALID');
 throwsCode(()=>parseXml(Uint8Array.of(0xff,0xfe,0x3c,0)),'XML_INVALID');
});

test('depth, node, attribute and text caps fail with typed errors',()=>{
 throwsCode(()=>parseXml('<a>'.repeat(300)+'</a>'.repeat(300)),'DOCUMENT_TOO_LARGE');
 parseXml('<a>'.repeat(200)+'</a>'.repeat(200));
 throwsCode(()=>parseXml('<r>'+'<a/>'.repeat(101)+'</r>',{maxNodes:100}),'DOCUMENT_TOO_LARGE');
 throwsCode(()=>parseXml('<r '+Array.from({length:20},(_,i)=>`a${i}="1"`).join(' ')+'/>',{maxAttributes:10}),'DOCUMENT_TOO_LARGE');
 throwsCode(()=>parseXml(`<r a="${'x'.repeat(200)}"/>`,{maxAttributeLength:100}),'DOCUMENT_TOO_LARGE');
 throwsCode(()=>parseXml(`<r>${'x'.repeat(200)}</r>`,{maxTextLength:100}),'DOCUMENT_TOO_LARGE');
});

test('mutation fuzzing yields a tree or ImportError only',()=>{
 const seed='<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t xml:space="preserve">Hello &amp; world &#169;</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl><!-- note --><x><![CDATA[a<b]]></x></w:body></w:document>';
 const random=prng(42);
 for(let i=0;i<600;i++) {
  const input=mutateText(seed,random);
  try{parseXml(input);}catch(error){assert(error instanceof ImportError,`case ${i}: ${error?.stack}`);}
 }
});
