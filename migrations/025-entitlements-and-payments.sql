-- DCE-029/030: entitlements independent of payment providers, an append-only
-- credit ledger, document-creation reservations and provider reconciliation
-- records. Quantities are whole units and money is integer minor units.
-- Subject rows belong to exactly one account or one workspace. Requests see
-- their workspace (dge.tenant_id) and their own account (dge.account_id).
-- Verified webhook processing and reconciliation declare dge.worker='billing'
-- after provider signature verification; no request handler sets it otherwise.
-- Card data, provider secrets and raw webhook bodies are never stored.
CREATE SCHEMA dge_billing;
REVOKE ALL ON SCHEMA dge_billing FROM PUBLIC;
GRANT USAGE ON SCHEMA dge_billing TO dge_identity_runtime;

CREATE TABLE dge_billing.grants (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES dge_identity.tenants(id),
  account_id uuid REFERENCES dge_identity.accounts(id),
  resource text NOT NULL CHECK (resource IN ('document-create','storage-bytes','seats')),
  quantity integer CHECK (quantity IS NULL OR quantity BETWEEN 0 AND 1000000000),
  period text NOT NULL CHECK (period IN ('none','week','month','year')),
  effective_at timestamptz NOT NULL,
  expires_at timestamptz,
  provenance text NOT NULL CHECK (provenance IN ('subscription','single-document','credit-pack','administrator','verified-official','enterprise-license')),
  provenance_ref text CHECK (provenance_ref IS NULL OR length(provenance_ref) BETWEEN 1 AND 200),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_by uuid REFERENCES dge_identity.accounts(id),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IS NULL OR length(revoked_reason) BETWEEN 1 AND 500),
  CHECK (num_nonnulls(tenant_id,account_id)=1),
  CHECK (expires_at IS NULL OR expires_at>effective_at),
  CHECK ((revoked_at IS NULL)=(revoked_reason IS NULL)),
  -- Purchased credits are counted in the ledger; the grant is their provenance.
  CHECK (provenance NOT IN ('single-document','credit-pack') OR (quantity IS NOT NULL AND period='none'))
);
CREATE INDEX billing_grants_account ON dge_billing.grants(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX billing_grants_tenant ON dge_billing.grants(tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX billing_grants_reference ON dge_billing.grants(provenance_ref) WHERE provenance_ref IS NOT NULL;

-- Current credit balance per subject. Never negative; changed only together
-- with an append-only ledger entry in the same transaction.
CREATE TABLE dge_billing.balances (
  subject text PRIMARY KEY CHECK (subject ~ '^(account|tenant):[0-9a-f-]{36}$'),
  tenant_id uuid REFERENCES dge_identity.tenants(id),
  account_id uuid REFERENCES dge_identity.accounts(id),
  credits integer NOT NULL DEFAULT 0 CHECK (credits>=0),
  updated_at timestamptz NOT NULL,
  CHECK (num_nonnulls(tenant_id,account_id)=1),
  CHECK (subject=CASE WHEN tenant_id IS NULL THEN 'account:'||account_id ELSE 'tenant:'||tenant_id END)
);
CREATE TABLE dge_billing.credit_ledger (
  id uuid PRIMARY KEY,
  tenant_id uuid REFERENCES dge_identity.tenants(id),
  account_id uuid REFERENCES dge_identity.accounts(id),
  grant_id uuid REFERENCES dge_billing.grants(id),
  kind text NOT NULL CHECK (kind IN ('purchase','reserve','refund','revoke')),
  delta integer NOT NULL CHECK (delta<>0),
  balance_after integer NOT NULL CHECK (balance_after>=0),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  reason text CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL,
  CHECK (num_nonnulls(tenant_id,account_id)=1),
  CHECK ((kind IN ('purchase','refund'))=(delta>0))
);
CREATE INDEX billing_ledger_grant ON dge_billing.credit_ledger(grant_id) WHERE grant_id IS NOT NULL;

-- One reservation per created document. A refund is a separate row whose
-- primary key makes it happen at most once.
CREATE TABLE dge_billing.usage (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES dge_identity.tenants(id),
  account_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  document_id uuid NOT NULL,
  command_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('weekly-allowance','grants','credits')),
  grant_id uuid REFERENCES dge_billing.grants(id),
  credit_entry_id uuid REFERENCES dge_billing.credit_ledger(id),
  reserved_at timestamptz NOT NULL,
  UNIQUE (tenant_id,document_id),
  UNIQUE (tenant_id,command_id),
  FOREIGN KEY (tenant_id,document_id) REFERENCES dge_documents.documents(tenant_id,id),
  CHECK ((source='grants')=(grant_id IS NOT NULL)),
  CHECK ((source='credits')=(credit_entry_id IS NOT NULL))
);
CREATE INDEX billing_usage_account ON dge_billing.usage(account_id,reserved_at);
CREATE INDEX billing_usage_grant ON dge_billing.usage(grant_id,reserved_at) WHERE grant_id IS NOT NULL;
CREATE TABLE dge_billing.usage_refunds (
  usage_id uuid PRIMARY KEY REFERENCES dge_billing.usage(id),
  tenant_id uuid NOT NULL REFERENCES dge_identity.tenants(id),
  account_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  actor_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  credit_entry_id uuid REFERENCES dge_billing.credit_ledger(id),
  refunded_at timestamptz NOT NULL
);

CREATE TABLE dge_billing.checkouts (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9-]{1,30}$'),
  tenant_id uuid REFERENCES dge_identity.tenants(id),
  account_id uuid REFERENCES dge_identity.accounts(id),
  created_by uuid NOT NULL REFERENCES dge_identity.accounts(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  request_digest char(64) NOT NULL,
  item jsonb NOT NULL CHECK (jsonb_typeof(item)='object'),
  amount_minor bigint NOT NULL CHECK (amount_minor>0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  livemode boolean,
  status text NOT NULL CHECK (status IN ('creating','open','invoice-requested','completed','mismatch')),
  provider_session_id text UNIQUE CHECK (provider_session_id IS NULL OR length(provider_session_id) BETWEEN 1 AND 200),
  checkout_url text CHECK (checkout_url IS NULL OR checkout_url ~ '^https://'),
  payment_reference text CHECK (payment_reference IS NULL OR length(payment_reference) BETWEEN 1 AND 200),
  subscription_reference text CHECK (subscription_reference IS NULL OR length(subscription_reference) BETWEEN 1 AND 200),
  refunded_minor bigint NOT NULL DEFAULT 0 CHECK (refunded_minor>=0 AND refunded_minor<=amount_minor),
  disputed_at timestamptz,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (created_by,idempotency_key),
  CHECK (num_nonnulls(tenant_id,account_id)=1)
);
-- Provider object identifiers (payment intent, subscription, invoice, charge)
-- that resolve to one checkout.
CREATE TABLE dge_billing.provider_links (
  provider text NOT NULL,
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 200),
  checkout_id uuid NOT NULL REFERENCES dge_billing.checkouts(id),
  tenant_id uuid REFERENCES dge_identity.tenants(id),
  account_id uuid REFERENCES dge_identity.accounts(id),
  PRIMARY KEY (provider,reference),
  CHECK (num_nonnulls(tenant_id,account_id)=1)
);
CREATE TABLE dge_billing.subscriptions (
  provider text NOT NULL,
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 200),
  checkout_id uuid NOT NULL REFERENCES dge_billing.checkouts(id),
  tenant_id uuid REFERENCES dge_identity.tenants(id),
  account_id uuid REFERENCES dge_identity.accounts(id),
  status text NOT NULL CHECK (status ~ '^[a-z_]{1,40}$'),
  current_period_end timestamptz,
  status_event_at timestamptz NOT NULL,
  canceled_at timestamptz,
  PRIMARY KEY (provider,reference),
  CHECK (num_nonnulls(tenant_id,account_id)=1)
);
-- Every verified provider event, by provider event ID. `refs` holds only the
-- normalized identifiers and integer amounts needed to process or retry it.
CREATE TABLE dge_billing.webhook_events (
  provider text NOT NULL,
  event_id text NOT NULL CHECK (length(event_id) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
  event_created timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('processed','ignored','pending-link','stale','mismatch')),
  refs jsonb NOT NULL CHECK (jsonb_typeof(refs)='object'),
  processed_at timestamptz,
  PRIMARY KEY (provider,event_id)
);
CREATE INDEX billing_events_pending ON dge_billing.webhook_events(provider,event_created) WHERE outcome='pending-link';

