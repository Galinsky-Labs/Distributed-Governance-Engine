import {createRequire} from 'node:module';
import test from 'node:test';
import {connect, rootCertificates} from 'node:tls';
import {readFile} from 'node:fs/promises';
import {randomBytes, createHmac} from 'node:crypto';
import assert from 'node:assert/strict';
import {createIdentityStore, applyIdentityMigrations} from '../server/identity-store.mjs';
import {createOIDCLogin, discoverIdentityProvider} from '../server/oidc-login.mjs';
import {createAccountHandler} from '../server/account-http.mjs';
import {createEngineApplication,createEngineServer} from '../server/application.mjs';
const require=createRequire(new URL('../package.json', import.meta.url));
const {PGlite}=require('@electric-sql/pglite');
const {default:puppeteer}=await import(require.resolve('puppeteer-core'));
test('real Keycloak TLS login enforces MFA before recovery and preserves engine request protection', {timeout: 120000}, async () => {
const state=JSON.parse(await readFile(process.env.DGE_IDENTITY_TEST_STATE,'utf8'));
assert.match(state.issuer,/^https:\/\/localhost:[0-9]+\/realms\/quill$/);
const secret=JSON.parse(await readFile(state.root+'/secrets.json','utf8'));
const ca=await readFile(state.root+'/ca.crt');
const handshake=options=>new Promise((resolve,reject)=>{
 const socket=connect({host:'localhost',port:state.port,servername:'localhost',ca,
   rejectUnauthorized:true,minVersion:'TLSv1.3',maxVersion:'TLSv1.3',...options});
 socket.setTimeout(10000,()=>socket.destroy(Error('TLS handshake timed out')));
 socket.once('secureConnect',()=>{const protocol=socket.getProtocol();socket.end();resolve(protocol);});
 socket.once('error',reject);
});
assert.equal(await handshake({}),'TLSv1.3');
await assert.rejects(handshake({minVersion:'TLSv1.2',maxVersion:'TLSv1.2'}));
await assert.rejects(handshake({ca:rootCertificates[0]}));
const origin='https://localhost:9444';
const db=await PGlite.create();await applyIdentityMigrations(fn=>db.transaction(fn));
const transaction=fn=>db.transaction(async tx=>{await tx.exec('SET LOCAL ROLE dge_identity_runtime');return fn(tx);});
const store=createIdentityStore({transaction,origin,sessionKey:randomBytes(32),stateKey:randomBytes(32)});
const configuration=await discoverIdentityProvider({issuer:state.issuer,clientId:'quill-civic',clientSecret:(await readFile(state.root+'/civic.secret','utf8')).trim()});
const login=createOIDCLogin({store,configuration,redirectUri:origin+'/auth/callback'});
const accounts=createAccountHandler({store,login,origin});
const application=createEngineApplication({accounts,origin,product:'civic'});
const server=createEngineServer({application,origin,key:await readFile(state.root+'/server.key'),cert:await readFile(state.root+'/server.crt')});
await new Promise(resolve=>server.listen(9444,'127.0.0.1',resolve));
function totp(value){
 // Keycloak's fixture form carries the raw UTF-8 secret; its QR encodes this in Base32.
 const key=Buffer.from(value,'utf8');
 const count=Buffer.alloc(8);count.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
 const h=createHmac('sha1',key).update(count).digest(),o=h[19]&15;
 return String((h.readUInt32BE(o)&0x7fffffff)%1000000).padStart(6,'0');
}
let browser,page;
try{
 browser=await puppeteer.launch({executablePath:process.env.DGE_BROWSER_EXECUTABLE,headless:true,acceptInsecureCerts:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 page=await browser.newPage();page.setDefaultTimeout(20000);
 await page.goto(origin+'/account');await page.waitForSelector('a.button-link[href="/auth/start"]');await page.click('a.button-link[href="/auth/start"]');
 await page.waitForSelector('#username');await page.type('#username','quillfixture');await page.type('#password',secret.user);await page.click('#kc-login');
 await page.waitForSelector('#totp');
 const otpSecret=await page.$eval('#totpSecret',element=>element.value.trim());
 await page.type('#totp',totp(otpSecret));
 if(await page.$('#userLabel'))await page.type('#userLabel','Local test authenticator');
 await page.click('#saveTOTPBtn');
 await page.waitForSelector('.account-id');
 let info=await page.evaluate(async()=>await (await fetch('/api/session')).json());
 assert.equal(info.authenticationAssurance,'primary');
 const initialRecovery=await page.evaluate(async()=>{const csrf=document.cookie.split('; ').find(x=>x.startsWith('__Host-dge_csrf=')).split('=')[1];const response=await fetch('/api/recovery-codes',{method:'POST',headers:{'content-type':'application/json','x-dge-csrf':csrf},body:'{}'});return {status:response.status,error:(await response.json()).error};});
 assert.deepEqual(initialRecovery,{status:403,error:'STEP_UP_REQUIRED'},'OTP enrollment must not silently turn a primary session into MFA');
 // Enrollment may finish after initial authentication. A new login must execute
 // the configured password+OTP flow before the engine accepts privileged writes.
 await page.goto(origin+'/auth/start');await page.waitForSelector('#username');
 await page.type('#username','quillfixture');await page.type('#password',secret.user);await page.click('#kc-login');
 await page.waitForSelector('#otp');
 await new Promise(resolve=>setTimeout(resolve,30000-Date.now()%30000+1000));
 await page.type('#otp',totp(otpSecret));await page.click('#kc-login');
 await page.waitForSelector('.account-id');
 info=await page.evaluate(async()=>await (await fetch('/api/session')).json());
 assert.equal(info.authenticationAssurance,'multifactor');assert.equal(info.authenticationMethod,'oidc');
 const result=await page.evaluate(async()=>{const csrf=document.cookie.split('; ').find(x=>x.startsWith('__Host-dge_csrf=')).split('=')[1];const r=await fetch('/api/workspaces',{method:'POST',headers:{'content-type':'application/json','x-dge-csrf':csrf},body:'{}'});return {status:r.status};});
 assert.equal(result.status,201);
 const recovery=await page.evaluate(async()=>{const csrf=document.cookie.split('; ').find(x=>x.startsWith('__Host-dge_csrf=')).split('=')[1];return (await fetch('/api/recovery-codes',{method:'POST',headers:{'content-type':'application/json','x-dge-csrf':csrf},body:'{}'})).status;});
 assert.equal(recovery,201,'Only a fresh verified MFA login permits issuing account recovery codes');
 console.log('Real Keycloak password+OTP login established a verified engine MFA session and created an authorized workspace.');
}catch(error){console.error('Identity journey failed:',error.name);if(page)console.error('Visible form fields:',await page.$$eval('input',nodes=>nodes.map(x=>({id:x.id,name:x.name,type:x.type}))));throw Error('Local identity journey failed: '+error.name);}
finally{await browser?.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await db.close();}
});
