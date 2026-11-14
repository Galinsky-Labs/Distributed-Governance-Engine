import {sha256,sha256Hex} from './sha256.mjs';

import {identifier,canonicalize,validDigest,invariant} from './integrity-values.mjs';
export * from './integrity-values.mjs';

export function digest(domain,value) {
  identifier(domain);
  return sha256Hex(encoder.encode('dce-c14n-v0-dev\0'+domain+'\0'+canonicalize(value)));
}

const encoder=new TextEncoder();
const concat=(...parts)=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let o=0;for(const p of parts){out.set(p,o);o+=p.length;}return out;};
const hexBytes=hex=>Uint8Array.from(hex.match(/../g),h=>parseInt(h,16));
const toHex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const equalBytes=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
const hashBytes=bytes=>sha256(bytes);
const leafHash=d=>hashBytes(concat(Uint8Array.of(0),hexBytes(validDigest(d))));
const parentHash=(l,r)=>hashBytes(concat(Uint8Array.of(1),l,r));
/** Development Merkle tree; odd nodes duplicate, empty root is domain-separated. */
export function merkleBatch(digests) {
  invariant(Array.isArray(digests) && digests.length<=100000,'Invalid batch');
  let level=digests.map(leafHash);
  const levels=[level];
  while(level.length>1) {
    const next=[];
    for(let i=0;i<level.length;i+=2) next.push(parentHash(level[i],level[i+1]??level[i]));
    levels.push(next); level=next;
  }
  const treeRoot=toHex(level[0]??hashBytes(Uint8Array.of(2)));
  return {root:digest('merkle-batch',{count:digests.length,treeRoot}),count:digests.length,
    proofs:digests.map((_,index)=>{
      let i=index;
      const path=[];
      for(let l=0;l<levels.length-1;l++) {
        const row=levels[l]; const sibling=i^1;
        path.push({side:i%2?'left':'right',hash:toHex(row[sibling]??row[i])});
        i=Math.floor(i/2);
      }
      return {index,count:digests.length,path};
    })};
}
export function verifyInclusion(leaf,proof,root) {
  try {
    validDigest(root);
    invariant(proof && Number.isSafeInteger(proof.index) && Number.isSafeInteger(proof.count) && proof.count>0 && proof.count<=100000 && proof.index>=0 && proof.index<proof.count && Array.isArray(proof.path),'Invalid proof');
    let current=leafHash(leaf), i=proof.index, width=proof.count;
    for(const step of proof.path) {
      invariant(width>1 && step.side===(i%2?'left':'right'),'Invalid proof side');
      const other=hexBytes(validDigest(step.hash));
      if(i%2===0 && i+1===width) invariant(equalBytes(other,current),'Invalid duplicated odd node');
      current=step.side==='left'?parentHash(other,current):parentHash(current,other);
      i=Math.floor(i/2); width=Math.ceil(width/2);
    }
    return width===1 && digest('merkle-batch',{count:proof.count,treeRoot:toHex(current)})===root;
  } catch { return false; }
}
