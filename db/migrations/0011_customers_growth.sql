-- 0011_customers_growth — loyalty ledger, campaigns, reservations, reviews, bulk orders (02-schema §2.9,
-- packs/customers-growth.md, R40 C2, R41). All books (R29: customer and loyalty records, outbound messages).
-- Runs as munim_migrator. RLS predicates: see the header of 0003.
--
-- Loyalty (R40 C2): append-only entries; each stores seq and balance_after, set by the trigger while it
-- holds the customer's row lock (SELECT … FOR UPDATE on core.customer), so concurrent redeems serialise
-- per customer and the balance never goes below zero (MB011 loyalty_refused). The balance shown is the
-- latest entry's balance_after — a row's own field. Customer contexts see only their own entries (R41).
--
-- Campaigns are created only by an approved draft (origin.kind = 'decision'): a person's direct command
-- cannot create one, even with authority for the command type (R15, R16; never auto-sent).

CREATE TABLE core.loyalty_entry (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  customer_id   uuid        NOT NULL,
  seq           bigint      NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('earn', 'redeem', 'reverse', 'expire', 'adjust')),
  points        bigint      NOT NULL CHECK (points <> 0),
  balance_after bigint      NOT NULL CHECK (balance_after >= 0),
  order_id      uuid,
  reverses_id   uuid,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  origin        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT loyalty_entry_seq_unique UNIQUE (tenant_id, customer_id, seq),
  CONSTRAINT loyalty_entry_one_reversal UNIQUE (tenant_id, reverses_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES core.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES core."order" (tenant_id, id),
  FOREIGN KEY (tenant_id, reverses_id) REFERENCES core.loyalty_entry (tenant_id, id),
  CHECK (CASE kind WHEN 'earn' THEN points > 0 WHEN 'redeem' THEN points < 0 WHEN 'expire' THEN points < 0 ELSE true END),
  CHECK ((kind = 'reverse') = (reverses_id IS NOT NULL))
);

-- A queued campaign (customers.campaign.create.v1). audience_count is the consented_audience cell the draft
-- cited; the segment snapshot is kept beside it.
CREATE TABLE core.campaign (
  tenant_id           uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                  uuid        NOT NULL,
  name                text        NOT NULL CHECK (name <> ''),
  channel             text        NOT NULL CHECK (channel IN ('email', 'sms')),
  outlet_ids          uuid[]      NOT NULL DEFAULT '{}',
  segment_snapshot_id uuid        NOT NULL,
  audience_count      integer     NOT NULL CHECK (audience_count >= 0),
  message_key         text        NOT NULL CHECK (message_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  placeholders        jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(placeholders) = 'object'),
  coupon_id           uuid,
  send_at             timestamptz NOT NULL,
  window_from         timestamptz,
  window_to           timestamptz,
  status              text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'cancelled')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  origin              jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, segment_snapshot_id) REFERENCES evidence.snapshot (tenant_id, id),
  FOREIGN KEY (tenant_id, coupon_id) REFERENCES core.coupon (tenant_id, id),
  CHECK (window_to IS NULL OR window_from IS NULL OR window_to > window_from)
);

CREATE TABLE core.reservation (
  tenant_id    uuid        NOT NULL,
  id           uuid        NOT NULL,
  outlet_id    uuid        NOT NULL,
  customer_id  uuid,
  name         text        NOT NULL CHECK (name <> ''),
  phone        text        CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  party_size   integer     NOT NULL CHECK (party_size BETWEEN 1 AND 500),
  starts_at    timestamptz NOT NULL,
  duration_min integer     NOT NULL DEFAULT 90 CHECK (duration_min BETWEEN 15 AND 720),
  table_ref    text        CHECK (length(table_ref) BETWEEN 1 AND 20),
  status       text        NOT NULL DEFAULT 'booked'
                 CHECK (status IN ('booked', 'seated', 'completed', 'cancelled', 'no_show')),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  origin       jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES core.customer (tenant_id, id)
);

-- Imported (or hand-entered) reviews. `body` is untrusted text: evidence for claims, never in traces.
CREATE TABLE core.review (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  outlet_id     uuid        NOT NULL,
  channel_id    uuid,
  source        text        NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]*$'),
  external_ref  text        NOT NULL CHECK (external_ref <> ''),
  rating        smallint    NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body          text,
  reviewed_at   timestamptz NOT NULL,
  import_run_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  origin        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT review_external_ref_unique UNIQUE (tenant_id, source, external_ref),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES core.channel (tenant_id, id),
  FOREIGN KEY (tenant_id, import_run_id) REFERENCES core.import_run (tenant_id, id)
);

