-- 0028_cares — Munim Cares (ADR-015 §1, §2.3; ledger R48 F-2 and the founder's Cares design answers 1–4), migrator lane
-- m-d, fix forward over 0001–0027. Runs as munim_migrator. Additive: 4 platform tables, 9 core book tables, one nullable
-- column on core.task, 4 stock kinds, 10 command types, 4 derivation rule rows, 5 SECURITY DEFINER read functions, 5
-- snapshot templates; munim_meta.assert_catalog re-issued with the definer list grown by those 5. One existing row is
-- rewritten (fix cycle fx-md, narrowing): 0022's inventory.transfer_in → core.batch binding gains `o.id IS NULL` (D1).
-- Items:
--   P1  platform.cares_city, platform.cares_recipient (simulated only: CHECK simulated, CHECK the name contains
--       "(simulated)"), platform.cares_enablement (per tenant, set by an approved config draft; RLS as platform.llm_budget),
--       platform.network_snapshot (operator-minted, append-only; published_at + publish_draft_id set once, together, by an
--       approved config draft whose target names the snapshot; only an operator platform.* template may be stored).
--       Enablement writes and the publish name a draft whose target matches (immediate) that is applied by COMMIT, in the
--       same transaction (deferred constraint trigger draft_applied: approve writes the target, then flips the draft).
--   C1  Nine core book tables (munim:book, guard, origin, FORCE RLS, shopper deny): cares_profile, cares_outlet,
--       cares_listing (+ _line), cares_handover (+ _line), cares_claim (+ _line, the buyer's), cares_allocation (the
--       offerer's). Row rules a CHECK cannot reach (they read the parent) are triggers named cares_rules:
--         every insert and status move only under the command that owns it (core.cares_command: the executing approved
--           draft's command, else app.command_type; MB004 otherwise) — the guard alone admits any listed command for any
--           operation on the table;
--         actor columns (published_by, recorded_by, voided_by, created_by, decided_by) = app.member_id (MB005, 0005 C7);
--         listing: created as published; pickup_on = the outlet's business date of pickup_from; closed only by a
--           hand-over recorded (with a line) in the same transaction;
--         listing line: donation lines unpriced, offer lines priced and never cooked; lines only on a published listing;
--           a cooked line never under an approved draft (the owner's own command only);
--         hand-over: created as recorded, of a published donation or an allocated offer (re-read under the listing row
--           lock by the line trigger: a hand-over of a withdrawn listing → MB004); a donation's carries no allocation, an
--           offer's carries the listing's accepted allocation; a voided hand-over is final (a second void and any un-void
--           → MB004; book_status_transition alone never fires on voided → voided);
--         hand-over line: its listing line belongs to the hand-over's listing; Σ non-voided hand-over qty per listing line
--           ≤ that line's qty_milli, under the listing row lock the trigger takes itself (MB001);
--         claim: created as requested; allocation_id set once, to the accepted allocation core.cares_claim_outcome shows
--           the receiving member (CHECK: received ⇒ allocation); claim line: received_qty_milli set once, from NULL, to
--           the handed quantity the outcome shows (MB004);
--         allocation: inserted by decide, on an offer; an accepted one only while the offer is published.
--       No cross-tenant FK: cares_claim.offer_* and cares_allocation.claim_* are plain uuids (an RI error would tell one
--       tenant whether another's row exists; RI checks bypass RLS).
--   C2  core.task.cares_listing_id (nullable, FK to the tenant's own listing) for goals.task.create.v1 (ADR-015 §4).
--   S1  core.stock_movement kinds donation (−), surplus_out (−), surplus_in (+), cares_reversal (+): 0005's two unnamed
--       CHECKs (stock_movement_kind_check, stock_movement_check) are pre-checked, dropped and re-added by name
--       (stock_movement_kind_check, stock_movement_sign_check).
--   A1  command_authority: the nine cares commands (§1.3), none draft-only.
--   D1  Derivation rules inventory.cares_handover, inventory.cares_handover_void, inventory.cares_claim_receive (→ movement
--       and batch), each with a binding (0022): the written row belongs to its source and stays within what the source's
--       lines imply (cumulative per unit, the written row included; hand-over movements in the ingredient's base unit);
--       the receive's batch is an INSERT (o.id IS NULL) with no MRP, supplier or GRN line. inventory.transfer_in →
--       core.batch gains o.id IS NULL too (its only writer, core-api destinationBatch, inserts).
--   X1  Five read-only SECURITY DEFINER functions owned by munim_crosstenant (EXECUTE munim_core only) with SELECT on exactly
--       the columns they read; each filters tenants in its own body (the owner bypasses RLS).
--   T1  Templates cares.recipient_match, cares.listings, cares.pickup_crew, cares.impact (member) and
--       platform.cares_network_impact (operator); a CHECK keeps the definer functions out of every other template.
-- New SQLSTATEs: none (MB001, MB004, MB005 as documented; 23514 for row rules).

------------------------------------------------------------------------------------------------------------
-- 0. Pre-checks: what this file builds on is the shape it builds on.
------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'core.stock_movement'::regclass AND c.conname = 'stock_movement_kind_check')
     IS DISTINCT FROM $d$CHECK ((kind = ANY (ARRAY['receipt'::text, 'sale_consumption'::text, 'waste'::text, 'transfer_out'::text, 'transfer_in'::text, 'count_adjust'::text, 'supplier_return'::text, 'sale_return'::text])))$d$ THEN
    RAISE EXCEPTION '0028: core.stock_movement stock_movement_kind_check is not the 0005 kind list 0028 widens';
  END IF;
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'core.stock_movement'::regclass AND c.conname = 'stock_movement_check')
     IS DISTINCT FROM $d$CHECK (
CASE
    WHEN (kind = ANY (ARRAY['receipt'::text, 'transfer_in'::text, 'sale_return'::text])) THEN (qty_milli > 0)
    WHEN (kind = ANY (ARRAY['sale_consumption'::text, 'waste'::text, 'transfer_out'::text, 'supplier_return'::text])) THEN (qty_milli < 0)
    ELSE (qty_milli <> 0)
END)$d$ THEN
    RAISE EXCEPTION '0028: core.stock_movement stock_movement_check is not the 0005 sign CASE 0028 replaces';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
              WHERE (s.nspname, c.relname) IN (('platform', 'cares_city'), ('platform', 'cares_recipient'), ('platform', 'cares_enablement'),
                                               ('platform', 'network_snapshot'), ('core', 'cares_profile'), ('core', 'cares_outlet'),
                                               ('core', 'cares_listing'), ('core', 'cares_listing_line'), ('core', 'cares_handover'),
                                               ('core', 'cares_handover_line'), ('core', 'cares_claim'), ('core', 'cares_claim_line'),
                                               ('core', 'cares_allocation')))
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname IN ('core', 'platform') AND p.proname LIKE 'cares\_%')
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'core.task'::regclass AND attname = 'cares_listing_id')
     OR EXISTS (SELECT 1 FROM core.command_authority WHERE command_type LIKE 'cares.%')
     OR EXISTS (SELECT 1 FROM core.derivation_rule WHERE rule_id LIKE 'inventory.cares\_%')
     OR EXISTS (SELECT 1 FROM evidence.snapshot_template WHERE id LIKE 'cares.%' OR id = 'platform.cares_network_impact') THEN
    RAISE EXCEPTION '0028: a Cares object already exists';
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.prosecdef AND p.proowner = 'munim_crosstenant'::regrole) <> 7 THEN
    RAISE EXCEPTION '0028: expected the 7 munim_crosstenant definer functions of 0017';
  END IF;
END $$;

------------------------------------------------------------------------------------------------------------
-- 1. P1 — platform tables (operator-managed)
------------------------------------------------------------------------------------------------------------
CREATE TABLE platform.cares_city (
  code         text        PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  country_code char(2)     NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  name         text        NOT NULL CHECK (name <> ''),
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Recipients are simulated only (founder answer 2): both CHECKs are the database's own refusal, whatever the caller.
CREATE TABLE platform.cares_recipient (
  id                        uuid        PRIMARY KEY,
  city_code                 text        NOT NULL REFERENCES platform.cares_city (code),
  name                      text        NOT NULL,
  kind                      text        NOT NULL CHECK (kind IN ('ngo', 'food_bank')),
  simulated                 boolean     NOT NULL,
  accepts_cooked            boolean     NOT NULL,
  accepts_raw               boolean     NOT NULL,
  accepts_packaged          boolean     NOT NULL,
  capacity_kg_per_day       integer     NOT NULL CHECK (capacity_kg_per_day >= 0),
  capacity_portions_per_day integer     NOT NULL CHECK (capacity_portions_per_day >= 0),
  receiving_from            time        NOT NULL,
  receiving_to              time        NOT NULL,
  lat_e6                    integer     NOT NULL CHECK (lat_e6 BETWEEN -90000000 AND 90000000),
  lng_e6                    integer     NOT NULL CHECK (lng_e6 BETWEEN -180000000 AND 180000000),
  status                    text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cares_recipient_simulated_check CHECK (simulated),
  CONSTRAINT cares_recipient_name_simulated_check CHECK (name ~ '\(simulated\)'),
  CHECK (receiving_to > receiving_from)
);

-- Set only by an approved config draft (target cares_enablement:<tenant>, R24); never inferred from is_demo.
CREATE TABLE platform.cares_enablement (
  tenant_id       uuid        PRIMARY KEY REFERENCES core.tenant (tenant_id),
  enabled         boolean     NOT NULL,
  config_draft_id uuid        NOT NULL REFERENCES platform.config_draft (id),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The network impact total (§2.3): minted by an operator's own command on munim_core, published by an approved config
-- draft. Append-only; published_at and publish_draft_id are written once, together (trigger below).
CREATE TABLE platform.network_snapshot (
  id                    uuid        PRIMARY KEY,
  template_id           text        NOT NULL,
  template_version      integer     NOT NULL,
  params                jsonb       NOT NULL DEFAULT '{}',
  rows                  jsonb       NOT NULL CHECK (jsonb_typeof(rows) = 'array'),
  row_count             integer     NOT NULL CHECK (row_count BETWEEN 0 AND 500),
  sha256                text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  minted_by_operator_id uuid        NOT NULL REFERENCES platform.operator (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  published_at          timestamptz,
  publish_draft_id      uuid        REFERENCES platform.config_draft (id),
  FOREIGN KEY (template_id, template_version) REFERENCES evidence.snapshot_template (id, version),
  CHECK (row_count = jsonb_array_length(rows)),
  CONSTRAINT network_snapshot_published_pair CHECK ((published_at IS NULL) = (publish_draft_id IS NULL))
);

CREATE FUNCTION platform.network_snapshot_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.published_at IS NOT NULL OR NEW.publish_draft_id IS NOT NULL THEN
      RAISE EXCEPTION 'illegal_transition: a network snapshot is minted unpublished' USING ERRCODE = 'MB004';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM evidence.snapshot_template t WHERE t.id = NEW.template_id AND t.version = NEW.template_version
                      AND t.min_role = 'operator' AND t.id ~ '^platform\.') THEN
      RAISE EXCEPTION 'network snapshot % names %@%, which is not an operator platform template', NEW.id, NEW.template_id, NEW.template_version
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.published_at IS NOT NULL
     OR (NEW.id, NEW.template_id, NEW.template_version, NEW.params, NEW.rows, NEW.row_count, NEW.sha256, NEW.minted_by_operator_id, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.template_id, OLD.template_version, OLD.params, OLD.rows, OLD.row_count, OLD.sha256, OLD.minted_by_operator_id, OLD.created_at) THEN
    RAISE EXCEPTION 'illegal_transition: network snapshot % is published once and never changes', OLD.id USING ERRCODE = 'MB004';
  END IF;
  -- The publishing draft names this snapshot (target cares_public_impact:<id>) and is not rejected or stale. core-api's
  -- approve writes the target before it flips the draft to applied, so 'proposed' is the state seen here (platform/drafts.ts);
  -- that it is applied by the time the transaction commits is the deferred cares_draft_applied check below.
  IF NEW.published_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM platform.config_draft d WHERE d.id = NEW.publish_draft_id
                        AND d.target = 'cares_public_impact:' || NEW.id::text AND d.status IN ('proposed', 'applied')) THEN
    RAISE EXCEPTION 'illegal_transition: network snapshot % is published only by a config draft that targets it', OLD.id USING ERRCODE = 'MB004';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.network_snapshot_rules() FROM PUBLIC;

-- An enablement row (insert or change) names a config draft for this tenant (target cares_enablement:<tenant>) that is
-- not rejected or stale; applied-at-commit is the deferred check below.
CREATE FUNCTION platform.cares_enablement_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform.config_draft d WHERE d.id = NEW.config_draft_id
                    AND d.target = 'cares_enablement:' || NEW.tenant_id::text AND d.status IN ('proposed', 'applied')) THEN
    RAISE EXCEPTION 'illegal_transition: Cares enablement of % is written only by a config draft that targets it', NEW.tenant_id
      USING ERRCODE = 'MB004';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION platform.cares_enablement_rules() FROM PUBLIC;

-- R24: the publish and every enablement write are an approved config draft's — at COMMIT the draft they name is applied,
-- and applied in this transaction (decided_at = now(), the transaction's start: approve applies the patch and flips the
-- draft in one transaction, platform/drafts.ts), so an old applied draft cannot be replayed onto a later write.
-- Deferred: inside approve the target row is written before the draft is flipped.
CREATE FUNCTION platform.cares_draft_applied() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  draft uuid;
BEGIN
  IF TG_TABLE_NAME = 'network_snapshot' THEN
    IF NEW.published_at IS NULL THEN RETURN NULL; END IF;
    draft := NEW.publish_draft_id;
  ELSE
    draft := NEW.config_draft_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM platform.config_draft d WHERE d.id = draft AND d.status = 'applied' AND d.decided_at = now()) THEN
    RAISE EXCEPTION 'illegal_transition: platform.% is written only by a config draft approved in the same transaction', TG_TABLE_NAME
      USING ERRCODE = 'MB004';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION platform.cares_draft_applied() FROM PUBLIC;

CREATE TRIGGER snapshot_rules BEFORE INSERT OR UPDATE ON platform.network_snapshot FOR EACH ROW EXECUTE FUNCTION platform.network_snapshot_rules();
CREATE CONSTRAINT TRIGGER draft_applied AFTER UPDATE ON platform.network_snapshot DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.cares_draft_applied();
CREATE TRIGGER draft_target BEFORE INSERT OR UPDATE ON platform.cares_enablement FOR EACH ROW EXECUTE FUNCTION platform.cares_enablement_rules();
CREATE CONSTRAINT TRIGGER draft_applied AFTER INSERT OR UPDATE ON platform.cares_enablement DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION platform.cares_draft_applied();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON platform.cares_enablement FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

