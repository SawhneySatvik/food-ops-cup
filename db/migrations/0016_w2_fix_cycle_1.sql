-- 0016_w2_fix_cycle_1 — W2 adversarial review, fix cycle 1, migrator row m-4 (docs/plan/W2-FIX-LIST.md), fix forward
-- over 0001–0015. Runs as munim_migrator. Items:
--   R3-M1    core.order_event.seq: per order, gapless from 1, assigned by the database under a per-order transaction
--            lock (supplied values overwritten); existing rows numbered by (at, id).
--   R1-m5    customers.loyalty_reverse: the cancel path reads the order (cancelled / rejected); the refund path reads the
--            REFUND (its order completed), cites it in loyalty_entry.refund_id (same order, FK) — at most one entry per
--            refund (unique). Every reverse entry undoes an entry of the same customer and order, opposite sign, never
--            more points than it had. finance.reconcile_settlement / reconcile_bank need a committed run (as 0015 A2).
--            The order and order-line pricing freezes evaluate orders.reprice's source state, not just its name. An
--            order's guest token hash is cleared whenever its customer changes (the token claim and the A10 merge).
--   R2-S1-4  finance.post_loyalty_redemption: a completed order with an unreversed redemption posts its value
--            (Dr loyalty redemptions 4100, Cr counter sales clearing 1110 — core-domain f-2); account 4100 backfilled.
--   R1-m4    the verified-email merge also moves coupon_use.customer_id and returns those rows.
--   R1-M1    core.customer_erase_merged_guests(uuid): erases the guest profiles merged into an erased profile (a
--            customer's own erasure cannot see them: customer_scope RLS, guard own-row rule).
--   R2-S2-8  unit_cost_per_1000_minor on stock_movement and supplier_return_line (cost of 1000 base units, minor).
--   D1       a default core.business_policy row for every tenant without a tenant-wide one.
--   D2       purchasing.invoice.dispute.v1 may move core.payable (open → disputed already in book_status_transition).
-- Backfills (section 9) write existing tenants' rows with the book guard disabled for this transaction only; every
-- inserted row carries origin {kind: migration} and one audit_log entry (actor {kind: migration}).
-- New SQLSTATEs: none (refusals use MB001, MB011).

------------------------------------------------------------------------------------------------------------
-- 1. R3-M1 — order_event.seq
------------------------------------------------------------------------------------------------------------
-- The order's own event sequence (1, 2, 3 … in commit order of the writers of that order). Clients never supply it:
-- the trigger takes a transaction lock per order and sets max + 1 under it, as core.outbox_seq does per tenant.
-- Insert-only like the rest of the row (no UPDATE grant on order_event). NOT NULL after the backfill (section 9).
ALTER TABLE core.order_event ADD COLUMN seq bigint CONSTRAINT order_event_seq_check CHECK (seq >= 1);
REVOKE ALL (seq) ON core.order_event FROM PUBLIC;

CREATE FUNCTION core.order_event_seq() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('core.order_event:' || NEW.tenant_id::text || ':' || NEW.order_id::text, 0));
  SELECT coalesce(max(e.seq), 0) + 1 INTO NEW.seq FROM core.order_event e WHERE e.tenant_id = NEW.tenant_id AND e.order_id = NEW.order_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.order_event_seq() FROM PUBLIC;
CREATE TRIGGER order_event_seq BEFORE INSERT ON core.order_event FOR EACH ROW EXECUTE FUNCTION core.order_event_seq();

------------------------------------------------------------------------------------------------------------
-- 2. R1-m5 — loyalty reversal: cancel path by order, refund path by refund (once per refund)
------------------------------------------------------------------------------------------------------------
-- The refund a refund-path reversal answers. The composite FK binds it to the entry's own order; the unique index
-- makes it once per refund. 0011's loyalty_entry_one_reversal (each entry reversed at most once) is unchanged.
ALTER TABLE core.refund ADD CONSTRAINT refund_order_unique UNIQUE (tenant_id, order_id, id);
ALTER TABLE core.loyalty_entry ADD COLUMN refund_id uuid;
ALTER TABLE core.loyalty_entry
  ADD CONSTRAINT loyalty_entry_refund_reverse CHECK (refund_id IS NULL OR (kind = 'reverse' AND order_id IS NOT NULL)),
  ADD CONSTRAINT loyalty_entry_refund_fkey FOREIGN KEY (tenant_id, order_id, refund_id) REFERENCES core.refund (tenant_id, order_id, id);
CREATE UNIQUE INDEX loyalty_entry_one_per_refund ON core.loyalty_entry (tenant_id, refund_id);
CREATE INDEX loyalty_entry_refund_fk_idx ON core.loyalty_entry (tenant_id, order_id, refund_id);
REVOKE ALL (refund_id) ON core.loyalty_entry FROM PUBLIC;

