// Grants or revokes platform administration. Runs only with the migration
// credential (MIGRATION_DATABASE_URL); there is deliberately no HTTP route.
// Usage: node scripts/grant-platform-admin.mjs grant|revoke <account-uuid> "<reason>"
import {randomUUID} from "node:crypto";
import {pathToFileURL} from "node:url";
import pg from "pg";
import {pgTransactions} from "../server/identity-store.mjs";

const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export async function changePlatformAdmin(transaction,{action,accountId,reason,clock=Date.now}){
  if(!['grant','revoke'].includes(action)||!UUID.test(accountId??'')||typeof reason!=='string'||reason.trim()!==reason||reason.length<1||reason.length>500)
    throw Error('Usage: grant|revoke <account-uuid> <reason>');
  return transaction(async db=>{
    const at=new Date(clock());
    const account=(await db.query("SELECT 1 FROM dge_identity.accounts WHERE id=$1 AND status='active'",[accountId])).rows[0];
    if(!account)throw Error('Active account not found');
    const changed=action==='grant'
      ?(await db.query(`INSERT INTO dge_settings.platform_admins(account_id,granted_at,granted_reason) VALUES($1,$2,$3)
          ON CONFLICT (account_id) DO UPDATE SET granted_at=$2,granted_reason=$3,revoked_at=NULL,revoked_reason=NULL
          WHERE dge_settings.platform_admins.revoked_at IS NOT NULL RETURNING account_id`,[accountId,at,reason])).rows.length
      :(await db.query("UPDATE dge_settings.platform_admins SET revoked_at=$2,revoked_reason=$3 WHERE account_id=$1 AND revoked_at IS NULL RETURNING account_id",[accountId,at,reason])).rows.length;
    if(changed)await db.query("INSERT INTO dge_settings.platform_admin_events(id,account_id,kind,reason,occurred_at) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(),accountId,action==='grant'?'granted':'revoked',reason,at]);
    return {changed:changed===1};
  });
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  let pool;
  try{
    const raw=process.env.MIGRATION_DATABASE_URL;
    if(!raw)throw Error('Migration credential required');
    const url=new URL(raw);
    if(!['postgres:','postgresql:'].includes(url.protocol))throw Error('Invalid migration configuration');
    for(const name of ['sslmode','sslcert','sslkey','sslrootcert'])url.searchParams.delete(name);
    pool=new pg.Pool({connectionString:url.href,max:1,connectionTimeoutMillis:10000,ssl:{rejectUnauthorized:true,minVersion:'TLSv1.3',servername:url.hostname}});
    const [action,accountId,reason]=process.argv.slice(2);
    const {changed}=await changePlatformAdmin(pgTransactions(pool),{action,accountId,reason});
    console.log(changed?'Platform administrator '+(action==='grant'?'granted':'revoked')+'.':'No change: the account was already in that state.');
  }catch(error){
    console.error(error.message.startsWith('Usage:')||error.message.endsWith('not found')||error.message.endsWith('required')?error.message:
      'Platform administrator change failed; the transaction rolled back. No credential details were logged.');
    process.exitCode=1;
  }finally{await pool?.end();}
}
