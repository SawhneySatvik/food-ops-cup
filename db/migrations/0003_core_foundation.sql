-- 0003_core_foundation — tenancy (02-schema §2.1, R30), commands (§2.2), approvals/audit/outbox (§2.12),
-- evidence (§3), intel.run (§4), the book guard (03-architecture §1.3, ADR-013), the munim_crosstenant
-- objects (§1.2, §1.6). Runs as munim_migrator.
--
-- RLS predicate used on every tenant table. The setting is wrapped in nullif(…, ''): after a transaction
-- that ran SET LOCAL app.tenant_id ends, current_setting(…, true) on that same pooled connection returns ''
-- (not NULL), and ''::uuid raises. With nullif a missing context reads 0 rows and never errors.
--   tenant:  tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
--   outlet:  … AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
--                   OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[]))
-- The double nullif keeps '{*}' from ever reaching the uuid[] cast (OR operands have no guaranteed order).
-- Policies are written inline, never through a helper function: a function in a policy would need EXECUTE
-- for every reader, including the intel read-only role (gate: functions executable by munim_intel_ro = 0).

------------------------------------------------------------------------------------------------------------
-- Tenancy (book unless noted)
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.tenant (
  tenant_id      uuid        PRIMARY KEY,
  name           text        NOT NULL CHECK (name <> ''),
  country_code   char(2)     NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  base_currency  char(3)     NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  fy_start_month smallint    NOT NULL CHECK (fy_start_month BETWEEN 1 AND 12),
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  is_demo        boolean     NOT NULL DEFAULT false,
  onboarded_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  origin         jsonb       NOT NULL
);

