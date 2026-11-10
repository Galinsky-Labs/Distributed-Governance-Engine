import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('../',import.meta.url));
const run=(command,args)=>{
 const result=spawnSync(command,args,{cwd,encoding:'utf8',maxBuffer:10_000_000});
 if(result.status!==0)throw Error('Pinned MLS dependency inspection failed');
 return result.stdout;
};
const metadata=JSON.parse(run('cargo',['+1.94.0','metadata','--locked','--format-version','1','--filter-platform','wasm32-unknown-unknown','--manifest-path','crypto/mls-endpoint/Cargo.toml']));
const expected=new Map([['openmls','0.9.0'],['openmls_traits','0.6.0'],['openmls_basic_credential','0.6.0'],['openmls_rust_crypto','0.6.0'],['openmls_memory_storage','0.6.0'],['openmls_serialization_helpers','0.1.0']]);
for(const [name,version] of expected){
 const packages=metadata.packages.filter(pkg=>pkg.name===name);
 if(packages.length!==1 || packages[0].version!==version || packages[0].source!=='git+https://github.com/openmls/openmls.git?rev=28369d5b48608bef4ddf8371d91503b0f3852bb3#28369d5b48608bef4ddf8371d91503b0f3852bb3')throw Error('Unapproved MLS upstream');
 const node=metadata.resolve.nodes.find(node=>node.id===packages[0].id);
 const allowed=name==='openmls'?['js']:name==='openmls_traits'?['default']:[];
 if(!node || node.features.some(feature=>!allowed.includes(feature)))throw Error('Unapproved MLS feature; sensitive logging/test/draft modes are forbidden');
}
const binder=run('wasm-bindgen',['--version']).trim();
if(binder!=='wasm-bindgen 0.2.130')throw Error('Pinned wasm-bindgen 0.2.130 required');
console.log('Pinned MLS dependencies verified; no sensitive logging, draft or test features enabled.');
