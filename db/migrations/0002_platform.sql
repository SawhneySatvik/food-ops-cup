-- 0002_platform — operator configuration (02-schema §1, R21, R24, R36). Runs as munim_migrator.
-- munim_platform writes (via /platform/v1); core roles read what they need. No DELETE grant anywhere:
-- retire rows with `status`. Country-pack rows are seeded by db/seeds/packs.ts from @munim/contracts, not here.

-- Pack documents are immutable per (code, version); a change is a new version.
CREATE TABLE platform.country_pack (
  code           char(2)     NOT NULL CHECK (code ~ '^[A-Z]{2}$'),
  version        integer     NOT NULL CHECK (version >= 1),
  effective_from date        NOT NULL,
  doc            jsonb       NOT NULL,
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'retired')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code, version),
  CHECK (doc ->> 'code' = code AND doc ->> 'version' = version::text)
);

CREATE TABLE platform.plan (
  code       text        PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name       text        NOT NULL,
  limits     jsonb       NOT NULL DEFAULT '{}',
  status     text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Typed flags; `intel.enabled` is the AI kill switch (project rule 11).
CREATE TABLE platform.feature_flag (
  key         text        PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  value_type  text        NOT NULL CHECK (value_type IN ('boolean', 'integer', 'text')),
  value       jsonb       NOT NULL,
  description text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (CASE value_type
           WHEN 'boolean' THEN jsonb_typeof(value) = 'boolean'
           WHEN 'integer' THEN jsonb_typeof(value) = 'number' AND value::text ~ '^-?[0-9]+$'
           ELSE jsonb_typeof(value) = 'string' END)
);
INSERT INTO platform.feature_flag (key, value_type, value, description)
VALUES ('intel.enabled', 'boolean', 'true', 'AI surfaces on/off; off hides them and the inbox keeps working');

-- Per-tenant monthly model spend cap. `spent` is a view over intel.intel_spend (M-B, 0011).
CREATE TABLE platform.llm_budget (
  tenant_id   uuid        NOT NULL,
  month       date        NOT NULL CHECK (extract(day FROM month) = 1),
  limit_minor bigint      NOT NULL CHECK (limit_minor >= 0),
  currency    char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, month)
);

-- Provider + model per AI role (R36). Changed only through an approved config_draft (T-031).
-- Never a gemini-2.5-* model (retires 20 Oct 2026; project rule 13).
CREATE TABLE platform.model_role (
  role       text        PRIMARY KEY CHECK (role IN ('router', 'reason', 'extract', 'narrate', 'vision', 'embed')),
  provider   text        NOT NULL CHECK (provider IN ('gemini', 'openai', 'openrouter', 'nvidia')),
  model_id   text        NOT NULL CHECK (model_id <> '' AND model_id !~* 'gemini-2\.5'),
  location   text,
  probed_at  timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform.operator (
  id         uuid        PRIMARY KEY,
  idp_sub    text        NOT NULL UNIQUE,
  email      text        NOT NULL,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Probe output and cross-operator review (R24); an operator's own command is its approval (R27).
CREATE TABLE platform.config_draft (
  id          uuid        PRIMARY KEY,
  target      text        NOT NULL CHECK (target ~ '^[a-z_]+(:[A-Za-z0-9_.-]+)?$'),
  patch       jsonb       NOT NULL,
  status      text        NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'rejected', 'stale')),
  proposed_by text        NOT NULL,
  decided_by  uuid        REFERENCES platform.operator (id),
  decided_at  timestamptz,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('applied', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL))
);

-- Hash-chained, gapless, append-only. seq/prev_hash/hash/created_at are computed by the trigger below;
-- anything the caller supplies for them is overwritten. Line format documented in db/README.md.
CREATE TABLE platform.platform_audit (
  seq             bigint      PRIMARY KEY,
  actor           jsonb       NOT NULL,
  action          text        NOT NULL,
  entity          text        NOT NULL,
  entity_id       text        NOT NULL,
  before          jsonb,
  after           jsonb,
  config_draft_id uuid        REFERENCES platform.config_draft (id),
  prev_hash       text        NOT NULL,
  hash            text        NOT NULL,
  created_at      timestamptz NOT NULL
);

