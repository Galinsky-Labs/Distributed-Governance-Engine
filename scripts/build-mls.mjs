import {spawn} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=root+'dist/mls';
const run=(cmd,args)=>new Promise((resolve,reject)=>{
 const child=spawn(cmd,args,{cwd:root,stdio:'inherit'});
 child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('MLS build step failed')));
});
await run(process.execPath,['scripts/verify-mls-build.mjs']);
await mkdir(output,{recursive:true});
await run('cargo',['+1.94.0','build','--locked','--release','--target','wasm32-unknown-unknown','--manifest-path','crypto/mls-endpoint/Cargo.toml']);
await run('wasm-bindgen',['--target','web','--out-dir',output,'--out-name','quill_mls','crypto/mls-endpoint/target/wasm32-unknown-unknown/release/quill_mls_endpoint.wasm']);
console.log('Built endpoint-only MLS module; private application routes remain disabled.');
