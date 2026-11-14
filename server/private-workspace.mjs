// Composition of the private (end-to-end encrypted) workspace path. The server
// side holds ciphertext, public MLS material and ordering metadata only.
import {EventEmitter} from 'node:events';
import {createPrivateDocumentStore} from './private-document-store.mjs';
import {createPrivateDocumentRoutes,privateDocumentBodyLimit} from './private-document-http.mjs';
import {createPrivateUpdateLedger} from './private-update-ledger.mjs';
import {createPrivateUpdateRoutes,privateUpdateBodyLimit} from './private-update-http.mjs';
import {createPrivateWorkspaceStore} from './private-workspace-store.mjs';
import {createPrivateWorkspaceRoutes,privateWorkspaceBodyLimit} from './private-workspace-http.mjs';
import {attachPrivateCollaborationHub} from './private-collaboration-hub.mjs';

/** Parses the PRIVATE_WORKSPACES flag; any value other than the two literals fails closed. */
export function privateWorkspacesFlag(value){
 if(value===undefined||value==='')return false;
 if(value==='enabled')return true;
 if(value==='disabled')return false;
 throw Error('Invalid PRIVATE_WORKSPACES value');
}

export function createPrivateWorkspaceServices({identity,clock=Date.now,limits={}}={}){
 const workspace=createPrivateWorkspaceStore({identity,clock,...limits.workspace});
 // The MLS roster/epoch adapter is the ONLY device authority for both stores.
 const authorizeDevice=args=>workspace.authorizeDevice(args);
 const authorizeEpochAdvance=args=>workspace.authorizeEpochAdvance(args);
 const documents=createPrivateDocumentStore({identity,authorizeDevice,authorizeEpochAdvance,clock,...limits.documents});
 const ledger=createPrivateUpdateLedger({identity,authorizeDevice,clock,...limits.ledger});
 const routeSets=[
  {routes:createPrivateWorkspaceRoutes({workspace}),bodyLimit:privateWorkspaceBodyLimit},
  {routes:createPrivateUpdateRoutes({ledger}),bodyLimit:privateUpdateBodyLimit},
  {routes:createPrivateDocumentRoutes({documents}),bodyLimit:privateDocumentBodyLimit},
 ];
 return Object.freeze({workspace,documents,ledger,routeSets});
}

/**
 * Splits one listening server's WebSocket upgrades between the public and the
 * private hubs by exact path prefix, so each hub keeps sole ownership of its
 * own upgrade namespace (the private hub refuses a shared upgrade listener).
 */
export function routeUpgrades(server){
 if(!server?.on||!server?.off)throw Error('Server required');
 const facade=()=>{const emitter=new EventEmitter();return {on:(...a)=>emitter.on(...a),off:(...a)=>emitter.off(...a),listenerCount:n=>emitter.listenerCount(n),emitter};};
 const publicServer=facade(),privateServer=facade();
 const onUpgrade=(req,socket,head)=>{
  const target=typeof req.url==='string'&&req.url.startsWith('/ws/private/')?privateServer:publicServer;
  if(!target.emitter.emit('upgrade',req,socket,head)){
   socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');socket.destroy();
  }
 };
 server.on('upgrade',onUpgrade);
 return {publicServer,privateServer,close(){server.off('upgrade',onUpgrade);}};
}

export function attachPrivateWorkspaceHub({server,origin,services,transport='tls'}){
 return attachPrivateCollaborationHub({server,origin,ledger:services.ledger,transport});
}
