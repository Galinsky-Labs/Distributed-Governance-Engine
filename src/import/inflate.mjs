import {fail} from './errors.mjs';

/**
 * Inflate with DecompressionStream, aborting as soon as output passes `maxBytes`, so a
 * compression bomb never materializes. `onTrailingJunk:'accept'` keeps the output when
 * the runtime reports data after a complete stream (common in PDF streams).
 */
export async function boundedInflate(data,format,{maxBytes,invalidCode,limitCode,limitMessage,onTrailingJunk='reject'}) {
 let stream;
 try{stream=new DecompressionStream(format);}catch{fail(invalidCode,'Decompression is unavailable in this runtime');}
 const writer=stream.writable.getWriter(),reader=stream.readable.getReader();
 const writing=writer.write(data).then(()=>writer.close()).catch(()=>{});
 const chunks=[];let total=0;
 try {
  for(;;) {
   let step;
   try{step=await reader.read();}
   catch(error) {
    if(onTrailingJunk==='accept'&&total>0&&/junk/i.test(String(error?.message)))break;
    fail(invalidCode,'Corrupt compressed data');
   }
   if(step.done)break;
   total+=step.value.byteLength;
   if(total>maxBytes)fail(limitCode,limitMessage);
   chunks.push(step.value);
  }
 } catch(error) {
  reader.cancel().catch(()=>{});
  throw error;
 }
 await writing;
 return concatBytes(chunks,total);
}

export function concatBytes(chunks,total=chunks.reduce((sum,chunk)=>sum+chunk.byteLength,0)) {
 const out=new Uint8Array(total);let offset=0;
 for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.byteLength;}
 return out;
}
