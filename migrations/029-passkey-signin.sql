-- First-party passkey sign-in: discoverable WebAuthn credentials act as the
-- identity provider when no external OIDC provider is configured. Only public
-- keys, counters and one-use challenge digests are stored.
CREATE TABLE dge_identity.signin_challenges (
  challenge_digest char(64) PRIMARY KEY,
  browser_digest char(64) NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('register','authenticate')),
  user_handle text CHECK (user_handle IS NULL OR user_handle ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at timestamptz NOT NULL,
  CHECK ((purpose='register') = (user_handle IS NOT NULL))
);
CREATE INDEX signin_challenges_expiry ON dge_identity.signin_challenges(expires_at);
CREATE TABLE dge_identity.signin_credentials (
  credential_id text PRIMARY KEY CHECK (credential_id ~ '^[A-Za-z0-9_-]+$' AND char_length(credential_id) BETWEEN 16 AND 1366),
  account_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  user_handle text NOT NULL CHECK (user_handle ~ '^[A-Za-z0-9_-]{43}$'),
  public_key text NOT NULL CHECK (char_length(public_key) <= 4096),
  counter bigint NOT NULL CHECK (counter >= 0),
  transports text[] NOT NULL DEFAULT '{}',
  backed_up boolean NOT NULL,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX signin_credentials_account ON dge_identity.signin_credentials(account_id);
ALTER TABLE dge_identity.signin_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE dge_identity.signin_challenges FORCE ROW LEVEL SECURITY;
ALTER TABLE dge_identity.signin_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE dge_identity.signin_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY signin_worker ON dge_identity.signin_challenges TO dge_identity_runtime
  USING (current_setting('dge.worker',true)='signin') WITH CHECK (current_setting('dge.worker',true)='signin');
CREATE POLICY signin_worker ON dge_identity.signin_credentials TO dge_identity_runtime
  USING (current_setting('dge.worker',true)='signin') WITH CHECK (current_setting('dge.worker',true)='signin');
CREATE POLICY own_credentials ON dge_identity.signin_credentials FOR SELECT TO dge_identity_runtime
  USING (account_id::text=current_setting('dge.account_id',true));
GRANT SELECT, INSERT, DELETE ON dge_identity.signin_challenges TO dge_identity_runtime;
GRANT SELECT, INSERT ON dge_identity.signin_credentials TO dge_identity_runtime;
GRANT UPDATE (counter, last_used_at, revoked_at) ON dge_identity.signin_credentials TO dge_identity_runtime;