CREATE TABLE core.bulk_order (
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,
  outlet_id     uuid        NOT NULL,
  customer_id   uuid,
  contact_name  text        NOT NULL CHECK (contact_name <> ''),
  contact_phone text        CHECK (contact_phone ~ '^\+[1-9][0-9]{6,14}$'),
  deliver_at    timestamptz NOT NULL,
  headcount     integer     CHECK (headcount >= 1),
  status        text        NOT NULL DEFAULT 'enquiry'
                  CHECK (status IN ('enquiry', 'quoted', 'confirmed', 'delivered', 'cancelled')),
  quote_minor   bigint      CHECK (quote_minor >= 0),
  advance_minor bigint      CHECK (advance_minor >= 0),
  currency      char(3),
  order_id      uuid,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  origin        jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES core.customer (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES core."order" (tenant_id, id),
  CHECK ((currency IS NULL) = (quote_minor IS NULL AND advance_minor IS NULL)),
  CHECK (status NOT IN ('quoted', 'confirmed', 'delivered') OR quote_minor IS NOT NULL)
);

-- 0004 left coupon.campaign_id without its FK until core.campaign existed.
ALTER TABLE core.coupon ADD FOREIGN KEY (tenant_id, campaign_id) REFERENCES core.campaign (tenant_id, id);

------------------------------------------------------------------------------------------------------------
-- Functions and triggers
------------------------------------------------------------------------------------------------------------
-- R40 C2. Values supplied for seq and balance_after are overwritten.
CREATE FUNCTION core.loyalty_balance() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  prev_seq bigint;
  prev_bal bigint;
BEGIN
  -- The per-customer row lock: concurrent entries for one customer queue here.
  PERFORM 1 FROM core.customer c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.customer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'loyalty_refused: customer % is not visible in this context', NEW.customer_id USING ERRCODE = 'MB011';
  END IF;
  -- A new statement, so (READ COMMITTED) it sees every entry committed before the lock was granted.
  SELECT e.seq, e.balance_after INTO prev_seq, prev_bal
    FROM core.loyalty_entry e
   WHERE e.tenant_id = NEW.tenant_id AND e.customer_id = NEW.customer_id
   ORDER BY e.seq DESC LIMIT 1;
  NEW.seq := coalesce(prev_seq, 0) + 1;
  NEW.balance_after := coalesce(prev_bal, 0) + NEW.points;
  IF NEW.balance_after < 0 THEN
    RAISE EXCEPTION 'loyalty_refused: balance % cannot cover % points', coalesce(prev_bal, 0), -NEW.points
      USING ERRCODE = 'MB011';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.loyalty_balance() FROM PUBLIC;

-- Fires after book_guard (name order), which has already stamped origin.
CREATE FUNCTION core.campaign_from_decision() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.origin ->> 'kind' IS DISTINCT FROM 'decision' THEN
    RAISE EXCEPTION 'book_write_refused: core.campaign — a campaign is created only by approving its draft'
      USING ERRCODE = 'MB001';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.campaign_from_decision() FROM PUBLIC;

CREATE TRIGGER loyalty_balance BEFORE INSERT ON core.loyalty_entry FOR EACH ROW EXECUTE FUNCTION core.loyalty_balance();
CREATE TRIGGER campaign_from_decision BEFORE INSERT ON core.campaign FOR EACH ROW EXECUTE FUNCTION core.campaign_from_decision();

CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.loyalty_entry FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.campaign      FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.reservation   FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.review        FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.bulk_order    FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();

CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.bulk_order FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');

------------------------------------------------------------------------------------------------------------
-- RLS. loyalty_entry: R41 own-rows rule (as core.customer's, on customer_id).
------------------------------------------------------------------------------------------------------------
ALTER TABLE core.loyalty_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.loyalty_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_customer_own ON core.loyalty_entry
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'customer'
              OR customer_id = (SELECT nullif(current_setting('app.customer_id', true), '')::uuid)))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'customer'
              OR customer_id = (SELECT nullif(current_setting('app.customer_id', true), '')::uuid)));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaign', 'reservation', 'review', 'bulk_order'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON core.%I
      USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
      WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))$p$, t);
  END LOOP;
END $$;

COMMENT ON TABLE core.loyalty_entry IS 'munim:book';
COMMENT ON TABLE core.campaign      IS 'munim:book';
COMMENT ON TABLE core.reservation   IS 'munim:book';
COMMENT ON TABLE core.review        IS 'munim:book';
COMMENT ON TABLE core.bulk_order    IS 'munim:book';

