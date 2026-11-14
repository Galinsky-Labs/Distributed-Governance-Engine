-- DCE-017/018: transparent moderation with appeals, and clause-level
-- permissions with expiring selective unlocks. Moderation never deletes
-- content and never touches ballots or decision history: it records a
-- visibility state that public reads honour with a visible placeholder.
CREATE SCHEMA dge_moderation;
REVOKE ALL ON SCHEMA dge_moderation FROM PUBLIC;
GRANT USAGE ON SCHEMA dge_moderation TO dge_identity_runtime;

-- Clause permissions -------------------------------------------------------
CREATE TABLE dge_moderation.section_access (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  restricted boolean NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  updated_by uuid NOT NULL REFERENCES dge_identity.accounts(id),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,document_id),
  FOREIGN KEY (tenant_id,document_id) REFERENCES dge_documents.documents(tenant_id,id)
);
CREATE TABLE dge_moderation.section_grants (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  document_id uuid NOT NULL,
  section_id text NOT NULL CHECK (section_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
  grantee_kind text NOT NULL CHECK (grantee_kind IN ('role','account','roster-class')),
  grantee_role text CHECK (grantee_role IN ('owner','admin','editor','participant','viewer')),
  grantee_account uuid REFERENCES dge_identity.accounts(id),
  grantee_roster uuid,
  grantee_class text CHECK (grantee_class ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  rights jsonb NOT NULL CHECK (jsonb_typeof(rights)='array' AND jsonb_array_length(rights) BETWEEN 1 AND 5
    AND rights <@ '["read","propose","discuss","vote","sign"]'::jsonb),
  effect text NOT NULL CHECK (effect IN ('allow','deny')),
  expires_at timestamptz,
  created_by uuid NOT NULL REFERENCES dge_identity.accounts(id),
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES dge_identity.accounts(id),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,document_id) REFERENCES dge_documents.documents(tenant_id,id),
  FOREIGN KEY (tenant_id,grantee_roster) REFERENCES dge_electorates.rosters(tenant_id,id),
  CHECK ((grantee_kind='role')=(grantee_role IS NOT NULL) AND (grantee_kind='account')=(grantee_account IS NOT NULL)
    AND (grantee_kind='roster-class')=(grantee_roster IS NOT NULL) AND (grantee_roster IS NULL)=(grantee_class IS NULL)),
  CHECK (expires_at IS NULL OR expires_at>created_at),
  CHECK ((revoked_at IS NULL)=(revoked_by IS NULL))
);
CREATE TABLE dge_moderation.access_events (
  tenant_id uuid NOT NULL REFERENCES dge_identity.tenants(id),
  id uuid NOT NULL,
  document_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  kind text NOT NULL CHECK (kind IN ('granted','revoked','restricted','unrestricted')),
  subject_id uuid,
  command_id uuid NOT NULL,
  request_digest char(64) NOT NULL,
  result jsonb NOT NULL,
  event_digest char(64) NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,actor_id,command_id)
);

-- Moderation ---------------------------------------------------------------
CREATE TABLE dge_moderation.reports (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('proposal','point')),
  target_id uuid NOT NULL,
  document_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  reporter_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  reason_category text NOT NULL CHECK (reason_category IN
    ('spam','harassment','off-topic','private-information','illegal-content','impersonation','other')),
  note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL,
  command_id uuid NOT NULL,
  request_digest char(64) NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,reporter_id,command_id),
  UNIQUE (tenant_id,reporter_id,target_kind,target_id),
  FOREIGN KEY (tenant_id,document_id,proposal_id) REFERENCES dge_proposals.proposals(tenant_id,document_id,id),
  CHECK (target_kind='point' OR target_id=proposal_id)
);
CREATE TABLE dge_moderation.visibility (
  tenant_id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('proposal','point')),
  target_id uuid NOT NULL,
  document_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  hidden boolean NOT NULL,
  reason_category text NOT NULL,
  version integer NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,target_kind,target_id),
  FOREIGN KEY (tenant_id,document_id,proposal_id) REFERENCES dge_proposals.proposals(tenant_id,document_id,id)
);
CREATE TABLE dge_moderation.actions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('proposal','point')),
  target_id uuid NOT NULL,
  document_id uuid NOT NULL,
  proposal_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('hide','restore')),
  reason_category text NOT NULL CHECK (reason_category IN
    ('spam','harassment','off-topic','private-information','illegal-content','impersonation','other',
     'review-reversed','appeal-granted')),
  moderator_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  appeal_id uuid,
  command_id uuid NOT NULL,
  request_digest char(64) NOT NULL,
  event_digest char(64) NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,moderator_id,command_id),
  FOREIGN KEY (tenant_id,document_id,proposal_id) REFERENCES dge_proposals.proposals(tenant_id,document_id,id),
  CHECK ((action='hide')=(reason_category NOT IN ('review-reversed','appeal-granted')))
);
CREATE TABLE dge_moderation.appeals (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  action_id uuid NOT NULL,
  appellant_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  statement text NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL,
  command_id uuid NOT NULL,
  request_digest char(64) NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','granted','denied')),
  resolved_by uuid REFERENCES dge_identity.accounts(id),
  resolved_at timestamptz,
  resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) BETWEEN 1 AND 1000),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,action_id),
  UNIQUE (tenant_id,appellant_id,command_id),
  FOREIGN KEY (tenant_id,action_id) REFERENCES dge_moderation.actions(tenant_id,id),
  CHECK ((status='pending')=(resolved_at IS NULL) AND (resolved_at IS NULL)=(resolved_by IS NULL))
);
CREATE TABLE dge_moderation.events (
  tenant_id uuid NOT NULL REFERENCES dge_identity.tenants(id),
  id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reported','hidden','restored','appealed','appeal-granted','appeal-denied')),
  subject_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES dge_identity.accounts(id),
  event_digest char(64) NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,id)
);

