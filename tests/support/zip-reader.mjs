/** Test-only ZIP reader (central directory + local headers, stored/deflate) and XML helpers. */
import {inflateRawSync,crc32} from 'node:zlib';
import {JSDOM} from 'jsdom';

export function readZip(bytes) {
 const buf=Buffer.from(bytes),entries=new Map();
 const eocd=buf.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
 if(eocd<0)throw new Error('No end of central directory');
 const count=buf.readUInt16LE(eocd+10);let at=buf.readUInt32LE(eocd+16);
 for(let i=0;i<count;i++) {
  if(buf.readUInt32LE(at)!==0x02014b50)throw new Error('Bad central directory record');
  const method=buf.readUInt16LE(at+10),time=buf.readUInt16LE(at+12),date=buf.readUInt16LE(at+14),crc=buf.readUInt32LE(at+16),size=buf.readUInt32LE(at+20),raw=buf.readUInt32LE(at+24);
  const nameLength=buf.readUInt16LE(at+28),extra=buf.readUInt16LE(at+30),comment=buf.readUInt16LE(at+32),offset=buf.readUInt32LE(at+42);
  const name=buf.toString('utf8',at+46,at+46+nameLength);
  if(buf.readUInt32LE(offset)!==0x04034b50)throw new Error('Bad local header for '+name);
  const start=offset+30+buf.readUInt16LE(offset+26)+buf.readUInt16LE(offset+28);
  const payload=buf.subarray(start,start+size);
  const data=method===0?Buffer.from(payload):method===8?inflateRawSync(payload):null;
  if(!data||data.length!==raw||crc32(data)!==crc)throw new Error('Corrupt entry '+name);
  entries.set(name,{data,method,time,date});
  at+=46+nameLength+extra+comment;
 }
 return entries;
}

const dom=new JSDOM('');
/** Parses XML; throws on malformed input. */
export function parseXml(text) {
 const doc=new dom.window.DOMParser().parseFromString(text,'application/xml');
 const error=doc.getElementsByTagName('parsererror')[0];
 if(error)throw new Error('Malformed XML: '+error.textContent.slice(0,200));
 return doc;
}