-- The guard checks the source row's state; this binds the written row to that source. Under
-- customers.loyalty_reverse: a core.refund source → refund_id = that refund; a core.order source → no refund_id and
-- order_id = that order. A refund_id under any other provenance is refused. Every reverse entry (any provenance)
-- undoes an existing entry of the same customer and order, with the opposite sign and at most its points.
-- Runs after book_guard (name order), so NEW.origin is the guard's stamp.
CREATE FUNCTION core.loyalty_reverse_binding() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  src  text := NEW.origin ->> 'source_ref';
  undo record;
BEGIN
  IF NEW.origin ->> 'kind' = 'derivation' AND NEW.origin ->> 'rule_id' = 'customers.loyalty_reverse' THEN
    IF NOT (coalesce(src = 'core.refund:' || NEW.refund_id::text, false)
            OR (NEW.refund_id IS NULL AND coalesce(src = 'core.order:' || NEW.order_id::text, false))) THEN
      RAISE EXCEPTION 'book_write_refused: core.loyalty_entry — a loyalty reversal cites its own source (refund_id for a refund, order_id for an order)'
        USING ERRCODE = 'MB001';
    END IF;
  ELSIF NEW.refund_id IS NOT NULL THEN
    RAISE EXCEPTION 'book_write_refused: core.loyalty_entry — refund_id is written only under customers.loyalty_reverse'
      USING ERRCODE = 'MB001';
  END IF;
  IF NEW.kind = 'reverse' THEN
    SELECT e.customer_id, e.order_id, e.points INTO undo FROM core.loyalty_entry e WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.reverses_id;
    IF NOT FOUND OR undo.customer_id <> NEW.customer_id OR undo.order_id IS DISTINCT FROM NEW.order_id
       OR sign(undo.points) = sign(NEW.points) OR abs(NEW.points) > abs(undo.points) THEN
      RAISE EXCEPTION 'loyalty_refused: a reversal undoes an entry of the same customer and order, opposite sign, at most its points'
        USING ERRCODE = 'MB011';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.loyalty_reverse_binding() FROM PUBLIC;
CREATE TRIGGER reverse_binding BEFORE INSERT ON core.loyalty_entry FOR EACH ROW EXECUTE FUNCTION core.loyalty_reverse_binding();

------------------------------------------------------------------------------------------------------------
-- 3. Derivation rules (R1-m5, R2-S1-4, R1-m4, R1-M1). db/derivation-rules.json lists every row (gate: DB = file).
------------------------------------------------------------------------------------------------------------
INSERT INTO core.derivation_rule (rule_id, source_table, target_table) VALUES
  -- Refund path of the loyalty reversal: the source is the refund itself.
  ('customers.loyalty_reverse',        'core.refund',   'core.loyalty_entry'),
  -- The value of the points a completed order redeemed clears counter sales clearing (1110).
  ('finance.post_loyalty_redemption',  'core.order',    'core.journal_entry'),
  ('finance.post_loyalty_redemption',  'core.order',    'core.posting'),
  -- The verified-email merge also moves the guests' coupon uses.
  ('customers.merge_verified_email',   'core.customer', 'core.coupon_use'),
  -- Erasure reaches the guest profiles merged into the erased profile (only inside the definer, section 7).
  ('customers.erase_merged_guests',    'core.customer', 'core.customer');

UPDATE core.derivation_rule SET source_state = p.state
  FROM (VALUES
    ('customers.loyalty_reverse', 'core.order',
     $s$s.status IN ('cancelled', 'rejected')$s$),
    ('customers.loyalty_reverse', 'core.refund',
     $s$EXISTS (SELECT 1 FROM core."order" o WHERE o.tenant_id = s.tenant_id AND o.id = s.order_id AND o.status = 'completed')$s$),
    ('finance.post_loyalty_redemption', 'core.order',
     $s$s.status = 'completed' AND EXISTS (SELECT 1 FROM core.loyalty_entry l WHERE l.tenant_id = s.tenant_id AND l.order_id = s.id AND l.kind = 'redeem' AND NOT EXISTS (SELECT 1 FROM core.loyalty_entry r WHERE r.tenant_id = l.tenant_id AND r.reverses_id = l.id))$s$),
    ('finance.reconcile_settlement', 'core.settlement',
     $s$s.import_run_id IS NOT NULL AND EXISTS (SELECT 1 FROM core.import_run r WHERE r.tenant_id = s.tenant_id AND r.id = s.import_run_id AND r.status = 'committed')$s$),
    ('finance.reconcile_bank', 'core.bank_line',
     $s$s.import_run_id IS NOT NULL AND EXISTS (SELECT 1 FROM core.import_run r WHERE r.tenant_id = s.tenant_id AND r.id = s.import_run_id AND r.status = 'committed')$s$),
    -- The coupon_use row of the merge rule carries the rule's state (0015).
    ('customers.merge_verified_email', 'core.customer',
     $s$s.id = nullif(current_setting('app.customer_id', true), '')::uuid AND NOT s.is_guest AND s.erased_at IS NULL AND s.email_verified_at IS NOT NULL AND current_user = 'munim_crosstenant'$s$),
    -- The source is the erased profile; the rule holds only inside core.customer_erase_merged_guests().
    ('customers.erase_merged_guests', 'core.customer',
     $s$s.erased_at IS NOT NULL AND current_user = 'munim_crosstenant'$s$)
  ) AS p (rule_id, source_table, state)
 WHERE core.derivation_rule.rule_id = p.rule_id AND core.derivation_rule.source_table = p.source_table;

