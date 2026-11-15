import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {readZip,crc32} from '../src/import/zip.mjs';
import {ImportError} from '../src/import/errors.mjs';
import {zip,prng,mutateBytes} from './support/import-fixtures.mjs';

const rejects=(promise,code,pattern)=>assert.rejects(promise,error=>error instanceof ImportError&&error.code===code&&(!pattern||pattern.test(error.message)));
const decode=bytes=>new TextDecoder().decode(bytes);

test('reads stored and deflated entries lazily with verified CRC-32',async()=>{
 const archive=await readZip(zip([{name:'a.txt',data:'stored',method:0},{name:'dir/b.xml',data:'<x>'+'y'.repeat(5000)+'</x>'}]));
 assert.deepEqual(archive.names,['a.txt','dir/b.xml']);
 assert.equal(decode(await archive.read('a.txt')),'stored');
 assert.equal(decode(await archive.read('dir/b.xml')).length,5007);
 await rejects(archive.read('missing'),'ARCHIVE_INVALID');
 assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926);
});

test('compression bombs abort on ratio, declared size and cumulative limits',async()=>{
 await rejects((await readZip(zip([{name:'ratio',data:new Uint8Array(10*1024*1024)}]))).read('ratio'),'ARCHIVE_LIMIT',/ratio/);
 const zeros=new Uint8Array(30*1024*1024);
 await rejects((await readZip(zip([{name:'bomb',data:zeros}]))).read('bomb'),'ARCHIVE_LIMIT');
 // A lying header (declared 1 MB) inflating to 30 MB stops at the declared size mid-stream.
 const raw=zlib.deflateRawSync(zeros);
 const liar=zip([{name:'liar',rawCompressed:raw,size:1024*1024,crc:0}]);
 await rejects((await readZip(liar,{maxRatio:1e6})).read('liar'),'ARCHIVE_LIMIT');
 // Huge declared sizes are rejected before any inflation.
 await rejects((await readZip(zip([{name:'huge',data:'x',size:0xfffffff0}]))).read('huge'),'ARCHIVE_LIMIT');
 const archive=await readZip(zip([{name:'a',data:'a'.repeat(4000)},{name:'b',data:'b'.repeat(4000)}]),{maxTotalBytes:6000});
 await archive.read('a');
 await rejects(archive.read('b'),'ARCHIVE_LIMIT',/total/);
 await rejects(readZip(zip(Array.from({length:12},(_,i)=>({name:'f'+i,data:''}))),{maxEntries:10}),'ARCHIVE_LIMIT');
 await rejects((await readZip(zip([{name:'big',data:'x'.repeat(2000),method:0}]),{maxEntryBytes:1000})).read('big'),'ARCHIVE_LIMIT');
});

test('unsafe names, duplicates, encryption, ZIP64 and multi-disk archives are rejected',async()=>{
 for(const name of ['../evil','a/../../b','/abs','C:/x','a\\b','nul\0x','','./a'])
  await rejects(readZip(zip([{name,data:'x'}])),'ARCHIVE_INVALID');
 await rejects(readZip(zip([{name:'a',data:'1'},{name:'a',data:'2'}])),'ARCHIVE_INVALID',/duplicate/);
 await rejects(readZip(zip([{name:'a',data:'x',flags:0x0801}])),'ARCHIVE_INVALID',/Encrypted/);
 await rejects(readZip(zip([{name:'a',data:'x',flags:0x0840}])),'ARCHIVE_INVALID',/Encrypted/);
 await rejects(readZip(zip([{name:'a',data:'x',extra:Uint8Array.of(1,0,0,0)}])),'ARCHIVE_INVALID',/ZIP64/);
 await rejects(readZip(zip([{name:'a',data:'x'}],{zip64Locator:true})),'ARCHIVE_INVALID',/ZIP64/);
 await rejects(readZip(zip([{name:'a',data:'x'}],{eocd:{count:0xffff,diskEntries:0xffff}})),'ARCHIVE_INVALID',/ZIP64/);
 await rejects(readZip(zip([{name:'a',data:'x'}],{eocd:{disk:1}})),'ARCHIVE_INVALID',/Multi-disk/);
 await rejects(readZip(zip([{name:'a',data:'x',method:12}])),'ARCHIVE_INVALID',/compression/);
 await rejects(readZip(zip([{name:'\xff',data:'x'}].map(e=>({...e,name:Uint8Array.of(0xff)})))),'ARCHIVE_INVALID');
});

test('header disagreement, overlap, CRC mismatch and truncation are rejected',async()=>{
 await rejects(readZip(zip([{name:'a',data:'x',localName:'b'}])),'ARCHIVE_INVALID',/name/);
 await rejects(readZip(zip([{name:'a',data:'x',localFlags:0x0808}])),'ARCHIVE_INVALID',/disagrees/);
 await rejects(readZip(zip([{name:'a',data:'x',localCrc:1}])),'ARCHIVE_INVALID',/disagrees/);
 await rejects(readZip(zip([{name:'a',data:'hello'},{name:'b',data:'world',localOffset:0}])),'ARCHIVE_INVALID');
 await rejects(readZip(zip([{name:'aa',data:'hello world',method:0},{name:'bb',data:'x',localOffset:10}])),'ARCHIVE_INVALID');
 // A genuine overlap: entry b's valid local record is hidden inside entry a's stored data.
 const hidden=zip([{name:'b',data:'x',method:0}]).slice(0,32);
 await rejects(readZip(zip([{name:'a',data:hidden,method:0},{name:'b',data:'x',method:0,localOffset:31}])),'ARCHIVE_INVALID',/overlap/);
 await rejects((await readZip(zip([{name:'a',data:'payload',crc:1234}]))).read('a'),'ARCHIVE_INVALID',/checksum/);
 await rejects((await readZip(zip([{name:'a',data:'payload',method:0,crc:1234}]))).read('a'),'ARCHIVE_INVALID',/checksum/);
 await rejects((await readZip(zip([{name:'a',rawCompressed:Uint8Array.of(0xff,0xff,0xff),size:3,crc:0}]))).read('a'),'ARCHIVE_INVALID');
 await rejects(readZip(zip([{name:'a',data:'x'}],{comment:'trailing'}).slice(0,-3)),'ARCHIVE_INVALID');
 await rejects(readZip(new Uint8Array(10)),'ARCHIVE_INVALID');
 await rejects(readZip(zip([{name:'a',data:'x'}],{eocd:{cdOffset:9999}})),'ARCHIVE_INVALID');
});

test('mutation fuzzing yields entries or ImportError only',async()=>{
 const seed=zip([{name:'[Content_Types].xml',data:'<Types/>'},{name:'word/document.xml',data:'<w:document>'+'text '.repeat(50)+'</w:document>'},{name:'m',data:'stored',method:0}]);
 const random=prng(0x5eed);
 for(let i=0;i<400;i++) {
  const input=mutateBytes(seed,random);
  try {
   const archive=await readZip(input);
   for(const name of archive.names)await archive.read(name).catch(error=>{if(!(error instanceof ImportError))throw error;});
  } catch(error) {
   assert(error instanceof ImportError,`case ${i}: ${error?.stack}`);
  }
 }
});