CREATE FUNCTION dge_billing.reject_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Append-only billing record';
END $$;
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['credit_ledger','usage','usage_refunds','provider_links'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON dge_billing.%I FOR EACH ROW EXECUTE FUNCTION dge_billing.reject_rewrite()',target);
  END LOOP;
END $$;
-- A grant only ever gains a revocation; nothing else changes after insert.
CREATE FUNCTION dge_billing.guard_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR
     (to_jsonb(NEW)-'revoked_at'-'revoked_reason')<>(to_jsonb(OLD)-'revoked_at'-'revoked_reason') THEN
    RAISE EXCEPTION 'Grants are append-only except for one revocation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_grant BEFORE UPDATE OR DELETE ON dge_billing.grants FOR EACH ROW EXECUTE FUNCTION dge_billing.guard_grant();
CREATE FUNCTION dge_billing.guard_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR OLD.outcome<>'pending-link' OR NEW.provider<>OLD.provider OR NEW.event_id<>OLD.event_id OR
     NEW.event_type<>OLD.event_type OR NEW.event_created<>OLD.event_created OR NEW.refs<>OLD.refs THEN
    RAISE EXCEPTION 'A provider event only leaves the pending-link state once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_event BEFORE UPDATE OR DELETE ON dge_billing.webhook_events FOR EACH ROW EXECUTE FUNCTION dge_billing.guard_event();

DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['grants','balances','credit_ledger','usage','usage_refunds','checkouts','provider_links','subscriptions'] LOOP
    EXECUTE format('ALTER TABLE dge_billing.%I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('ALTER TABLE dge_billing.%I FORCE ROW LEVEL SECURITY',target);
    EXECUTE format('CREATE POLICY subject_scope ON dge_billing.%I TO dge_identity_runtime USING (tenant_id::text=current_setting(''dge.tenant_id'',true) OR account_id::text=current_setting(''dge.account_id'',true) OR current_setting(''dge.worker'',true)=''billing'') WITH CHECK (tenant_id::text=current_setting(''dge.tenant_id'',true) OR account_id::text=current_setting(''dge.account_id'',true) OR current_setting(''dge.worker'',true)=''billing'')',target);
  END LOOP;
END $$;
ALTER TABLE dge_billing.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dge_billing.webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_worker ON dge_billing.webhook_events TO dge_identity_runtime
  USING (current_setting('dge.worker',true)='billing') WITH CHECK (current_setting('dge.worker',true)='billing');

GRANT SELECT,INSERT ON dge_billing.grants,dge_billing.credit_ledger,dge_billing.usage,dge_billing.usage_refunds,
  dge_billing.provider_links,dge_billing.webhook_events TO dge_identity_runtime;
GRANT UPDATE (revoked_at,revoked_reason) ON dge_billing.grants TO dge_identity_runtime;
GRANT SELECT,INSERT ON dge_billing.balances,dge_billing.checkouts,dge_billing.subscriptions TO dge_identity_runtime;
GRANT UPDATE (credits,updated_at) ON dge_billing.balances TO dge_identity_runtime;
GRANT UPDATE (status,provider_session_id,checkout_url,livemode,payment_reference,subscription_reference,refunded_minor,disputed_at,completed_at)
  ON dge_billing.checkouts TO dge_identity_runtime;
GRANT UPDATE (status,current_period_end,status_event_at,canceled_at) ON dge_billing.subscriptions TO dge_identity_runtime;
GRANT UPDATE (outcome,processed_at) ON dge_billing.webhook_events TO dge_identity_runtime;
