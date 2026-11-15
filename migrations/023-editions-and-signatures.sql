-- DCE-019/026/027: immutable final editions, signing intents, append-only
-- signature records and Merkle signature manifests.
-- Public-safe data (digests, opted-in names/marks, counts, manifests) and
-- tenant-private evidence (account links, private marks, intents, signatory
-- order) live in separate tables so row policies alone decide disclosure.
CREATE SCHEMA dge_editions;
REVOKE ALL ON SCHEMA dge_editions FROM PUBLIC;
GRANT USAGE ON SCHEMA dge_editions TO dge_identity_runtime;

CREATE TABLE dge_editions.editions (
  tenant_id uuid NOT NULL REFERENCES dge_identity.tenants(id),
  id uuid NOT NULL UNIQUE,
  document_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 1000),
  kind text NOT NULL CHECK (kind IN ('adopted','final','consultation-source')),
  lifecycle text NOT NULL CHECK (lifecycle IN ('adopted','published')),
  source_version integer NOT NULL,
  source_digest char(64) NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  document jsonb NOT NULL,
  edition_digest char(64) NOT NULL CHECK (edition_digest ~ '^[a-f0-9]{64}$'),
  artifact_sha256 char(64) CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_media_type text CHECK (artifact_media_type ~ '^[a-z]+/[a-z0-9.+-]{1,80}$'),
  decision_id uuid,
  certificate_digest char(64) CHECK (certificate_digest ~ '^[a-f0-9]{64}$'),
  record jsonb NOT NULL,
  record_digest char(64) NOT NULL UNIQUE CHECK (record_digest ~ '^[a-f0-9]{64}$'),
  command_id uuid NOT NULL,
  request_digest char(64) NOT NULL,
  created_by uuid NOT NULL REFERENCES dge_identity.accounts(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,document_id,sequence),
  UNIQUE (tenant_id,document_id,source_version,kind),
  UNIQUE (tenant_id,command_id),
  FOREIGN KEY (tenant_id,document_id,source_version) REFERENCES dge_documents.versions(tenant_id,document_id,version),
  FOREIGN KEY (tenant_id,decision_id) REFERENCES dge_decisions.decisions(tenant_id,id),
  CHECK ((artifact_sha256 IS NULL) = (artifact_media_type IS NULL)),
  CHECK ((kind='adopted') = (decision_id IS NOT NULL AND certificate_digest IS NOT NULL)),
  CHECK (lifecycle = CASE WHEN kind='adopted' THEN 'adopted' ELSE 'published' END),
  CHECK (document->>'id'=document_id::text AND document->>'tenantId'=tenant_id::text AND document->>'lifecycle'=lifecycle),
  CHECK (record->>'editionId'=id::text AND record->>'editionDigest'=edition_digest AND record->>'sourceDigest'=source_digest)
);
CREATE INDEX edition_document_order ON dge_editions.editions(document_id,sequence);

-- The exact saved version, its mode and (for adoption) a passed decision that
-- produced exactly this version are checked here, not only in the store.
CREATE FUNCTION dge_editions.guard_edition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source record; decision record;
BEGIN
  SELECT digest,document->>'mode' AS mode INTO source FROM dge_documents.versions
    WHERE tenant_id=NEW.tenant_id AND document_id=NEW.document_id AND version=NEW.source_version;
  IF source IS NULL OR source.digest<>NEW.source_digest THEN RAISE EXCEPTION 'Edition source digest mismatch'; END IF;
  IF (NEW.kind='consultation-source') <> (source.mode='public-input') THEN RAISE EXCEPTION 'Edition kind does not match document mode'; END IF;
  IF NEW.kind='adopted' THEN
    SELECT state,certificate,certificate_digest,document_id INTO decision FROM dge_decisions.decisions
      WHERE tenant_id=NEW.tenant_id AND id=NEW.decision_id;
    IF decision IS NULL OR decision.state<>'closed' OR decision.document_id<>NEW.document_id
       OR decision.certificate_digest<>NEW.certificate_digest
       OR decision.certificate->'outcome'->>'status'<>'passed'
       OR decision.certificate->>'application'<>'applied-to-public-draft'
       OR decision.certificate->>'appliedVersion'<>NEW.source_version::text
       OR decision.certificate->>'appliedDigest'<>NEW.source_digest THEN
      RAISE EXCEPTION 'Adoption requires the passed decision that produced this exact version';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_edition BEFORE INSERT ON dge_editions.editions FOR EACH ROW EXECUTE FUNCTION dge_editions.guard_edition();
