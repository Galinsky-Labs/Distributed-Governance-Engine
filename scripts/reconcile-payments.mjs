// Read-only payment reconciliation: compares provider state with the local
// entitlement ledger and prints a JSON report of differences (identifiers and
// integer amounts only). It changes neither side; an operator decides fixes.
// Usage: node scripts/reconcile-payments.mjs stripe|manual [limit]
// Uses the ordinary request credential (DATABASE_URL) in billing-worker mode.
import pg from "pg";
import {pgTransactions} from "../server/identity-store.mjs";
import {reconcilePayments} from "../server/billing-store.mjs";
import {stripeProviderFromEnvironment} from "../server/payment-providers/stripe.mjs";
import {manualProviderFromEnvironment} from "../server/payment-providers/manual.mjs";

let pool;
try{
  const [providerId='stripe',limitText='200']=process.argv.slice(2);
  const providers={stripe:()=>stripeProviderFromEnvironment(),manual:()=>manualProviderFromEnvironment()};
  if(!Object.hasOwn(providers,providerId)||!/^[0-9]{1,4}$/.test(limitText))throw Error('Usage: reconcile-payments.mjs stripe|manual [limit]');
  const raw=process.env.DATABASE_URL;
  if(!raw)throw Error('Database configuration required');
  const url=new URL(raw);
  if(!['postgres:','postgresql:'].includes(url.protocol))throw Error('Invalid database configuration');
  for(const name of ['sslmode','sslcert','sslkey','sslrootcert'])url.searchParams.delete(name);
  pool=new pg.Pool({connectionString:url.href,max:1,connectionTimeoutMillis:10000,statement_timeout:10000,
    ssl:{rejectUnauthorized:true,minVersion:'TLSv1.3',servername:url.hostname}});
  pool.on('error',()=>{});
  const provider=providers[providerId]();
  if(!provider.available)throw Error('Provider '+providerId+' is not configured; nothing to reconcile');
  const report=await reconcilePayments({transaction:pgTransactions(pool),provider,limit:Number(limitText)});
  console.log(JSON.stringify(report,null,2));
  if(report.differences.length||report.pendingEvents)process.exitCode=2;
}catch(error){
  console.error(/^(Usage|Database|Invalid database|Provider )/.test(error.message)?error.message:
    'Reconciliation failed. Check database and provider configuration; no credential details were logged.');
  process.exitCode=1;
}finally{await pool?.end();}
