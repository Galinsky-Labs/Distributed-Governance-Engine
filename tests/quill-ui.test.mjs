import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';

test('the built React interface mounts both brands, freezes public-input text and opens/closes the anchored tour',async()=>{
 const output=await build({entryPoints:['web/main.jsx'],bundle:true,write:false,outdir:'unused',platform:'browser',format:'iife',target:'es2022',define:{'process.env.NODE_ENV':'"production"'}});
 const script=output.outputFiles.find(x=>x.path.endsWith('.js')).text;
 const dom=new JSDOM('<html data-quill-product="civic"><body><div id="root"></div></body></html>',{url:'https://preview.example.test',runScripts:'dangerously',pretendToBeVisual:true,beforeParse(window){window.structuredClone=value=>window.JSON.parse(window.JSON.stringify(value));window.TextEncoder=TextEncoder;window.HTMLElement.prototype.scrollIntoView=function(){};window.Range.prototype.getClientRects=()=>[];window.Range.prototype.getBoundingClientRect=()=>({left:0,right:0,top:0,bottom:0,width:0,height:0});}});
 const waitFor=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('Expected UI state did not appear');};
 try{
  dom.window.eval(script);const document=dom.window.document;
  await waitFor(()=>document.querySelector('.ProseMirror'));
  assert.match(document.querySelector('.brand').textContent,/CivicQuill/);assert.match(document.querySelector('.ProseMirror').textContent,/SEC\. 1\./);
  const button=text=>[...document.querySelectorAll('button')].find(b=>b.textContent===text);
  const change=(element,value)=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
  const inputs=document.querySelectorAll('.search-tools input:not([type=checkbox])');change(inputs[0],'annually');await waitFor(()=>!button('Find next').disabled);button('Find next').click();await waitFor(()=>dom.window.getSelection().toString()==='annually');
  change(inputs[1],'monthly');await new Promise(r=>setTimeout(r,0));button('Replace all').click();await waitFor(()=>document.querySelector('.ProseMirror').textContent.includes('monthly'));button('Undo').click();await waitFor(()=>document.querySelector('.ProseMirror').textContent.includes('annually'));
  button('Preview a fixed public-input edition').click();await waitFor(()=>document.querySelector('.ProseMirror').getAttribute('contenteditable')==='false');assert.equal(button('Bold').disabled,true);assert.equal(button('Replace all').disabled,true);assert.equal(button('Find next').disabled,false);assert.match(document.querySelector('.edition').textContent,/Public-input/);
  button('CharterQuill').click();await waitFor(()=>document.querySelector('.brand').textContent.includes('CharterQuill'));await waitFor(()=>document.querySelector('.ProseMirror').getAttribute('contenteditable')==='true');assert.match(document.querySelector('h1').textContent,/Resolution/);
  button('Take a tour').click();await waitFor(()=>document.querySelector('.tour'));assert.match(document.querySelector('.tour').textContent,/STEP 1 OF 6/);assert(document.querySelector('.tour-target'));
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape'}));await waitFor(()=>!document.querySelector('.tour'));
 }finally{dom.window.close();}
});