CREATE FUNCTION dge_editions.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Final editions and signature records are append-only';
END $$;
CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON dge_editions.editions FOR EACH ROW EXECUTE FUNCTION dge_editions.reject_change();

ALTER TABLE dge_editions.editions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dge_editions.editions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON dge_editions.editions FOR SELECT TO dge_identity_runtime
  USING (tenant_id::text=current_setting('dge.tenant_id',true));
CREATE POLICY tenant_append ON dge_editions.editions FOR INSERT TO dge_identity_runtime
  WITH CHECK (tenant_id::text=current_setting('dge.tenant_id',true));
-- Every document in this engine is public; its final editions are too.
CREATE POLICY public_read ON dge_editions.editions FOR SELECT TO dge_identity_runtime
  USING (id::text=current_setting('dge.public_edition_id',true) OR document_id::text=current_setting('dge.public_document_id',true));
GRANT SELECT,INSERT ON dge_editions.editions TO dge_identity_runtime;

CREATE SCHEMA dge_signatures;
REVOKE ALL ON SCHEMA dge_signatures FROM PUBLIC;
GRANT USAGE ON SCHEMA dge_signatures TO dge_identity_runtime;

-- Execution order and capacities, configured once per edition (tenant-private).
CREATE TABLE dge_signatures.signatories (
  tenant_id uuid NOT NULL,
  edition_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 100),
  account_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  capacity text NOT NULL CHECK (char_length(capacity) BETWEEN 1 AND 200),
  configured_by uuid NOT NULL REFERENCES dge_identity.accounts(id),
  configured_at timestamptz NOT NULL,
  PRIMARY KEY (edition_id,position),
  UNIQUE (edition_id,account_id),
  FOREIGN KEY (tenant_id,edition_id) REFERENCES dge_editions.editions(tenant_id,id)
);

-- Single-use, expiring, account-bound statements of what will be signed.
CREATE TABLE dge_signatures.intents (
  tenant_id uuid NOT NULL,
  id uuid PRIMARY KEY,
  edition_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('support','approval','execution')),
  account_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  intent jsonb NOT NULL,
  signing_digest char(64) NOT NULL UNIQUE CHECK (signing_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  outcome text CHECK (outcome IN ('signed','declined')),
  closed_at timestamptz,
  FOREIGN KEY (tenant_id,edition_id) REFERENCES dge_editions.editions(tenant_id,id),
  CHECK (expires_at>created_at),
  CHECK ((outcome IS NULL) = (closed_at IS NULL)),
  CHECK (intent->>'editionId'=edition_id::text AND intent->>'accountId'=account_id::text AND intent->>'kind'=kind)
);
CREATE INDEX signature_intents_account ON dge_signatures.intents(account_id,created_at);
CREATE FUNCTION dge_signatures.guard_intent() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Signing intents are retained'; END IF;
  IF OLD.outcome IS NOT NULL OR NEW.outcome IS NULL
     OR (to_jsonb(NEW) - 'outcome' - 'closed_at') <> (to_jsonb(OLD) - 'outcome' - 'closed_at') THEN
    RAISE EXCEPTION 'A signing intent can only be closed once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_intent BEFORE UPDATE OR DELETE ON dge_signatures.intents FOR EACH ROW EXECUTE FUNCTION dge_signatures.guard_intent();

-- Public-safe, append-only event stream: sign, withdraw and dispute records.
CREATE TABLE dge_signatures.records (
  tenant_id uuid NOT NULL,
  id uuid PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  edition_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('support','approval','execution')),
  action text NOT NULL CHECK (action IN ('sign','withdraw','dispute')),
  target_id uuid REFERENCES dge_signatures.records(id),
  record_digest char(64) NOT NULL UNIQUE CHECK (record_digest ~ '^[a-f0-9]{64}$'),
  display text NOT NULL CHECK (display IN ('public','private')),
  public_record jsonb,
  public_mark jsonb,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id,edition_id) REFERENCES dge_editions.editions(tenant_id,id),
  CHECK ((action='sign') = (target_id IS NULL)),
  CHECK (display='public' OR (public_record IS NULL AND public_mark IS NULL)),
  CHECK (display='private' OR action<>'sign' OR public_record IS NOT NULL),
  CHECK (public_record IS NULL OR (public_record->>'editionId'=edition_id::text AND public_record->>'kind'=kind AND public_record->>'action'=action))
);
CREATE INDEX signature_records_edition ON dge_signatures.records(edition_id,kind,seq);