------------------------------------------------------------------------------------------------------------
-- 4. R1-m5 — the pricing freezes evaluate orders.reprice's source state
------------------------------------------------------------------------------------------------------------
-- 0014/0015 compared only the setting text, so an own command (or decision) that also set app.posting_rule =
-- orders.reprice passed the guard through its own branch and rewrote a completed order's money. Now the source
-- order must also satisfy the rule row's source_state (placed / accepted), read from core.derivation_rule.
CREATE OR REPLACE FUNCTION core.order_pricing_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  state text;
  ok    boolean := false;
BEGIN
  IF (NEW.subtotal_minor, NEW.discount_minor, NEW.tax_minor, NEW.total_minor, NEW.currency, NEW.pricing_snapshot)
       IS DISTINCT FROM (OLD.subtotal_minor, OLD.discount_minor, OLD.tax_minor, OLD.total_minor, OLD.currency, OLD.pricing_snapshot) THEN
    IF coalesce(current_setting('app.posting_rule', true), '') = 'orders.reprice'
       AND coalesce(current_setting('app.source_ref', true), '') = 'core.order:' || OLD.id::text THEN
      SELECT dr.source_state INTO state FROM core.derivation_rule dr
       WHERE dr.rule_id = 'orders.reprice' AND dr.source_table = 'core.order' AND dr.target_table = 'core.order';
      IF state IS NOT NULL THEN
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM core."order" s WHERE s.tenant_id = $1 AND s.id = $2 AND (%s))', state)
           INTO ok USING OLD.tenant_id, OLD.id;
      END IF;
    END IF;
    IF NOT coalesce(ok, false) THEN
      RAISE EXCEPTION 'book_write_refused: core.order — money columns change only under the pricing rule orders.reprice, while the order is in its source state'
        USING ERRCODE = 'MB001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.order_pricing_frozen() FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.order_line_pricing_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  state text;
  ok    boolean := false;
BEGIN
  IF (NEW.unit_price_minor, NEW.line_discount_minor, NEW.tax_minor)
       IS DISTINCT FROM (OLD.unit_price_minor, OLD.line_discount_minor, OLD.tax_minor) THEN
    IF coalesce(current_setting('app.posting_rule', true), '') = 'orders.reprice'
       AND coalesce(current_setting('app.source_ref', true), '') = 'core.order:' || OLD.order_id::text THEN
      SELECT dr.source_state INTO state FROM core.derivation_rule dr
       WHERE dr.rule_id = 'orders.reprice' AND dr.source_table = 'core.order' AND dr.target_table = 'core.order_line';
      IF state IS NOT NULL THEN
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM core."order" s WHERE s.tenant_id = $1 AND s.id = $2 AND (%s))', state)
           INTO ok USING OLD.tenant_id, OLD.order_id;
      END IF;
    END IF;
    IF NOT coalesce(ok, false) THEN
      RAISE EXCEPTION 'book_write_refused: core.order_line — money columns change only under the pricing rule orders.reprice, while the order is in its source state'
        USING ERRCODE = 'MB001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.order_line_pricing_frozen() FROM PUBLIC;

------------------------------------------------------------------------------------------------------------
-- 5. R1-m5 — a guest token stops working once its order changes customer
------------------------------------------------------------------------------------------------------------
-- The token claim (customers.account.link.v1) and the A10 merge both move an order to a signed-in profile; from then
-- on the order is reached through that profile, never through the bearer token. A database rule, so no caller can
-- forget it and munim_core needs no UPDATE on guest_access_hash. The claim's own WHERE guest_access_hash = … and the
-- guard's OLD-row ownership read OLD, so the claim still matches.
CREATE FUNCTION core.order_guest_hash_clear() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    NEW.guest_access_hash := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.order_guest_hash_clear() FROM PUBLIC;
CREATE TRIGGER guest_hash_clear BEFORE UPDATE OF customer_id ON core."order" FOR EACH ROW EXECUTE FUNCTION core.order_guest_hash_clear();

------------------------------------------------------------------------------------------------------------
-- 6. D2 — an invoice dispute also moves its payable (open → disputed is a book_status_transition row since 0014)
------------------------------------------------------------------------------------------------------------
UPDATE core.command_authority SET target_tables = target_tables || ARRAY['core.payable']
 WHERE command_type = 'purchasing.invoice.dispute.v1';

