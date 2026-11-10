// Local TLS-only server for the compiled endpoint module, never production routing.
import {mkdtemp,readFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:https';
export async function mlsFixture(){
 const directory=await mkdtemp(join(tmpdir(),'quill-mls-browser-'));
 let server;
 try{
  const result=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-days','1'],{stdio:'ignore'});
  if(result.status!==0)throw Error('Local MLS fixture certificate generation failed');
  await chmod(join(directory,'key.pem'),0o600);
  const [key,cert,js,wasm]=await Promise.all([readFile(join(directory,'key.pem')),readFile(join(directory,'cert.pem')),readFile(new URL('../../dist/mls/quill_mls.js',import.meta.url)),readFile(new URL('../../dist/mls/quill_mls_bg.wasm',import.meta.url))]);
  const files=new Map([
   ['/',{type:'text/html',body:'<!doctype html><meta charset="utf-8"><title>Endpoint protocol test</title>'}],
   ['/quill_mls.js',{type:'text/javascript',body:js}],
   ['/quill_mls_bg.wasm',{type:'application/wasm',body:wasm}],
  ]);
  server=createServer({key,cert,minVersion:'TLSv1.3',maxVersion:'TLSv1.3'},(request,response)=>{
   const file=request.method==='GET'?files.get(request.url):undefined;
   response.writeHead(file?200:404,{'content-type':file?.type??'text/plain','cache-control':'no-store','content-security-policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",'x-content-type-options':'nosniff'});
   response.end(file?.body??'Not found');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {origin:'https://127.0.0.1:'+server.address().port,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}};
 }catch(error){server?.closeAllConnections();server?.close();await rm(directory,{recursive:true,force:true});throw error;}
}