-- cares_enablement carries tenant_id: as platform.llm_budget (0002), plus the shopper deny policies (0014 F4 form).
ALTER TABLE platform.cares_enablement ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform.cares_enablement FORCE ROW LEVEL SECURITY;
CREATE POLICY operator_all ON platform.cares_enablement TO munim_platform USING (true) WITH CHECK (true);
CREATE POLICY tenant_read ON platform.cares_enablement FOR SELECT TO munim_core, munim_svc
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
CREATE POLICY customer_scope ON platform.cares_enablement AS RESTRICTIVE FOR ALL
  USING (((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'customer'))
  WITH CHECK (((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'customer'));
CREATE POLICY guest_scope ON platform.cares_enablement AS RESTRICTIVE FOR ALL
  USING (((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'guest'))
  WITH CHECK (((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'guest'));

-- Grants: revoke-then-grant per table. No DELETE/TRUNCATE; UPDATE column-pinned (never id, code or simulated).
REVOKE ALL ON platform.cares_city, platform.cares_recipient, platform.cares_enablement, platform.network_snapshot FROM PUBLIC;

GRANT SELECT, INSERT ON platform.cares_city TO munim_platform;
GRANT UPDATE (name, status) ON platform.cares_city TO munim_platform;
GRANT SELECT ON platform.cares_city TO munim_core, munim_svc;

GRANT SELECT, INSERT ON platform.cares_recipient TO munim_platform;
GRANT UPDATE (city_code, name, kind, accepts_cooked, accepts_raw, accepts_packaged, capacity_kg_per_day, capacity_portions_per_day,
  receiving_from, receiving_to, lat_e6, lng_e6, status) ON platform.cares_recipient TO munim_platform;
GRANT SELECT ON platform.cares_recipient TO munim_core, munim_svc;

GRANT SELECT, INSERT ON platform.cares_enablement TO munim_platform;
GRANT UPDATE (enabled, config_draft_id, updated_at) ON platform.cares_enablement TO munim_platform;
GRANT SELECT ON platform.cares_enablement TO munim_core, munim_svc;

GRANT SELECT ON platform.network_snapshot TO munim_platform;
GRANT UPDATE (published_at, publish_draft_id) ON platform.network_snapshot TO munim_platform;
GRANT SELECT, INSERT ON platform.network_snapshot TO munim_core;

CREATE INDEX cares_recipient_city_idx ON platform.cares_recipient (city_code, status);
CREATE INDEX network_snapshot_published_idx ON platform.network_snapshot (published_at DESC) WHERE published_at IS NOT NULL;

------------------------------------------------------------------------------------------------------------
-- 2. C1 — tenant tables (core, munim:book)
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.cares_profile (
  tenant_id   uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id          uuid        NOT NULL,
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  public_name text        NOT NULL CHECK (length(public_name) BETWEEN 1 AND 120),
  b2b_enabled boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  origin      jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT cares_profile_one_per_tenant UNIQUE (tenant_id)
);

CREATE TABLE core.cares_outlet (
  tenant_id   uuid        NOT NULL,
  outlet_id   uuid        NOT NULL,
  city_code   text        NOT NULL REFERENCES platform.cares_city (code),
  lat_e6      integer     NOT NULL CHECK (lat_e6 BETWEEN -90000000 AND 90000000),
  lng_e6      integer     NOT NULL CHECK (lng_e6 BETWEEN -180000000 AND 180000000),
  pickup_from time        NOT NULL,
  pickup_to   time        NOT NULL,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  origin      jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, outlet_id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  CHECK (pickup_to > pickup_from)
);

-- A donation names its (simulated) recipient; an offer names none (its buyer claims it).
CREATE TABLE core.cares_listing (
  tenant_id    uuid        NOT NULL,
  id           uuid        NOT NULL,
  outlet_id    uuid        NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('donation', 'offer')),
  status       text        NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'allocated', 'closed', 'withdrawn')),
  recipient_id uuid        REFERENCES platform.cares_recipient (id),
  pickup_from  timestamptz NOT NULL,
  pickup_to    timestamptz NOT NULL,
  pickup_on    date        NOT NULL,
  published_by uuid        NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  origin       jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT cares_listing_outlet_key UNIQUE (tenant_id, id, outlet_id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.cares_outlet (tenant_id, outlet_id),
  FOREIGN KEY (tenant_id, published_by) REFERENCES core.member (tenant_id, id),
  CHECK (pickup_to > pickup_from),
  CONSTRAINT cares_listing_recipient_check CHECK ((kind = 'donation') = (recipient_id IS NOT NULL))
);

-- Exactly one of item (cooked, counted in portions) / ingredient (raw or packaged, optionally a batch).
CREATE TABLE core.cares_listing_line (
  tenant_id        uuid        NOT NULL,
  id               uuid        NOT NULL,
  listing_id       uuid        NOT NULL,
  line_no          integer     NOT NULL CHECK (line_no >= 1),
  food_kind        text        NOT NULL CHECK (food_kind IN ('cooked', 'raw', 'packaged')),
  item_id          uuid,
  ingredient_id    uuid,
  batch_id         uuid,
  qty_milli        bigint      NOT NULL CHECK (qty_milli > 0),
  unit             text        NOT NULL CHECK (unit ~ '^[a-z][a-z_]{0,15}$'),
  expires_on       date,
  unit_price_minor bigint      CHECK (unit_price_minor >= 0),
  currency         char(3),
  created_at       timestamptz NOT NULL DEFAULT now(),
  origin           jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT cares_listing_line_no_unique UNIQUE (tenant_id, listing_id, line_no),
  FOREIGN KEY (tenant_id, listing_id) REFERENCES core.cares_listing (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES core.item (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES core.batch (tenant_id, id),
  CONSTRAINT cares_listing_line_one_subject CHECK (num_nonnulls(item_id, ingredient_id) = 1),
  CONSTRAINT cares_listing_line_cooked_item CHECK ((food_kind = 'cooked') = (item_id IS NOT NULL)),
  -- A cooked line is counted in portions (the recipe × N bound of inventory.cares_handover reads it so).
  CONSTRAINT cares_listing_line_cooked_portion CHECK (food_kind <> 'cooked' OR unit = 'portion'),
  CHECK (batch_id IS NULL OR ingredient_id IS NOT NULL),
  CHECK ((unit_price_minor IS NULL) = (currency IS NULL))
);

-- A hand-over is recorded once and voided at most once (no editing: void, then re-record).
CREATE TABLE core.cares_handover (
  tenant_id        uuid        NOT NULL,
  id               uuid        NOT NULL,
  listing_id       uuid        NOT NULL,
  outlet_id        uuid        NOT NULL,
  allocation_id    uuid,
  status           text        NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'voided')),
  handed_at        timestamptz NOT NULL DEFAULT now(),
  recorded_by      uuid        NOT NULL,
  voided_by        uuid,
  void_reason_code text        CHECK (void_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  origin           jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, listing_id, outlet_id) REFERENCES core.cares_listing (tenant_id, id, outlet_id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES core.member (tenant_id, id),
  FOREIGN KEY (tenant_id, voided_by) REFERENCES core.member (tenant_id, id),
  CONSTRAINT cares_handover_void_pair CHECK ((status = 'voided') = (voided_by IS NOT NULL AND void_reason_code IS NOT NULL))
);

CREATE TABLE core.cares_handover_line (
  tenant_id       uuid        NOT NULL,
  id              uuid        NOT NULL,
  handover_id     uuid        NOT NULL,
  listing_line_id uuid        NOT NULL,
  qty_milli       bigint      NOT NULL CHECK (qty_milli > 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  origin          jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT cares_handover_line_unique UNIQUE (tenant_id, handover_id, listing_line_id),
  FOREIGN KEY (tenant_id, handover_id) REFERENCES core.cares_handover (tenant_id, id),
  FOREIGN KEY (tenant_id, listing_line_id) REFERENCES core.cares_listing_line (tenant_id, id)
);

-- The buyer's claim on another tenant's offer: all lines at the offered quantities (all-or-nothing). offer_* and
-- allocation_id name the offerer's rows — plain uuids, no FK (see the header). Money is recorded, never processed.
CREATE TABLE core.cares_claim (
  tenant_id        uuid        NOT NULL,
  id               uuid        NOT NULL,
  outlet_id        uuid        NOT NULL,
  offer_tenant_id  uuid        NOT NULL,
  offer_listing_id uuid        NOT NULL,
  allocation_id    uuid,
  status           text        NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'cancelled', 'closed', 'received')),
  total_minor      bigint      NOT NULL CHECK (total_minor >= 0),
  currency         char(3)     NOT NULL,
  created_by       uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  origin           jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.cares_outlet (tenant_id, outlet_id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES core.member (tenant_id, id),
  CONSTRAINT cares_claim_other_tenant CHECK (offer_tenant_id <> tenant_id),
  CONSTRAINT cares_claim_received_allocation CHECK (status <> 'received' OR allocation_id IS NOT NULL)
);

CREATE TABLE core.cares_claim_line (
  tenant_id          uuid        NOT NULL,
  id                 uuid        NOT NULL,
  claim_id           uuid        NOT NULL,
  offer_line_id      uuid        NOT NULL,
  ingredient_id      uuid        NOT NULL,
  qty_milli          bigint      NOT NULL CHECK (qty_milli > 0),
  unit               text        NOT NULL CHECK (unit ~ '^[a-z][a-z_]{0,15}$'),
  unit_price_minor   bigint      NOT NULL CHECK (unit_price_minor >= 0),
  expires_on         date,
  received_qty_milli bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  origin             jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT cares_claim_line_unique UNIQUE (tenant_id, claim_id, offer_line_id),
  FOREIGN KEY (tenant_id, claim_id) REFERENCES core.cares_claim (tenant_id, id),
  FOREIGN KEY (tenant_id, ingredient_id) REFERENCES core.ingredient (tenant_id, id),
  CONSTRAINT cares_claim_line_received_check CHECK (received_qty_milli BETWEEN 0 AND qty_milli)
);

-- The offerer's verdict on one claim. Immutable (no UPDATE grant); one accepted claim per offer.
CREATE TABLE core.cares_allocation (
  tenant_id         uuid        NOT NULL,
  id                uuid        NOT NULL,
  listing_id        uuid        NOT NULL,
  outlet_id         uuid        NOT NULL,
  claim_tenant_id   uuid        NOT NULL,
  claim_id          uuid        NOT NULL,
  buyer_public_name text        NOT NULL CHECK (length(buyer_public_name) BETWEEN 1 AND 120),
  verdict           text        NOT NULL CHECK (verdict IN ('accepted', 'declined')),
  total_minor       bigint      NOT NULL CHECK (total_minor >= 0),
  currency          char(3)     NOT NULL,
  decided_by        uuid        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  origin            jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT cares_allocation_listing_key UNIQUE (tenant_id, id, listing_id),
  CONSTRAINT cares_allocation_one_per_claim UNIQUE (tenant_id, claim_tenant_id, claim_id),
  FOREIGN KEY (tenant_id, listing_id, outlet_id) REFERENCES core.cares_listing (tenant_id, id, outlet_id),
  FOREIGN KEY (tenant_id, decided_by) REFERENCES core.member (tenant_id, id),
  CONSTRAINT cares_allocation_other_tenant CHECK (claim_tenant_id <> tenant_id)
);
CREATE UNIQUE INDEX cares_allocation_one_accepted ON core.cares_allocation (tenant_id, listing_id) WHERE verdict = 'accepted';

-- An offer's hand-over carries the listing's allocation (composite: the allocation is of this listing).
ALTER TABLE core.cares_handover
  ADD FOREIGN KEY (tenant_id, allocation_id, listing_id) REFERENCES core.cares_allocation (tenant_id, id, listing_id);

------------------------------------------------------------------------------------------------------------
-- 3. C2 — core.task.cares_listing_id (goals.task.create.v1, ADR-015 §4)
------------------------------------------------------------------------------------------------------------
ALTER TABLE core.task ADD COLUMN cares_listing_id uuid;
ALTER TABLE core.task ADD CONSTRAINT task_cares_listing_fk FOREIGN KEY (tenant_id, cares_listing_id) REFERENCES core.cares_listing (tenant_id, id);

------------------------------------------------------------------------------------------------------------
-- 4. S1 — stock kinds (both 0005 CHECKs replaced by name)
------------------------------------------------------------------------------------------------------------
ALTER TABLE core.stock_movement DROP CONSTRAINT stock_movement_kind_check, DROP CONSTRAINT stock_movement_check;
ALTER TABLE core.stock_movement
  ADD CONSTRAINT stock_movement_kind_check CHECK (kind IN ('receipt', 'sale_consumption', 'waste', 'transfer_out', 'transfer_in',
    'count_adjust', 'supplier_return', 'sale_return', 'donation', 'surplus_out', 'surplus_in', 'cares_reversal')),
  ADD CONSTRAINT stock_movement_sign_check CHECK (CASE
    WHEN kind IN ('receipt', 'transfer_in', 'sale_return', 'surplus_in', 'cares_reversal') THEN qty_milli > 0
    WHEN kind IN ('sale_consumption', 'waste', 'transfer_out', 'supplier_return', 'donation', 'surplus_out') THEN qty_milli < 0
    ELSE qty_milli <> 0 END);

------------------------------------------------------------------------------------------------------------
-- 5. C1 — row rules (triggers named cares_rules / status_transition / currency_check: all sort after book_guard)
------------------------------------------------------------------------------------------------------------
-- The guard's own-command branch admits any command that lists a table, for any operation and any granted column
-- (it checks role, table and scope). Several Cares commands share tables, so each row operation is pinned here to the
-- command that owns it (MB004 otherwise): a staff hand-over cannot insert a listing or void; receive cannot cancel.
-- The command is the approved draft's when one executes in this transaction (the guard's branch 2, checked first;
-- core.cares_decision_command), else the caller's own (app.command_type).
CREATE FUNCTION core.cares_decision_command(tenant uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.command_type FROM core.decision d JOIN core.draft r ON r.tenant_id = d.tenant_id AND r.id = d.draft_id
   WHERE d.tenant_id = tenant AND d.id::text = nullif(current_setting('app.decision_id', true), '')
     AND d.verdict IN ('approved', 'edited') AND r.status = 'executing' AND r.exec_txid = txid_current()
$$;
REVOKE ALL ON FUNCTION core.cares_decision_command(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.cares_decision_command(uuid) TO munim_core;

CREATE FUNCTION core.cares_command(tenant uuid) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT coalesce(core.cares_decision_command(tenant), nullif(current_setting('app.command_type', true), ''))
$$;
REVOKE ALL ON FUNCTION core.cares_command(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.cares_command(uuid) TO munim_core;

-- Actor columns (published_by, recorded_by, voided_by, created_by, decided_by) are the signed-in member, as 0005's
-- expired_override_rules (R40 C7, MB005): under an approved draft that is the approver (core.decision.decided_by is
-- app.member_id, 0003 decision_named_person). Checked after the command checks, so a sibling command still gets MB004.

-- Listing: inserted by publish only; each status move by its own command (withdraw → withdrawn, decide → allocated,
-- a hand-over → closed, and only by a hand-over recorded in this transaction with at least one line).
CREATE FUNCTION core.cares_listing_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  d   date;
  cmd text := core.cares_command(NEW.tenant_id);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT ((cmd = 'cares.listing.withdraw.v1' AND NEW.status = 'withdrawn') OR (cmd = 'cares.claim.decide.v1' AND NEW.status = 'allocated')
                OR (cmd = 'cares.handover.record.v1' AND NEW.status = 'closed')) THEN
      RAISE EXCEPTION 'illegal_transition: cares listing % → % is not a move of %', OLD.id, NEW.status, coalesce(cmd, 'this context')
        USING ERRCODE = 'MB004';
    END IF;
    -- created_at = now(): this transaction's start (its default), so an earlier hand-over cannot close the listing later.
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'closed'
       AND NOT EXISTS (SELECT 1 FROM core.cares_handover h
                        WHERE h.tenant_id = NEW.tenant_id AND h.listing_id = NEW.id AND h.status = 'recorded' AND h.created_at = now()
                          AND EXISTS (SELECT 1 FROM core.cares_handover_line hl WHERE hl.tenant_id = h.tenant_id AND hl.handover_id = h.id)) THEN
      RAISE EXCEPTION 'illegal_transition: cares listing % is closed only by the hand-over recorded with it', OLD.id USING ERRCODE = 'MB004';
    END IF;
    RETURN NEW;
  END IF;
  IF cmd IS DISTINCT FROM 'cares.listing.publish.v1' THEN
    RAISE EXCEPTION 'illegal_transition: a Cares listing is inserted only by cares.listing.publish.v1, not %', coalesce(cmd, 'this context')
      USING ERRCODE = 'MB004';
  END IF;
  IF NEW.status <> 'published' THEN
    RAISE EXCEPTION 'illegal_transition: a Cares listing is created as published' USING ERRCODE = 'MB004';
  END IF;
  IF NEW.published_by::text IS DISTINCT FROM nullif(current_setting('app.member_id', true), '') THEN
    RAISE EXCEPTION 'override_refused: published_by must be the signed-in member' USING ERRCODE = 'MB005';
  END IF;
  SELECT ((NEW.pickup_from AT TIME ZONE o.tz) - o.business_day_cutoff)::date INTO d
    FROM core.outlet o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.outlet_id;
  IF NEW.pickup_on IS DISTINCT FROM d THEN
    RAISE EXCEPTION 'cares listing %: pickup_on % is not the outlet''s business date % of pickup_from', NEW.id, NEW.pickup_on, d
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.cares_listing_rules() FROM PUBLIC;

CREATE FUNCTION core.cares_listing_line_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  l_kind   text;
  l_status text;
  cmd      text := core.cares_command(NEW.tenant_id);
BEGIN
  IF cmd IS DISTINCT FROM 'cares.listing.publish.v1' THEN
    RAISE EXCEPTION 'illegal_transition: a listing line is inserted only by cares.listing.publish.v1, not %', coalesce(cmd, 'this context')
      USING ERRCODE = 'MB004';
  END IF;
  SELECT l.kind, l.status INTO l_kind, l_status FROM core.cares_listing l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.listing_id;
  IF l_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'illegal_transition: lines are added only to a published listing' USING ERRCODE = 'MB004';
  END IF;
  -- ADR-015 §1.3: cooked food is listed only by the owner's own command, never by approving a draft.
  IF NEW.food_kind = 'cooked' AND core.cares_decision_command(NEW.tenant_id) IS NOT NULL THEN
    RAISE EXCEPTION 'illegal_transition: a cooked line is published only by its owner''s own command, not a draft' USING ERRCODE = 'MB004';
  END IF;
  IF l_kind = 'donation' AND NEW.unit_price_minor IS NOT NULL THEN
    RAISE EXCEPTION 'cares listing line %: a donation line carries no price', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF l_kind = 'offer' AND (NEW.unit_price_minor IS NULL OR NEW.food_kind = 'cooked') THEN
    RAISE EXCEPTION 'cares listing line %: an offer line is priced and never cooked', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.cares_listing_line_rules() FROM PUBLIC;

-- A hand-over is of a live listing: a donation still published, an offer allocated (accepted); never one withdrawn,
-- closed, or an offer still waiting for its decision. cares_handover_line_bound re-reads this under the row lock.
CREATE FUNCTION core.cares_handover_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  l_kind   text;
  l_status text;
  cmd      text := core.cares_command(NEW.tenant_id);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- voided is final: a second void (voided → voided) and an un-void both stop here.
    IF OLD.status = 'voided' THEN
      RAISE EXCEPTION 'illegal_transition: hand-over % is voided and final', OLD.id USING ERRCODE = 'MB004';
    END IF;
    IF (NEW.status, NEW.voided_by, NEW.void_reason_code) IS DISTINCT FROM (OLD.status, OLD.voided_by, OLD.void_reason_code)
       AND NOT (cmd = 'cares.handover.void.v1' AND NEW.status = 'voided') THEN
      RAISE EXCEPTION 'illegal_transition: hand-over % is voided only by cares.handover.void.v1, not %', OLD.id, coalesce(cmd, 'this context')
        USING ERRCODE = 'MB004';
    END IF;
    IF NEW.status = 'voided' AND NEW.voided_by::text IS DISTINCT FROM nullif(current_setting('app.member_id', true), '') THEN
      RAISE EXCEPTION 'override_refused: voided_by must be the signed-in member' USING ERRCODE = 'MB005';
    END IF;
    RETURN NEW;
  END IF;
  IF cmd IS DISTINCT FROM 'cares.handover.record.v1' THEN
    RAISE EXCEPTION 'illegal_transition: a hand-over is inserted only by cares.handover.record.v1, not %', coalesce(cmd, 'this context')
      USING ERRCODE = 'MB004';
  END IF;
  IF NEW.status <> 'recorded' THEN
    RAISE EXCEPTION 'illegal_transition: a hand-over is created as recorded' USING ERRCODE = 'MB004';
  END IF;
  IF NEW.recorded_by::text IS DISTINCT FROM nullif(current_setting('app.member_id', true), '') THEN
    RAISE EXCEPTION 'override_refused: recorded_by must be the signed-in member' USING ERRCODE = 'MB005';
  END IF;
  SELECT l.kind, l.status INTO l_kind, l_status FROM core.cares_listing l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.listing_id;
  IF (l_kind, l_status) IS DISTINCT FROM ('donation', 'published') AND (l_kind, l_status) IS DISTINCT FROM ('offer', 'allocated') THEN
    RAISE EXCEPTION 'illegal_transition: hand-over % of a listing that is % (a donation hands over while published, an offer once allocated)',
      NEW.id, coalesce(l_status, 'not visible') USING ERRCODE = 'MB004';
  END IF;
  IF (l_kind = 'donation' AND NEW.allocation_id IS NOT NULL)
     OR (l_kind = 'offer' AND NOT EXISTS (SELECT 1 FROM core.cares_allocation a
                                           WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.allocation_id
                                             AND a.listing_id = NEW.listing_id AND a.verdict = 'accepted')) THEN
    RAISE EXCEPTION 'hand-over %: a donation carries no allocation; an offer carries its accepted allocation', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.cares_handover_rules() FROM PUBLIC;

-- Σ of non-voided hand-over quantities per listing line ≤ the line's approved qty_milli. The listing row is locked
-- FOR UPDATE first, so two concurrent hand-overs of one listing are judged one after the other (ADR-015 §1.2), and its
-- kind and status are read under that lock (a withdraw that committed while this hand-over waited is seen here).
CREATE FUNCTION core.cares_handover_line_bound() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  h_listing uuid;
  h_status  text;
  l_kind    text;
  l_status  text;
  l_listing uuid;
  l_qty     bigint;
  handed    bigint;
  cmd       text := core.cares_command(NEW.tenant_id);
BEGIN
  IF cmd IS DISTINCT FROM 'cares.handover.record.v1' THEN
    RAISE EXCEPTION 'illegal_transition: a hand-over line is inserted only by cares.handover.record.v1, not %', coalesce(cmd, 'this context')
      USING ERRCODE = 'MB004';
  END IF;
  SELECT h.listing_id, h.status INTO h_listing, h_status FROM core.cares_handover h WHERE h.tenant_id = NEW.tenant_id AND h.id = NEW.handover_id;
  SELECT l.kind, l.status INTO l_kind, l_status FROM core.cares_listing l WHERE l.tenant_id = NEW.tenant_id AND l.id = h_listing FOR UPDATE;
  IF (l_kind, l_status) IS DISTINCT FROM ('donation', 'published') AND (l_kind, l_status) IS DISTINCT FROM ('offer', 'allocated') THEN
    RAISE EXCEPTION 'illegal_transition: hand-over line % of a listing that is %', NEW.id, coalesce(l_status, 'not visible') USING ERRCODE = 'MB004';
  END IF;
  SELECT ll.listing_id, ll.qty_milli INTO l_listing, l_qty FROM core.cares_listing_line ll WHERE ll.tenant_id = NEW.tenant_id AND ll.id = NEW.listing_line_id;
  IF h_status IS DISTINCT FROM 'recorded' OR l_listing IS DISTINCT FROM h_listing THEN
    RAISE EXCEPTION 'hand-over line %: its listing line is not a line of the recorded hand-over''s listing', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(hl.qty_milli), 0) INTO handed
    FROM core.cares_handover_line hl
    JOIN core.cares_handover h ON h.tenant_id = hl.tenant_id AND h.id = hl.handover_id AND h.status = 'recorded'
   WHERE hl.tenant_id = NEW.tenant_id AND hl.listing_line_id = NEW.listing_line_id;
  IF handed + NEW.qty_milli > l_qty THEN
    RAISE EXCEPTION 'book_write_refused: core.cares_handover_line — % handed over against listing line % of %', handed + NEW.qty_milli,
      NEW.listing_line_id, l_qty USING ERRCODE = 'MB001', HINT = 'a hand-over never exceeds the approved listing line';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.cares_handover_line_bound() FROM PUBLIC;

-- Claim: created by create; cancel → cancelled, close → closed, receive → received; allocation_id set once, by receive,
-- to the allocation the offerer accepted for this claim (core.cares_claim_outcome, read as the receiving member).
CREATE FUNCTION core.cares_claim_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cmd text := core.cares_command(NEW.tenant_id);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF cmd IS DISTINCT FROM 'cares.claim.create.v1' THEN
      RAISE EXCEPTION 'illegal_transition: a claim is inserted only by cares.claim.create.v1, not %', coalesce(cmd, 'this context')
        USING ERRCODE = 'MB004';
    END IF;
    IF NEW.status <> 'requested' OR NEW.allocation_id IS NOT NULL THEN
      RAISE EXCEPTION 'illegal_transition: a claim is created as requested, with no allocation' USING ERRCODE = 'MB004';
    END IF;
    IF NEW.created_by::text IS DISTINCT FROM nullif(current_setting('app.member_id', true), '') THEN
      RAISE EXCEPTION 'override_refused: created_by must be the signed-in member' USING ERRCODE = 'MB005';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((cmd = 'cares.claim.cancel.v1' AND NEW.status = 'cancelled') OR (cmd = 'cares.claim.close.v1' AND NEW.status = 'closed')
              OR (cmd = 'cares.claim.receive.v1' AND NEW.status = 'received')) THEN
    RAISE EXCEPTION 'illegal_transition: claim % → % is not a move of %', OLD.id, NEW.status, coalesce(cmd, 'this context') USING ERRCODE = 'MB004';
  END IF;
  IF NEW.allocation_id IS DISTINCT FROM OLD.allocation_id AND (OLD.allocation_id IS NOT NULL OR cmd IS DISTINCT FROM 'cares.claim.receive.v1') THEN
    RAISE EXCEPTION 'illegal_transition: claim % allocation is set once, by cares.claim.receive.v1', OLD.id USING ERRCODE = 'MB004';
  END IF;
  IF NEW.allocation_id IS DISTINCT FROM OLD.allocation_id
     AND NOT EXISTS (SELECT 1 FROM core.cares_claim_outcome(NEW.id) o WHERE o.verdict = 'accepted' AND o.allocation_id = NEW.allocation_id) THEN
    RAISE EXCEPTION 'illegal_transition: claim % allocation is the offerer''s accepted allocation of this claim', OLD.id USING ERRCODE = 'MB004';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.cares_claim_rules() FROM PUBLIC;

-- Claim line: created by create (received_qty_milli NULL); received_qty_milli set once, from NULL, by receive, to the
-- quantity the offerer handed over against that offer line (core.cares_claim_outcome of an accepted claim).
CREATE FUNCTION core.cares_claim_line_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cmd text := core.cares_command(NEW.tenant_id);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF cmd IS DISTINCT FROM 'cares.claim.create.v1' THEN
      RAISE EXCEPTION 'illegal_transition: a claim line is inserted only by cares.claim.create.v1, not %', coalesce(cmd, 'this context')
        USING ERRCODE = 'MB004';
    END IF;
    IF NEW.received_qty_milli IS NOT NULL THEN
      RAISE EXCEPTION 'illegal_transition: received_qty_milli is set by receive, not at claim' USING ERRCODE = 'MB004';
    END IF;
  ELSIF OLD.received_qty_milli IS NOT NULL AND NEW.received_qty_milli IS DISTINCT FROM OLD.received_qty_milli THEN
    RAISE EXCEPTION 'illegal_transition: claim line % received_qty_milli is set once', OLD.id USING ERRCODE = 'MB004';
  ELSIF NEW.received_qty_milli IS DISTINCT FROM OLD.received_qty_milli AND cmd IS DISTINCT FROM 'cares.claim.receive.v1' THEN
    RAISE EXCEPTION 'illegal_transition: claim line % received_qty_milli is set by cares.claim.receive.v1, not %', OLD.id, coalesce(cmd, 'this context')
      USING ERRCODE = 'MB004';
  ELSIF NEW.received_qty_milli IS DISTINCT FROM OLD.received_qty_milli
        AND NOT EXISTS (SELECT 1 FROM core.cares_claim_outcome(NEW.claim_id) o, jsonb_array_elements(o.lines) x
                         WHERE o.verdict = 'accepted' AND x ->> 'offer_line_id' = NEW.offer_line_id::text
                           AND (x ->> 'handed_qty_milli')::bigint = NEW.received_qty_milli) THEN
    RAISE EXCEPTION 'illegal_transition: claim line % received_qty_milli is the quantity handed over on an accepted claim', OLD.id
      USING ERRCODE = 'MB004';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.cares_claim_line_rules() FROM PUBLIC;

-- Allocation: inserted by decide only, by the signed-in member, on an offer; an accepted one only while the offer is
-- still published (the decide handler then moves it to allocated; one accepted per offer is the partial unique index).
CREATE FUNCTION core.cares_allocation_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  l_kind   text;
  l_status text;
  cmd      text := core.cares_command(NEW.tenant_id);
BEGIN
  IF cmd IS DISTINCT FROM 'cares.claim.decide.v1' THEN
    RAISE EXCEPTION 'illegal_transition: an allocation is inserted only by cares.claim.decide.v1, not %', coalesce(cmd, 'this context')
      USING ERRCODE = 'MB004';
  END IF;
  IF NEW.decided_by::text IS DISTINCT FROM nullif(current_setting('app.member_id', true), '') THEN
    RAISE EXCEPTION 'override_refused: decided_by must be the signed-in member' USING ERRCODE = 'MB005';
  END IF;
  SELECT l.kind, l.status INTO l_kind, l_status FROM core.cares_listing l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.listing_id;
  IF l_kind IS DISTINCT FROM 'offer' OR (NEW.verdict = 'accepted' AND l_status IS DISTINCT FROM 'published') THEN
    RAISE EXCEPTION 'illegal_transition: allocation % decides an offer; an accepted one only a published offer (it is %)', NEW.id,
      coalesce(l_status, 'not visible') USING ERRCODE = 'MB004';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.cares_allocation_rules() FROM PUBLIC;

CREATE TRIGGER cares_rules BEFORE INSERT OR UPDATE ON core.cares_listing FOR EACH ROW EXECUTE FUNCTION core.cares_listing_rules();
CREATE TRIGGER cares_rules BEFORE INSERT ON core.cares_listing_line FOR EACH ROW EXECUTE FUNCTION core.cares_listing_line_rules();
CREATE TRIGGER cares_rules BEFORE INSERT OR UPDATE ON core.cares_handover FOR EACH ROW EXECUTE FUNCTION core.cares_handover_rules();
CREATE TRIGGER cares_rules BEFORE INSERT ON core.cares_handover_line FOR EACH ROW EXECUTE FUNCTION core.cares_handover_line_bound();
CREATE TRIGGER cares_rules BEFORE INSERT OR UPDATE ON core.cares_claim FOR EACH ROW EXECUTE FUNCTION core.cares_claim_rules();
CREATE TRIGGER cares_rules BEFORE INSERT OR UPDATE ON core.cares_claim_line FOR EACH ROW EXECUTE FUNCTION core.cares_claim_line_rules();
CREATE TRIGGER cares_rules BEFORE INSERT ON core.cares_allocation FOR EACH ROW EXECUTE FUNCTION core.cares_allocation_rules();

-- MB003 on every currency column (R30).
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.cares_listing_line FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.cares_claim FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.cares_allocation FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');

-- Status transitions (0014 #23): the legal (from → to) rows, and the trigger on each status-bearing table.
INSERT INTO core.book_status_transition (table_name, from_status, to_status) VALUES
  ('core.cares_listing', 'published', 'closed'), ('core.cares_listing', 'published', 'withdrawn'),
  ('core.cares_listing', 'published', 'allocated'), ('core.cares_listing', 'allocated', 'closed'),
  ('core.cares_claim', 'requested', 'cancelled'), ('core.cares_claim', 'requested', 'closed'), ('core.cares_claim', 'requested', 'received'),
  ('core.cares_handover', 'recorded', 'voided'),
  ('core.cares_profile', 'active', 'paused'), ('core.cares_profile', 'paused', 'active');
CREATE TRIGGER status_transition BEFORE UPDATE ON core.cares_listing FOR EACH ROW EXECUTE FUNCTION core.book_status_transition_check();
CREATE TRIGGER status_transition BEFORE UPDATE ON core.cares_claim FOR EACH ROW EXECUTE FUNCTION core.book_status_transition_check();
CREATE TRIGGER status_transition BEFORE UPDATE ON core.cares_handover FOR EACH ROW EXECUTE FUNCTION core.book_status_transition_check();
CREATE TRIGGER status_transition BEFORE UPDATE ON core.cares_profile FOR EACH ROW EXECUTE FUNCTION core.book_status_transition_check();

------------------------------------------------------------------------------------------------------------
-- 6. C1 — RLS: enable + force; one permissive policy (0019 forms) + the restrictive shopper deny policies (0020 form)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  t      text;
  r      record;
  tenant constant text := $c$tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)$c$;
  outlet constant text := $c$tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.role', true)) IN ('customer', 'guest')
              OR (SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[]))$c$;
  via    text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cares_profile', 'cares_outlet', 'cares_listing', 'cares_listing_line', 'cares_handover', 'cares_handover_line',
                           'cares_claim', 'cares_claim_line', 'cares_allocation'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY customer_scope ON core.%I AS RESTRICTIVE FOR ALL
      USING (((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'customer'))
      WITH CHECK (((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'customer'))$p$, t);
    EXECUTE format($p$CREATE POLICY guest_scope ON core.%I AS RESTRICTIVE FOR ALL
      USING (((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'guest'))
      WITH CHECK (((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'guest'))$p$, t);
  END LOOP;
  EXECUTE format('CREATE POLICY tenant_isolation ON core.cares_profile USING (%s) WITH CHECK (%s)', tenant, tenant);
  FOREACH t IN ARRAY ARRAY['cares_outlet', 'cares_listing', 'cares_handover', 'cares_claim', 'cares_allocation'] LOOP
    EXECUTE format('CREATE POLICY tenant_outlet_isolation ON core.%I USING (%s) WITH CHECK (%s)', t, outlet, outlet);
  END LOOP;
  -- Lines: read through their parent; new rows checked by tenant (written with their parent; the guard's book_scope
  -- 'parent' refuses a line under a parent the writer cannot see) — 0019 O2.
  FOR r IN SELECT * FROM (VALUES ('cares_listing_line', 'cares_listing', 'listing_id'), ('cares_handover_line', 'cares_handover', 'handover_id'),
                                 ('cares_claim_line', 'cares_claim', 'claim_id')) v(child, parent, fk) LOOP
    via := format('%s AND EXISTS (SELECT 1 FROM core.%I x WHERE x.tenant_id = %I.tenant_id AND x.id = %I.%I)', tenant, r.parent, r.child, r.child, r.fk);
    EXECUTE format('CREATE POLICY tenant_via_parent ON core.%I USING (%s) WITH CHECK (%s)', r.child, via, tenant);
  END LOOP;
END $$;

------------------------------------------------------------------------------------------------------------
-- 7. C1 — tags, book scope, the guard
------------------------------------------------------------------------------------------------------------
COMMENT ON TABLE core.cares_profile       IS 'munim:book';
COMMENT ON TABLE core.cares_outlet        IS 'munim:book';
COMMENT ON TABLE core.cares_listing       IS 'munim:book';
COMMENT ON TABLE core.cares_listing_line  IS 'munim:book';
COMMENT ON TABLE core.cares_handover      IS 'munim:book';
COMMENT ON TABLE core.cares_handover_line IS 'munim:book';
COMMENT ON TABLE core.cares_claim         IS 'munim:book';
COMMENT ON TABLE core.cares_claim_line    IS 'munim:book';
COMMENT ON TABLE core.cares_allocation    IS 'munim:book';

INSERT INTO core.book_scope (table_name, outlet_kind, outlet_ref, parent_table) VALUES
  ('core.cares_profile', 'none', NULL, NULL),
  ('core.cares_outlet', 'column', 'outlet_id', NULL),
  ('core.cares_listing', 'column', 'outlet_id', NULL),
  ('core.cares_handover', 'column', 'outlet_id', NULL),
  ('core.cares_claim', 'column', 'outlet_id', NULL),
  ('core.cares_allocation', 'column', 'outlet_id', NULL),
  ('core.cares_listing_line', 'parent', 'listing_id', 'core.cares_listing'),
  ('core.cares_handover_line', 'parent', 'handover_id', 'core.cares_handover'),
  ('core.cares_claim_line', 'parent', 'claim_id', 'core.cares_claim');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cares_profile', 'cares_outlet', 'cares_listing', 'cares_listing_line', 'cares_handover', 'cares_handover_line',
                           'cares_claim', 'cares_claim_line', 'cares_allocation'] LOOP
    EXECUTE format('CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.%I FOR EACH ROW EXECUTE FUNCTION core.guard_book_write()', t);
  END LOOP;
END $$;

------------------------------------------------------------------------------------------------------------
-- 8. C1, C2 — grants: revoke-then-grant per table. munim_core writes (UPDATE column-pinned); munim_svc SELECT only;
--    munim_intel_ro nothing. No DELETE/TRUNCATE for anyone.
------------------------------------------------------------------------------------------------------------
REVOKE ALL ON core.cares_profile, core.cares_outlet, core.cares_listing, core.cares_listing_line, core.cares_handover,
  core.cares_handover_line, core.cares_claim, core.cares_claim_line, core.cares_allocation FROM PUBLIC;

GRANT SELECT, INSERT ON core.cares_profile TO munim_core;
GRANT UPDATE (status, public_name, b2b_enabled) ON core.cares_profile TO munim_core;
GRANT SELECT ON core.cares_profile TO munim_svc;

GRANT SELECT, INSERT ON core.cares_outlet TO munim_core;
GRANT UPDATE (city_code, lat_e6, lng_e6, pickup_from, pickup_to, active) ON core.cares_outlet TO munim_core;
GRANT SELECT ON core.cares_outlet TO munim_svc;

GRANT SELECT, INSERT ON core.cares_listing TO munim_core;
GRANT UPDATE (status) ON core.cares_listing TO munim_core;
GRANT SELECT ON core.cares_listing TO munim_svc;

GRANT SELECT, INSERT ON core.cares_listing_line TO munim_core;
GRANT SELECT ON core.cares_listing_line TO munim_svc;

GRANT SELECT, INSERT ON core.cares_handover TO munim_core;
GRANT UPDATE (status, voided_by, void_reason_code) ON core.cares_handover TO munim_core;
GRANT SELECT ON core.cares_handover TO munim_svc;

GRANT SELECT, INSERT ON core.cares_handover_line TO munim_core;
GRANT SELECT ON core.cares_handover_line TO munim_svc;

GRANT SELECT, INSERT ON core.cares_claim TO munim_core;
GRANT UPDATE (status, allocation_id) ON core.cares_claim TO munim_core;
GRANT SELECT ON core.cares_claim TO munim_svc;

GRANT SELECT, INSERT ON core.cares_claim_line TO munim_core;
GRANT UPDATE (received_qty_milli) ON core.cares_claim_line TO munim_core;
GRANT SELECT ON core.cares_claim_line TO munim_svc;

GRANT SELECT, INSERT ON core.cares_allocation TO munim_core;
GRANT SELECT ON core.cares_allocation TO munim_svc;

------------------------------------------------------------------------------------------------------------
-- 9. Indexes (every tenant-led FK covered; gotcha 1: asserted from pg_index below)
------------------------------------------------------------------------------------------------------------
CREATE INDEX cares_listing_outlet_idx ON core.cares_listing (tenant_id, outlet_id, status);
CREATE INDEX cares_listing_published_by_fk_idx ON core.cares_listing (tenant_id, published_by);
-- The network page reads live donations across tenants by status and pickup end (core.cares_network_listings).
CREATE INDEX cares_listing_live_idx ON core.cares_listing (kind, status, pickup_to);
CREATE INDEX cares_listing_line_item_id_fk_idx ON core.cares_listing_line (tenant_id, item_id);
CREATE INDEX cares_listing_line_ingredient_id_fk_idx ON core.cares_listing_line (tenant_id, ingredient_id);
CREATE INDEX cares_listing_line_batch_id_fk_idx ON core.cares_listing_line (tenant_id, batch_id);
CREATE INDEX cares_handover_listing_fk_idx ON core.cares_handover (tenant_id, listing_id, outlet_id);
CREATE INDEX cares_handover_allocation_fk_idx ON core.cares_handover (tenant_id, allocation_id, listing_id);
CREATE INDEX cares_handover_recorded_by_fk_idx ON core.cares_handover (tenant_id, recorded_by);
CREATE INDEX cares_handover_voided_by_fk_idx ON core.cares_handover (tenant_id, voided_by);
CREATE INDEX cares_handover_line_listing_line_fk_idx ON core.cares_handover_line (tenant_id, listing_line_id);
CREATE INDEX cares_claim_outlet_idx ON core.cares_claim (tenant_id, outlet_id, status);
CREATE INDEX cares_claim_created_by_fk_idx ON core.cares_claim (tenant_id, created_by);
-- The offerer's inbound read (core.cares_inbound_claims) finds claims on its listing across buyer tenants.
CREATE INDEX cares_claim_offer_idx ON core.cares_claim (offer_tenant_id, offer_listing_id);
CREATE INDEX cares_claim_line_ingredient_id_fk_idx ON core.cares_claim_line (tenant_id, ingredient_id);
CREATE INDEX cares_allocation_listing_fk_idx ON core.cares_allocation (tenant_id, listing_id, outlet_id);
CREATE INDEX cares_allocation_decided_by_fk_idx ON core.cares_allocation (tenant_id, decided_by);
CREATE INDEX task_cares_listing_id_fk_idx ON core.task (tenant_id, cares_listing_id);

------------------------------------------------------------------------------------------------------------
-- 10. A1 — commands (§1.3; none draft-only). The handlers' final-payload checks (opt-in, recipient, expiry, on-hand)
--     are core-api's (T-095a); the guard binds each command to exactly the tables it writes.
------------------------------------------------------------------------------------------------------------
-- cares.handover.record.v1 also lists core.cares_listing so the hand-over can close it (published | allocated → closed; no
-- other command reaches 'closed'); cares_listing_rules lets it make that one move and nothing else.
INSERT INTO core.command_authority (command_type, allowed_roles, scope, target_tables) VALUES
  ('cares.profile.set.v1',       ARRAY['owner', 'judge'],                     'tenant', ARRAY['core.cares_profile', 'core.cares_outlet']),
  ('cares.listing.publish.v1',   ARRAY['owner', 'judge'],                     'outlet', ARRAY['core.cares_listing', 'core.cares_listing_line']),
  ('cares.listing.withdraw.v1',  ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.cares_listing']),
  ('cares.handover.record.v1',   ARRAY['owner', 'manager', 'staff', 'judge'], 'outlet', ARRAY['core.cares_handover', 'core.cares_handover_line', 'core.cares_listing']),
  ('cares.handover.void.v1',     ARRAY['owner', 'judge'],                     'outlet', ARRAY['core.cares_handover']),
  ('cares.claim.create.v1',      ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.cares_claim', 'core.cares_claim_line']),
  ('cares.claim.cancel.v1',      ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.cares_claim']),
  ('cares.claim.close.v1',       ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.cares_claim']),
  ('cares.claim.decide.v1',      ARRAY['owner', 'judge'],                     'outlet', ARRAY['core.cares_allocation', 'core.cares_listing']),
  ('cares.claim.receive.v1',     ARRAY['owner', 'manager', 'staff', 'judge'], 'outlet', ARRAY['core.cares_claim', 'core.cares_claim_line']);

------------------------------------------------------------------------------------------------------------
-- 11. D1 — derivation rules (bindings per 0022: s = source, n = written row; evaluated BEFORE n exists, so every
--     cumulative bound adds n itself). Mirrored by hand in db/derivation-rules.json.
------------------------------------------------------------------------------------------------------------
-- inventory.cares_handover: a recorded hand-over leaves stock as `donation` (donation listing) or `surplus_out` (offer),
-- at its outlet, referencing it, in the ingredient's base unit (so every movement of a hand-over shares one unit: a kg
-- row beside a g row would sum 0.2 kg + 199.8 g as 200 against a 200 g line). Per (ingredient, batch) and per
-- ingredient, Σ |qty| of its movements in that unit (n included) ≤ what its lines imply: a raw/packaged line its own qty
-- (kg↔g, l↔ml converted to the movement's unit) for its ingredient and batch (a line with no batch: any batch, FEFO); a
-- cooked line portions × the dish's recipe valid on the hand-over's business date, base-unit recipe lines only (as
-- consume_order, which skips any other), rounded up: core-domain rounds the exact rational half-up once.
-- inventory.cares_handover_void: a voided hand-over's `cares_reversal`, cumulative per (ingredient, batch, unit) ≤ Σ |out|.
-- inventory.cares_claim_receive: a received claim's `surplus_in` = one claim line's ingredient, unit and received qty
-- (cumulative per ingredient and unit ≤ Σ received in that unit), into a batch of that ingredient with the line's
-- expiry; the batch is a new row (o.id IS NULL: never an UPDATE of an existing one) with no MRP, supplier or GRN line.
INSERT INTO core.derivation_rule (rule_id, source_table, target_table, source_state, binding) VALUES
  ('inventory.cares_handover', 'core.cares_handover', 'core.stock_movement', $s$s.status = 'recorded'$s$,
   $b$n.ref_type = 'core.cares_handover' AND n.ref_id = s.id AND n.outlet_id = s.outlet_id AND n.unit = (SELECT g.base_unit FROM core.ingredient g WHERE g.tenant_id = s.tenant_id AND g.id = n.ingredient_id) AND n.kind = (SELECT CASE l.kind WHEN 'donation' THEN 'donation' ELSE 'surplus_out' END FROM core.cares_listing l WHERE l.tenant_id = s.tenant_id AND l.id = s.listing_id) AND -n.qty_milli + coalesce((SELECT sum(-m.qty_milli) FROM core.stock_movement m WHERE m.tenant_id = s.tenant_id AND m.ref_type = 'core.cares_handover' AND m.ref_id = s.id AND m.kind = n.kind AND m.unit = n.unit AND m.ingredient_id = n.ingredient_id AND m.batch_id IS NOT DISTINCT FROM n.batch_id), 0) <= (SELECT ceil(coalesce(sum(CASE WHEN ll.item_id IS NULL THEN CASE WHEN ll.ingredient_id = n.ingredient_id AND (ll.batch_id IS NULL OR ll.batch_id = n.batch_id) THEN hl.qty_milli * CASE WHEN ll.unit = n.unit THEN 1 ELSE (SELECT cv.f FROM (VALUES ('kg', 'g', 1000::numeric), ('g', 'kg', 0.001), ('l', 'ml', 1000), ('ml', 'l', 0.001)) cv (a, b, f) WHERE cv.a = ll.unit AND cv.b = n.unit) END END ELSE (SELECT sum(hl.qty_milli * rl.qty_milli * (10000 + rl.waste_pct_bp) / (10000.0 * rv.yield_qty_milli)) FROM core.outlet ou JOIN core.recipe_version rv ON rv.tenant_id = ou.tenant_id AND rv.item_id = ll.item_id AND rv.variant_id IS NULL AND rv.valid_from <= ((s.handed_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date AND (rv.valid_to IS NULL OR rv.valid_to > ((s.handed_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date) JOIN core.recipe_line rl ON rl.tenant_id = rv.tenant_id AND rl.recipe_version_id = rv.id AND rl.ingredient_id = n.ingredient_id AND rl.unit = n.unit WHERE ou.tenant_id = s.tenant_id AND ou.id = s.outlet_id) END), 0)) FROM core.cares_handover_line hl JOIN core.cares_listing_line ll ON ll.tenant_id = hl.tenant_id AND ll.id = hl.listing_line_id WHERE hl.tenant_id = s.tenant_id AND hl.handover_id = s.id) AND -n.qty_milli + coalesce((SELECT sum(-m.qty_milli) FROM core.stock_movement m WHERE m.tenant_id = s.tenant_id AND m.ref_type = 'core.cares_handover' AND m.ref_id = s.id AND m.kind = n.kind AND m.unit = n.unit AND m.ingredient_id = n.ingredient_id), 0) <= (SELECT ceil(coalesce(sum(CASE WHEN ll.item_id IS NULL THEN CASE WHEN ll.ingredient_id = n.ingredient_id THEN hl.qty_milli * CASE WHEN ll.unit = n.unit THEN 1 ELSE (SELECT cv.f FROM (VALUES ('kg', 'g', 1000::numeric), ('g', 'kg', 0.001), ('l', 'ml', 1000), ('ml', 'l', 0.001)) cv (a, b, f) WHERE cv.a = ll.unit AND cv.b = n.unit) END END ELSE (SELECT sum(hl.qty_milli * rl.qty_milli * (10000 + rl.waste_pct_bp) / (10000.0 * rv.yield_qty_milli)) FROM core.outlet ou JOIN core.recipe_version rv ON rv.tenant_id = ou.tenant_id AND rv.item_id = ll.item_id AND rv.variant_id IS NULL AND rv.valid_from <= ((s.handed_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date AND (rv.valid_to IS NULL OR rv.valid_to > ((s.handed_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date) JOIN core.recipe_line rl ON rl.tenant_id = rv.tenant_id AND rl.recipe_version_id = rv.id AND rl.ingredient_id = n.ingredient_id AND rl.unit = n.unit WHERE ou.tenant_id = s.tenant_id AND ou.id = s.outlet_id) END), 0)) FROM core.cares_handover_line hl JOIN core.cares_listing_line ll ON ll.tenant_id = hl.tenant_id AND ll.id = hl.listing_line_id WHERE hl.tenant_id = s.tenant_id AND hl.handover_id = s.id)$b$),
  ('inventory.cares_handover_void', 'core.cares_handover', 'core.stock_movement', $s$s.status = 'voided'$s$,
   $b$n.kind = 'cares_reversal' AND n.ref_type = 'core.cares_handover' AND n.ref_id = s.id AND n.outlet_id = s.outlet_id AND n.qty_milli + coalesce((SELECT sum(r.qty_milli) FROM core.stock_movement r WHERE r.tenant_id = s.tenant_id AND r.ref_type = 'core.cares_handover' AND r.ref_id = s.id AND r.kind = 'cares_reversal' AND r.ingredient_id = n.ingredient_id AND r.batch_id IS NOT DISTINCT FROM n.batch_id AND r.unit = n.unit), 0) <= coalesce((SELECT sum(-c.qty_milli) FROM core.stock_movement c WHERE c.tenant_id = s.tenant_id AND c.ref_type = 'core.cares_handover' AND c.ref_id = s.id AND c.kind IN ('donation', 'surplus_out') AND c.ingredient_id = n.ingredient_id AND c.batch_id IS NOT DISTINCT FROM n.batch_id AND c.unit = n.unit), 0)$b$),
  ('inventory.cares_claim_receive', 'core.cares_claim', 'core.stock_movement', $s$s.status = 'received'$s$,
   $b$n.kind = 'surplus_in' AND n.ref_type = 'core.cares_claim' AND n.ref_id = s.id AND n.outlet_id = s.outlet_id AND EXISTS (SELECT 1 FROM core.cares_claim_line cl WHERE cl.tenant_id = s.tenant_id AND cl.claim_id = s.id AND cl.ingredient_id = n.ingredient_id AND cl.unit = n.unit AND cl.received_qty_milli = n.qty_milli AND (n.batch_id IS NULL OR EXISTS (SELECT 1 FROM core.batch b WHERE b.tenant_id = s.tenant_id AND b.id = n.batch_id AND b.ingredient_id = n.ingredient_id AND b.expires_on IS NOT DISTINCT FROM cl.expires_on))) AND n.qty_milli + coalesce((SELECT sum(m.qty_milli) FROM core.stock_movement m WHERE m.tenant_id = s.tenant_id AND m.ref_type = 'core.cares_claim' AND m.ref_id = s.id AND m.kind = 'surplus_in' AND m.unit = n.unit AND m.ingredient_id = n.ingredient_id), 0) <= (SELECT coalesce(sum(cl.received_qty_milli), 0) FROM core.cares_claim_line cl WHERE cl.tenant_id = s.tenant_id AND cl.claim_id = s.id AND cl.ingredient_id = n.ingredient_id AND cl.unit = n.unit)$b$),
  ('inventory.cares_claim_receive', 'core.cares_claim', 'core.batch', $s$s.status = 'received'$s$,
   $b$o.id IS NULL AND n.mrp_minor IS NULL AND n.supplier_id IS NULL AND n.grn_line_id IS NULL AND n.outlet_id = s.outlet_id AND EXISTS (SELECT 1 FROM core.cares_claim_line cl WHERE cl.tenant_id = s.tenant_id AND cl.claim_id = s.id AND cl.ingredient_id = n.ingredient_id AND cl.received_qty_milli IS NOT NULL AND n.expires_on IS NOT DISTINCT FROM cl.expires_on)$b$);

-- inventory.transfer_in → core.batch creates the destination's batch (0015 R2-S1-7; core-api destinationBatch only
-- INSERTs): an UPDATE of an existing batch under this rule (its expiry or MRP) is no longer admitted (o.id IS NULL).
UPDATE core.derivation_rule SET binding = 'o.id IS NULL AND ' || binding
 WHERE rule_id = 'inventory.transfer_in' AND target_table = 'core.batch'
   AND binding = $b$n.outlet_id = s.to_outlet_id AND EXISTS (SELECT 1 FROM core.transfer_line l WHERE l.tenant_id = s.tenant_id AND l.transfer_id = s.id AND l.ingredient_id = n.ingredient_id)$b$;
DO $$
BEGIN
  IF (SELECT binding FROM core.derivation_rule WHERE rule_id = 'inventory.transfer_in' AND target_table = 'core.batch')
     IS DISTINCT FROM $b$o.id IS NULL AND n.outlet_id = s.to_outlet_id AND EXISTS (SELECT 1 FROM core.transfer_line l WHERE l.tenant_id = s.tenant_id AND l.transfer_id = s.id AND l.ingredient_id = n.ingredient_id)$b$ THEN
    RAISE EXCEPTION '0028: inventory.transfer_in → core.batch binding is not 0022''s text plus o.id IS NULL';
  END IF;
END $$;

------------------------------------------------------------------------------------------------------------
-- 12. X1 — SECURITY DEFINER reads (owner munim_crosstenant, pinned search_path, EXECUTE munim_core only)
------------------------------------------------------------------------------------------------------------
-- Every function is STABLE (Postgres refuses a write inside it) and filters tenants in its own body: the owner bypasses
-- RLS. Context comes from app.* (gotcha 20: any role may set them — each function re-checks the named member/operator
-- against the books, and with no context returns 0 rows, never an error; gotcha 29: nullif before the cast).
-- A tenant is shown on the network (listings, impact) only when active, its profile active, its enablement on, and no
-- active judge membership (judge-session tenants never appear).

-- Public network page and storefront section: live donations (published, pickup not over) of shown tenants, newest id
-- after the cursor first … in id order; ≤ 50 per call.
CREATE FUNCTION core.cares_network_listings(p_city text, p_tenant uuid, p_listing uuid, p_after uuid, p_limit integer)
RETURNS TABLE (listing_id uuid, city_code text, business_name text, outlet_name text, pickup_from timestamptz, pickup_to timestamptz,
               recipient_name text, recipient_simulated boolean, lines jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT l.id, co.city_code, pr.public_name, o.name, l.pickup_from, l.pickup_to, rc.name, rc.simulated,
         (SELECT jsonb_agg(jsonb_build_object('line_no', ll.line_no, 'food_kind', ll.food_kind, 'label_key', i.name_key, 'label', g.name,
                                              'qty_milli', ll.qty_milli, 'unit', ll.unit, 'expires_on', ll.expires_on) ORDER BY ll.line_no)
            FROM core.cares_listing_line ll
            LEFT JOIN core.item i ON i.tenant_id = ll.tenant_id AND i.id = ll.item_id
            LEFT JOIN core.ingredient g ON g.tenant_id = ll.tenant_id AND g.id = ll.ingredient_id
           WHERE ll.tenant_id = l.tenant_id AND ll.listing_id = l.id)
    FROM core.cares_listing l
    JOIN core.tenant t ON t.tenant_id = l.tenant_id AND t.status = 'active'
    JOIN core.cares_profile pr ON pr.tenant_id = l.tenant_id AND pr.status = 'active'
    JOIN platform.cares_enablement en ON en.tenant_id = l.tenant_id AND en.enabled
    JOIN core.cares_outlet co ON co.tenant_id = l.tenant_id AND co.outlet_id = l.outlet_id AND co.active
    JOIN platform.cares_city ci ON ci.code = co.city_code AND ci.status = 'active'
    JOIN core.outlet o ON o.tenant_id = l.tenant_id AND o.id = l.outlet_id
    JOIN platform.cares_recipient rc ON rc.id = l.recipient_id AND rc.simulated AND rc.status = 'active'
   WHERE l.kind = 'donation' AND l.status = 'published' AND l.pickup_to > now()
     AND NOT EXISTS (SELECT 1 FROM core.membership j WHERE j.tenant_id = l.tenant_id AND j.role = 'judge' AND j.active)
     AND (p_city IS NULL OR co.city_code = p_city)
     AND (p_tenant IS NULL OR l.tenant_id = p_tenant)
     AND (p_listing IS NULL OR l.id = p_listing)
     AND (p_after IS NULL OR l.id > p_after)
   ORDER BY l.id
   LIMIT greatest(least(coalesce(p_limit, 50), 50), 1)
$$;

-- B2B browse (buyer side): other tenants' live offers in the caller's opted-in cities. The caller (app.tenant_id,
-- app.member_id) is an active owner, manager or judge with an active, enabled, b2b profile; the offerer likewise (and
-- never a retired or judge tenant). The offered qty is each line's own field.
CREATE FUNCTION core.cares_market_offers(p_listing uuid)
RETURNS TABLE (offer_tenant_id uuid, listing_id uuid, business_name text, outlet_name text, city_code text, pickup_from timestamptz,
               pickup_to timestamptz, pickup_on date, lines jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH me AS (
    SELECT ms.tenant_id
      FROM core.membership ms
      JOIN core.member m ON m.tenant_id = ms.tenant_id AND m.id = ms.member_id AND m.active
      JOIN core.tenant t ON t.tenant_id = ms.tenant_id AND t.status = 'active'
      JOIN core.cares_profile pr ON pr.tenant_id = ms.tenant_id AND pr.status = 'active' AND pr.b2b_enabled
      JOIN platform.cares_enablement en ON en.tenant_id = ms.tenant_id AND en.enabled
     WHERE ms.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
       AND ms.member_id = nullif(current_setting('app.member_id', true), '')::uuid
       AND ms.active AND ms.role IN ('owner', 'manager', 'judge')),
  cities AS (
    SELECT DISTINCT co.city_code FROM me JOIN core.cares_outlet co ON co.tenant_id = me.tenant_id AND co.active)
  SELECT l.tenant_id, l.id, pr.public_name, o.name, co.city_code, l.pickup_from, l.pickup_to, l.pickup_on,
         (SELECT jsonb_agg(jsonb_build_object('offer_line_id', ll.id, 'food_kind', ll.food_kind, 'label', g.name, 'qty_milli', ll.qty_milli,
                                              'unit', ll.unit, 'expires_on', ll.expires_on, 'unit_price_minor', ll.unit_price_minor,
                                              'currency', ll.currency) ORDER BY ll.line_no)
            FROM core.cares_listing_line ll
            LEFT JOIN core.ingredient g ON g.tenant_id = ll.tenant_id AND g.id = ll.ingredient_id
           WHERE ll.tenant_id = l.tenant_id AND ll.listing_id = l.id)
    FROM me
    JOIN core.cares_listing l ON l.tenant_id <> me.tenant_id
    JOIN core.tenant t ON t.tenant_id = l.tenant_id AND t.status = 'active'
    JOIN core.cares_profile pr ON pr.tenant_id = l.tenant_id AND pr.status = 'active' AND pr.b2b_enabled
    JOIN platform.cares_enablement en ON en.tenant_id = l.tenant_id AND en.enabled
    JOIN core.cares_outlet co ON co.tenant_id = l.tenant_id AND co.outlet_id = l.outlet_id AND co.active
    JOIN cities ON cities.city_code = co.city_code
    JOIN core.outlet o ON o.tenant_id = l.tenant_id AND o.id = l.outlet_id
   WHERE l.kind = 'offer' AND l.status = 'published' AND l.pickup_to > now()
     AND NOT EXISTS (SELECT 1 FROM core.membership j WHERE j.tenant_id = l.tenant_id AND j.role = 'judge' AND j.active)
     AND (p_listing IS NULL OR l.id = p_listing)
   ORDER BY l.pickup_from, l.id
$$;

-- B2B inbound (offerer side): the claims on the caller's own offer. The caller is an active member of app.tenant_id
-- (owner, manager, judge or staff) whose outlet scope covers the listing's outlet — core-domain outletScopeOf: the
-- membership's outlet_ids, or every outlet when empty for owner / judge.
CREATE FUNCTION core.cares_inbound_claims(p_listing uuid)
RETURNS TABLE (claim_tenant_id uuid, claim_id uuid, buyer_public_name text, status text, created_at timestamptz, lines jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.tenant_id, c.id, pr.public_name, c.status, c.created_at,
         (SELECT jsonb_agg(jsonb_build_object('offer_line_id', cl.offer_line_id, 'qty_milli', cl.qty_milli, 'unit_price_minor', cl.unit_price_minor)
                           ORDER BY cl.offer_line_id)
            FROM core.cares_claim_line cl WHERE cl.tenant_id = c.tenant_id AND cl.claim_id = c.id)
    FROM core.cares_listing l
    JOIN core.membership ms ON ms.tenant_id = l.tenant_id AND ms.member_id = nullif(current_setting('app.member_id', true), '')::uuid
     AND ms.active AND ms.role IN ('owner', 'manager', 'judge', 'staff')
     AND (l.outlet_id = ANY (ms.outlet_ids) OR (cardinality(ms.outlet_ids) = 0 AND ms.role IN ('owner', 'judge')))
    JOIN core.member m ON m.tenant_id = ms.tenant_id AND m.id = ms.member_id AND m.active
    JOIN core.cares_claim c ON c.offer_tenant_id = l.tenant_id AND c.offer_listing_id = l.id
    LEFT JOIN core.cares_profile pr ON pr.tenant_id = c.tenant_id
   WHERE l.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND l.id = p_listing AND l.kind = 'offer'
   ORDER BY c.created_at, c.tenant_id, c.id
$$;

-- B2B outcome (buyer side): the offerer's verdict on the caller's own claim — 'declined' also when the offer was withdrawn,
-- closed or allocated to another claim — and, when accepted, the quantity handed over per offer line (non-voided). The
-- listing is read only as an offer of an offerer cares_market_offers would show (active tenant, active b2b profile,
-- enablement on, no judge): a claim naming any other listing id reads 'declined', never its status.
CREATE FUNCTION core.cares_claim_outcome(p_claim uuid)
RETURNS TABLE (verdict text, allocation_id uuid, decided_at timestamptz, lines jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN a.id IS NOT NULL THEN a.verdict WHEN l.status IS DISTINCT FROM 'published' THEN 'declined' ELSE 'none' END,
         a.id, a.created_at,
         CASE WHEN a.verdict = 'accepted' THEN
           (SELECT coalesce(jsonb_agg(jsonb_build_object('offer_line_id', cl.offer_line_id, 'handed_qty_milli',
                     coalesce((SELECT sum(hl.qty_milli) FROM core.cares_handover h
                                 JOIN core.cares_handover_line hl ON hl.tenant_id = h.tenant_id AND hl.handover_id = h.id
                                WHERE h.tenant_id = a.tenant_id AND h.allocation_id = a.id AND h.listing_id = a.listing_id
                                  AND h.status = 'recorded' AND hl.listing_line_id = cl.offer_line_id), 0)) ORDER BY cl.offer_line_id), '[]'::jsonb)
              FROM core.cares_claim_line cl WHERE cl.tenant_id = c.tenant_id AND cl.claim_id = c.id)
         ELSE '[]'::jsonb END
    FROM core.cares_claim c
    JOIN core.membership ms ON ms.tenant_id = c.tenant_id AND ms.member_id = nullif(current_setting('app.member_id', true), '')::uuid
     AND ms.active AND ms.role IN ('owner', 'manager', 'judge', 'staff')
     AND (c.outlet_id = ANY (ms.outlet_ids) OR (cardinality(ms.outlet_ids) = 0 AND ms.role IN ('owner', 'judge')))
    JOIN core.member m ON m.tenant_id = ms.tenant_id AND m.id = ms.member_id AND m.active
    LEFT JOIN LATERAL (
      SELECT l.status FROM core.cares_listing l
        JOIN core.tenant t ON t.tenant_id = l.tenant_id AND t.status = 'active'
        JOIN core.cares_profile pr ON pr.tenant_id = l.tenant_id AND pr.status = 'active' AND pr.b2b_enabled
        JOIN platform.cares_enablement en ON en.tenant_id = l.tenant_id AND en.enabled
       WHERE l.tenant_id = c.offer_tenant_id AND l.id = c.offer_listing_id AND l.kind = 'offer'
         AND NOT EXISTS (SELECT 1 FROM core.membership j WHERE j.tenant_id = l.tenant_id AND j.role = 'judge' AND j.active)) l ON true
    LEFT JOIN core.cares_allocation a ON a.tenant_id = c.offer_tenant_id AND a.listing_id = c.offer_listing_id
     AND a.claim_tenant_id = c.tenant_id AND a.claim_id = c.id
   WHERE c.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND c.id = p_claim
$$;

-- Network impact (§2.3, operator only): non-voided donation hand-overs of shown tenants whose listing's pickup date is in
-- [p_from, p_to], the Σ row first (city_code NULL), then one row per city. Meals = cooked portions; weight and volume
-- from g/kg and ml/l lines (no kg → meals factor). all_synthetic = every contributor is a demo tenant (vacuously true).
CREATE FUNCTION core.cares_network_impact(p_from date, p_to date, p_city text)
RETURNS TABLE (city_code text, businesses bigint, donations bigint, meals_portions_milli bigint, weight_g bigint, volume_ml bigint,
               all_synthetic boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH op AS (
    SELECT 1 AS ok FROM platform.operator x
     WHERE x.id = nullif(current_setting('app.operator_id', true), '')::uuid AND x.active
       AND current_setting('app.role', true) = 'operator'
       -- Never under a tenant: the network total is minted only into platform.network_snapshot, not a tenant's evidence.
       AND nullif(current_setting('app.tenant_id', true), '') IS NULL),
  h AS (
    SELECT h.tenant_id, h.id, co.city_code, t.is_demo
      FROM op
      CROSS JOIN core.cares_handover h
      JOIN core.cares_listing l ON l.tenant_id = h.tenant_id AND l.id = h.listing_id AND l.kind = 'donation'
      JOIN core.tenant t ON t.tenant_id = h.tenant_id AND t.status = 'active'
      JOIN core.cares_profile pr ON pr.tenant_id = h.tenant_id AND pr.status = 'active'
      JOIN platform.cares_enablement en ON en.tenant_id = h.tenant_id AND en.enabled
      JOIN core.cares_outlet co ON co.tenant_id = l.tenant_id AND co.outlet_id = l.outlet_id AND co.active
     WHERE h.status = 'recorded' AND l.pickup_on BETWEEN p_from AND p_to
       AND (p_city IS NULL OR co.city_code = p_city)
       AND NOT EXISTS (SELECT 1 FROM core.membership j WHERE j.tenant_id = h.tenant_id AND j.role = 'judge' AND j.active)),
  q AS (
    SELECT h.tenant_id, h.id, h.city_code, h.is_demo,
           sum(hl.qty_milli) FILTER (WHERE ll.food_kind = 'cooked' AND ll.unit = 'portion') AS portions,
           sum(CASE ll.unit WHEN 'g' THEN hl.qty_milli / 1000.0 WHEN 'kg' THEN hl.qty_milli::numeric END) AS grams,
           sum(CASE ll.unit WHEN 'ml' THEN hl.qty_milli / 1000.0 WHEN 'l' THEN hl.qty_milli::numeric END) AS mls
      FROM h
      LEFT JOIN core.cares_handover_line hl ON hl.tenant_id = h.tenant_id AND hl.handover_id = h.id
      LEFT JOIN core.cares_listing_line ll ON ll.tenant_id = hl.tenant_id AND ll.id = hl.listing_line_id
     GROUP BY h.tenant_id, h.id, h.city_code, h.is_demo)
  SELECT NULL::text, count(DISTINCT q.tenant_id), count(q.id), coalesce(sum(q.portions), 0)::bigint,
         round(coalesce(sum(q.grams), 0))::bigint, round(coalesce(sum(q.mls), 0))::bigint, coalesce(bool_and(q.is_demo), true)
    FROM q HAVING EXISTS (SELECT 1 FROM op)
  UNION ALL
  SELECT q.city_code, count(DISTINCT q.tenant_id), count(q.id), coalesce(sum(q.portions), 0)::bigint,
         round(coalesce(sum(q.grams), 0))::bigint, round(coalesce(sum(q.mls), 0))::bigint, bool_and(q.is_demo)
    FROM q GROUP BY q.city_code
   ORDER BY 1 NULLS FIRST
$$;

-- What the five read, column by column (SELECT only); 0007 / 0015–0017 already granted some of the core.* ones.
GRANT SELECT (tenant_id, status, is_demo, country_code) ON core.tenant TO munim_crosstenant;
GRANT SELECT (tenant_id, member_id, role, outlet_ids, active) ON core.membership TO munim_crosstenant;
GRANT SELECT (tenant_id, id, active) ON core.member TO munim_crosstenant;
GRANT SELECT (tenant_id, id, name) ON core.outlet TO munim_crosstenant;
GRANT SELECT (tenant_id, id, name_key) ON core.item TO munim_crosstenant;
GRANT SELECT (tenant_id, id, name) ON core.ingredient TO munim_crosstenant;
GRANT SELECT (tenant_id, status, public_name, b2b_enabled) ON core.cares_profile TO munim_crosstenant;
GRANT SELECT (tenant_id, outlet_id, city_code, active) ON core.cares_outlet TO munim_crosstenant;
GRANT SELECT (tenant_id, id, outlet_id, kind, status, recipient_id, pickup_from, pickup_to, pickup_on) ON core.cares_listing TO munim_crosstenant;
GRANT SELECT (tenant_id, id, listing_id, line_no, food_kind, item_id, ingredient_id, qty_milli, unit, expires_on, unit_price_minor, currency)
  ON core.cares_listing_line TO munim_crosstenant;
GRANT SELECT (tenant_id, id, listing_id, allocation_id, status, handed_at) ON core.cares_handover TO munim_crosstenant;
GRANT SELECT (tenant_id, handover_id, listing_line_id, qty_milli) ON core.cares_handover_line TO munim_crosstenant;
GRANT SELECT (tenant_id, id, outlet_id, offer_tenant_id, offer_listing_id, status, created_at) ON core.cares_claim TO munim_crosstenant;
GRANT SELECT (tenant_id, claim_id, offer_line_id, qty_milli, unit_price_minor) ON core.cares_claim_line TO munim_crosstenant;
GRANT SELECT (tenant_id, id, listing_id, claim_tenant_id, claim_id, verdict, created_at) ON core.cares_allocation TO munim_crosstenant;
GRANT SELECT (id, name, simulated, status) ON platform.cares_recipient TO munim_crosstenant;
GRANT SELECT (code, status) ON platform.cares_city TO munim_crosstenant;
GRANT SELECT (tenant_id, enabled) ON platform.cares_enablement TO munim_crosstenant;
GRANT SELECT (id, active) ON platform.operator TO munim_crosstenant;

GRANT CREATE ON SCHEMA core TO munim_crosstenant;
ALTER FUNCTION core.cares_network_listings(text, uuid, uuid, uuid, integer) OWNER TO munim_crosstenant;
ALTER FUNCTION core.cares_market_offers(uuid) OWNER TO munim_crosstenant;
ALTER FUNCTION core.cares_inbound_claims(uuid) OWNER TO munim_crosstenant;
ALTER FUNCTION core.cares_claim_outcome(uuid) OWNER TO munim_crosstenant;
ALTER FUNCTION core.cares_network_impact(date, date, text) OWNER TO munim_crosstenant;
REVOKE CREATE ON SCHEMA core FROM munim_crosstenant;

REVOKE ALL ON FUNCTION core.cares_network_listings(text, uuid, uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.cares_market_offers(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.cares_inbound_claims(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.cares_claim_outcome(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.cares_network_impact(date, date, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.cares_network_listings(text, uuid, uuid, uuid, integer) TO munim_core;
GRANT EXECUTE ON FUNCTION core.cares_market_offers(uuid) TO munim_core;
GRANT EXECUTE ON FUNCTION core.cares_inbound_claims(uuid) TO munim_core;
GRANT EXECUTE ON FUNCTION core.cares_claim_outcome(uuid) TO munim_core;
GRANT EXECUTE ON FUNCTION core.cares_network_impact(date, date, text) TO munim_core;

------------------------------------------------------------------------------------------------------------
-- 13. T1 — snapshot templates (v1)
------------------------------------------------------------------------------------------------------------
-- Only an operator platform.* template may call a §1.5 definer function (the member and intel mint routes refuse
-- operator templates; munim_svc holds no EXECUTE).
ALTER TABLE evidence.snapshot_template ADD CONSTRAINT snapshot_template_cares_definers
  CHECK (sql !~* 'cares_(network_listings|market_offers|inbound_claims|claim_outcome|network_impact)' OR (id ~ '^platform\.' AND min_role = 'operator'));

-- Recipients for one outlet's surplus: active simulated recipients in the outlet's Cares city that accept every food
-- kind asked for, whose receiving hours overlap the outlet's pickup window. Each gets the next such overlap after now()
-- in the outlet's zone (today's when it starts later today, else tomorrow's) and its pickup_on (the listing's formula);
-- an expiry before pickup_on + the pack's cares.min_days_left_at_pickup excludes it, and a pack with no cares block (or a
-- tenant not enabled, profile not active, outlet not active) gives 0 rows. capacity_fit: g/kg against the kg capacity,
-- ml/l at 1 l = 1 kg (INFERENCE), portions against the portion capacity, other units always fit. distance_m: haversine
-- on a 6,371,008.8 m sphere. Rank (row order): fitting first, then the longest overlap, then the nearest, then the id.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'cares.recipient_match', 1,
  $q$WITH ou AS (
  SELECT o.tz, o.business_day_cutoff, co.city_code, co.lat_e6, co.lng_e6, co.pickup_from, co.pickup_to,
         (cp.doc #>> '{cares,min_days_left_at_pickup}')::int AS min_days
    FROM core.outlet o
    JOIN core.cares_outlet co ON co.tenant_id = o.tenant_id AND co.outlet_id = o.id AND co.active
    JOIN core.cares_profile pr ON pr.tenant_id = o.tenant_id AND pr.status = 'active'
    JOIN platform.cares_enablement en ON en.tenant_id = o.tenant_id AND en.enabled
    JOIN core.tenant t ON t.tenant_id = o.tenant_id
    JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
   WHERE o.id = :outlet_id::uuid
     AND cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')
     AND cp.doc #>> '{cares,min_days_left_at_pickup}' IS NOT NULL),
r AS (
  SELECT rc.id, rc.name, rc.simulated, rc.capacity_kg_per_day::bigint AS cap_kg, rc.capacity_portions_per_day::bigint AS cap_portions,
         ou.tz, ou.business_day_cutoff, ou.min_days,
         greatest(ou.pickup_from, rc.receiving_from) AS w_from, least(ou.pickup_to, rc.receiving_to) AS w_to,
         2 * 6371008.8 * asin(least(1, sqrt(power(sin(radians((rc.lat_e6 - ou.lat_e6) / 1000000.0) / 2), 2)
           + cos(radians(ou.lat_e6 / 1000000.0)) * cos(radians(rc.lat_e6 / 1000000.0)) * power(sin(radians((rc.lng_e6 - ou.lng_e6) / 1000000.0) / 2), 2)))) AS dist
    FROM ou
    JOIN platform.cares_recipient rc ON rc.city_code = ou.city_code AND rc.status = 'active' AND rc.simulated
    JOIN platform.cares_city ci ON ci.code = rc.city_code AND ci.status = 'active'
   WHERE (NOT :needs_cooked::boolean OR rc.accepts_cooked) AND (NOT :needs_raw::boolean OR rc.accepts_raw)
     AND (NOT :needs_packaged::boolean OR rc.accepts_packaged)),
w AS (
  SELECT r.*, (x.d + r.w_from) AT TIME ZONE r.tz AS p_from, (x.d + r.w_to) AT TIME ZONE r.tz AS p_to
    FROM r
    CROSS JOIN LATERAL (SELECT CASE WHEN ((now() AT TIME ZONE r.tz)::date + r.w_from) AT TIME ZONE r.tz > now()
                                    THEN (now() AT TIME ZONE r.tz)::date ELSE (now() AT TIME ZONE r.tz)::date + 1 END AS d) x
   WHERE r.w_to > r.w_from),
m AS (
  SELECT w.*, ((w.p_from AT TIME ZONE w.tz) - w.business_day_cutoff)::date AS p_on,
         (extract(epoch FROM w.w_to - w.w_from) / 60)::bigint AS overlap,
         CASE :unit::text WHEN 'g' THEN :qty_milli::bigint <= w.cap_kg * 1000000 WHEN 'kg' THEN :qty_milli::bigint <= w.cap_kg * 1000
                          WHEN 'ml' THEN :qty_milli::bigint <= w.cap_kg * 1000000 WHEN 'l' THEN :qty_milli::bigint <= w.cap_kg * 1000
                          WHEN 'portion' THEN :qty_milli::bigint <= w.cap_portions * 1000 ELSE true END AS fit
    FROM w)
SELECT m.id AS recipient_id, m.name, m.simulated, round(m.dist)::bigint AS distance_m, m.fit AS capacity_fit, m.overlap AS overlap_min,
       m.p_from AS pickup_from, m.p_to AS pickup_to, m.p_on AS pickup_on
  FROM m
 WHERE :expires_on::date IS NULL OR :expires_on::date >= m.p_on + m.min_days
 ORDER BY m.fit DESC, m.overlap DESC, m.dist, m.id$q$,
  '{"type": "object", "required": ["outlet_id", "needs_cooked", "needs_raw", "needs_packaged", "qty_milli", "unit", "expires_on"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": "string", "format": "uuid"}, "needs_cooked": {"type": "boolean"}, "needs_raw": {"type": "boolean"},
                   "needs_packaged": {"type": "boolean"}, "qty_milli": {"type": "integer", "minimum": 1}, "unit": {"type": "string", "pattern": "^[a-z][a-z_]{0,15}$"},
                   "expires_on": {"type": ["string", "null"], "format": "date"}}}',
  '[{"name": "recipient_id", "type": "uuid"},
    {"name": "name", "type": "text"},
    {"name": "simulated", "type": "boolean"},
    {"name": "distance_m", "type": "integer", "numeric_source": ["core.cares_outlet.lat_e6", "core.cares_outlet.lng_e6", "platform.cares_recipient.lat_e6", "platform.cares_recipient.lng_e6"]},
    {"name": "capacity_fit", "type": "boolean"},
    {"name": "overlap_min", "type": "integer", "numeric_source": ["core.cares_outlet.pickup_from", "core.cares_outlet.pickup_to", "platform.cares_recipient.receiving_from", "platform.cares_recipient.receiving_to"]},
    {"name": "pickup_from", "type": "timestamptz"},
    {"name": "pickup_to", "type": "timestamptz"},
    {"name": "pickup_on", "type": "date"}]',
  'manager');

-- An outlet's listings (optionally one status), soonest pickup first. pickup_weekday / pickup_slot_start are 0026's
-- people.labour_vs_demand v2 expressions on b = the 60-minute bin of pickup_from in the outlet's zone: the slot is
-- to_char(b, 'HH24:MI') and the weekday to_char((b − cutoff)::date, 'dy'), so a listing's cells equal the labour row's.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'cares.listings', 1,
  $q$SELECT l.id AS listing_id, l.kind, l.status, l.recipient_id, l.pickup_from, l.pickup_to, l.pickup_on,
       to_char((b.b - ou.business_day_cutoff)::date, 'dy') AS pickup_weekday, to_char(b.b, 'HH24:MI') AS pickup_slot_start,
       (SELECT count(*) FROM core.cares_listing_line ll WHERE ll.tenant_id = l.tenant_id AND ll.listing_id = l.id)::bigint AS lines
  FROM core.cares_listing l
  JOIN core.outlet ou ON ou.tenant_id = l.tenant_id AND ou.id = l.outlet_id
  CROSS JOIN LATERAL (SELECT date_bin(interval '60 minutes', l.pickup_from AT TIME ZONE ou.tz, timestamp '2001-01-01') AS b) b
 WHERE (:outlet_id::uuid IS NULL OR l.outlet_id = :outlet_id::uuid) AND (:status::text IS NULL OR l.status = :status::text)
 ORDER BY l.pickup_from, l.id$q$,
  '{"type": "object", "required": ["outlet_id", "status"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"},
                   "status": {"type": ["string", "null"], "pattern": "^(published|allocated|closed|withdrawn)$"}}}',
  '[{"name": "listing_id", "type": "uuid"},
    {"name": "kind", "type": "text"},
    {"name": "status", "type": "text"},
    {"name": "recipient_id", "type": "uuid"},
    {"name": "pickup_from", "type": "timestamptz"},
    {"name": "pickup_to", "type": "timestamptz"},
    {"name": "pickup_on", "type": "date"},
    {"name": "pickup_weekday", "type": "text"},
    {"name": "pickup_slot_start", "type": "text"},
    {"name": "lines", "type": "integer", "numeric_source": "count:core.cares_listing_line"}]',
  'staff');

-- Who can pack and hand over a listing: active staff with an active member, holding a scheduled roster shift at the
-- listing's outlet that covers its whole pickup slot (the 60-minute bin of pickup_from), cheapest rate first (0026's
-- extra-staff order; the rate orders only and is not output), then staff_id.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'cares.pickup_crew', 1,
  $q$WITH sl AS (
  SELECT l.outlet_id, date_bin(interval '60 minutes', l.pickup_from AT TIME ZONE ou.tz, timestamp '2001-01-01') AT TIME ZONE ou.tz AS slot_from
    FROM core.cares_listing l JOIN core.outlet ou ON ou.tenant_id = l.tenant_id AND ou.id = l.outlet_id
   WHERE l.id = :listing_id::uuid AND l.outlet_id = :outlet_id::uuid)
SELECT s.id AS staff_id, s.member_id
  FROM core.staff s
  JOIN core.member m ON m.tenant_id = s.tenant_id AND m.id = s.member_id AND m.active
 WHERE s.active
   AND EXISTS (SELECT 1 FROM sl JOIN core.roster_shift r ON r.outlet_id = sl.outlet_id AND r.status = 'scheduled'
                WHERE r.tenant_id = s.tenant_id AND r.staff_id = s.id
                  AND r.starts_at <= sl.slot_from AND r.ends_at >= sl.slot_from + interval '60 minutes')
 ORDER BY CASE WHEN s.pay_basis = 'hourly' THEN s.wage_rate_minor::numeric
               ELSE s.monthly_salary_minor::numeric * 60 / s.contract_min_per_month END NULLS LAST, s.id$q$,
  '{"type": "object", "required": ["outlet_id", "listing_id"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": "string", "format": "uuid"}, "listing_id": {"type": "string", "format": "uuid"}}}',
  '[{"name": "staff_id", "type": "uuid"}, {"name": "member_id", "type": "uuid"}]',
  'manager');

-- Impact over listings whose pickup date is in [from, to] (non-voided hand-overs only): the Σ row (kind 'total') first, then
-- donation, then offer. Quantities from the hand-over lines bucketed by unit (g/kg → weight_g, ml/l → volume_ml,
-- portion → portions_milli, anything else → units_milli); value at cost = each out-movement at the outlet's last receipt
-- cost on or before the movement's business date (kitchen.remakes_overprep's valuation), rounded once per row.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'cares.impact', 1,
  $q$WITH h AS (
  SELECT h.tenant_id, h.id, l.kind
    FROM core.cares_handover h JOIN core.cares_listing l ON l.tenant_id = h.tenant_id AND l.id = h.listing_id
   WHERE h.status = 'recorded' AND l.pickup_on BETWEEN :from::date AND :to::date
     AND (:outlet_id::uuid IS NULL OR h.outlet_id = :outlet_id::uuid)),
q AS (
  SELECT h.kind, hl.qty_milli, ll.unit
    FROM h JOIN core.cares_handover_line hl ON hl.tenant_id = h.tenant_id AND hl.handover_id = h.id
    JOIN core.cares_listing_line ll ON ll.tenant_id = hl.tenant_id AND ll.id = hl.listing_line_id),
v AS (
  SELECT h.kind,
         -m.qty_milli * (SELECT r.unit_cost_per_1000_minor FROM core.stock_movement r
                          JOIN core.outlet ro ON ro.tenant_id = r.tenant_id AND ro.id = r.outlet_id
                         WHERE r.outlet_id = m.outlet_id AND r.ingredient_id = m.ingredient_id AND r.kind = 'receipt'
                           AND r.unit_cost_per_1000_minor IS NOT NULL
                           AND ((r.at AT TIME ZONE ro.tz) - ro.business_day_cutoff)::date <= ((m.at AT TIME ZONE ro.tz) - ro.business_day_cutoff)::date
                         ORDER BY r.at DESC, r.id DESC LIMIT 1) / 1000000.0 AS value
    FROM h JOIN core.stock_movement m ON m.tenant_id = h.tenant_id AND m.ref_type = 'core.cares_handover' AND m.ref_id = h.id
     AND m.kind IN ('donation', 'surplus_out')),
k (kind, ord) AS (VALUES ('total', 0), ('donation', 1), ('offer', 2))
SELECT k.kind,
       (SELECT count(*) FROM h WHERE k.kind = 'total' OR h.kind = k.kind)::bigint AS handovers,
       (SELECT coalesce(sum(q.qty_milli), 0) FROM q WHERE (k.kind = 'total' OR q.kind = k.kind) AND q.unit = 'portion')::bigint AS portions_milli,
       (SELECT round(coalesce(sum(CASE q.unit WHEN 'g' THEN q.qty_milli / 1000.0 ELSE q.qty_milli::numeric END), 0)) FROM q
         WHERE (k.kind = 'total' OR q.kind = k.kind) AND q.unit IN ('g', 'kg'))::bigint AS weight_g,
       (SELECT round(coalesce(sum(CASE q.unit WHEN 'ml' THEN q.qty_milli / 1000.0 ELSE q.qty_milli::numeric END), 0)) FROM q
         WHERE (k.kind = 'total' OR q.kind = k.kind) AND q.unit IN ('ml', 'l'))::bigint AS volume_ml,
       (SELECT coalesce(sum(q.qty_milli), 0) FROM q WHERE (k.kind = 'total' OR q.kind = k.kind) AND q.unit NOT IN ('g', 'kg', 'ml', 'l', 'portion'))::bigint AS units_milli,
       (SELECT round(coalesce(sum(v.value), 0)) FROM v WHERE k.kind = 'total' OR v.kind = k.kind)::bigint AS value_at_cost_minor
  FROM k
 ORDER BY k.ord$q$,
  '{"type": "object", "required": ["outlet_id", "from", "to"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"},
                   "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
  '[{"name": "kind", "type": "text"},
    {"name": "handovers", "type": "integer", "numeric_source": "count:core.cares_handover"},
    {"name": "portions_milli", "type": "integer", "numeric_source": "core.cares_handover_line.qty_milli"},
    {"name": "weight_g", "type": "integer", "numeric_source": "core.cares_handover_line.qty_milli"},
    {"name": "volume_ml", "type": "integer", "numeric_source": "core.cares_handover_line.qty_milli"},
    {"name": "units_milli", "type": "integer", "numeric_source": "core.cares_handover_line.qty_milli"},
    {"name": "value_at_cost_minor", "type": "integer", "numeric_source": ["core.stock_movement.qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]}]',
  'manager');

-- The network total (§2.3): minted by an operator on munim_core with role operator and no tenant; stored in
-- platform.network_snapshot, never evidence.snapshot.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'platform.cares_network_impact', 1,
  $q$SELECT f.city_code, f.businesses, f.donations, f.meals_portions_milli, f.weight_g, f.volume_ml, f.all_synthetic
  FROM core.cares_network_impact(:from::date, :to::date, :city_code::text) f
 ORDER BY f.city_code NULLS FIRST$q$,
  '{"type": "object", "required": ["from", "to", "city_code"], "additionalProperties": false,
    "properties": {"from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"},
                   "city_code": {"type": ["string", "null"], "pattern": "^[a-z][a-z0-9_]*$"}}}',
  '[{"name": "city_code", "type": "text"},
    {"name": "businesses", "type": "integer", "numeric_source": "count:core.cares_profile"},
    {"name": "donations", "type": "integer", "numeric_source": "count:core.cares_handover"},
    {"name": "meals_portions_milli", "type": "integer", "numeric_source": "core.cares_handover_line.qty_milli"},
    {"name": "weight_g", "type": "integer", "numeric_source": "core.cares_handover_line.qty_milli"},
    {"name": "volume_ml", "type": "integer", "numeric_source": "core.cares_handover_line.qty_milli"},
    {"name": "all_synthetic", "type": "boolean"}]',
  'operator');

------------------------------------------------------------------------------------------------------------
-- 14. assert_catalog re-issued: identical to 0017 except the SECURITY DEFINER list (+ the five Cares reads) and count 12.
------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION munim_meta.assert_catalog(migration text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  bad text;
  n   integer;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = 'core' AND c.relkind IN ('r', 'p')
     AND coalesce(obj_description(c.oid, 'pg_class'), '') NOT IN ('munim:book', 'munim:operational');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: untagged core tables: %', migration, bad; END IF;

  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = 'core' AND c.relkind = 'r' AND obj_description(c.oid, 'pg_class') = 'munim:book'
     AND (NOT EXISTS (SELECT 1 FROM pg_trigger t
                       WHERE t.tgrelid = c.oid AND t.tgname = 'book_guard' AND t.tgenabled = 'O'
                         AND t.tgfoid = 'core.guard_book_write()'::regprocedure)
          OR NOT EXISTS (SELECT 1 FROM pg_attribute a
                          WHERE a.attrelid = c.oid AND a.attname = 'origin' AND a.attnotnull
                            AND a.atttypid = 'jsonb'::regtype));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: book tables without guard/origin: %', migration, bad; END IF;

  SELECT string_agg(c.relname || '.' || t.tgname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace JOIN pg_trigger t ON t.tgrelid = c.oid
   WHERE s.nspname = 'core' AND obj_description(c.oid, 'pg_class') = 'munim:book' AND NOT t.tgisinternal
     AND (t.tgtype & 2) <> 0 AND (t.tgtype & 1) <> 0 AND t.tgname < 'book_guard';
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: BEFORE ROW triggers sorting before book_guard: %', migration, bad; END IF;

  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_trigger t ON t.tgrelid = c.oid AND t.tgfoid = 'core.guard_book_write()'::regprocedure
   WHERE obj_description(c.oid, 'pg_class') IS DISTINCT FROM 'munim:book';
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: guard on non-book tables: %', migration, bad; END IF;

  SELECT string_agg(DISTINCT x.t, ', ') INTO bad
    FROM core.command_authority ca, unnest(ca.target_tables) x(t)
   WHERE coalesce(obj_description(to_regclass(x.t), 'pg_class'), '') <> 'munim:book';
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: target_tables naming non-book tables: %', migration, bad; END IF;
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = 'core' AND c.relkind = 'r' AND obj_description(c.oid, 'pg_class') = 'munim:book'
     AND NOT EXISTS (SELECT 1 FROM core.command_authority ca WHERE ('core.' || c.relname) = ANY (ca.target_tables))
     AND NOT EXISTS (SELECT 1 FROM core.derivation_rule dr WHERE dr.target_table = 'core.' || c.relname);
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: book tables no command or derivation can write: %', migration, bad; END IF;

  -- A command's outlet_column names a column of every table it writes.
  SELECT string_agg(ca.command_type || ' → ' || x.t, ', ') INTO bad
    FROM core.command_authority ca, unnest(ca.target_tables) x(t)
   WHERE ca.outlet_column IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass(x.t) AND a.attname = ca.outlet_column
                        AND a.attnum > 0 AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype);
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: outlet_column missing on target tables: %', migration, bad; END IF;
  -- Caps only for roles the command allows.
  SELECT string_agg(ca.command_type, ', ') INTO bad
    FROM core.command_authority ca
   WHERE NOT (ARRAY(SELECT jsonb_object_keys(ca.role_caps)) <@ ca.allowed_roles);
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: role_caps for roles the command does not allow: %', migration, bad; END IF;

  SELECT string_agg(coalesce(b.table_name, 'core.' || c.relname), ', ') INTO bad
    FROM (SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
           WHERE s.nspname = 'core' AND c.relkind = 'r' AND obj_description(c.oid, 'pg_class') = 'munim:book') c
    FULL JOIN core.book_scope b ON b.table_name = 'core.' || c.relname
   WHERE c.oid IS NULL OR b.table_name IS NULL
      OR (b.parent_table IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.book_scope p WHERE p.table_name = b.parent_table));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: book_scope does not match the book tables: %', migration, bad; END IF;

  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = 'core' AND c.relkind = 'r' AND obj_description(c.oid, 'pg_class') = 'munim:book'
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname IN ('status', 'stage')
                    AND a.attnum > 0 AND NOT a.attisdropped AND has_column_privilege('munim_core', c.oid, a.attnum, 'UPDATE'))
     AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal AND t.tgname LIKE '%transition%');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: book status columns without a transition trigger: %', migration, bad; END IF;

  SELECT string_agg(s.nspname || '.' || c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform') AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
          OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polpermissive));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: tenant tables without forced RLS + policy: %', migration, bad; END IF;

  SELECT string_agg(s.nspname || '.' || c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform') AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     AND (s.nspname || '.' || c.relname) NOT IN ('core.ticket_counter', 'core.pickup_window')
     AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'customer_scope' AND NOT p.polpermissive);
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: tenant tables without the customer_scope policy: %', migration, bad; END IF;
  SELECT string_agg(s.nspname || '.' || c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform') AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'guest_scope' AND NOT p.polpermissive);
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: tenant tables without the guest_scope policy: %', migration, bad; END IF;

  SELECT string_agg(c.conrelid::regclass::text || '(' || c.conname || ')', ', ') INTO bad
    FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace s ON s.oid = cl.relnamespace
   WHERE c.contype = 'f' AND s.nspname IN ('core', 'evidence', 'intel', 'platform')
     AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) = 'tenant_id'
     AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid
           AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] @> c.conkey
           AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] <@ c.conkey);
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: FKs without a covering index: %', migration, bad; END IF;

  SELECT string_agg(c.conrelid::regclass::text || '(' || c.conname || ')', ', ') INTO bad
    FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace s ON s.oid = cl.relnamespace
   WHERE c.contype = 'f' AND s.nspname IN ('core', 'evidence', 'intel', 'platform')
     AND (c.confdeltype <> 'a' OR c.confupdtype <> 'a');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: cascading FKs: %', migration, bad; END IF;

  SELECT string_agg(DISTINCT s.nspname || '.' || c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace,
         LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform', 'intel_ro', 'munim_meta') AND c.relkind IN ('r', 'v', 'p')
     AND (x.grantee = 0 OR (x.privilege_type IN ('DELETE', 'TRUNCATE') AND x.grantee <> c.relowner));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: PUBLIC grants or DELETE/TRUNCATE grants on: %', migration, bad; END IF;

  -- Column-level grants to PUBLIC (a table ACL scan does not see them).
  SELECT string_agg(DISTINCT s.nspname || '.' || c.relname || '.' || a.attname, ', ') INTO bad
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace,
         LATERAL aclexplode(a.attacl) x
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform', 'intel_ro', 'munim_meta') AND a.attacl IS NOT NULL
     AND x.grantee = 0;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: PUBLIC column grants on: %', migration, bad; END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace,
         LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform', 'intel_ro', 'munim_meta') AND x.grantee = 0;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: functions executable by PUBLIC: %', migration, bad; END IF;

  -- SECURITY DEFINER functions = exactly the twelve munim_crosstenant functions; it also owns exactly the view
  -- platform.tenant_registry.
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform', 'intel_ro', 'munim_meta')
     AND (p.prosecdef OR p.proowner = 'munim_crosstenant'::regrole)
     AND NOT (p.prosecdef AND p.proowner = 'munim_crosstenant'::regrole
              AND p.oid IN ('core.outbox_claim(integer, interval, interval)'::regprocedure,
                            'core.active_tenants()'::regprocedure,
                            'core.tenant_for_storefront_key(text)'::regprocedure,
                            'core.memberships_for_sub(text)'::regprocedure,
                            'core.customer_claim_verified_email_guests()'::regprocedure,
                            'core.customer_erase_merged_guests(uuid)'::regprocedure,
                            'core.customer_claim_guest_token()'::regprocedure,
                            -- 0028 (ADR-015 §1.5): the five Cares reads.
                            'core.cares_network_listings(text, uuid, uuid, uuid, integer)'::regprocedure,
                            'core.cares_market_offers(uuid)'::regprocedure,
                            'core.cares_inbound_claims(uuid)'::regprocedure,
                            'core.cares_claim_outcome(uuid)'::regprocedure,
                            'core.cares_network_impact(date, date, text)'::regprocedure));
  IF n <> 0 THEN RAISE EXCEPTION '%: unexpected SECURITY DEFINER / munim_crosstenant functions: %', migration, n; END IF;
  SELECT count(*) INTO n FROM pg_proc p WHERE p.prosecdef AND p.proowner = 'munim_crosstenant'::regrole;
  IF n <> 12 THEN RAISE EXCEPTION '%: expected 12 munim_crosstenant definer functions, found %', migration, n; END IF;
  SELECT count(*) INTO n FROM pg_class c WHERE c.relowner = 'munim_crosstenant'::regrole;
  IF n <> 1 OR NOT EXISTS (SELECT 1 FROM pg_class c
                            WHERE c.oid = 'platform.tenant_registry'::regclass AND c.relowner = 'munim_crosstenant'::regrole) THEN
    RAISE EXCEPTION '%: munim_crosstenant must own exactly the view platform.tenant_registry', migration;
  END IF;

  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = 'intel_ro' AND (c.relkind <> 'v' OR c.relowner <> 'munim_view_owner'::regrole);
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: intel_ro objects not views owned by munim_view_owner: %', migration, bad; END IF;
END $$;
REVOKE ALL ON FUNCTION munim_meta.assert_catalog(text) FROM PUBLIC;

------------------------------------------------------------------------------------------------------------
-- 15. Post-conditions (read back what Postgres holds; never trust IF NOT EXISTS)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
  core9 constant text[] := ARRAY['core.cares_profile', 'core.cares_outlet', 'core.cares_listing', 'core.cares_listing_line', 'core.cares_handover',
                                 'core.cares_handover_line', 'core.cares_claim', 'core.cares_claim_line', 'core.cares_allocation'];
  plat4 constant text[] := ARRAY['platform.cares_city', 'platform.cares_recipient', 'platform.cares_enablement', 'platform.network_snapshot'];
  defs  constant text[] := ARRAY['core.cares_network_listings(text,uuid,uuid,uuid,integer)', 'core.cares_market_offers(uuid)',
                                 'core.cares_inbound_claims(uuid)', 'core.cares_claim_outcome(uuid)', 'core.cares_network_impact(date,date,text)'];
BEGIN
  SELECT string_agg(x, ', ') INTO bad FROM (
    -- C1: the nine core tables are books with forced RLS, exactly one permissive policy of the written name, and the two
    -- restrictive shopper policies; the four platform tables exist.
    SELECT 'table:' || t AS x FROM unnest(core9) t
     WHERE obj_description(t::regclass, 'pg_class') IS DISTINCT FROM 'munim:book'
        OR NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = t::regclass)
        OR (SELECT string_agg(polname, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = t::regclass AND polpermissive)
           IS DISTINCT FROM CASE WHEN t = 'core.cares_profile' THEN 'tenant_isolation'
                                 WHEN t LIKE '%\_line' THEN 'tenant_via_parent' ELSE 'tenant_outlet_isolation' END
        OR (SELECT string_agg(polname, ',' ORDER BY polname) FROM pg_policy WHERE polrelid = t::regclass AND NOT polpermissive)
           IS DISTINCT FROM 'customer_scope,guest_scope'
    UNION ALL
    SELECT 'platform:' || t FROM unnest(plat4) t WHERE to_regclass(t) IS NULL
    UNION ALL
    SELECT 'enablement-rls' WHERE NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'platform.cares_enablement'::regclass)
       OR (SELECT string_agg(polname || ':' || polpermissive || ':' || polcmd::text || ':' || array_to_string(ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_get_userbyid(r)::text END FROM unnest(polroles) r ORDER BY 1), '+'), ',' ORDER BY polname)
             FROM pg_policy WHERE polrelid = 'platform.cares_enablement'::regclass)
          IS DISTINCT FROM 'customer_scope:false:*:public,guest_scope:false:*:public,operator_all:true:*:munim_platform,tenant_read:true:r:munim_core+munim_svc'
    UNION ALL
    -- P1: the simulated-only CHECKs, as written.
    SELECT 'recipient-checks' WHERE (SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), ' | ' ORDER BY conname) FROM pg_constraint
                                      WHERE conrelid = 'platform.cares_recipient'::regclass AND conname IN ('cares_recipient_simulated_check', 'cares_recipient_name_simulated_check'))
      IS DISTINCT FROM $d$cares_recipient_name_simulated_check=CHECK ((name ~ '\(simulated\)'::text)) | cares_recipient_simulated_check=CHECK (simulated)$d$
    UNION ALL
    -- S1: both stock CHECKs replaced by name; 0005's unnamed sign CHECK is gone.
    SELECT 'stock-checks' WHERE (SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), ' | ' ORDER BY conname) FROM pg_constraint
                                  WHERE conrelid = 'core.stock_movement'::regclass AND conname IN ('stock_movement_kind_check', 'stock_movement_sign_check', 'stock_movement_check'))
      IS DISTINCT FROM $d$stock_movement_kind_check=CHECK ((kind = ANY (ARRAY['receipt'::text, 'sale_consumption'::text, 'waste'::text, 'transfer_out'::text, 'transfer_in'::text, 'count_adjust'::text, 'supplier_return'::text, 'sale_return'::text, 'donation'::text, 'surplus_out'::text, 'surplus_in'::text, 'cares_reversal'::text]))) | stock_movement_sign_check=CHECK (
CASE
    WHEN (kind = ANY (ARRAY['receipt'::text, 'transfer_in'::text, 'sale_return'::text, 'surplus_in'::text, 'cares_reversal'::text])) THEN (qty_milli > 0)
    WHEN (kind = ANY (ARRAY['sale_consumption'::text, 'waste'::text, 'transfer_out'::text, 'supplier_return'::text, 'donation'::text, 'surplus_out'::text])) THEN (qty_milli < 0)
    ELSE (qty_milli <> 0)
END)$d$
    UNION ALL
    -- Row-rule triggers: name, table, function, enabled, BEFORE ROW, events (tgtype bits: 1 row, 2 before, 4 insert, 16 update).
    SELECT 'trigger:' || v.t || '.' || v.g FROM (VALUES
        ('core.cares_listing', 'cares_rules', 'core.cares_listing_rules()', 23), ('core.cares_listing_line', 'cares_rules', 'core.cares_listing_line_rules()', 7),
        ('core.cares_handover', 'cares_rules', 'core.cares_handover_rules()', 23), ('core.cares_handover_line', 'cares_rules', 'core.cares_handover_line_bound()', 7),
        ('core.cares_claim', 'cares_rules', 'core.cares_claim_rules()', 23), ('core.cares_claim_line', 'cares_rules', 'core.cares_claim_line_rules()', 23),
        ('core.cares_listing_line', 'currency_check', 'core.assert_tenant_currency()', 23), ('core.cares_claim', 'currency_check', 'core.assert_tenant_currency()', 23),
        ('core.cares_allocation', 'currency_check', 'core.assert_tenant_currency()', 23), ('core.cares_allocation', 'cares_rules', 'core.cares_allocation_rules()', 7),
        ('core.cares_listing', 'status_transition', 'core.book_status_transition_check()', 19), ('core.cares_claim', 'status_transition', 'core.book_status_transition_check()', 19),
        ('core.cares_handover', 'status_transition', 'core.book_status_transition_check()', 19), ('core.cares_profile', 'status_transition', 'core.book_status_transition_check()', 19),
        ('platform.network_snapshot', 'snapshot_rules', 'platform.network_snapshot_rules()', 23),
        ('platform.cares_enablement', 'touch_updated_at', 'platform.touch_updated_at()', 19),
        ('platform.cares_enablement', 'draft_target', 'platform.cares_enablement_rules()', 23),
        -- Constraint triggers (AFTER ROW: no BEFORE bit), deferrable and initially deferred.
        ('platform.network_snapshot', 'draft_applied', 'platform.cares_draft_applied()', 17),
        ('platform.cares_enablement', 'draft_applied', 'platform.cares_draft_applied()', 21)) v(t, g, f, ty)
     WHERE NOT EXISTS (SELECT 1 FROM pg_trigger tr WHERE tr.tgrelid = v.t::regclass AND tr.tgname = v.g AND tr.tgfoid = v.f::regprocedure
                          AND tr.tgenabled = 'O' AND tr.tgtype = v.ty AND NOT tr.tgisinternal
                          AND (tr.tgdeferrable AND tr.tginitdeferred AND tr.tgconstraint <> 0) = (v.g = 'draft_applied'))
    UNION ALL
    -- Trigger functions: invoker rights, pinned search_path, no PUBLIC EXECUTE.
    SELECT 'trigger-fn:' || p.oid::regprocedure::text FROM pg_proc p
     WHERE p.oid IN ('core.cares_listing_rules()'::regprocedure, 'core.cares_listing_line_rules()'::regprocedure, 'core.cares_handover_rules()'::regprocedure,
                     'core.cares_handover_line_bound()'::regprocedure, 'core.cares_claim_rules()'::regprocedure, 'core.cares_claim_line_rules()'::regprocedure,
                     'core.cares_allocation_rules()'::regprocedure, 'platform.network_snapshot_rules()'::regprocedure,
                     'platform.cares_enablement_rules()'::regprocedure, 'platform.cares_draft_applied()'::regprocedure)
       AND (p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] OR p.proacl IS NULL
            OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner))
    UNION ALL
    -- The command resolvers: invoker rights, STABLE, pinned search_path, EXECUTE for munim_core only.
    SELECT 'cares_command:' || p.oid::regprocedure::text FROM pg_proc p
     WHERE p.oid IN ('core.cares_command(uuid)'::regprocedure, 'core.cares_decision_command(uuid)'::regprocedure)
       AND (p.prosecdef OR p.provolatile <> 's' OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
            OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee NOT IN (p.proowner, 'munim_core'::regrole))
            OR NOT has_function_privilege('munim_core', p.oid, 'EXECUTE'))
    UNION ALL
    -- Indexes: exact columns (and predicate) per name — gotcha 1.
    SELECT 'index:' || v.i FROM (VALUES
        ('cares_listing_outlet_idx', 'tenant_id,outlet_id,status', false, NULL), ('cares_listing_published_by_fk_idx', 'tenant_id,published_by', false, NULL),
        ('cares_listing_live_idx', 'kind,status,pickup_to', false, NULL), ('cares_listing_line_item_id_fk_idx', 'tenant_id,item_id', false, NULL),
        ('cares_listing_line_ingredient_id_fk_idx', 'tenant_id,ingredient_id', false, NULL), ('cares_listing_line_batch_id_fk_idx', 'tenant_id,batch_id', false, NULL),
        ('cares_handover_listing_fk_idx', 'tenant_id,listing_id,outlet_id', false, NULL), ('cares_handover_allocation_fk_idx', 'tenant_id,allocation_id,listing_id', false, NULL),
        ('cares_handover_recorded_by_fk_idx', 'tenant_id,recorded_by', false, NULL), ('cares_handover_voided_by_fk_idx', 'tenant_id,voided_by', false, NULL),
        ('cares_handover_line_listing_line_fk_idx', 'tenant_id,listing_line_id', false, NULL), ('cares_claim_outlet_idx', 'tenant_id,outlet_id,status', false, NULL),
        ('cares_claim_created_by_fk_idx', 'tenant_id,created_by', false, NULL), ('cares_claim_offer_idx', 'offer_tenant_id,offer_listing_id', false, NULL),
        ('cares_claim_line_ingredient_id_fk_idx', 'tenant_id,ingredient_id', false, NULL), ('cares_allocation_listing_fk_idx', 'tenant_id,listing_id,outlet_id', false, NULL),
        ('cares_allocation_decided_by_fk_idx', 'tenant_id,decided_by', false, NULL), ('task_cares_listing_id_fk_idx', 'tenant_id,cares_listing_id', false, NULL),
        ('cares_allocation_one_accepted', 'tenant_id,listing_id', true, $p$(verdict = 'accepted'::text)$p$),
        ('cares_allocation_one_per_claim', 'tenant_id,claim_tenant_id,claim_id', true, NULL), ('cares_profile_one_per_tenant', 'tenant_id', true, NULL),
        ('cares_listing_outlet_key', 'tenant_id,id,outlet_id', true, NULL), ('cares_allocation_listing_key', 'tenant_id,id,listing_id', true, NULL),
        ('cares_handover_line_unique', 'tenant_id,handover_id,listing_line_id', true, NULL), ('cares_claim_line_unique', 'tenant_id,claim_id,offer_line_id', true, NULL),
        ('cares_listing_line_no_unique', 'tenant_id,listing_id,line_no', true, NULL)) v(i, cols, uniq, pred)
     WHERE NOT EXISTS (SELECT 1 FROM pg_index x JOIN pg_class c ON c.oid = x.indexrelid JOIN pg_namespace s ON s.oid = c.relnamespace
                        WHERE s.nspname = 'core' AND c.relname = v.i AND x.indisunique = v.uniq AND x.indisvalid
                          AND pg_get_expr(x.indpred, x.indrelid) IS NOT DISTINCT FROM v.pred
                          AND (SELECT string_agg(a.attname, ',' ORDER BY k.n) FROM unnest(x.indkey) WITH ORDINALITY k(attnum, n)
                                 JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum) = v.cols)
    UNION ALL
    -- Grants. munim_svc: SELECT on the nine and city/recipient/enablement, nothing on network_snapshot, no write anywhere;
    -- munim_intel_ro: nothing; nobody DELETE/TRUNCATE.
    SELECT 'svc:' || t FROM unnest(core9 || plat4) t
     WHERE has_table_privilege('munim_svc', t, 'INSERT,UPDATE,DELETE,TRUNCATE') OR has_any_column_privilege('munim_svc', t, 'INSERT,UPDATE')
        OR has_table_privilege('munim_svc', t, 'SELECT') IS DISTINCT FROM (t <> 'platform.network_snapshot')
        OR has_any_column_privilege('munim_intel_ro', t, 'SELECT,INSERT,UPDATE')
        OR has_table_privilege('munim_intel_ro', t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
        OR EXISTS (SELECT 1 FROM unnest(ARRAY['munim_core', 'munim_svc', 'munim_platform', 'munim_crosstenant']) r WHERE has_table_privilege(r, t, 'DELETE,TRUNCATE'))
    UNION ALL
    -- munim_core: SELECT, INSERT on the nine; UPDATE exactly the pinned columns.
    SELECT 'core-update:' || v.t FROM (VALUES
        ('core.cares_profile', 'b2b_enabled,public_name,status'), ('core.cares_outlet', 'active,city_code,lat_e6,lng_e6,pickup_from,pickup_to'),
        ('core.cares_listing', 'status'), ('core.cares_listing_line', NULL), ('core.cares_handover', 'status,void_reason_code,voided_by'),
        ('core.cares_handover_line', NULL), ('core.cares_claim', 'allocation_id,status'), ('core.cares_claim_line', 'received_qty_milli'),
        ('core.cares_allocation', NULL)) v(t, cols)
     WHERE NOT has_table_privilege('munim_core', v.t, 'SELECT') OR NOT has_table_privilege('munim_core', v.t, 'INSERT')
        OR has_table_privilege('munim_core', v.t, 'UPDATE')
        OR (SELECT string_agg(a.attname, ',' ORDER BY a.attname) FROM pg_attribute a, aclexplode(a.attacl) x
             WHERE a.attrelid = v.t::regclass AND a.attnum > 0 AND x.grantee = 'munim_core'::regrole AND x.privilege_type = 'UPDATE') IS DISTINCT FROM v.cols
    UNION ALL
    -- Platform: munim_platform pinned UPDATE (never id, code or simulated); network_snapshot INSERT only by munim_core.
    SELECT 'platform-grants' WHERE has_column_privilege('munim_platform', 'platform.cares_recipient', 'simulated', 'UPDATE')
       OR has_column_privilege('munim_platform', 'platform.cares_recipient', 'id', 'UPDATE')
       OR has_column_privilege('munim_platform', 'platform.cares_city', 'code', 'UPDATE')
       OR NOT has_column_privilege('munim_platform', 'platform.cares_recipient', 'name', 'UPDATE')
       OR has_table_privilege('munim_platform', 'platform.network_snapshot', 'INSERT')
       OR (SELECT string_agg(a.attname, ',' ORDER BY a.attname) FROM pg_attribute a, aclexplode(a.attacl) x
            WHERE a.attrelid = 'platform.network_snapshot'::regclass AND x.grantee = 'munim_platform'::regrole AND x.privilege_type = 'UPDATE')
          IS DISTINCT FROM 'publish_draft_id,published_at'
       OR NOT has_table_privilege('munim_core', 'platform.network_snapshot', 'INSERT')
       OR has_any_column_privilege('munim_core', 'platform.network_snapshot', 'UPDATE')
       OR has_any_column_privilege('munim_core', 'platform.cares_recipient', 'INSERT,UPDATE')
    UNION ALL
    -- X1: owner, definer, STABLE, pinned search_path, EXECUTE munim_core only, read-only body.
    SELECT 'definer:' || d FROM unnest(defs) d JOIN pg_proc p ON p.oid = d::regprocedure
     WHERE NOT p.prosecdef OR p.proowner <> 'munim_crosstenant'::regrole OR p.provolatile <> 's'
        OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
        OR NOT has_function_privilege('munim_core', p.oid, 'EXECUTE')
        OR has_function_privilege('munim_svc', p.oid, 'EXECUTE') OR has_function_privilege('munim_platform', p.oid, 'EXECUTE')
        OR has_function_privilege('munim_intel_ro', p.oid, 'EXECUTE')
        OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee NOT IN (p.proowner, 'munim_core'::regrole))
        OR p.prosrc ~* '\m(insert|update|delete|merge|truncate|copy|nextval|setval|set_config|pg_advisory\w*)\M'
    UNION ALL
    -- X1: munim_crosstenant holds exactly these columns of the cares tables (SELECT only), no table-level privilege there,
    -- and no cost or price column outside them.
    SELECT 'crosstenant-columns' WHERE (SELECT string_agg(c.relname || '.' || a.attname || ':' || x.privilege_type, ',' ORDER BY c.relname, a.attname)
                                         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid, aclexplode(a.attacl) x
                                        WHERE c.oid = ANY ((core9 || ARRAY['platform.cares_city', 'platform.cares_recipient', 'platform.cares_enablement'])::regclass[])
                                          AND x.grantee = 'munim_crosstenant'::regrole)
      IS DISTINCT FROM 'cares_allocation.claim_id:SELECT,cares_allocation.claim_tenant_id:SELECT,cares_allocation.created_at:SELECT,cares_allocation.id:SELECT,'
                    || 'cares_allocation.listing_id:SELECT,cares_allocation.tenant_id:SELECT,cares_allocation.verdict:SELECT,'
                    || 'cares_city.code:SELECT,cares_city.status:SELECT,'
                    || 'cares_claim.created_at:SELECT,cares_claim.id:SELECT,cares_claim.offer_listing_id:SELECT,cares_claim.offer_tenant_id:SELECT,'
                    || 'cares_claim.outlet_id:SELECT,cares_claim.status:SELECT,cares_claim.tenant_id:SELECT,'
                    || 'cares_claim_line.claim_id:SELECT,cares_claim_line.offer_line_id:SELECT,cares_claim_line.qty_milli:SELECT,'
                    || 'cares_claim_line.tenant_id:SELECT,cares_claim_line.unit_price_minor:SELECT,'
                    || 'cares_enablement.enabled:SELECT,cares_enablement.tenant_id:SELECT,'
                    || 'cares_handover.allocation_id:SELECT,cares_handover.handed_at:SELECT,cares_handover.id:SELECT,cares_handover.listing_id:SELECT,'
                    || 'cares_handover.status:SELECT,cares_handover.tenant_id:SELECT,'
                    || 'cares_handover_line.handover_id:SELECT,cares_handover_line.listing_line_id:SELECT,cares_handover_line.qty_milli:SELECT,'
                    || 'cares_handover_line.tenant_id:SELECT,'
                    || 'cares_listing.id:SELECT,cares_listing.kind:SELECT,cares_listing.outlet_id:SELECT,cares_listing.pickup_from:SELECT,'
                    || 'cares_listing.pickup_on:SELECT,cares_listing.pickup_to:SELECT,cares_listing.recipient_id:SELECT,cares_listing.status:SELECT,'
                    || 'cares_listing.tenant_id:SELECT,'
                    || 'cares_listing_line.currency:SELECT,cares_listing_line.expires_on:SELECT,cares_listing_line.food_kind:SELECT,'
                    || 'cares_listing_line.id:SELECT,cares_listing_line.ingredient_id:SELECT,cares_listing_line.item_id:SELECT,'
                    || 'cares_listing_line.line_no:SELECT,cares_listing_line.listing_id:SELECT,cares_listing_line.qty_milli:SELECT,'
                    || 'cares_listing_line.tenant_id:SELECT,cares_listing_line.unit:SELECT,cares_listing_line.unit_price_minor:SELECT,'
                    || 'cares_outlet.active:SELECT,cares_outlet.city_code:SELECT,cares_outlet.outlet_id:SELECT,cares_outlet.tenant_id:SELECT,'
                    || 'cares_profile.b2b_enabled:SELECT,cares_profile.public_name:SELECT,cares_profile.status:SELECT,cares_profile.tenant_id:SELECT,'
                    || 'cares_recipient.id:SELECT,cares_recipient.name:SELECT,cares_recipient.simulated:SELECT,cares_recipient.status:SELECT'
       OR EXISTS (SELECT 1 FROM unnest(core9 || plat4) t WHERE has_table_privilege('munim_crosstenant', t, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))
       OR has_any_column_privilege('munim_crosstenant', 'platform.network_snapshot', 'SELECT')
       OR NOT has_column_privilege('munim_crosstenant', 'core.membership', 'outlet_ids', 'SELECT')
       OR NOT has_column_privilege('munim_crosstenant', 'core.outlet', 'name', 'SELECT')
       OR NOT has_column_privilege('munim_crosstenant', 'core.item', 'name_key', 'SELECT')
       OR NOT has_column_privilege('munim_crosstenant', 'core.ingredient', 'name', 'SELECT')
       OR NOT has_column_privilege('munim_crosstenant', 'platform.operator', 'active', 'SELECT')
       OR has_column_privilege('munim_crosstenant', 'platform.operator', 'email', 'SELECT')
       OR has_column_privilege('munim_crosstenant', 'core.stock_movement', 'unit_cost_minor', 'SELECT')
       OR has_column_privilege('munim_crosstenant', 'core.stock_movement', 'unit_cost_per_1000_minor', 'SELECT')
       OR has_column_privilege('munim_crosstenant', 'core.batch', 'mrp_minor', 'SELECT')
       OR has_column_privilege('munim_crosstenant', 'core.price', 'amount_minor', 'SELECT')
       OR has_column_privilege('munim_crosstenant', 'core.staff', 'wage_rate_minor', 'SELECT')
       OR has_column_privilege('munim_crosstenant', 'core.staff', 'monthly_salary_minor', 'SELECT')
       OR has_column_privilege('munim_crosstenant', 'core.cares_claim', 'total_minor', 'SELECT')
       OR has_column_privilege('munim_crosstenant', 'core.cares_allocation', 'total_minor', 'SELECT')
       OR has_column_privilege('munim_crosstenant', 'core.item', 'mrp_minor', 'SELECT')
    UNION ALL
    -- A1: the ten commands, as written.
    SELECT 'commands' WHERE (SELECT string_agg(command_type || '|' || array_to_string(allowed_roles, '+') || '|' || scope || '|' || array_to_string(target_tables, '+')
                                               || '|' || draft_only || '|' || coalesce(outlet_column, '-'), E'\n' ORDER BY command_type)
                               FROM core.command_authority WHERE command_type LIKE 'cares.%')
      IS DISTINCT FROM 'cares.claim.cancel.v1|owner+manager+judge|outlet|core.cares_claim|false|-' || E'\n'
                    || 'cares.claim.close.v1|owner+manager+judge|outlet|core.cares_claim|false|-' || E'\n'
                    || 'cares.claim.create.v1|owner+manager+judge|outlet|core.cares_claim+core.cares_claim_line|false|-' || E'\n'
                    || 'cares.claim.decide.v1|owner+judge|outlet|core.cares_allocation+core.cares_listing|false|-' || E'\n'
                    || 'cares.claim.receive.v1|owner+manager+staff+judge|outlet|core.cares_claim+core.cares_claim_line|false|-' || E'\n'
                    || 'cares.handover.record.v1|owner+manager+staff+judge|outlet|core.cares_handover+core.cares_handover_line+core.cares_listing|false|-' || E'\n'
                    || 'cares.handover.void.v1|owner+judge|outlet|core.cares_handover|false|-' || E'\n'
                    || 'cares.listing.publish.v1|owner+judge|outlet|core.cares_listing+core.cares_listing_line|false|-' || E'\n'
                    || 'cares.listing.withdraw.v1|owner+manager+judge|outlet|core.cares_listing|false|-' || E'\n'
                    || 'cares.profile.set.v1|owner+judge|tenant|core.cares_profile+core.cares_outlet|false|-'
    UNION ALL
    -- D1: four rule rows, each with its source state and a binding on s and n.
    SELECT 'rules' WHERE (SELECT string_agg(rule_id || '|' || source_table || '|' || target_table || '|' || source_state, E'\n' ORDER BY rule_id, target_table)
                            FROM core.derivation_rule WHERE rule_id LIKE 'inventory.cares\_%')
      IS DISTINCT FROM $r$inventory.cares_claim_receive|core.cares_claim|core.batch|s.status = 'received'
