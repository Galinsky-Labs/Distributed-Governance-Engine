import { AccessError } from "./identity-store.mjs";

/**
 * Account-scoped transaction for rows owned by one signed-in account rather
 * than one workspace. The identity store validates the session; the operation
 * then runs with dge.account_id set, which the dge_notifications row policies
 * and the membership read policy require. Writes additionally rely on the
 * HTTP layer's write() guard (exact Origin and the x-dge-csrf header), because
 * identity-store exposes CSRF digest verification only through withTenant.
 * Recovery-restricted sessions may read but never write.
 */
export function createAccountScope({ identity, transaction }) {
  if (typeof identity?.sessionInfo !== "function" || typeof transaction !== "function")
    throw Error("Account scope requires the identity store and a transaction runner");
  return async (credentials, { write = false } = {}, operation) => {
    const session = await identity.sessionInfo(credentials?.sessionToken);
    if (write && session.recoveryRestricted) throw new AccessError("RECOVERY_SESSION_RESTRICTED");
    return transaction(async (db) => {
      await db.query("SELECT set_config('dge.account_id',$1,true)", [session.accountId]);
      return operation(db, session.accountId);
    });
  };
}

/** Run with dge.account_id bound to an account proven by a signed token, not a session. */
export const asAccount = (transaction, accountId, operation) => transaction(async (db) => {
  await db.query("SELECT set_config('dge.account_id',$1,true)", [accountId]);
  return operation(db);
});