------------------------------------------------------------------------------------------------------------
-- 7. R1-m4 / R1-M1 — the verified-email merge moves coupon uses; erasure reaches merged guest profiles
------------------------------------------------------------------------------------------------------------
-- Re-issued from 0015 (owner, SECURITY DEFINER, search_path and EXECUTE unchanged): coupon_use rows of the merged
-- guests move too and are returned as core.coupon_use (entity order: bulk_order < coupon_use < customer < order <
-- reservation).
CREATE OR REPLACE FUNCTION core.customer_claim_verified_email_guests()
RETURNS TABLE (entity text, entity_id uuid, from_customer_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t         uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  me        uuid := nullif(current_setting('app.customer_id', true), '')::uuid;
  prev_rule text := coalesce(current_setting('app.posting_rule', true), '');
  prev_src  text := coalesce(current_setting('app.source_ref', true), '');
  mail      text;
  guests    uuid[];
BEGIN
  IF current_setting('app.role', true) IS DISTINCT FROM 'customer'
     OR current_setting('app.command_type', true) IS DISTINCT FROM 'customers.account.link.v1'
     OR t IS NULL OR me IS NULL THEN
    RAISE EXCEPTION 'book_write_refused: the verified-email merge runs only in the customer''s own customers.account.link.v1'
      USING ERRCODE = 'MB001';
  END IF;
  SELECT lower(c.email) INTO mail FROM core.customer c
   WHERE c.tenant_id = t AND c.id = me AND NOT c.is_guest AND c.idp_sub IS NOT NULL AND c.erased_at IS NULL
     AND c.merged_into IS NULL AND c.email_verified_at IS NOT NULL AND c.email IS NOT NULL;
  IF mail IS NULL THEN
    RETURN;
  END IF;
  SELECT array_agg(g.id ORDER BY g.id) INTO guests FROM core.customer g
   WHERE g.tenant_id = t AND g.id <> me AND g.is_guest AND g.idp_sub IS NULL AND g.erased_at IS NULL
     AND g.merged_into IS NULL AND lower(g.email) = mail;
  IF guests IS NULL THEN
    RETURN;
  END IF;

  PERFORM set_config('app.posting_rule', 'customers.merge_verified_email', true),
          set_config('app.source_ref', 'core.customer:' || me::text, true);
  RETURN QUERY
    WITH o AS (
      UPDATE core."order" x SET customer_id = me
        FROM (SELECT y.id, y.customer_id FROM core."order" y WHERE y.tenant_id = t AND y.customer_id = ANY (guests) FOR UPDATE) prev
       WHERE x.tenant_id = t AND x.id = prev.id
      RETURNING x.id, prev.customer_id
    ), r AS (
      UPDATE core.reservation x SET customer_id = me
        FROM (SELECT y.id, y.customer_id FROM core.reservation y WHERE y.tenant_id = t AND y.customer_id = ANY (guests) FOR UPDATE) prev
       WHERE x.tenant_id = t AND x.id = prev.id
      RETURNING x.id, prev.customer_id
    ), b AS (
      UPDATE core.bulk_order x SET customer_id = me
        FROM (SELECT y.id, y.customer_id FROM core.bulk_order y WHERE y.tenant_id = t AND y.customer_id = ANY (guests) FOR UPDATE) prev
       WHERE x.tenant_id = t AND x.id = prev.id
      RETURNING x.id, prev.customer_id
    ), cu AS (
      UPDATE core.coupon_use x SET customer_id = me
        FROM (SELECT y.id, y.customer_id FROM core.coupon_use y WHERE y.tenant_id = t AND y.customer_id = ANY (guests) FOR UPDATE) prev
       WHERE x.tenant_id = t AND x.id = prev.id
      RETURNING x.id, prev.customer_id
    ), g AS (
      UPDATE core.customer x SET merged_into = me WHERE x.tenant_id = t AND x.id = ANY (guests)
      RETURNING x.id
    )
    SELECT u.entity, u.entity_id, u.from_customer_id
      FROM (SELECT 'core.order'::text AS entity, o.id AS entity_id, o.customer_id AS from_customer_id FROM o
            UNION ALL SELECT 'core.reservation', r.id, r.customer_id FROM r
            UNION ALL SELECT 'core.bulk_order', b.id, b.customer_id FROM b
            UNION ALL SELECT 'core.coupon_use', cu.id, cu.customer_id FROM cu
            UNION ALL SELECT 'core.customer', g.id, g.id FROM g) u
     ORDER BY u.entity, u.entity_id;
  PERFORM set_config('app.posting_rule', prev_rule, true), set_config('app.source_ref', prev_src, true);
END $$;

-- Called by core-api inside customers.erasure.request.v1, AFTER the profile itself is erased (erased_at set): erases
-- every live guest profile merged into it (core.customer_erasure blanks their personal columns). The customer's own
-- context cannot do this itself — customer_scope RLS hides other profiles and the guard admits only its own row —
-- hence SECURITY DEFINER (munim_crosstenant, BYPASSRLS), EXECUTE munim_core only. Callers: the customer erasing its
-- own profile (app.role customer, id = app.customer_id), or an owner holding '{*}' (the command's own allowed roles).
-- Writes pass the guard through customers.erase_merged_guests (source = the erased profile; current_user clause).
-- Returns one row per erased guest profile (entity core.customer), ordered by id, for the caller's audit entries.
CREATE FUNCTION core.customer_erase_merged_guests(erased_customer_id uuid)
RETURNS TABLE (entity text, entity_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t         uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  r         text := nullif(current_setting('app.role', true), '');
  prev_rule text := coalesce(current_setting('app.posting_rule', true), '');
  prev_src  text := coalesce(current_setting('app.source_ref', true), '');
BEGIN
  IF current_setting('app.command_type', true) IS DISTINCT FROM 'customers.erasure.request.v1'
     OR t IS NULL OR erased_customer_id IS NULL
     OR NOT coalesce((r = 'customer' AND erased_customer_id = nullif(current_setting('app.customer_id', true), '')::uuid)
                     OR (r = 'owner' AND current_setting('app.outlet_ids', true) = '{*}'), false) THEN
    RAISE EXCEPTION 'book_write_refused: merged guest profiles are erased only inside customers.erasure.request.v1, by the customer or an owner'
      USING ERRCODE = 'MB001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.customer c WHERE c.tenant_id = t AND c.id = erased_customer_id AND c.erased_at IS NOT NULL) THEN
    RAISE EXCEPTION 'book_write_refused: erase the profile itself first' USING ERRCODE = 'MB001';
  END IF;
  PERFORM set_config('app.posting_rule', 'customers.erase_merged_guests', true),
          set_config('app.source_ref', 'core.customer:' || erased_customer_id::text, true);
  RETURN QUERY
    WITH g AS (
      UPDATE core.customer x SET erased_at = now()
       WHERE x.tenant_id = t AND x.merged_into = erased_customer_id AND x.erased_at IS NULL
      RETURNING x.id
    )
    SELECT 'core.customer'::text, g.id FROM g ORDER BY g.id;
  PERFORM set_config('app.posting_rule', prev_rule, true), set_config('app.source_ref', prev_src, true);
END $$;

-- What the two functions (and the triggers they fire, which run as munim_crosstenant) need beyond 0015's grants.
GRANT SELECT (tenant_id, id, customer_id), UPDATE (customer_id) ON core.coupon_use TO munim_crosstenant;
GRANT UPDATE (erased_at) ON core.customer TO munim_crosstenant;

GRANT CREATE ON SCHEMA core TO munim_crosstenant;
ALTER FUNCTION core.customer_erase_merged_guests(uuid) OWNER TO munim_crosstenant;
REVOKE CREATE ON SCHEMA core FROM munim_crosstenant;
REVOKE ALL ON FUNCTION core.customer_erase_merged_guests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.customer_erase_merged_guests(uuid) TO munim_core;

------------------------------------------------------------------------------------------------------------
-- 8. R2-S2-8 — unit cost per 1000 base units
------------------------------------------------------------------------------------------------------------
-- unit_cost_minor on these two tables is per ONE base unit (g, ml, each), so ₹410.01/kg became 41 paise/g. The new
-- column is the cost of 1000 units of the row's `unit` in minor units (₹410.01/kg → 41001 per 1000 g, exact);
-- value_minor = round(qty_milli × unit_cost_per_1000_minor / 1 000 000). unit_cost_minor stays as written before
-- (round half up of the new column / 1000) for existing readers. A writer supplies either column (or both, equal
-- under that rounding — CHECK); the trigger fills the other. grn_line keeps its per-purchase-unit cost (exact).
ALTER TABLE core.stock_movement ADD COLUMN unit_cost_per_1000_minor bigint
  CONSTRAINT stock_movement_unit_cost_per_1000_check CHECK (unit_cost_per_1000_minor >= 0);
ALTER TABLE core.supplier_return_line ADD COLUMN unit_cost_per_1000_minor bigint
  CONSTRAINT supplier_return_line_unit_cost_per_1000_check CHECK (unit_cost_per_1000_minor >= 0);
REVOKE ALL (unit_cost_per_1000_minor) ON core.stock_movement FROM PUBLIC;
REVOKE ALL (unit_cost_per_1000_minor) ON core.supplier_return_line FROM PUBLIC;

CREATE FUNCTION core.unit_cost_fill() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.unit_cost_per_1000_minor IS NULL AND NEW.unit_cost_minor IS NOT NULL THEN
    NEW.unit_cost_per_1000_minor := NEW.unit_cost_minor * 1000;
  ELSIF NEW.unit_cost_per_1000_minor IS NOT NULL AND NEW.unit_cost_minor IS NULL THEN
    NEW.unit_cost_minor := (NEW.unit_cost_per_1000_minor + 500) / 1000;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.unit_cost_fill() FROM PUBLIC;
CREATE TRIGGER unit_cost_fill BEFORE INSERT ON core.stock_movement FOR EACH ROW EXECUTE FUNCTION core.unit_cost_fill();
CREATE TRIGGER unit_cost_fill BEFORE INSERT ON core.supplier_return_line FOR EACH ROW EXECUTE FUNCTION core.unit_cost_fill();

------------------------------------------------------------------------------------------------------------
-- 9. Backfills over existing tenants (hosted dev DB; an empty database does nothing here)
------------------------------------------------------------------------------------------------------------
-- munim_migrator is NOBYPASSRLS and every tenant table forces RLS, so each tenant is visited under its own
-- app.tenant_id with app.outlet_ids '{*}' (tenants listed through platform.tenant_registry, owned by
-- munim_crosstenant, of which the migrator is a member). The book guard admits no migration, so it is disabled on
-- the five tables written here for the rest of this transaction and re-enabled below (assert_catalog checks it).
--   order_event.seq             numbered per order by (at, id)                       — no value changes
--   unit_cost_per_1000_minor    = unit_cost_minor × 1000 on existing rows            — no value changes
--   D1 business_policy          one tenant-wide row with the column defaults (the W2-R4 loyalty values; margin,
--                               labour, payment-days NULL as provisionTenant writes) valid from the earlier of the
--                               tenant's creation date and its first order's business date, in the tenant's zone
--                               (home_tz, else the first outlet's, else the pack's) — INFERENCE: provisionTenant
--                               uses "today" for a new tenant; a backfill from today would leave every earlier
--                               order without a policy.
--   account 4100                "Loyalty redemptions" (income, a contra-revenue) where the tenant has a chart
--                               (any account) without code 4100.
-- Each inserted row: origin {kind: migration}, created_by NULL (no person made it), one audit_log entry.
ALTER TABLE core.order_event DISABLE TRIGGER book_guard;
ALTER TABLE core.stock_movement DISABLE TRIGGER book_guard;
ALTER TABLE core.supplier_return_line DISABLE TRIGGER book_guard;
ALTER TABLE core.business_policy DISABLE TRIGGER book_guard;
ALTER TABLE core.account DISABLE TRIGGER book_guard;

DO $$
DECLARE
  t      uuid;
  zone   text;
  since  date;
  pid    uuid;
  aid    uuid;
  origin constant jsonb := '{"kind": "migration", "migration": "0016_w2_fix_cycle_1"}';
  actor  constant jsonb := '{"kind": "migration", "id": "0016_w2_fix_cycle_1"}';
BEGIN
  FOR t IN SELECT r.tenant_id FROM platform.tenant_registry r ORDER BY r.tenant_id LOOP
    PERFORM set_config('app.tenant_id', t::text, true), set_config('app.outlet_ids', '{*}', true);

    UPDATE core.order_event e SET seq = n.rn
      FROM (SELECT x.id, row_number() OVER (PARTITION BY x.order_id ORDER BY x.at, x.id) AS rn
              FROM core.order_event x WHERE x.tenant_id = t) n
     WHERE e.tenant_id = t AND e.id = n.id;
    UPDATE core.stock_movement SET unit_cost_per_1000_minor = unit_cost_minor * 1000
     WHERE tenant_id = t AND unit_cost_minor IS NOT NULL;
    UPDATE core.supplier_return_line SET unit_cost_per_1000_minor = unit_cost_minor * 1000 WHERE tenant_id = t;

    IF NOT EXISTS (SELECT 1 FROM core.business_policy b WHERE b.tenant_id = t AND b.outlet_id IS NULL) THEN
      SELECT coalesce(tn.home_tz,
                      (SELECT o.tz FROM core.outlet o WHERE o.tenant_id = t ORDER BY o.created_at, o.id LIMIT 1),
                      (SELECT p.doc ->> 'default_timezone' FROM platform.country_pack p
                        WHERE p.code = tn.country_code AND p.status = 'active' ORDER BY p.version DESC LIMIT 1),
                      'UTC')
        INTO zone FROM core.tenant tn WHERE tn.tenant_id = t;
      SELECT least((tn.created_at AT TIME ZONE zone)::date, (SELECT min(o.business_date) FROM core."order" o WHERE o.tenant_id = t))
        INTO since FROM core.tenant tn WHERE tn.tenant_id = t;
      pid := gen_random_uuid();
      INSERT INTO core.business_policy (tenant_id, id, valid_from, origin) VALUES (t, pid, since, origin);
      INSERT INTO core.audit_log (tenant_id, actor, action, entity, entity_id, after)
      SELECT t, actor, 'db.migration.backfill', 'core.business_policy', pid::text,
             jsonb_build_object('valid_from', b.valid_from, 'loyalty_earn_per_minor', b.loyalty_earn_per_minor,
                                'loyalty_point_value_minor', b.loyalty_point_value_minor, 'reason', 'W2 fix D1: default policy')
        FROM core.business_policy b WHERE b.tenant_id = t AND b.id = pid;
    END IF;

    IF EXISTS (SELECT 1 FROM core.account a WHERE a.tenant_id = t)
       AND NOT EXISTS (SELECT 1 FROM core.account a WHERE a.tenant_id = t AND a.code = '4100') THEN
      aid := gen_random_uuid();
      INSERT INTO core.account (tenant_id, id, code, name, type, origin) VALUES (t, aid, '4100', 'Loyalty redemptions', 'income', origin);
      INSERT INTO core.audit_log (tenant_id, actor, action, entity, entity_id, after)
      VALUES (t, actor, 'db.migration.backfill', 'core.account', aid::text,
              '{"code": "4100", "name": "Loyalty redemptions", "type": "income", "reason": "W2 fix R2-S1-4: loyalty redemption posting"}');
    END IF;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true), set_config('app.outlet_ids', '', true);
END $$;

ALTER TABLE core.order_event ENABLE TRIGGER book_guard;
ALTER TABLE core.stock_movement ENABLE TRIGGER book_guard;
ALTER TABLE core.supplier_return_line ENABLE TRIGGER book_guard;
ALTER TABLE core.business_policy ENABLE TRIGGER book_guard;
ALTER TABLE core.account ENABLE TRIGGER book_guard;

-- Constraints that need the backfilled values (a row any tenant left unnumbered fails here, not silently).
ALTER TABLE core.order_event ALTER COLUMN seq SET NOT NULL;
CREATE UNIQUE INDEX order_event_order_seq_unique ON core.order_event (tenant_id, order_id, seq);
ALTER TABLE core.stock_movement
  ADD CONSTRAINT stock_movement_unit_cost_pair CHECK ((unit_cost_per_1000_minor IS NULL) = (unit_cost_minor IS NULL)
                                                      AND (unit_cost_minor IS NULL OR unit_cost_minor = (unit_cost_per_1000_minor + 500) / 1000));
ALTER TABLE core.supplier_return_line ALTER COLUMN unit_cost_per_1000_minor SET NOT NULL;
ALTER TABLE core.supplier_return_line
  ADD CONSTRAINT supplier_return_line_unit_cost_pair CHECK (unit_cost_minor = (unit_cost_per_1000_minor + 500) / 1000);

------------------------------------------------------------------------------------------------------------
-- 10. Catalog post-conditions: assert_catalog re-issued (six definer functions), then this file's own
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

  -- SECURITY DEFINER functions = exactly the six munim_crosstenant functions; it also owns exactly the view
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
                            'core.customer_erase_merged_guests(uuid)'::regprocedure));
  IF n <> 0 THEN RAISE EXCEPTION '%: unexpected SECURITY DEFINER / munim_crosstenant functions: %', migration, n; END IF;
  SELECT count(*) INTO n FROM pg_proc p WHERE p.prosecdef AND p.proowner = 'munim_crosstenant'::regrole;
  IF n <> 6 THEN RAISE EXCEPTION '%: expected 6 munim_crosstenant definer functions, found %', migration, n; END IF;
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