------------------------------------------------------------------------------------------------------------
-- Grants. loyalty_entry and review are append-only.
------------------------------------------------------------------------------------------------------------
REVOKE ALL ON core.loyalty_entry, core.campaign, core.reservation, core.review, core.bulk_order FROM PUBLIC;
GRANT SELECT ON core.loyalty_entry, core.campaign, core.reservation, core.review, core.bulk_order TO munim_core, munim_svc;
GRANT INSERT ON core.loyalty_entry, core.campaign, core.reservation, core.review, core.bulk_order TO munim_core;
GRANT UPDATE (status) ON core.campaign TO munim_core;
GRANT UPDATE (customer_id, name, phone, party_size, starts_at, duration_min, table_ref, status, note) ON core.reservation TO munim_core;
GRANT UPDATE (customer_id, contact_name, contact_phone, deliver_at, headcount, status, quote_minor, advance_minor,
  currency, order_id, note) ON core.bulk_order TO munim_core;

------------------------------------------------------------------------------------------------------------
-- Indexes
------------------------------------------------------------------------------------------------------------
CREATE INDEX loyalty_entry_order_id_fk_idx ON core.loyalty_entry (tenant_id, order_id);
CREATE INDEX campaign_segment_snapshot_id_fk_idx ON core.campaign (tenant_id, segment_snapshot_id);
CREATE INDEX campaign_coupon_id_fk_idx ON core.campaign (tenant_id, coupon_id);
CREATE INDEX coupon_campaign_id_fk_idx ON core.coupon (tenant_id, campaign_id);
CREATE INDEX reservation_outlet_id_fk_idx ON core.reservation (tenant_id, outlet_id, starts_at);
CREATE INDEX reservation_customer_id_fk_idx ON core.reservation (tenant_id, customer_id);
CREATE INDEX review_outlet_id_fk_idx ON core.review (tenant_id, outlet_id, reviewed_at);
CREATE INDEX review_channel_id_fk_idx ON core.review (tenant_id, channel_id);
CREATE INDEX review_import_run_id_fk_idx ON core.review (tenant_id, import_run_id);
CREATE INDEX bulk_order_outlet_id_fk_idx ON core.bulk_order (tenant_id, outlet_id);
CREATE INDEX bulk_order_customer_id_fk_idx ON core.bulk_order (tenant_id, customer_id);
CREATE INDEX bulk_order_order_id_fk_idx ON core.bulk_order (tenant_id, order_id);

------------------------------------------------------------------------------------------------------------
-- Derivations and command authority (draft type from packs/customers-growth.md §6; the rest INFERENCE)
------------------------------------------------------------------------------------------------------------
-- Earn on completion and reverse on cancellation are derived from the order (T-028).
INSERT INTO core.derivation_rule (rule_id, source_table, target_table) VALUES
  ('customers.loyalty_earn',    'core.order', 'core.loyalty_entry'),
  ('customers.loyalty_reverse', 'core.order', 'core.loyalty_entry');

-- Redeeming at checkout is part of placing the order (the customer's own command or the cashier's).
UPDATE core.command_authority SET target_tables = target_tables || ARRAY['core.loyalty_entry']
 WHERE command_type = 'orders.place.v1';
UPDATE core.command_authority SET target_tables = target_tables || ARRAY['core.review']
 WHERE command_type = 'imports.run.commit.v1';

INSERT INTO core.command_authority (command_type, allowed_roles, scope, target_tables) VALUES
  ('customers.campaign.create.v1',     ARRAY['owner', 'manager', 'judge'],          'tenant', ARRAY['core.campaign']),
  ('customers.campaign.cancel.v1',     ARRAY['owner', 'manager', 'judge'],          'tenant', ARRAY['core.campaign']),
  ('customers.loyalty.adjust.v1',      ARRAY['owner', 'manager', 'judge'],          'tenant', ARRAY['core.loyalty_entry']),
  ('customers.reservation.upsert.v1',  ARRAY['owner', 'manager', 'staff', 'judge'], 'outlet', ARRAY['core.reservation']),
  ('customers.review.record.v1',       ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.review']),
  ('customers.bulk_order.upsert.v1',   ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.bulk_order']);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'loyalty_entry_seq_unique' AND contype = 'u'
                    AND conrelid = 'core.loyalty_entry'::regclass) THEN
    RAISE EXCEPTION '0011: loyalty_entry seq uniqueness missing';
  END IF;
  PERFORM munim_meta.assert_catalog('0011');
END $$;