CREATE FUNCTION platform.platform_audit_chain() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  last_seq  bigint;
  last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('platform.platform_audit', 0));
  SELECT a.seq, a.hash INTO last_seq, last_hash FROM platform.platform_audit a ORDER BY a.seq DESC LIMIT 1;
  NEW.seq        := coalesce(last_seq, 0) + 1;
  NEW.prev_hash  := coalesce(last_hash, repeat('0', 64));
  NEW.created_at := now();
  NEW.hash := encode(sha256(convert_to(concat_ws(E'\n',
                NEW.prev_hash, NEW.seq::text, NEW.actor::text, NEW.action, NEW.entity, NEW.entity_id,
                coalesce(NEW.before::text, 'null'), coalesce(NEW.after::text, 'null'),
                coalesce(NEW.config_draft_id::text, 'null'),
                to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), 'UTF8')), 'hex');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.platform_audit_chain() FROM PUBLIC;

CREATE TRIGGER audit_chain BEFORE INSERT ON platform.platform_audit
  FOR EACH ROW EXECUTE FUNCTION platform.platform_audit_chain();

CREATE FUNCTION platform.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.touch_updated_at() FROM PUBLIC;

CREATE TRIGGER touch_updated_at BEFORE UPDATE ON platform.feature_flag
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON platform.model_role
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON platform.config_draft
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

-- llm_budget carries tenant_id: tenants read only their own row; the operator role sees all.
ALTER TABLE platform.llm_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.llm_budget FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_all ON platform.llm_budget TO munim_platform USING (true) WITH CHECK (true);
CREATE POLICY tenant_read ON platform.llm_budget FOR SELECT TO munim_core, munim_svc
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

-- Grants: revoke-then-grant per table. No DELETE/TRUNCATE to anyone; UPDATE is column-pinned.
REVOKE ALL ON platform.country_pack, platform.plan, platform.feature_flag, platform.llm_budget,
  platform.model_role, platform.operator, platform.config_draft, platform.platform_audit FROM PUBLIC;

GRANT SELECT, INSERT ON platform.country_pack TO munim_platform;
GRANT UPDATE (status) ON platform.country_pack TO munim_platform;
GRANT SELECT ON platform.country_pack TO munim_core, munim_svc;

GRANT SELECT, INSERT ON platform.plan TO munim_platform;
GRANT UPDATE (name, limits, status) ON platform.plan TO munim_platform;
GRANT SELECT ON platform.plan TO munim_core, munim_svc;

GRANT SELECT, INSERT ON platform.feature_flag TO munim_platform;
GRANT UPDATE (value, description) ON platform.feature_flag TO munim_platform;
GRANT SELECT ON platform.feature_flag TO munim_core, munim_svc;

GRANT SELECT, INSERT ON platform.llm_budget TO munim_platform;
GRANT UPDATE (limit_minor) ON platform.llm_budget TO munim_platform;
GRANT SELECT ON platform.llm_budget TO munim_core, munim_svc;

GRANT SELECT, INSERT ON platform.model_role TO munim_platform;
GRANT UPDATE (provider, model_id, location, probed_at) ON platform.model_role TO munim_platform;
GRANT SELECT ON platform.model_role TO munim_core, munim_svc;

GRANT SELECT, INSERT ON platform.operator TO munim_platform;
GRANT UPDATE (email, active) ON platform.operator TO munim_platform;
-- core-api resolves an operator identity before running tenancy.provision.v1 as an operator command.
GRANT SELECT (id, idp_sub, active) ON platform.operator TO munim_core;

GRANT SELECT, INSERT ON platform.config_draft TO munim_platform;
GRANT UPDATE (status, decided_by, decided_at, reason) ON platform.config_draft TO munim_platform;

GRANT SELECT, INSERT ON platform.platform_audit TO munim_platform;
