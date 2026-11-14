import {WebSocketServer,WebSocket} from 'ws';
import {requestCookies} from './account-http.mjs';

/**
 * Optional dedicated TLS 1.3 transport for ciphertext-only Yjs frames.
 * No MLS key exchange or document plaintext is present here.
 * Requires a separately provisioned ledger with trusted device authorization.
 * Do not install on the public collaboration server: that server already owns
 * its upgrade routing. Attach to a dedicated private service when reviewed.
 */
const UUID='[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
const PATH=new RegExp('^/ws/private/('+UUID+')/('+UUID+')/('+UUID+')$');
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const MAX_INBOUND=65536,MAX_BUFFERED=1048576;
const decode=new TextDecoder('utf-8',{fatal:true});

function credentials(cookie,origin) {
 if(typeof cookie!=='string'||cookie.length>8192)throw Error('Invalid private session cookie');
 const selected=requestCookies(cookie);
 const csrf=cookie.split(';').map(item=>item.trim())
  .filter(item=>item.startsWith('__Host-dge_csrf='));
 if(csrf.length!==1)throw Error('Invalid private session CSRF cookie');
 const value=csrf[0].slice('__Host-dge_csrf='.length);
 if(!TOKEN.test(value)||!selected.get('__Host-dge_session'))throw Error('Invalid private session');
 return {sessionToken:selected.get('__Host-dge_session'),csrfToken:value,origin};
}
function record(value,fields) {
 if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).sort().join(',')!==fields.slice().sort().join(','))
  throw Error('Invalid private socket message');
}
function send(ws,payload) {
 if(ws.readyState!==WebSocket.OPEN||ws.bufferedAmount>MAX_BUFFERED)
  throw Error('Private connection is unavailable or backpressured');
 const encoded=JSON.stringify(payload);
 if(Buffer.byteLength(encoded)>MAX_BUFFERED)throw Error('Private response is too large');
 ws.send(encoded,{binary:false});
}
function reject(socket,status=403) {
 if(socket.destroyed)return;
 socket.end('HTTP/1.1 '+status+' Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
 socket.destroy();
}
function disconnect(ws,code=1008) {
 if(ws.readyState===WebSocket.OPEN)ws.close(code,'Private collaboration access changed');
 else ws.terminate();
}

/**
 * The ledger must reauthenticate + reauthorize each read/append, including
 * membership revocation and current cryptographic epoch. No authorization is
 * inferred solely from a user-provided deviceId or envelope metadata.
 */
export function attachPrivateCollaborationHub({
 server,origin,ledger,maxRooms=32,maxClientsPerRoom=12,maxPending=16,transport='tls'
}={}) {
 if(!server?.on||!server?.off||typeof server.listenerCount!=='function'||
    server.listenerCount('upgrade')!==0||
    typeof ledger?.append!=='function'||typeof ledger?.list!=='function'||
    ![maxRooms,maxClientsPerRoom,maxPending].every(n=>Number.isSafeInteger(n)&&n>=1&&n<=100)||
    !['tls','edge-tls'].includes(transport))
  throw Error('Dedicated TLS server and verified private update ledger required');
 const site=new URL(origin);
 if(site.protocol!=='https:'||site.origin!==origin)throw Error('Exact private HTTPS origin required');
 const expectedHost=site.host,rooms=new Map();
 const sockets=new WebSocketServer({noServer:true,perMessageDeflate:false,
  maxPayload:MAX_INBOUND,handleProtocols:protocols=>protocols.has('dge-private-v1')?'dge-private-v1':false});
 let stopped=false;
 function endRoom(room) {
  if(room.closed)return;
  room.closed=true;
  for(const client of room.clients)disconnect(client.ws,1012);
  room.clients.clear();
  if(rooms.get(room.key)===room)rooms.delete(room.key);
 }
 async function pull(room,client,after,limit) {
  const page=await ledger.list(client.credentials,room.tenantId,room.documentId,{
   recipientDeviceId:client.deviceId,after,limit
  });
  return {kind:'updates',keyEpoch:page.keyEpoch,nextCursor:page.nextCursor,
   items:page.items.map(({position,...frame})=>({position,frame}))};
 }
 async function handle(room,client,message,isBinary) {
  if(stopped||room.closed||isBinary||message.length<2||message.length>MAX_INBOUND)
   throw Error('Invalid private update frame transport');
  let parsed;
  try{parsed=JSON.parse(decode.decode(message));}
  catch{throw Error('Invalid private socket JSON');}
  if(parsed?.kind==='pull') {
   record(parsed,['kind','after','limit']);
   if(!Number.isSafeInteger(parsed.after)||parsed.after<0||
      parsed.after>1000000||!Number.isSafeInteger(parsed.limit)||
      parsed.limit<1||parsed.limit>10)throw Error('Invalid private pull page');
   send(client.ws,await pull(room,client,parsed.after,parsed.limit));
   return;
  }
  record(parsed,['kind','frame']);
  if(parsed.kind!=='update'||!parsed.frame||typeof parsed.frame!=='object'||
     parsed.frame.senderDeviceId!==client.deviceId)
   throw Error('Private sender device mismatch');
  // Append and current-epoch access happen in one authenticated DB transaction.
  const saved=await ledger.append(client.credentials,room.tenantId,room.documentId,parsed.frame);
  send(client.ws,{kind:'ack',position:saved.frame.position,replayed:saved.replayed});
  if(saved.replayed)return;
  // Every recipient is reauthorized BEFORE delivery, including after removals.
  for(const receiver of [...room.clients]) {
   if(receiver===client||receiver.ws.readyState!==WebSocket.OPEN)continue;
   try{
    const page=await pull(room,receiver,saved.frame.position-1,1);
    const delivered=page.items.find(item=>item.position===saved.frame.position);
    if(delivered)send(receiver.ws,{kind:'update',...delivered});
   }catch{room.clients.delete(receiver);disconnect(receiver.ws);}
  }
 }
 async function onUpgrade(req,socket,head) {
  try {
   // 'edge-tls' is the declared managed-edge boundary of createEdgeServer: the
   // platform edge terminated public TLS and forwarded over its private network.
   const secure=transport==='tls'?req.socket.encrypted&&req.socket.getProtocol?.()==='TLSv1.3':
    !req.socket.encrypted&&req.headers['x-forwarded-proto']==='https';
   if(stopped||!secure||
      req.headers.host!==expectedHost||req.headers.origin!==origin||
      req.headers['sec-websocket-protocol']!=='dge-private-v1'||
      typeof req.url!=='string'||req.url.length>300||req.url.includes('?')||
      req.url.includes('\\'))return reject(socket);
   const match=req.url.match(PATH);
   if(!match)return reject(socket,404);
   const [,tenantId,documentId,deviceId]=match;
   const actor=credentials(req.headers.cookie??'',origin);
   const first=await ledger.list(actor,tenantId,documentId,{
    recipientDeviceId:deviceId,after:0,limit:1
   });
   if(stopped||socket.destroyed)return reject(socket);
   const key=tenantId+'/'+documentId;
   let room=rooms.get(key);
   if(!room){
    if(rooms.size>=maxRooms)return reject(socket,503);
    room={key,tenantId,documentId,clients:new Set(),
     pending:0,chain:Promise.resolve(),closed:false};
    rooms.set(key,room);
   }
   if(room.closed||room.clients.size>=maxClientsPerRoom)return reject(socket,503);
   sockets.handleUpgrade(req,socket,head,ws=>{
    if(stopped||room.closed){ws.terminate();return;}
    const client={ws,credentials:actor,deviceId};
    room.clients.add(client);
    ws.on('message',(data,isBinary)=>{
     if(room.pending>=maxPending||stopped||room.closed){
      room.clients.delete(client);disconnect(ws,1013);return;
     }
     room.pending++;
     room.chain=room.chain.then(async()=>{
      if(ws.readyState===WebSocket.OPEN)await handle(room,client,data,isBinary);
     }).catch(()=>{
      room.clients.delete(client);disconnect(ws);
     }).finally(()=>{room.pending--;});
    });
    ws.on('close',()=>{
     room.clients.delete(client);
     if(!room.clients.size)endRoom(room);
    });
    ws.on('error',()=>{});
    try{send(ws,{kind:'ready',keyEpoch:first.keyEpoch});}
    catch{disconnect(ws,1011);}
   });
  }catch{reject(socket);}
 }
 server.on('upgrade',onUpgrade);
 return Object.freeze({
  close(){
   if(stopped)return;
   stopped=true;server.off('upgrade',onUpgrade);
   for(const room of [...rooms.values()])endRoom(room);
   sockets.close();
  },
  stats(){return {rooms:rooms.size,connections:[...rooms.values()].reduce((n,room)=>n+room.clients.size,0)};}
 });
}
