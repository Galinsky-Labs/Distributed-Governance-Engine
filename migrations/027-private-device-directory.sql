-- Private workspaces: public MLS device material, opaque group metadata and an
-- ordered per-group handshake mailbox. Nothing here is plaintext document
-- content, a private key, an exported epoch secret or a Yjs update.

-- One immutable MLS signature key per step-up authorized device. A changed key
-- is a different authorized device, never an in-place replacement, so clients
-- can always surface the change as a new device requiring re-approval.
CREATE TABLE dge_private.device_keys (
 device_id uuid PRIMARY KEY REFERENCES dge_identity.authorized_devices(id),
 account_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
 identity bytea NOT NULL UNIQUE CHECK(octet_length(identity) BETWEEN 1 AND 512),
 signature_key bytea NOT NULL UNIQUE CHECK(octet_length(signature_key)=32),
 published_at timestamptz NOT NULL
);
CREATE INDEX device_keys_account ON dge_private.device_keys(account_id,published_at);

-- Single-use RFC 9420 key packages (public). Consumption is atomic and final.
CREATE TABLE dge_private.key_packages (
 id uuid PRIMARY KEY,
 device_id uuid NOT NULL REFERENCES dge_private.device_keys(device_id),
 package bytea NOT NULL CHECK(octet_length(package) BETWEEN 1 AND 65536),
 package_digest char(64) NOT NULL UNIQUE CHECK(package_digest ~ '^[a-f0-9]{64}$'),
 published_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 consumed_tenant_id uuid,
 consumed_by uuid,
 CHECK(expires_at>published_at),
 CHECK((consumed_at IS NULL AND consumed_tenant_id IS NULL AND consumed_by IS NULL) OR
       (consumed_at IS NOT NULL AND consumed_tenant_id IS NOT NULL AND consumed_by IS NOT NULL))
);
CREATE INDEX key_packages_available ON dge_private.key_packages(device_id,published_at) WHERE consumed_at IS NULL;

CREATE FUNCTION dge_private.guard_key_package() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL OR NEW.id<>OLD.id OR
    NEW.device_id<>OLD.device_id OR NEW.package<>OLD.package OR
    NEW.package_digest<>OLD.package_digest OR NEW.published_at<>OLD.published_at OR
    NEW.expires_at<>OLD.expires_at THEN
  RAISE EXCEPTION 'Key packages are single-use and immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_key_package BEFORE UPDATE ON dge_private.key_packages
 FOR EACH ROW EXECUTE FUNCTION dge_private.guard_key_package();

-- Opaque MLS group binding for one private document. The epoch is the
-- service's ordering counter for accepted commits, not a key.
CREATE TABLE dge_private.groups (
 tenant_id uuid NOT NULL REFERENCES dge_identity.tenants(id),
 document_id uuid NOT NULL UNIQUE,
 group_id bytea NOT NULL UNIQUE CHECK(octet_length(group_id)=32),
 epoch integer NOT NULL CHECK(epoch BETWEEN 0 AND 1000000),
 created_by uuid NOT NULL REFERENCES dge_identity.accounts(id),
 creator_device_id uuid NOT NULL REFERENCES dge_private.device_keys(device_id),
 created_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,document_id)
);
CREATE FUNCTION dge_private.guard_group() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.document_id<>OLD.document_id OR
    NEW.group_id<>OLD.group_id OR NEW.created_by<>OLD.created_by OR
    NEW.creator_device_id<>OLD.creator_device_id OR NEW.created_at<>OLD.created_at OR
    NEW.epoch<>OLD.epoch+1 THEN
  RAISE EXCEPTION 'Invalid private group transition';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_group BEFORE UPDATE ON dge_private.groups
 FOR EACH ROW EXECUTE FUNCTION dge_private.guard_group();

CREATE TABLE dge_private.group_members (
 tenant_id uuid NOT NULL,
 document_id uuid NOT NULL,
 device_id uuid NOT NULL REFERENCES dge_private.device_keys(device_id),
 account_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
 added_epoch integer NOT NULL CHECK(added_epoch BETWEEN 0 AND 1000000),
 removed_epoch integer CHECK(removed_epoch IS NULL OR removed_epoch>added_epoch),
 PRIMARY KEY(tenant_id,document_id,device_id),
 FOREIGN KEY(tenant_id,document_id) REFERENCES dge_private.groups(tenant_id,document_id)
);

-- Ordered, append-only handshake mailbox: MLS Commit and Welcome bytes only.
CREATE TABLE dge_private.group_messages (
 tenant_id uuid NOT NULL,
 document_id uuid NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 1 AND 1000000),
 kind text NOT NULL CHECK(kind IN ('commit','welcome')),
 epoch integer NOT NULL CHECK(epoch BETWEEN 0 AND 1000000),
 sender_device_id uuid NOT NULL,
 recipient_device_id uuid,
 roster uuid[] NOT NULL CHECK(cardinality(roster) BETWEEN 1 AND 1000),
 payload bytea NOT NULL CHECK(octet_length(payload) BETWEEN 1 AND 2000000),
 digest char(64) NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 command_id uuid NOT NULL,
 request_digest char(64) NOT NULL,
 actor_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
 created_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,document_id,position),
 UNIQUE(tenant_id,command_id,kind),
 FOREIGN KEY(tenant_id,document_id) REFERENCES dge_private.groups(tenant_id,document_id),
 CHECK((kind='commit' AND recipient_device_id IS NULL) OR (kind='welcome' AND recipient_device_id IS NOT NULL))
);
CREATE UNIQUE INDEX group_messages_one_commit_per_epoch
 ON dge_private.group_messages(tenant_id,document_id,epoch) WHERE kind='commit';

DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['groups','group_members','group_messages'] LOOP
  EXECUTE format('ALTER TABLE dge_private.%I ENABLE ROW LEVEL SECURITY',target);
  EXECUTE format('ALTER TABLE dge_private.%I FORCE ROW LEVEL SECURITY',target);
  EXECUTE format('CREATE POLICY private_tenant_select ON dge_private.%I FOR SELECT TO dge_identity_runtime USING(tenant_id::text=current_setting(''dge.tenant_id'',true))',target);
  EXECUTE format('CREATE POLICY private_tenant_insert ON dge_private.%I FOR INSERT TO dge_identity_runtime WITH CHECK(tenant_id::text=current_setting(''dge.tenant_id'',true))',target);
 END LOOP;
END $$;
CREATE POLICY private_group_update ON dge_private.groups FOR UPDATE TO dge_identity_runtime
 USING(tenant_id::text=current_setting('dge.tenant_id',true))
 WITH CHECK(tenant_id::text=current_setting('dge.tenant_id',true));
CREATE POLICY private_member_update ON dge_private.group_members FOR UPDATE TO dge_identity_runtime
 USING(tenant_id::text=current_setting('dge.tenant_id',true))
 WITH CHECK(tenant_id::text=current_setting('dge.tenant_id',true));

GRANT SELECT,INSERT ON dge_private.device_keys TO dge_identity_runtime;
GRANT SELECT,INSERT,UPDATE ON dge_private.key_packages TO dge_identity_runtime;
GRANT SELECT,INSERT,UPDATE ON dge_private.groups,dge_private.group_members TO dge_identity_runtime;
GRANT SELECT,INSERT ON dge_private.group_messages TO dge_identity_runtime;
-- Deliberately no DELETE grants: device keys, consumed packages and the
-- handshake history are append-only evidence of who was admitted when.