-- Tenant-private evidence: who signed, the private mark and the intent used.
CREATE TABLE dge_signatures.evidence (
  tenant_id uuid NOT NULL,
  record_id uuid PRIMARY KEY REFERENCES dge_signatures.records(id),
  edition_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  intent_id uuid UNIQUE REFERENCES dge_signatures.intents(id),
  record jsonb NOT NULL,
  mark jsonb NOT NULL,
  passkey_credential_id uuid,
  FOREIGN KEY (tenant_id,edition_id) REFERENCES dge_editions.editions(tenant_id,id)
);
CREATE INDEX signature_evidence_account ON dge_signatures.evidence(account_id,edition_id);

-- One active signature per account, edition and kind. Withdrawal removes the
-- projection row; the immutable records above keep the full history.
CREATE TABLE dge_signatures.active (
  tenant_id uuid NOT NULL,
  edition_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('support','approval','execution')),
  account_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  record_id uuid NOT NULL UNIQUE REFERENCES dge_signatures.records(id),
  display text NOT NULL CHECK (display IN ('public','private')),
  PRIMARY KEY (edition_id,kind,account_id),
  FOREIGN KEY (tenant_id,edition_id) REFERENCES dge_editions.editions(tenant_id,id)
);
-- Opted-in public names only; no account identifier is stored here.
CREATE TABLE dge_signatures.directory (
  tenant_id uuid NOT NULL,
  edition_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('support','approval','execution')),
  record_id uuid PRIMARY KEY REFERENCES dge_signatures.records(id),
  seq bigint NOT NULL,
  public_name text NOT NULL CHECK (char_length(public_name) BETWEEN 1 AND 120),
  name_key text COLLATE "C" NOT NULL CHECK (char_length(name_key) BETWEEN 1 AND 480),
  signed_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id,edition_id) REFERENCES dge_editions.editions(tenant_id,id)
);
CREATE INDEX signature_directory_order ON dge_signatures.directory(edition_id,kind,seq);
CREATE INDEX signature_directory_prefix ON dge_signatures.directory(edition_id,kind,name_key,seq);
-- Sharded live counters keep counting O(1) without one hot row.
CREATE TABLE dge_signatures.tallies (
  tenant_id uuid NOT NULL,
  edition_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('support','approval','execution')),
  shard smallint NOT NULL CHECK (shard BETWEEN 0 AND 15),
  active_count bigint NOT NULL,
  public_count bigint NOT NULL,
  PRIMARY KEY (edition_id,kind,shard),
  FOREIGN KEY (tenant_id,edition_id) REFERENCES dge_editions.editions(tenant_id,id)
);