CREATE TABLE core.outlet (
  tenant_id        uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id               uuid        NOT NULL,
  name             text        NOT NULL CHECK (name <> ''),
  kind             text        NOT NULL CHECK (kind IN ('restaurant', 'cloud_kitchen', 'store')),
  tz               text        NOT NULL CHECK (tz ~ '^[A-Za-z]+/[A-Za-z_]+$'),
  address          text        NOT NULL,
  tax_ids          jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(tax_ids) = 'object'),
  accepting_orders text        NOT NULL DEFAULT 'open' CHECK (accepting_orders IN ('open', 'busy', 'paused')),
  busy_extra_min   integer     NOT NULL DEFAULT 0 CHECK (busy_extra_min BETWEEN 0 AND 240),
  -- Outlet settings (orchestrator scope rider, 9 Oct): storefront/kitchen timing knobs, minutes.
  default_prep_min      integer NOT NULL DEFAULT 15 CHECK (default_prep_min BETWEEN 0 AND 240),
  cancel_window_min     integer NOT NULL DEFAULT 5  CHECK (cancel_window_min BETWEEN 0 AND 1440),
  reschedule_window_min integer NOT NULL DEFAULT 30 CHECK (reschedule_window_min BETWEEN 0 AND 1440),
  pickup_slot_min       integer NOT NULL DEFAULT 15 CHECK (pickup_slot_min BETWEEN 5 AND 120),
  pickup_lead_min       integer NOT NULL DEFAULT 20 CHECK (pickup_lead_min BETWEEN 0 AND 1440),
  -- UPI payee address shown for recorded UPI tenders (scope rider 3); payments are recorded, never processed.
  upi_vpa               text    CHECK (upi_vpa ~ '^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid,
  origin           jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE core.brand (
  tenant_id  uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id         uuid        NOT NULL,
  name       text        NOT NULL CHECK (name <> ''),
  outlet_ids uuid[]      NOT NULL DEFAULT '{}',
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  origin     jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE core.channel (
  tenant_id  uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id         uuid        NOT NULL,
  name       text        NOT NULL CHECK (name <> ''),
  kind       text        NOT NULL CHECK (kind IN ('counter', 'table_qr', 'pickup', 'own_site')
                                         OR kind ~ '^aggregator:[a-z][a-z0-9_]*$'),
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  origin     jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

-- idp_sub is bound on first sign-in (an invited member has none yet).
CREATE TABLE core.member (
  tenant_id          uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                 uuid        NOT NULL,
  idp_sub            text,
  name               text        NOT NULL CHECK (name <> ''),
  email              text        NOT NULL,
  is_ephemeral_judge boolean     NOT NULL DEFAULT false,
  active             boolean     NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  origin             jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idp_sub)
);

-- One role per member per tenant. outlet_ids '{}' = every outlet (owner/advisor/judge).
-- A judge holds owner rights in their own demo tenant only (03-architecture §6).
CREATE TABLE core.membership (
  tenant_id  uuid        NOT NULL,
  member_id  uuid        NOT NULL,
  role       text        NOT NULL CHECK (role IN ('owner', 'manager', 'staff', 'advisor', 'judge')),
  outlet_ids uuid[]      NOT NULL DEFAULT '{}',
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  origin     jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, member_id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES core.member (tenant_id, id)
);

-- Operational: heartbeats change constantly; registration itself is a member command.
CREATE TABLE core.device (
  tenant_id      uuid        NOT NULL,
  id             uuid        NOT NULL,
  outlet_id      uuid        NOT NULL,
  kind           text        NOT NULL CHECK (kind IN ('pos', 'kds')),
  invoice_series text        CHECK (invoice_series ~ '^[A-Z][A-Z0-9-]{0,15}$'),
  last_seen_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  CHECK (kind = 'pos' OR invoice_series IS NULL)
);

CREATE TABLE core.outlet_calendar (
  tenant_id  uuid        NOT NULL,
  id         uuid        NOT NULL,
  outlet_id  uuid        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('weekly', 'override')),
  weekday    smallint    CHECK (weekday BETWEEN 0 AND 6),
  on_date    date,
  opens_at   time,
  closes_at  time,
  closed     boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  origin     jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  CHECK ((kind = 'weekly') = (weekday IS NOT NULL AND on_date IS NULL)),
  CHECK ((kind = 'override') = (on_date IS NOT NULL AND weekday IS NULL)),
  CHECK (closed OR (opens_at IS NOT NULL AND closes_at IS NOT NULL))
);

-- Owner targets the packs judge against (scope rider 3; book by orchestrator ruling). outlet_id NULL =
-- tenant-wide default; an outlet row overrides it. Versioned by validity.
CREATE TABLE core.business_policy (
  tenant_id         uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                uuid        NOT NULL,
  outlet_id         uuid,
  target_margin_bp  integer     CHECK (target_margin_bp BETWEEN 0 AND 10000),
  margin_floor_bp   integer     CHECK (margin_floor_bp BETWEEN 0 AND 10000),
  labour_target_bp  integer     CHECK (labour_target_bp BETWEEN 0 AND 10000),
  min_payment_days  integer     CHECK (min_payment_days >= 0),
  valid_from        date        NOT NULL,
  valid_to          date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  origin            jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (margin_floor_bp IS NULL OR target_margin_bp IS NULL OR margin_floor_bp <= target_margin_bp)
);

------------------------------------------------------------------------------------------------------------
-- Global reference tables (no tenant_id, no RLS, SELECT-only at runtime; 02-schema §0 exception)
------------------------------------------------------------------------------------------------------------
-- R27: a member's own command is its approval when its role is listed here. `scope`: 'tenant' needs an
-- all-outlet context ('{*}'); 'outlet' needs the row's outlet inside app.outlet_ids; 'own_order' / 'own' (the
-- customer's own order / own profile, R41) are enforced by core-api and, for core.customer, by its own-row
-- policy. max_amount_minor is evaluated by core-domain, not the trigger.
CREATE TABLE core.command_authority (
  command_type     text   PRIMARY KEY CHECK (command_type ~ '^[a-z_]+(\.[a-z_]+)+\.v[0-9]+$'),
  allowed_roles    text[] NOT NULL CHECK (cardinality(allowed_roles) >= 1 AND allowed_roles <@
                     ARRAY['owner', 'manager', 'staff', 'advisor', 'customer', 'operator', 'judge']),
  scope            text   NOT NULL CHECK (scope IN ('outlet', 'tenant', 'own_order', 'own')),
  max_amount_minor bigint CHECK (max_amount_minor >= 0)
);

-- The W1 command catalogue (BOARD T-002; packages/contracts COMMANDS). Role lists are this migration's
-- INFERENCE from R27 and 03-architecture §6 (judge = owner rights in its demo tenant); T-003 reads them.
-- No country-change command: country is chosen inside tenancy.provision.v1 and fixed at onboarding (R30).
INSERT INTO core.command_authority (command_type, allowed_roles, scope) VALUES
  ('tenancy.provision.v1',               ARRAY['operator'],                                     'tenant'),
  ('tenancy.outlet.create.v1',           ARRAY['owner', 'judge'],                               'tenant'),
  ('tenancy.member.invite.v1',           ARRAY['owner', 'judge'],                               'tenant'),
  ('tenancy.brand.create.v1',            ARRAY['owner', 'judge'],                               'tenant'),
  ('tenancy.channel.create.v1',          ARRAY['owner', 'judge'],                               'tenant'),
  ('tenancy.device.register.v1',         ARRAY['owner', 'manager', 'judge'],                    'outlet'),
  ('catalogue.item.upsert.v1',           ARRAY['owner', 'manager', 'judge'],                    'tenant'),
  ('catalogue.recipe.version.create.v1', ARRAY['owner', 'manager', 'judge'],                    'tenant'),
  ('catalogue.price.set.v1',             ARRAY['owner', 'manager', 'judge'],                    'outlet'),
  ('inventory.ingredient.upsert.v1',     ARRAY['owner', 'manager', 'judge'],                    'tenant'),
  ('inventory.reorder_level.set.v1',     ARRAY['owner', 'manager', 'judge'],                    'outlet'),
  ('inventory.stock.receive.v1',         ARRAY['owner', 'manager', 'staff', 'judge'],           'outlet'),
  ('purchasing.supplier.upsert.v1',      ARRAY['owner', 'manager', 'judge'],                    'tenant'),
  ('purchasing.po.create.v1',            ARRAY['owner', 'manager', 'judge'],                    'outlet'),
  ('orders.pickup_window.generate.v1',   ARRAY['owner', 'manager', 'judge'],                    'outlet'),
  ('orders.place.v1',                    ARRAY['owner', 'manager', 'staff', 'customer', 'judge'], 'outlet'),
  ('storefront.guest.create.v1',         ARRAY['customer'],                                     'own_order'),
  ('kitchen.ticket.advance.v1',          ARRAY['owner', 'manager', 'staff', 'judge'],           'outlet'),
  ('drafts.approve.v1',                  ARRAY['owner', 'manager', 'judge'],                    'outlet'),
  ('drafts.reject.v1',                   ARRAY['owner', 'manager', 'judge'],                    'outlet');

-- Allow-listed deterministic derivations (03-architecture §1.3 branch 3). Ids match
-- packages/core-domain/*/rules (test, T-003). Rows are seeded by the migration that creates the target.
CREATE TABLE core.derivation_rule (
  rule_id      text NOT NULL CHECK (rule_id ~ '^[a-z_]+\.[a-z_]+$'),
  source_table text NOT NULL CHECK (source_table ~ '^core\.[a-z_]+$'),
  target_table text NOT NULL CHECK (target_table ~ '^core\.[a-z_]+$'),
  PRIMARY KEY (rule_id, source_table, target_table)
);

------------------------------------------------------------------------------------------------------------
-- Commands (operational)
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.command_log (
  tenant_id       uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  idempotency_key text        NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  command_id      uuid        NOT NULL,
  command_type    text        NOT NULL REFERENCES core.command_authority (command_type),
  actor           jsonb       NOT NULL,
  request_hash    text        NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  result          jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);

------------------------------------------------------------------------------------------------------------
-- intel.run (02-schema §4) — run-token rows; core-api checks the token's run here (03-architecture §1.7)
------------------------------------------------------------------------------------------------------------
CREATE TABLE intel.run (
  tenant_id    uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id           uuid        NOT NULL,
  trigger      text        NOT NULL CHECK (trigger IN ('event', 'watch_sweep', 'ask', 'brief')),
  actor        text        NOT NULL CHECK (actor ~ '^(watcher:[a-z_]+|brief|[0-9a-f-]{36})$'),
  outlet_scope text[]      NOT NULL CHECK (outlet_scope = '{*}' OR (cardinality(outlet_scope) >= 1
                             AND array_to_string(outlet_scope, ',') ~ '^[0-9a-f-]{36}(,[0-9a-f-]{36})*$')),
  issued_at    timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  PRIMARY KEY (tenant_id, id),
  CHECK (expires_at > issued_at)
);

------------------------------------------------------------------------------------------------------------
-- evidence (02-schema §3). Templates are created only by migrations; snapshots are minted by core-api as
-- munim_svc under the run's RLS context — no SECURITY DEFINER.
------------------------------------------------------------------------------------------------------------
CREATE TABLE evidence.snapshot_template (
  id            text        NOT NULL CHECK (id ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  version       integer     NOT NULL CHECK (version >= 1),
  sql           text        NOT NULL,
  params_schema jsonb       NOT NULL,
  -- [{name, type, numeric_source}] — numeric columns name their source column: 'core.<table>.<column>',
  -- 'count:core.<table>', or an allow-listed intel column (R40 C5; gate: template numeric sources).
  columns       jsonb       NOT NULL CHECK (jsonb_typeof(columns) = 'array' AND jsonb_array_length(columns) >= 1),
  -- Who may open snapshots of this template (R40 C4); core-api checks it on GET /v1/snapshots/{id}.
  min_role      text        NOT NULL CHECK (min_role IN ('staff', 'manager', 'owner', 'operator')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

CREATE TABLE evidence.snapshot (
  tenant_id        uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id               uuid        NOT NULL,
  template_id      text        NOT NULL,
  template_version integer     NOT NULL,
  params           jsonb       NOT NULL DEFAULT '{}',
  -- Exactly one minter (R40 C4): an intel run, a member (POST /v1/snapshots), or an operator (/platform/v1).
  run_id                uuid,
  minted_by_member_id   uuid,
  minted_by_operator_id uuid REFERENCES platform.operator (id),
  outlet_scope     text[]      NOT NULL,
  rows             jsonb       NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  row_count        integer     NOT NULL CHECK (row_count BETWEEN 0 AND 500),
  sha256           text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (template_id, template_version) REFERENCES evidence.snapshot_template (id, version),
  FOREIGN KEY (tenant_id, run_id) REFERENCES intel.run (tenant_id, id),
  FOREIGN KEY (tenant_id, minted_by_member_id) REFERENCES core.member (tenant_id, id),
  CHECK (row_count = jsonb_array_length(rows)),
  CONSTRAINT snapshot_one_minter CHECK (num_nonnulls(run_id, minted_by_member_id, minted_by_operator_id) = 1)
);

------------------------------------------------------------------------------------------------------------
-- Approvals, audit, outbox (02-schema §2.12) — operational
------------------------------------------------------------------------------------------------------------
-- finding_id gets its FK when intel.finding exists (M-B, 0011).
CREATE TABLE core.draft (
  tenant_id       uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id              uuid        NOT NULL,
  outlet_ids      uuid[]      NOT NULL DEFAULT '{}',
  source          text        NOT NULL CHECK (source IN ('import', 'member') OR source ~ '^intel:[a-z_]+$'),
  finding_id      uuid,
  run_id          uuid,
  command_type    text        NOT NULL REFERENCES core.command_authority (command_type),
  command_payload jsonb       NOT NULL,
  evidence        jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(evidence) = 'array'),
  based_on        jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(based_on) = 'array'),
  status          text        NOT NULL DEFAULT 'proposed'
                    CHECK (status IN ('proposed', 'executing', 'rejected', 'stale', 'executed', 'failed')),
  exec_txid       bigint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES intel.run (tenant_id, id),
  CHECK (status = 'proposed' OR status = 'rejected' OR status = 'stale' OR exec_txid IS NOT NULL)
);

CREATE TABLE core.decision (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  draft_id      uuid        NOT NULL,
  verdict       text        NOT NULL CHECK (verdict IN ('approved', 'edited', 'rejected')),
  final_payload jsonb,
  reason        text,
  decided_by    uuid        NOT NULL,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, draft_id),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES core.draft (tenant_id, id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES core.member (tenant_id, id),
  CHECK ((verdict = 'rejected') = (final_payload IS NULL))
);

-- Per-tenant gapless, hash-chained, append-only. seq/prev_hash/hash/created_at are set by the trigger.
CREATE TABLE core.audit_log (
  tenant_id   uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  seq         bigint      NOT NULL,
  actor       jsonb       NOT NULL,
  action      text        NOT NULL,
  entity      text        NOT NULL,
  entity_id   text        NOT NULL,
  before      jsonb,
  after       jsonb,
  decision_id uuid,
  prev_hash   text        NOT NULL,
  hash        text        NOT NULL,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, seq),
  FOREIGN KEY (tenant_id, decision_id) REFERENCES core.decision (tenant_id, id)
);

-- Debezium-compatible columns (03-architecture §1.6). claimed_until is the sweeper's lease.
CREATE TABLE core.outbox (
  tenant_id     uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id            uuid        NOT NULL,
  aggregatetype text        NOT NULL,
  aggregateid   text        NOT NULL,
  type          text        NOT NULL CHECK (type ~ '^munim\.[a-z_]+\.[a-z_]+\.[a-z_]+\.v[0-9]+$'),
  payload       jsonb       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  claimed_until timestamptz,
  PRIMARY KEY (tenant_id, id)
);

------------------------------------------------------------------------------------------------------------
-- Functions. Every one: SET search_path, schema-qualified names, explicit REVOKE FROM PUBLIC. Trigger
-- functions need no EXECUTE grant (EXECUTE is checked when the trigger is created, not when it fires).
------------------------------------------------------------------------------------------------------------

-- The book guard (03-architecture §1.3, ADR-013). SECURITY INVOKER: it reads decision/draft/source rows
-- under the caller's own RLS context. Admits a row change only via (2) an approved decision whose draft is
-- executing in this very transaction, (3) an allow-listed derivation of an existing book row, or (1) a
-- named person's own command allowed by core.command_authority within the row's outlet scope; stamps
-- `origin`; otherwise raises MB001. There is no bypass for any role, including the migrator.
CREATE FUNCTION core.guard_book_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  uuid_re    constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  target     text := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  s_role     text := nullif(current_setting('app.role', true), '');
  s_cmd      text := nullif(current_setting('app.command_type', true), '');
  s_decision text := nullif(current_setting('app.decision_id', true), '');
  s_rule     text := nullif(current_setting('app.posting_rule', true), '');
  s_source   text := nullif(current_setting('app.source_ref', true), '');
  s_outlets  text := nullif(current_setting('app.outlet_ids', true), '');
  principal  text;
  rule_src   text;
  src_id     text;
  src_found  boolean;
  auth_scope text;
  row_outlet text;
BEGIN
  IF s_decision ~ uuid_re THEN
    PERFORM 1
       FROM core.decision d
       JOIN core.draft r ON r.tenant_id = d.tenant_id AND r.id = d.draft_id
      WHERE d.tenant_id = NEW.tenant_id AND d.id = s_decision::uuid
        AND d.verdict IN ('approved', 'edited')
        AND r.status = 'executing' AND r.exec_txid = txid_current();
    IF FOUND THEN
      NEW.origin := jsonb_build_object('kind', 'decision', 'decision_id', s_decision);
      RETURN NEW;
    END IF;
  END IF;

  IF s_rule IS NOT NULL AND s_source IS NOT NULL THEN
    src_id := split_part(s_source, ':', 2);
    -- The table that is probed comes only from the rule row, never from the app.source_ref text.
    SELECT dr.source_table INTO rule_src
      FROM core.derivation_rule dr
     WHERE dr.rule_id = s_rule AND dr.target_table = target AND dr.source_table = split_part(s_source, ':', 1);
    IF rule_src IS NOT NULL AND src_id ~ uuid_re THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE tenant_id = $1 AND id = $2)',
                     split_part(rule_src, '.', 1), split_part(rule_src, '.', 2))
         INTO src_found USING NEW.tenant_id, src_id::uuid;
      IF src_found THEN
        NEW.origin := jsonb_build_object('kind', 'derivation', 'rule_id', s_rule, 'source_ref', s_source);
        RETURN NEW;
      END IF;
    END IF;
  END IF;

  IF s_role IS NOT NULL AND s_cmd IS NOT NULL THEN
    principal := nullif(current_setting(CASE s_role WHEN 'customer' THEN 'app.customer_id'
                                                    WHEN 'operator' THEN 'app.operator_id'
                                                    ELSE 'app.member_id' END, true), '');
    SELECT ca.scope INTO auth_scope
      FROM core.command_authority ca
     WHERE ca.command_type = s_cmd AND s_role = ANY (ca.allowed_roles);
    row_outlet := to_jsonb(NEW) ->> 'outlet_id';
    IF principal ~ uuid_re AND auth_scope IS NOT NULL
       AND (auth_scope <> 'tenant' OR s_outlets = '{*}')
       AND (row_outlet IS NULL OR s_outlets = '{*}'
            OR row_outlet::uuid = ANY (nullif(s_outlets, '{*}')::uuid[])) THEN
      NEW.origin := jsonb_build_object('kind', 'command', 'command_type', s_cmd, 'role', s_role,
                                       'principal_id', principal);
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'book_write_refused: %', target
    USING ERRCODE = 'MB001',
          HINT = 'needs a person''s own command allowed by core.command_authority, an executing approved decision, or an allow-listed derivation';
END $$;
REVOKE ALL ON FUNCTION core.guard_book_write() FROM PUBLIC;

CREATE FUNCTION core.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.touch_updated_at() FROM PUBLIC;

-- NOTIFY with ids only (R20, R33): payload '<tenant_id>:<id>'; the channel is the trigger argument.
-- Delivered at commit, so a rolled-back write notifies nobody.
CREATE FUNCTION core.notify_ids() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_notify(TG_ARGV[0], NEW.tenant_id::text || ':' || NEW.id::text);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION core.notify_ids() FROM PUBLIC;

-- R30: once onboarded_at is set, country, currency and FY start are fixed, and onboarded_at itself cannot
-- be cleared or moved (closes the two-step "unset, then change country" path).
CREATE FUNCTION core.tenant_country_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.onboarded_at IS NOT NULL
     AND (NEW.onboarded_at IS DISTINCT FROM OLD.onboarded_at
          OR NEW.country_code <> OLD.country_code
          OR NEW.base_currency <> OLD.base_currency
          OR NEW.fy_start_month <> OLD.fy_start_month) THEN
    RAISE EXCEPTION 'country_locked: tenant % completed onboarding', OLD.tenant_id USING ERRCODE = 'MB002';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.tenant_country_lock() FROM PUBLIC;

-- R30: every currency-bearing column equals the tenant's base currency. Trigger arguments name the
-- currency columns of the table. FOR SHARE holds the tenant row so a concurrent pre-onboarding currency
-- change cannot interleave with this write.
CREATE FUNCTION core.assert_tenant_currency() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  col  text;
  val  text;
  base text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    val := to_jsonb(NEW) ->> col;
    CONTINUE WHEN val IS NULL;
    IF base IS NULL THEN
      SELECT t.base_currency INTO base FROM core.tenant t WHERE t.tenant_id = NEW.tenant_id FOR SHARE;
    END IF;
    IF base IS NULL OR val <> base THEN
      RAISE EXCEPTION 'currency_mismatch: %.% = % but the tenant base currency is %',
        TG_TABLE_NAME, col, val, coalesce(base, '?') USING ERRCODE = 'MB003';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.assert_tenant_currency() FROM PUBLIC;

-- Draft lifecycle (03-architecture §1.6): proposed → executing → executed | failed | stale,
-- proposed → rejected | stale. Moving to executing must stamp exec_txid = txid_current(), so the
-- decision branch of the guard admits book writes only inside the approving transaction.
CREATE FUNCTION core.draft_lifecycle() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'proposed' OR NEW.exec_txid IS NOT NULL THEN
      RAISE EXCEPTION 'illegal_transition: a draft is created as proposed' USING ERRCODE = 'MB004';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'proposed' AND NEW.status IN ('executing', 'rejected', 'stale'))
         OR (OLD.status = 'executing' AND NEW.status IN ('executed', 'failed', 'stale'))) THEN
      RAISE EXCEPTION 'illegal_transition: draft % → %', OLD.status, NEW.status USING ERRCODE = 'MB004';
    END IF;
  END IF;
  IF NEW.exec_txid IS DISTINCT FROM OLD.exec_txid
     AND NOT (OLD.status = 'proposed' AND NEW.status = 'executing' AND NEW.exec_txid = txid_current()) THEN
    RAISE EXCEPTION 'illegal_transition: exec_txid is set only to txid_current() on proposed → executing'
      USING ERRCODE = 'MB004';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.draft_lifecycle() FROM PUBLIC;

-- A decision is a named person's (R15, R27): decided_by is the signed-in member, and that member's role is
-- listed in core.command_authority for the draft's command type. (core-api also checks max_amount_minor
-- against the final payload — 03-architecture §1.6.) Refused with MB006.
CREATE FUNCTION core.decision_named_person() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.decided_by::text IS DISTINCT FROM nullif(current_setting('app.member_id', true), '')
     OR NOT EXISTS (SELECT 1 FROM core.draft r JOIN core.command_authority ca ON ca.command_type = r.command_type
                     WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.draft_id
                       AND nullif(current_setting('app.role', true), '') = ANY (ca.allowed_roles)) THEN
    RAISE EXCEPTION 'decision_refused: the decider must be the signed-in member with authority for this command type'
      USING ERRCODE = 'MB006';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.decision_named_person() FROM PUBLIC;

-- Audit chain (02-schema §2.12): per-tenant gapless seq under a per-tenant transaction lock;
-- hash = sha256 of the newline-joined line documented in db/README.md.
CREATE FUNCTION core.audit_log_chain() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  last_seq  bigint;
  last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('core.audit_log:' || NEW.tenant_id::text, 0));
  SELECT a.seq, a.hash INTO last_seq, last_hash
    FROM core.audit_log a WHERE a.tenant_id = NEW.tenant_id ORDER BY a.seq DESC LIMIT 1;
  NEW.seq        := coalesce(last_seq, 0) + 1;
  NEW.prev_hash  := coalesce(last_hash, repeat('0', 64));
  NEW.created_at := now();
  NEW.hash := encode(sha256(convert_to(concat_ws(E'\n',
                NEW.prev_hash, NEW.tenant_id::text, NEW.seq::text, NEW.actor::text, NEW.action, NEW.entity,
                NEW.entity_id, coalesce(NEW.before::text, 'null'), coalesce(NEW.after::text, 'null'),
                coalesce(NEW.decision_id::text, 'null'),
                to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), 'UTF8')), 'hex');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.audit_log_chain() FROM PUBLIC;

------------------------------------------------------------------------------------------------------------
-- munim_crosstenant objects — exactly three (gate: definer owners)
------------------------------------------------------------------------------------------------------------
-- Sweeper claim (03-architecture §1.6): leases unpublished rows older than min_age; returns outbox rows
-- only. The worker marks published_at per row under that row's tenant context.
CREATE FUNCTION core.outbox_claim(batch_size integer, min_age interval DEFAULT '30 seconds',
                                  lease interval DEFAULT '2 minutes')
RETURNS SETOF core.outbox
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE core.outbox o
     SET claimed_until = now() + lease
    FROM (SELECT c.tenant_id, c.id
            FROM core.outbox c
           WHERE c.published_at IS NULL
             AND c.created_at <= now() - min_age
             AND (c.claimed_until IS NULL OR c.claimed_until < now())
           ORDER BY c.created_at, c.id
           LIMIT least(greatest(batch_size, 0), 1000)
           FOR UPDATE SKIP LOCKED) pick
   WHERE o.tenant_id = pick.tenant_id AND o.id = pick.id
  RETURNING o.*;
$$;

-- fanout job (03-architecture §1.9): tenant ids only.
CREATE FUNCTION core.active_tenants() RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.tenant_id FROM core.tenant t WHERE t.status = 'active' ORDER BY t.tenant_id;
$$;

-- Operator view over core.tenant (02-schema §1) — not a second source of truth.
CREATE VIEW platform.tenant_registry AS
  SELECT t.tenant_id, t.name, t.country_code, t.base_currency, t.status, t.is_demo, t.onboarded_at, t.created_at
    FROM core.tenant t;

GRANT CREATE ON SCHEMA core, platform TO munim_crosstenant;
ALTER FUNCTION core.outbox_claim(integer, interval, interval) OWNER TO munim_crosstenant;
ALTER FUNCTION core.active_tenants() OWNER TO munim_crosstenant;
ALTER VIEW platform.tenant_registry OWNER TO munim_crosstenant;
REVOKE CREATE ON SCHEMA core, platform FROM munim_crosstenant;

REVOKE ALL ON FUNCTION core.outbox_claim(integer, interval, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.active_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.outbox_claim(integer, interval, interval) TO munim_svc;
GRANT EXECUTE ON FUNCTION core.active_tenants() TO munim_svc;
REVOKE ALL ON platform.tenant_registry FROM PUBLIC;
GRANT SELECT ON platform.tenant_registry TO munim_platform;

------------------------------------------------------------------------------------------------------------
-- Triggers
------------------------------------------------------------------------------------------------------------
-- The guard is named book_guard; other BEFORE triggers on book tables sort after it, so it fires first.
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.tenant          FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.outlet          FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.brand           FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.channel         FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.member          FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.membership      FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.outlet_calendar FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.business_policy FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();

CREATE TRIGGER country_lock BEFORE UPDATE ON core.tenant FOR EACH ROW EXECUTE FUNCTION core.tenant_country_lock();

CREATE TRIGGER draft_lifecycle BEFORE INSERT OR UPDATE ON core.draft FOR EACH ROW EXECUTE FUNCTION core.draft_lifecycle();
CREATE TRIGGER notify_inbox AFTER INSERT OR UPDATE ON core.draft FOR EACH ROW EXECUTE FUNCTION core.notify_ids('munim_inbox');
CREATE TRIGGER notify_outbox AFTER INSERT ON core.outbox FOR EACH ROW EXECUTE FUNCTION core.notify_ids('munim_outbox');
CREATE TRIGGER audit_chain BEFORE INSERT ON core.audit_log FOR EACH ROW EXECUTE FUNCTION core.audit_log_chain();
CREATE TRIGGER named_person BEFORE INSERT ON core.decision FOR EACH ROW EXECUTE FUNCTION core.decision_named_person();

------------------------------------------------------------------------------------------------------------
-- RLS: enable + force + policy on every tenant table
------------------------------------------------------------------------------------------------------------
ALTER TABLE core.tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.tenant
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.outlet ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.outlet FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.outlet
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.brand ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.brand FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.brand
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.channel ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.channel FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.channel
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.member ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.member FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.member
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.membership ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.membership FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.membership
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.device ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.device FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.device
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.outlet_calendar ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.outlet_calendar FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_isolation ON core.outlet_calendar
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])));

ALTER TABLE core.business_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.business_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.business_policy
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.command_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.command_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.command_log
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE intel.run ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel.run FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON intel.run
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE evidence.snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence.snapshot FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON evidence.snapshot
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

-- draft: outlet_ids overlap with the caller's outlet scope (02-schema §0).
ALTER TABLE core.draft ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.draft FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_outlet_overlap ON core.draft
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_ids && (SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}')::uuid[])))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_ids && (SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}')::uuid[])));

ALTER TABLE core.decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.decision FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.decision
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.audit_log
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE core.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.outbox
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE platform.llm_budget
  ADD FOREIGN KEY (tenant_id) REFERENCES core.tenant (tenant_id);

------------------------------------------------------------------------------------------------------------
-- Tags (R29)
------------------------------------------------------------------------------------------------------------
COMMENT ON TABLE core.tenant            IS 'munim:book';
COMMENT ON TABLE core.outlet            IS 'munim:book';
COMMENT ON TABLE core.brand             IS 'munim:book';
COMMENT ON TABLE core.channel           IS 'munim:book';
COMMENT ON TABLE core.member            IS 'munim:book';
COMMENT ON TABLE core.membership        IS 'munim:book';
COMMENT ON TABLE core.outlet_calendar   IS 'munim:book';
COMMENT ON TABLE core.business_policy   IS 'munim:book';
COMMENT ON TABLE core.device            IS 'munim:operational';
COMMENT ON TABLE core.command_authority IS 'munim:operational';
COMMENT ON TABLE core.derivation_rule   IS 'munim:operational';
COMMENT ON TABLE core.command_log       IS 'munim:operational';
COMMENT ON TABLE core.draft             IS 'munim:operational';
COMMENT ON TABLE core.decision          IS 'munim:operational';
COMMENT ON TABLE core.audit_log         IS 'munim:operational';
COMMENT ON TABLE core.outbox            IS 'munim:operational';

------------------------------------------------------------------------------------------------------------
-- Grants: revoke-then-grant per table. No DELETE/TRUNCATE to any runtime role; UPDATE is column-pinned.
-- munim_svc: SELECT everywhere here, INSERT only on operational rows (draft, outbox, intel.run,
-- evidence.snapshot) — never on a book table.
------------------------------------------------------------------------------------------------------------
REVOKE ALL ON core.tenant, core.outlet, core.brand, core.channel, core.member, core.membership, core.device,
  core.outlet_calendar, core.business_policy, core.command_authority, core.derivation_rule, core.command_log, core.draft,
  core.decision, core.audit_log, core.outbox, intel.run, evidence.snapshot_template, evidence.snapshot
  FROM PUBLIC;

GRANT SELECT, INSERT ON core.tenant TO munim_core;
GRANT UPDATE (name, country_code, base_currency, fy_start_month, status, onboarded_at) ON core.tenant TO munim_core;
GRANT SELECT ON core.tenant TO munim_svc;
GRANT SELECT (tenant_id, name, country_code, base_currency, status, is_demo, onboarded_at, created_at)
  ON core.tenant TO munim_crosstenant;

GRANT SELECT, INSERT ON core.outlet TO munim_core;
GRANT UPDATE (name, tz, address, tax_ids, accepting_orders, busy_extra_min, default_prep_min, cancel_window_min,
  reschedule_window_min, pickup_slot_min, pickup_lead_min, upi_vpa) ON core.outlet TO munim_core;
GRANT SELECT ON core.outlet TO munim_svc;

GRANT SELECT, INSERT ON core.brand TO munim_core;
GRANT UPDATE (name, outlet_ids, active) ON core.brand TO munim_core;
GRANT SELECT ON core.brand TO munim_svc;

GRANT SELECT, INSERT ON core.channel TO munim_core;
GRANT UPDATE (name, active) ON core.channel TO munim_core;
GRANT SELECT ON core.channel TO munim_svc;

GRANT SELECT, INSERT ON core.member TO munim_core;
GRANT UPDATE (idp_sub, name, email, active) ON core.member TO munim_core;
GRANT SELECT ON core.member TO munim_svc;

GRANT SELECT, INSERT ON core.membership TO munim_core;
GRANT UPDATE (role, outlet_ids, active) ON core.membership TO munim_core;
GRANT SELECT ON core.membership TO munim_svc;

GRANT SELECT, INSERT ON core.device TO munim_core;
GRANT UPDATE (invoice_series, last_seen_at) ON core.device TO munim_core;
GRANT SELECT ON core.device TO munim_svc;

GRANT SELECT, INSERT ON core.outlet_calendar TO munim_core;
GRANT UPDATE (opens_at, closes_at, closed) ON core.outlet_calendar TO munim_core;
GRANT SELECT ON core.outlet_calendar TO munim_svc;

GRANT SELECT, INSERT ON core.business_policy TO munim_core;
GRANT UPDATE (valid_to) ON core.business_policy TO munim_core;
GRANT SELECT ON core.business_policy TO munim_svc;

GRANT SELECT ON core.command_authority, core.derivation_rule TO munim_core, munim_svc;

GRANT SELECT, INSERT ON core.command_log TO munim_core;
GRANT SELECT ON core.command_log TO munim_svc;

GRANT SELECT, INSERT ON core.draft TO munim_core, munim_svc;
GRANT UPDATE (status, exec_txid) ON core.draft TO munim_core;

GRANT SELECT, INSERT ON core.decision TO munim_core;
GRANT SELECT ON core.decision TO munim_svc;

GRANT SELECT, INSERT ON core.audit_log TO munim_core;
GRANT SELECT ON core.audit_log TO munim_svc;

GRANT SELECT, INSERT ON core.outbox TO munim_core, munim_svc;
GRANT UPDATE (published_at) ON core.outbox TO munim_core, munim_svc;
GRANT SELECT, UPDATE (claimed_until) ON core.outbox TO munim_crosstenant;

GRANT SELECT, INSERT ON intel.run TO munim_svc;
GRANT UPDATE (ended_at) ON intel.run TO munim_svc;
GRANT SELECT ON intel.run TO munim_core;

GRANT SELECT ON evidence.snapshot_template TO munim_core, munim_svc;
GRANT SELECT, INSERT ON evidence.snapshot TO munim_svc, munim_core;