CREATE FUNCTION dge_moderation.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Moderation and access history is append-only';
END $$;
DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['access_events','reports','actions','events'] LOOP
    EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON dge_moderation.%I FOR EACH ROW EXECUTE FUNCTION dge_moderation.reject_change()',target);
  END LOOP;
  FOREACH target IN ARRAY ARRAY['section_access','section_grants','visibility','appeals'] LOOP
    EXECUTE format('CREATE TRIGGER no_delete BEFORE DELETE ON dge_moderation.%I FOR EACH ROW EXECUTE FUNCTION dge_moderation.reject_change()',target);
  END LOOP;
END $$;
CREATE FUNCTION dge_moderation.guard_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR
     (to_jsonb(NEW)-'revoked_at'-'revoked_by')<>(to_jsonb(OLD)-'revoked_at'-'revoked_by') THEN
    RAISE EXCEPTION 'Section grants can only be revoked once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_grant BEFORE UPDATE ON dge_moderation.section_grants
  FOR EACH ROW EXECUTE FUNCTION dge_moderation.guard_grant();
CREATE FUNCTION dge_moderation.guard_appeal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.status<>'pending' OR NEW.status='pending' OR
     (to_jsonb(NEW)-'status'-'resolved_by'-'resolved_at'-'resolution_note')<>
     (to_jsonb(OLD)-'status'-'resolved_by'-'resolved_at'-'resolution_note') THEN
    RAISE EXCEPTION 'An appeal is resolved exactly once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_appeal BEFORE UPDATE ON dge_moderation.appeals
  FOR EACH ROW EXECUTE FUNCTION dge_moderation.guard_appeal();
CREATE FUNCTION dge_moderation.guard_versioned() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.tenant_id<>OLD.tenant_id OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'Versioned moderation state must advance by one';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_versioned BEFORE UPDATE ON dge_moderation.section_access
  FOR EACH ROW EXECUTE FUNCTION dge_moderation.guard_versioned();
CREATE TRIGGER guard_versioned BEFORE UPDATE ON dge_moderation.visibility
  FOR EACH ROW EXECUTE FUNCTION dge_moderation.guard_versioned();

DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['section_access','section_grants','access_events','reports','visibility',
    'actions','appeals','events'] LOOP
    EXECUTE format('ALTER TABLE dge_moderation.%I ENABLE ROW LEVEL SECURITY',target);
    EXECUTE format('ALTER TABLE dge_moderation.%I FORCE ROW LEVEL SECURITY',target);
    EXECUTE format('CREATE POLICY tenant_scope ON dge_moderation.%I TO dge_identity_runtime USING (tenant_id::text=current_setting(''dge.tenant_id'',true)) WITH CHECK (tenant_id::text=current_setting(''dge.tenant_id'',true))',target);
  END LOOP;
END $$;
-- Public readers learn that an item was removed and why (by category), and
-- see the moderation log of a public document without moderator identity.
CREATE POLICY public_visibility ON dge_moderation.visibility FOR SELECT TO dge_identity_runtime
  USING (document_id::text=current_setting('dge.public_document_id',true));
CREATE POLICY public_actions ON dge_moderation.actions FOR SELECT TO dge_identity_runtime
  USING (document_id::text=current_setting('dge.public_document_id',true));
GRANT SELECT,INSERT ON dge_moderation.access_events,dge_moderation.reports,dge_moderation.actions,
  dge_moderation.events,dge_moderation.section_grants,dge_moderation.appeals TO dge_identity_runtime;
GRANT SELECT,INSERT,UPDATE (restricted,version,updated_by,updated_at) ON dge_moderation.section_access TO dge_identity_runtime;
GRANT SELECT,INSERT,UPDATE (hidden,reason_category,version,updated_at) ON dge_moderation.visibility TO dge_identity_runtime;
GRANT UPDATE (revoked_at,revoked_by) ON dge_moderation.section_grants TO dge_identity_runtime;
GRANT UPDATE (status,resolved_by,resolved_at,resolution_note) ON dge_moderation.appeals TO dge_identity_runtime;
CREATE INDEX section_grants_document ON dge_moderation.section_grants(tenant_id,document_id);
CREATE INDEX reports_target ON dge_moderation.reports(tenant_id,target_kind,target_id,created_at);
CREATE INDEX reports_reporter ON dge_moderation.reports(tenant_id,reporter_id,created_at);
CREATE INDEX actions_target ON dge_moderation.actions(tenant_id,target_kind,target_id,created_at);
CREATE INDEX visibility_document ON dge_moderation.visibility(document_id,target_kind);