-- Records waiting for the next manifest freeze, in commit-independent order.
CREATE TABLE dge_signatures.manifest_queue (
  tenant_id uuid NOT NULL,
  edition_id uuid NOT NULL,
  kind text NOT NULL,
  seq bigint NOT NULL,
  record_id uuid PRIMARY KEY REFERENCES dge_signatures.records(id),
  FOREIGN KEY (tenant_id,edition_id) REFERENCES dge_editions.editions(tenant_id,id)
);
CREATE INDEX signature_manifest_queue_order ON dge_signatures.manifest_queue(edition_id,kind,seq);
CREATE TABLE dge_signatures.manifest_heads (
  tenant_id uuid NOT NULL,
  edition_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('support','approval','execution')),
  size bigint NOT NULL CHECK (size >= 0),
  version integer NOT NULL CHECK (version >= 0),
  active_count bigint NOT NULL CHECK (active_count >= 0),
  public_count bigint NOT NULL CHECK (public_count >= 0),
  PRIMARY KEY (edition_id,kind),
  FOREIGN KEY (tenant_id,edition_id) REFERENCES dge_editions.editions(tenant_id,id)
);
CREATE TABLE dge_signatures.manifest_entries (
  tenant_id uuid NOT NULL,
  edition_id uuid NOT NULL,
  kind text NOT NULL,
  position bigint NOT NULL CHECK (position >= 0),
  record_id uuid NOT NULL UNIQUE REFERENCES dge_signatures.records(id),
  record_digest char(64) NOT NULL,
  PRIMARY KEY (edition_id,kind,position),
  FOREIGN KEY (tenant_id,edition_id) REFERENCES dge_editions.editions(tenant_id,id)
);
-- Hashes of complete subtrees of each (edition, kind) manifest tree.
CREATE TABLE dge_signatures.manifest_nodes (
  tenant_id uuid NOT NULL,
  edition_id uuid NOT NULL,
  kind text NOT NULL,
  level smallint NOT NULL CHECK (level BETWEEN 0 AND 62),
  idx bigint NOT NULL CHECK (idx >= 0),
  hash char(64) NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (edition_id,kind,level,idx),
  FOREIGN KEY (tenant_id,edition_id) REFERENCES dge_editions.editions(tenant_id,id)
);
CREATE TABLE dge_signatures.manifests (
  tenant_id uuid NOT NULL,
  edition_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('support','approval','execution')),
  version integer NOT NULL CHECK (version >= 1),
  size bigint NOT NULL CHECK (size >= 1),
  root_hash char(64) NOT NULL CHECK (root_hash ~ '^[a-f0-9]{64}$'),
  consistency jsonb NOT NULL,
  record jsonb NOT NULL,
  manifest_digest char(64) NOT NULL UNIQUE CHECK (manifest_digest ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL REFERENCES dge_identity.accounts(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (edition_id,kind,version),
  UNIQUE (edition_id,kind,size),
  FOREIGN KEY (tenant_id,edition_id) REFERENCES dge_editions.editions(tenant_id,id),
  CHECK ((record->>'size')::bigint=size AND record->>'rootHash'=root_hash AND (record->>'version')::int=version)
);

-- Execution signatures follow the configured order, enforced at insert.
CREATE FUNCTION dge_signatures.guard_active() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE place smallint;
BEGIN
  IF NEW.kind='execution' THEN
    SELECT position INTO place FROM dge_signatures.signatories WHERE edition_id=NEW.edition_id AND account_id=NEW.account_id;
    IF place IS NULL THEN RAISE EXCEPTION 'Account is not a configured signatory'; END IF;
    IF EXISTS (SELECT 1 FROM dge_signatures.signatories s WHERE s.edition_id=NEW.edition_id AND s.position<place
        AND NOT EXISTS (SELECT 1 FROM dge_signatures.active a WHERE a.edition_id=s.edition_id AND a.kind='execution' AND a.account_id=s.account_id)) THEN
      RAISE EXCEPTION 'Execution signatures must follow the configured order';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_active BEFORE INSERT ON dge_signatures.active FOR EACH ROW EXECUTE FUNCTION dge_signatures.guard_active();
CREATE FUNCTION dge_signatures.guard_head() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.size<=OLD.size OR NEW.version<>OLD.version+1 OR NEW.tenant_id<>OLD.tenant_id OR NEW.edition_id<>OLD.edition_id OR NEW.kind<>OLD.kind THEN
    RAISE EXCEPTION 'A manifest can only grow by a new version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_head BEFORE UPDATE ON dge_signatures.manifest_heads FOR EACH ROW EXECUTE FUNCTION dge_signatures.guard_head();
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['signatories','records','evidence','manifest_entries','manifest_nodes','manifests'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON dge_signatures.%I FOR EACH ROW EXECUTE FUNCTION dge_editions.reject_change()',target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['signatories','intents','records','evidence','active','directory','tallies','manifest_queue','manifest_heads','manifest_entries','manifest_nodes','manifests'] LOOP
    EXECUTE format('ALTER TABLE dge_signatures.%I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('ALTER TABLE dge_signatures.%I FORCE ROW LEVEL SECURITY',target);
    EXECUTE format('CREATE POLICY tenant_scope ON dge_signatures.%I TO dge_identity_runtime USING (tenant_id::text=current_setting(''dge.tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''dge.tenant_id'',true))',target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['records','directory','tallies','manifest_heads','manifest_entries','manifest_nodes','manifests'] LOOP
    EXECUTE format('CREATE POLICY public_read ON dge_signatures.%I FOR SELECT TO dge_identity_runtime USING (edition_id::text=current_setting(''dge.public_edition_id'',true))',target);
  END LOOP;
END $$;
GRANT SELECT,INSERT ON dge_signatures.signatories,dge_signatures.records,dge_signatures.evidence,
  dge_signatures.manifest_entries,dge_signatures.manifest_nodes,dge_signatures.manifests TO dge_identity_runtime;
GRANT SELECT,INSERT ON dge_signatures.intents TO dge_identity_runtime;
GRANT UPDATE (outcome,closed_at) ON dge_signatures.intents TO dge_identity_runtime;
GRANT SELECT,INSERT,DELETE ON dge_signatures.active,dge_signatures.directory,dge_signatures.manifest_queue TO dge_identity_runtime;
GRANT SELECT,INSERT ON dge_signatures.tallies,dge_signatures.manifest_heads TO dge_identity_runtime;
GRANT UPDATE (active_count,public_count) ON dge_signatures.tallies TO dge_identity_runtime;
GRANT UPDATE (size,version,active_count,public_count) ON dge_signatures.manifest_heads TO dge_identity_runtime;