DO $$
DECLARE
  bad text;
BEGIN
  -- R3-M1: seq NOT NULL, its trigger, and the unique index as written (gotcha 1).
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'core.order_event'::regclass AND attname = 'seq' AND attnotnull
                    AND atttypid = 'bigint'::regtype)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'core.order_event'::regclass AND tgname = 'order_event_seq'
                       AND tgfoid = 'core.order_event_seq()'::regprocedure AND tgenabled = 'O') THEN
    RAISE EXCEPTION '0016: order_event.seq not as written';
  END IF;
  SELECT string_agg(v.ix, ', ') INTO bad
    FROM (VALUES ('core.order_event_order_seq_unique', 'tenant_id,order_id,seq', true),
                 ('core.loyalty_entry_one_per_refund', 'tenant_id,refund_id', true),
                 ('core.loyalty_entry_refund_fk_idx', 'tenant_id,order_id,refund_id', false),
                 ('core.refund_order_unique', 'tenant_id,order_id,id', true)) v(ix, cols, uniq)
   WHERE to_regclass(v.ix) IS NULL
      OR (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
            FROM pg_index i
           CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
           WHERE i.indexrelid = to_regclass(v.ix)) IS DISTINCT FROM v.cols
      OR (SELECT i.indisunique FROM pg_index i WHERE i.indexrelid = to_regclass(v.ix)) IS DISTINCT FROM v.uniq
      OR (SELECT i.indpred IS NOT NULL FROM pg_index i WHERE i.indexrelid = to_regclass(v.ix));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0016: indexes not as written: %', bad; END IF;

  -- Rules read back as written: the refund path by refund, the cancel path by order only, both reconcile rules need a
  -- committed run, the new rules exist on every target.
  IF (SELECT source_state FROM core.derivation_rule
       WHERE rule_id = 'customers.loyalty_reverse' AND source_table = 'core.order') IS DISTINCT FROM $s$s.status IN ('cancelled', 'rejected')$s$
     OR (SELECT count(*) FROM core.derivation_rule WHERE rule_id = 'customers.loyalty_reverse') <> 2
     OR (SELECT count(*) FROM core.derivation_rule WHERE rule_id IN ('finance.reconcile_settlement', 'finance.reconcile_bank')
           AND source_state LIKE 's.import_run_id IS NOT NULL AND EXISTS %') <> 2
     OR (SELECT array_agg(target_table ORDER BY target_table) FROM core.derivation_rule WHERE rule_id = 'finance.post_loyalty_redemption')
          IS DISTINCT FROM ARRAY['core.journal_entry', 'core.posting']
     OR (SELECT count(DISTINCT source_state) FROM core.derivation_rule WHERE rule_id = 'customers.merge_verified_email') <> 1
     OR (SELECT count(*) FROM core.derivation_rule WHERE rule_id = 'customers.merge_verified_email') <> 5
     OR NOT EXISTS (SELECT 1 FROM core.derivation_rule WHERE rule_id = 'customers.erase_merged_guests'
                       AND source_state LIKE '%current_user = ''munim_crosstenant''') THEN
    RAISE EXCEPTION '0016: derivation rules not as written';
  END IF;

  -- Triggers present, enabled, and sorted after book_guard (assert_catalog checks the order).
  SELECT string_agg(v.tbl || '.' || v.tg, ', ') INTO bad
    FROM (VALUES ('core.loyalty_entry', 'reverse_binding'), ('core."order"', 'guest_hash_clear'),
                 ('core.stock_movement', 'unit_cost_fill'), ('core.supplier_return_line', 'unit_cost_fill'),
                 ('core."order"', 'book_guard'), ('core.order_event', 'book_guard'), ('core.stock_movement', 'book_guard'),
                 ('core.supplier_return_line', 'book_guard'), ('core.business_policy', 'book_guard'),
                 ('core.account', 'book_guard')) v(tbl, tg)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = v.tbl::regclass AND t.tgname = v.tg AND t.tgenabled = 'O');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0016: triggers missing or disabled: %', bad; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'core.order_line_pricing_frozen()'::regprocedure AND prosrc LIKE '%dr.source_state%')
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'core.order_pricing_frozen()'::regprocedure AND prosrc LIKE '%dr.source_state%') THEN
    RAISE EXCEPTION '0016: pricing freezes not re-issued as written';
  END IF;

  -- D2.
  IF NOT (SELECT 'core.payable' = ANY (target_tables) FROM core.command_authority WHERE command_type = 'purchasing.invoice.dispute.v1') THEN
    RAISE EXCEPTION '0016: purchasing.invoice.dispute.v1 not bound to core.payable';
  END IF;

  -- Definer functions: owner, definer, EXECUTE munim_core only; the merge function still a definer after the replace.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad
    FROM pg_proc p
   WHERE p.oid IN ('core.customer_claim_verified_email_guests()'::regprocedure, 'core.customer_erase_merged_guests(uuid)'::regprocedure)
     AND NOT (p.prosecdef AND p.proowner = 'munim_crosstenant'::regrole
              AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
              AND has_function_privilege('munim_core', p.oid, 'EXECUTE')
              AND NOT has_function_privilege('munim_svc', p.oid, 'EXECUTE')
              AND NOT has_function_privilege('munim_platform', p.oid, 'EXECUTE')
              AND NOT has_function_privilege('munim_intel_ro', p.oid, 'EXECUTE'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0016: definer functions not owned/granted as written: %', bad; END IF;

  -- New column privileges, positive and negative.
  IF NOT has_column_privilege('munim_crosstenant', 'core.coupon_use', 'customer_id', 'UPDATE')
     OR has_column_privilege('munim_crosstenant', 'core.coupon_use', 'discount_minor', 'UPDATE')
     OR has_column_privilege('munim_core', 'core.coupon_use', 'customer_id', 'UPDATE')
     OR NOT has_column_privilege('munim_crosstenant', 'core.customer', 'erased_at', 'UPDATE')
     OR has_column_privilege('munim_crosstenant', 'core.customer', 'name', 'UPDATE')
     OR has_column_privilege('munim_core', 'core.order_event', 'seq', 'UPDATE')
     OR has_column_privilege('munim_core', 'core."order"', 'guest_access_hash', 'UPDATE')
     OR has_column_privilege('munim_core', 'core.loyalty_entry', 'refund_id', 'UPDATE')
     OR NOT has_column_privilege('munim_core', 'core.loyalty_entry', 'refund_id', 'INSERT')
     OR has_column_privilege('munim_svc', 'core.loyalty_entry', 'refund_id', 'INSERT')
     OR NOT has_column_privilege('munim_core', 'core.stock_movement', 'unit_cost_per_1000_minor', 'INSERT')
     OR has_column_privilege('munim_core', 'core.stock_movement', 'unit_cost_per_1000_minor', 'UPDATE')
     OR has_column_privilege('munim_svc', 'core.supplier_return_line', 'unit_cost_per_1000_minor', 'INSERT')
     OR NOT has_column_privilege('munim_svc', 'core.order_event', 'seq', 'SELECT') THEN
    RAISE EXCEPTION '0016: new column privileges not as written';
  END IF;

  PERFORM munim_meta.assert_catalog('0016');
END $$;
