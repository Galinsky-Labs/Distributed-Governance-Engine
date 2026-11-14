import {build} from 'esbuild';import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:{app:'web/main.jsx'},bundle:true,format:'esm',platform:'browser',target:['es2022'],outdir:'dist',minify:true,legalComments:'eof',sourcemap:true});
await copyFile('web/index.html','dist/index.html');
console.log('Built shared Quill editor preview. No deployed-service claim.');