inventory.cares_claim_receive|core.cares_claim|core.stock_movement|s.status = 'received'
inventory.cares_handover|core.cares_handover|core.stock_movement|s.status = 'recorded'
inventory.cares_handover_void|core.cares_handover|core.stock_movement|s.status = 'voided'$r$
       OR EXISTS (SELECT 1 FROM core.derivation_rule WHERE rule_id LIKE 'inventory.cares\_%' AND (binding IS NULL OR binding !~ '\ms\.' OR binding !~ '\mn\.'))
    UNION ALL
    -- Book scope and transitions, as written.
    SELECT 'book_scope' WHERE (SELECT string_agg(table_name || ':' || outlet_kind || ':' || coalesce(outlet_ref, '-') || ':' || coalesce(parent_table, '-'), ',' ORDER BY table_name)
                                 FROM core.book_scope WHERE table_name LIKE 'core.cares\_%')
      IS DISTINCT FROM 'core.cares_allocation:column:outlet_id:-,core.cares_claim:column:outlet_id:-,core.cares_claim_line:parent:claim_id:core.cares_claim,'
                    || 'core.cares_handover:column:outlet_id:-,core.cares_handover_line:parent:handover_id:core.cares_handover,'
                    || 'core.cares_listing:column:outlet_id:-,core.cares_listing_line:parent:listing_id:core.cares_listing,'
                    || 'core.cares_outlet:column:outlet_id:-,core.cares_profile:none:-:-'
    UNION ALL
    SELECT 'transitions' WHERE (SELECT string_agg(table_name || ':' || from_status || '>' || to_status, ',' ORDER BY table_name, from_status, to_status)
                                  FROM core.book_status_transition WHERE table_name LIKE 'core.cares\_%')
      IS DISTINCT FROM 'core.cares_claim:requested>cancelled,core.cares_claim:requested>closed,core.cares_claim:requested>received,'
                    || 'core.cares_handover:recorded>voided,core.cares_listing:allocated>closed,core.cares_listing:published>allocated,'
                    || 'core.cares_listing:published>closed,core.cares_listing:published>withdrawn,core.cares_profile:active>paused,core.cares_profile:paused>active'
    UNION ALL
    -- T1: the five templates (version, role) and the definer-reference CHECK.
    SELECT 'templates' WHERE (SELECT string_agg(id || '@' || version || ':' || min_role, ',' ORDER BY id)
                                FROM evidence.snapshot_template WHERE id LIKE 'cares.%' OR id = 'platform.cares_network_impact')
      IS DISTINCT FROM 'cares.impact@1:manager,cares.listings@1:staff,cares.pickup_crew@1:manager,cares.recipient_match@1:manager,platform.cares_network_impact@1:operator'
       OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'evidence.snapshot_template'::regclass AND conname = 'snapshot_template_cares_definers' AND convalidated)
       OR EXISTS (SELECT 1 FROM evidence.snapshot_template WHERE sql ~* 'cares_(network_listings|market_offers|inbound_claims|claim_outcome|network_impact)'
                     AND id <> 'platform.cares_network_impact')
    UNION ALL
    -- C2: core.task.cares_listing_id → the tenant's own listing; no new UPDATE on it.
    SELECT 'task' WHERE NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'core.task'::regclass AND conname = 'task_cares_listing_fk'
                                       AND pg_get_constraintdef(oid) = 'FOREIGN KEY (tenant_id, cares_listing_id) REFERENCES core.cares_listing(tenant_id, id)')
       OR has_column_privilege('munim_core', 'core.task', 'cares_listing_id', 'UPDATE')
    UNION ALL
    -- C1: a received claim names its allocation.
    SELECT 'claim-check' WHERE (SELECT pg_get_constraintdef(oid) FROM pg_constraint
                                 WHERE conrelid = 'core.cares_claim'::regclass AND conname = 'cares_claim_received_allocation')
      IS DISTINCT FROM $d$CHECK (((status <> 'received'::text) OR (allocation_id IS NOT NULL)))$d$
    UNION ALL
    -- D1: the hand-over movement is in the ingredient's base unit with per-unit cumulative sums; the claim's batch is a
    -- fresh one (o.id IS NULL) with no MRP, supplier or GRN line.
    SELECT 'bindings' WHERE (SELECT binding FROM core.derivation_rule WHERE rule_id = 'inventory.cares_handover')
                              !~ 'n\.unit = \(SELECT g\.base_unit FROM core\.ingredient g'
       OR (SELECT count(*) FROM regexp_matches((SELECT binding FROM core.derivation_rule WHERE rule_id = 'inventory.cares_handover'), 'm\.unit = n\.unit', 'g')) <> 2
       OR (SELECT binding FROM core.derivation_rule WHERE rule_id = 'inventory.cares_claim_receive' AND target_table = 'core.batch')
          !~ '^o\.id IS NULL AND n\.mrp_minor IS NULL AND n\.supplier_id IS NULL AND n\.grn_line_id IS NULL AND '
    UNION ALL
    -- No row is in a Cares table yet (this file writes none).
    SELECT 'rows' WHERE EXISTS (SELECT 1 FROM core.cares_listing) OR EXISTS (SELECT 1 FROM platform.cares_recipient)
       OR EXISTS (SELECT 1 FROM core.stock_movement WHERE kind IN ('donation', 'surplus_out', 'surplus_in', 'cares_reversal'))) y;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0028: Munim Cares not as written: %', bad; END IF;

  PERFORM munim_meta.assert_catalog('0028');
END $$;
