// Bundles the private workspace page. The MLS endpoint itself is built and
// pinned separately by scripts/build-mls.mjs into dist/mls/ and is loaded at
// runtime from /mls/ (never bundled; served only with PRIVATE_WORKSPACES=enabled).
import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:['web/private-main.jsx'],bundle:true,format:'esm',platform:'browser',target:['es2022'],outdir:'dist',
 entryNames:'private',minify:true,legalComments:'eof',sourcemap:true,external:['/mls/*']});
await copyFile('web/private.html','dist/private.html');
console.log('Built private workspace page; the MLS Wasm module is built by scripts/build-mls.mjs.');
