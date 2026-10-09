-- 0014_w1_fix_cycle_1 — W1 fix cycle 1 (docs/plan/W1-FIX-LIST.md), fix forward over 0001–0013. Runs as
-- munim_migrator. Items:
--   #28 F1  guard outlet scope for every book table (core.book_scope says how a row reaches its outlets:
--           own column, own id, outlet set, both ends, or a parent row), applied in the decision branch too;
--           a tenant-wide row (no outlet / empty set) needs the all-outlet scope '{*}'.
--   #29 F2  customer writes: the row must be the customer's own (core.book_scope customer path; a guest
--           proves an order by its access-token hash), only tables in command_authority.customer_target_tables,
--           never under the '{*}' outlet wildcard.
--   #30 F3  core."order" money columns change only under the pricing rule orders.reprice; an UPDATE never
--           re-stamps `origin` except under a derivation rule (origin = how the row was made; audit_log has
--           every change).
--   #31 F4  customer RLS: a RESTRICTIVE policy `customer_scope` on every tenant table — own rows, the public
--           catalogue (read only), coupons by presented code, the two placement counters, deny elsewhere.
--   #21     derivation_rule.source_state: the source row must be in that state (e.g. invoice approved).
--   #22     reconciliation_break and viability_case become books (guarded); market_signal only inside an
--           approved import; import_run figures frozen once previewed; staging rows only while parsing.
--   #23     book status transitions (core.book_status_transition + trigger) for the 19 + reconciliation_break
--           + hiring_candidate.stage.
--   #24     posting rules for refunds, expenses, payroll.
--   #37     intel runs/traces visible only when the caller's outlet scope covers the run's; '{*}' runs to
--           owner/advisor/judge (and service contexts) only.
--   #48 #49 #54  account.link writes core."order"; expired-sale override issued before placement against a
--           cart line, consumed at placement; missing command types.
--   #59 #60 #62 #17  tender.rounding_minor; outlet.business_day_cutoff (business date and ticket numbers roll
--           at the cutoff); tenant.home_tz; draft.failure_reason.
--   Riders:  guests (app.role = 'guest', app.guest_access_hash = hex sha256 of the order's token): a RESTRICTIVE
--           `guest_scope` policy on every tenant table shows that one order and its lines, events, tenders and
--           kitchen tickets, read-only, and nothing else. Shoppers (customer, guest) do not depend on outlet
--           scope: the outlet-scoped permissive policies admit them and the restrictive policies govern; the guard
--           checks ownership, not outlets, for customers. core.outbox.publish_attempts / dead_at; outbox_claim
--           skips dead rows. IN aggregator (Sec 9(5)) orders take no invoice number.
-- New SQLSTATEs: none (refusals use MB001, MB004, MB006, MB008).

------------------------------------------------------------------------------------------------------------
-- 1. Command authority: customer-safe tables, new commands, binding additions
------------------------------------------------------------------------------------------------------------
ALTER TABLE core.command_authority ADD COLUMN customer_target_tables text[] NOT NULL DEFAULT '{}';

UPDATE core.command_authority SET target_tables = target_tables || ARRAY['core.order']
 WHERE command_type = 'customers.account.link.v1';
UPDATE core.command_authority SET target_tables = target_tables || ARRAY['core.expired_sale_override']
 WHERE command_type = 'orders.place.v1';
UPDATE core.command_authority SET target_tables = target_tables || ARRAY['core.reconciliation_break']
 WHERE command_type = 'finance.dispute.draft.v1';

-- A customer writes only these, and only its own rows (guard). Tenders are recorded by staff, never by the
-- customer (R4: pay at the counter).
UPDATE core.command_authority SET customer_target_tables = CASE command_type
    WHEN 'orders.place.v1' THEN ARRAY['core.order', 'core.order_line', 'core.order_event', 'core.coupon_use', 'core.loyalty_entry']
    WHEN 'storefront.guest.create.v1' THEN ARRAY['core.customer']
    WHEN 'customers.account.link.v1' THEN ARRAY['core.customer', 'core.order']
    WHEN 'customers.profile.update.v1' THEN ARRAY['core.customer']
    WHEN 'customers.consent.set.v1' THEN ARRAY['core.customer']
    WHEN 'customers.erasure.request.v1' THEN ARRAY['core.customer']
    ELSE '{}'::text[] END;

ALTER TABLE core.command_authority
  ADD CONSTRAINT command_authority_customer_tables_subset CHECK (customer_target_tables <@ target_tables),
  ADD CONSTRAINT command_authority_customer_tables_role CHECK (customer_target_tables = '{}' OR 'customer' = ANY (allowed_roles));

-- #54 and the commands this cycle needs (INFERENCE: names from W1-FIX-LIST / D-2; roles as for their peers).
-- kitchen.ticket.accept.v1 is not seeded: order-level accept stays kitchen.ticket.advance.v1 (#41).
INSERT INTO core.command_authority (command_type, allowed_roles, scope, target_tables) VALUES
  ('orders.promise.push_back.v1',     ARRAY['owner', 'manager', 'staff', 'judge'], 'outlet', ARRAY['core.order', 'core.order_event']),
  ('catalogue.availability.set.v1',   ARRAY['owner', 'manager', 'staff', 'judge'], 'outlet', ARRAY[]::text[]),
  ('catalogue.deal.end.v1',           ARRAY['owner', 'manager', 'judge'],          'tenant', ARRAY['core.deal']),
  ('kitchen.prep_time.set.v1',        ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY[]::text[]),
  ('demo.session.start.v1',           ARRAY['operator'],                           'tenant',
                                      ARRAY['core.tenant', 'core.member', 'core.membership', 'core.outlet', 'core.outlet_calendar',
                                            'core.brand', 'core.channel', 'core.business_policy', 'core.account']),
  ('tenancy.tenant.update.v1',        ARRAY['owner', 'judge'],                     'tenant', ARRAY['core.tenant']),
  ('finance.break.update.v1',         ARRAY['owner', 'judge'],                     'tenant', ARRAY['core.reconciliation_break']),
  ('market.viability_case.upsert.v1', ARRAY['owner', 'manager', 'judge'],          'tenant', ARRAY['core.viability_case']);

------------------------------------------------------------------------------------------------------------
-- 2. core.book_scope — how a book row reaches its outlets (F1) and its owning customer (F2)
------------------------------------------------------------------------------------------------------------
-- outlet_kind: column  = outlet_ref column (NULL → tenant-wide row)
--              self    = the row's own id (core.outlet)
--              array   = outlet_ref uuid[] ('{}' → tenant-wide row)
--              pair    = both columns in outlet_ref ('a,b'), both must be in scope (transfer)
--              parent  = the row named by outlet_ref in parent_table, resolved by that table's own rule
--              none    = no outlet: a tenant-level record (the command's scope alone decides)
-- customer_kind: self (id), column (customer_ref), order (parent order via customer_ref), none (customers never write)
CREATE TABLE core.book_scope (
  table_name    text PRIMARY KEY CHECK (table_name ~ '^core\.[a-z_]+$'),
  outlet_kind   text NOT NULL CHECK (outlet_kind IN ('column', 'self', 'array', 'pair', 'parent', 'none')),
  outlet_ref    text CHECK (outlet_ref ~ '^[a-z_]+(,[a-z_]+)?$'),
  parent_table  text CHECK (parent_table ~ '^core\.[a-z_]+$'),
  customer_kind text NOT NULL DEFAULT 'none' CHECK (customer_kind IN ('self', 'column', 'order', 'none')),
  customer_ref  text CHECK (customer_ref ~ '^[a-z_]+$'),
  CHECK ((outlet_kind IN ('column', 'array', 'pair', 'parent')) = (outlet_ref IS NOT NULL)),
  CHECK ((outlet_kind = 'parent') = (parent_table IS NOT NULL)),
  CHECK ((customer_kind IN ('column', 'order')) = (customer_ref IS NOT NULL))
);

INSERT INTO core.book_scope (table_name, outlet_kind, outlet_ref, parent_table, customer_kind, customer_ref)
SELECT 'core.' || t, 'column', 'outlet_id', NULL, 'none', NULL
  FROM unnest(ARRAY['asset', 'attendance', 'bank_line', 'batch', 'budget', 'business_policy', 'checklist', 'checklist_run',
                    'expense', 'expired_sale_override', 'goal', 'goods_received', 'hiring_candidate', 'journal_entry', 'licence',
                    'outlet_calendar', 'payroll_draft', 'period_close', 'prep_list', 'price', 'reconciliation_break',
                    'reorder_level', 'review', 'roster', 'roster_shift', 'settlement', 'shift', 'staff', 'stock_count',
                    'stock_movement', 'supplier_return', 'task', 'tax_return_draft', 'temp_log', 'tip_pool', 'waste_log']) t;
INSERT INTO core.book_scope (table_name, outlet_kind, outlet_ref, customer_kind, customer_ref) VALUES
  ('core.order',       'column', 'outlet_id', 'column', 'customer_id'),
  ('core.reservation', 'column', 'outlet_id', 'column', 'customer_id'),
  ('core.bulk_order',  'column', 'outlet_id', 'column', 'customer_id'),
  ('core.order_line',  'column', 'outlet_id', 'order',  'order_id'),
  ('core.order_event', 'column', 'outlet_id', 'order',  'order_id'),
  ('core.tender',      'column', 'outlet_id', 'order',  'order_id'),
  ('core.refund',      'column', 'outlet_id', 'order',  'order_id'),
  ('core.void',        'column', 'outlet_id', 'order',  'order_id'),
  ('core.sale_return', 'column', 'outlet_id', 'order',  'order_id');
INSERT INTO core.book_scope (table_name, outlet_kind, outlet_ref) VALUES
  ('core.brand', 'array', 'outlet_ids'), ('core.campaign', 'array', 'outlet_ids'), ('core.coupon', 'array', 'outlet_ids'),
  ('core.deal', 'array', 'outlet_ids'), ('core.membership', 'array', 'outlet_ids'), ('core.purchase_order', 'array', 'outlet_ids'),
  ('core.transfer', 'pair', 'from_outlet_id,to_outlet_id');
INSERT INTO core.book_scope (table_name, outlet_kind) VALUES ('core.outlet', 'self');
INSERT INTO core.book_scope (table_name, outlet_kind, outlet_ref, parent_table, customer_kind, customer_ref) VALUES
  ('core.advance',              'parent', 'staff_id',           'core.staff',          'none',  NULL),
  ('core.amc',                  'parent', 'asset_id',           'core.asset',          'none',  NULL),
  ('core.coupon_use',           'parent', 'order_id',           'core.order',          'order', 'order_id'),
  ('core.grn_line',             'parent', 'goods_received_id',  'core.goods_received', 'none',  NULL),
  ('core.maintenance',          'parent', 'asset_id',           'core.asset',          'none',  NULL),
  ('core.payroll_draft_line',   'parent', 'payroll_draft_id',   'core.payroll_draft',  'none',  NULL),
  ('core.po_line',              'parent', 'po_id',              'core.purchase_order', 'none',  NULL),
  ('core.posting',              'parent', 'journal_entry_id',   'core.journal_entry',  'none',  NULL),
  ('core.prep_list_line',       'parent', 'prep_list_id',       'core.prep_list',      'none',  NULL),
  ('core.settlement_line',      'parent', 'settlement_id',      'core.settlement',     'none',  NULL),
  ('core.stock_count_line',     'parent', 'stock_count_id',     'core.stock_count',    'none',  NULL),
  ('core.supplier_return_line', 'parent', 'supplier_return_id', 'core.supplier_return','none',  NULL),
  ('core.tip_pool_share',       'parent', 'tip_pool_id',        'core.tip_pool',       'none',  NULL),
  ('core.training_record',      'parent', 'staff_id',           'core.staff',          'none',  NULL),
  ('core.transfer_line',        'parent', 'transfer_id',        'core.transfer',       'none',  NULL);
INSERT INTO core.book_scope (table_name, outlet_kind, customer_kind, customer_ref)
SELECT 'core.' || t, 'none', 'none', NULL
  FROM unnest(ARRAY['account', 'channel', 'channel_terms', 'dispute', 'dispute_line', 'ingredient', 'item', 'member',
                    'option', 'option_group', 'option_ingredient_delta', 'payable', 'receivable', 'recipe_line',
                    'recipe_version', 'supplier', 'supplier_invoice', 'supplier_invoice_line', 'supplier_price', 'tenant',
                    'variant', 'viability_case']) t;
INSERT INTO core.book_scope (table_name, outlet_kind, customer_kind, customer_ref) VALUES
  ('core.customer', 'none', 'self', NULL),
  ('core.loyalty_entry', 'none', 'column', 'customer_id');

COMMENT ON TABLE core.book_scope IS 'munim:operational';
REVOKE ALL ON core.book_scope FROM PUBLIC;
GRANT SELECT ON core.book_scope TO munim_core, munim_svc;

------------------------------------------------------------------------------------------------------------
-- 3. Derivation rules: source state (#21), posting rules (#24), pricing (F3), reconciliation (#22)
------------------------------------------------------------------------------------------------------------
-- A SQL predicate over the source row `s`, written only by migrations (munim_core and munim_svc have SELECT
-- only); the guard admits a derived row only when the source row exists AND satisfies it.
ALTER TABLE core.derivation_rule
  ADD COLUMN source_state text NOT NULL DEFAULT 'true' CHECK (source_state <> '' AND position(';' IN source_state) = 0);

INSERT INTO core.derivation_rule (rule_id, source_table, target_table) VALUES
  ('finance.post_refund',          'core.refund',        'core.journal_entry'),
  ('finance.post_refund',          'core.refund',        'core.posting'),
  ('finance.post_expense',         'core.expense',       'core.journal_entry'),
  ('finance.post_expense',         'core.expense',       'core.posting'),
  ('finance.post_payroll',         'core.payroll_draft', 'core.journal_entry'),
  ('finance.post_payroll',         'core.payroll_draft', 'core.posting'),
  ('orders.reprice',               'core.order',         'core.order'),
  ('finance.reconcile_settlement', 'core.settlement',    'core.reconciliation_break'),
  ('finance.reconcile_bank',       'core.bank_line',     'core.reconciliation_break'),
  ('finance.reconcile_order',      'core.order',         'core.reconciliation_break');

UPDATE core.derivation_rule SET source_state = p.state
  FROM (VALUES
    ('inventory.consume_order',         $s$s.status IN ('placed', 'accepted', 'preparing', 'ready', 'completed')$s$),
    ('inventory.consume_sku',           $s$s.status IN ('placed', 'accepted', 'preparing', 'ready', 'completed')$s$),
    ('finance.post_order',              $s$s.status = 'completed'$s$),
    ('finance.post_supplier_invoice',   $s$s.status = 'approved'$s$),
    ('purchasing.payable_from_invoice', $s$s.status = 'approved'$s$),
    ('finance.post_settlement',         $s$(s.import_run_id IS NULL OR EXISTS (SELECT 1 FROM core.import_run r WHERE r.tenant_id = s.tenant_id AND r.id = s.import_run_id AND r.status = 'committed'))$s$),
    ('finance.reconcile_settlement',    $s$(s.import_run_id IS NULL OR EXISTS (SELECT 1 FROM core.import_run r WHERE r.tenant_id = s.tenant_id AND r.id = s.import_run_id AND r.status = 'committed'))$s$),
    ('finance.reconcile_bank',          $s$(s.import_run_id IS NULL OR EXISTS (SELECT 1 FROM core.import_run r WHERE r.tenant_id = s.tenant_id AND r.id = s.import_run_id AND r.status = 'committed'))$s$),
    ('finance.reconcile_order',         $s$s.status = 'completed'$s$),
    ('finance.post_payroll',            $s$s.status IN ('approved', 'paid_externally')$s$),
    ('inventory.transfer_out',          $s$s.status IN ('sent', 'received')$s$),
    ('inventory.transfer_in',           $s$s.status = 'received'$s$),
    ('inventory.sale_return',           $s$s.restock$s$),
    ('customers.loyalty_earn',          $s$s.status = 'completed'$s$),
    ('customers.loyalty_reverse',       $s$s.status IN ('cancelled', 'rejected')$s$),
    ('orders.reprice',                  $s$s.status IN ('placed', 'accepted')$s$)
  ) AS p (rule_id, state)
 WHERE core.derivation_rule.rule_id = p.rule_id;

------------------------------------------------------------------------------------------------------------
-- 4. #22 — operational money tables: two become books, the rest are tied to their import path
------------------------------------------------------------------------------------------------------------
ALTER TABLE core.reconciliation_break ADD COLUMN origin jsonb NOT NULL DEFAULT '{}';
ALTER TABLE core.reconciliation_break ALTER COLUMN origin DROP DEFAULT;
ALTER TABLE core.viability_case ADD COLUMN origin jsonb NOT NULL DEFAULT '{}';
ALTER TABLE core.viability_case ALTER COLUMN origin DROP DEFAULT;
COMMENT ON TABLE core.reconciliation_break IS 'munim:book';
COMMENT ON TABLE core.viability_case IS 'munim:book';
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.reconciliation_break FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.viability_case FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();

-- market_signal (operational by ruling) exists only inside an approved import run (MB006).
CREATE FUNCTION core.market_signal_from_import() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.decision d
                   JOIN core.draft r ON r.tenant_id = d.tenant_id AND r.id = d.draft_id
                  WHERE d.tenant_id = NEW.tenant_id
                    AND d.id::text = nullif(current_setting('app.decision_id', true), '')
                    AND d.verdict IN ('approved', 'edited') AND r.command_type = 'imports.run.commit.v1'
                    AND r.status = 'executing' AND r.exec_txid = txid_current()) THEN
    RAISE EXCEPTION 'decision_refused: market signals enter only through an approved import (imports.run.commit.v1)'
      USING ERRCODE = 'MB006';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.market_signal_from_import() FROM PUBLIC;
CREATE TRIGGER from_import BEFORE INSERT OR UPDATE ON core.market_signal FOR EACH ROW EXECUTE FUNCTION core.market_signal_from_import();

-- import_run: created as parsing; parsing → previewed | failed (parser), previewed → committed | rejected
-- (a person, under the run's approved imports.run.commit.v1 draft for committed). Counters, control total,
-- currency and draft are fixed once the run leaves parsing (the preview a person saw is what is approved).
CREATE FUNCTION core.import_run_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'parsing' THEN
      RAISE EXCEPTION 'illegal_transition: an import run is created as parsing' USING ERRCODE = 'MB004';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'parsing' AND NEW.status IN ('previewed', 'failed'))
           OR (OLD.status = 'previewed' AND NEW.status IN ('committed', 'rejected'))) THEN
    RAISE EXCEPTION 'illegal_transition: import run % → %', OLD.status, NEW.status USING ERRCODE = 'MB004';
  END IF;
  IF OLD.status <> 'parsing'
     AND (NEW.rows_ok, NEW.rows_quarantined, NEW.control_total_minor, NEW.currency, NEW.draft_id)
         IS DISTINCT FROM (OLD.rows_ok, OLD.rows_quarantined, OLD.control_total_minor, OLD.currency, OLD.draft_id) THEN
    RAISE EXCEPTION 'illegal_transition: import run figures are fixed once previewed' USING ERRCODE = 'MB004';
  END IF;
  IF NEW.status = 'committed' AND OLD.status <> 'committed'
     AND NOT EXISTS (SELECT 1 FROM core.decision d JOIN core.draft r ON r.tenant_id = d.tenant_id AND r.id = d.draft_id
                      WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.decision_id AND d.verdict IN ('approved', 'edited')
                        AND r.command_type = 'imports.run.commit.v1' AND r.status = 'executing' AND r.exec_txid = txid_current()) THEN
    RAISE EXCEPTION 'decision_refused: an import run is committed only by approving its draft' USING ERRCODE = 'MB006';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.import_run_rules() FROM PUBLIC;
CREATE TRIGGER run_rules BEFORE INSERT OR UPDATE ON core.import_run FOR EACH ROW EXECUTE FUNCTION core.import_run_rules();

-- Staged and quarantined rows are written only while their run is parsing.
CREATE FUNCTION core.import_rows_while_parsing() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.import_run r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.import_run_id AND r.status = 'parsing') THEN
    RAISE EXCEPTION 'illegal_transition: rows are added to an import run only while it is parsing' USING ERRCODE = 'MB004';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.import_rows_while_parsing() FROM PUBLIC;
CREATE TRIGGER while_parsing BEFORE INSERT ON core.import_staging FOR EACH ROW EXECUTE FUNCTION core.import_rows_while_parsing();
CREATE TRIGGER while_parsing BEFORE INSERT ON core.import_quarantine FOR EACH ROW EXECUTE FUNCTION core.import_rows_while_parsing();

------------------------------------------------------------------------------------------------------------
-- 5. #23 — book status transitions
------------------------------------------------------------------------------------------------------------
-- The legal (from → to) per book table; the trigger argument names the column (status, or stage).
-- core."order", purchase_order and transfer keep their own transition triggers (0004, 0005). INFERENCE.
CREATE TABLE core.book_status_transition (
  table_name  text NOT NULL CHECK (table_name ~ '^core\.[a-z_]+$'),
  from_status text NOT NULL,
  to_status   text NOT NULL,
  PRIMARY KEY (table_name, from_status, to_status),
  CHECK (from_status <> to_status)
);
INSERT INTO core.book_status_transition (table_name, from_status, to_status) VALUES
  ('core.bulk_order', 'enquiry', 'quoted'), ('core.bulk_order', 'enquiry', 'cancelled'), ('core.bulk_order', 'quoted', 'confirmed'),
  ('core.bulk_order', 'quoted', 'cancelled'), ('core.bulk_order', 'confirmed', 'delivered'), ('core.bulk_order', 'confirmed', 'cancelled'),
  ('core.campaign', 'queued', 'sent'), ('core.campaign', 'queued', 'cancelled'),
  ('core.dispute', 'recorded', 'sent'), ('core.dispute', 'recorded', 'resolved'), ('core.dispute', 'recorded', 'rejected'),
  ('core.dispute', 'recorded', 'withdrawn'), ('core.dispute', 'sent', 'resolved'), ('core.dispute', 'sent', 'rejected'),
  ('core.dispute', 'sent', 'withdrawn'),
  ('core.goal', 'active', 'achieved'), ('core.goal', 'active', 'missed'), ('core.goal', 'active', 'cancelled'),
  ('core.licence', 'active', 'superseded'), ('core.licence', 'active', 'lapsed'),
  ('core.maintenance', 'scheduled', 'done'), ('core.maintenance', 'scheduled', 'cancelled'),
  ('core.payable', 'open', 'paid'), ('core.payable', 'open', 'disputed'), ('core.payable', 'open', 'void'),
  ('core.payable', 'disputed', 'open'), ('core.payable', 'disputed', 'paid'), ('core.payable', 'disputed', 'void'),
  ('core.payroll_draft', 'approved', 'paid_externally'), ('core.payroll_draft', 'approved', 'void'),
  ('core.prep_list', 'open', 'done'), ('core.prep_list', 'open', 'cancelled'),
  ('core.receivable', 'open', 'received'), ('core.receivable', 'open', 'written_off'), ('core.receivable', 'open', 'void'),
  ('core.reservation', 'booked', 'seated'), ('core.reservation', 'booked', 'cancelled'), ('core.reservation', 'booked', 'no_show'),
  ('core.reservation', 'seated', 'completed'),
  ('core.roster', 'active', 'cancelled'),
  ('core.roster_shift', 'scheduled', 'cancelled'),
  ('core.shift', 'open', 'closed'),
  ('core.stock_count', 'open', 'submitted'), ('core.stock_count', 'open', 'cancelled'),
  ('core.supplier_invoice', 'recorded', 'approved'), ('core.supplier_invoice', 'recorded', 'disputed'),
  ('core.supplier_invoice', 'recorded', 'void'), ('core.supplier_invoice', 'approved', 'disputed'),
  ('core.supplier_invoice', 'disputed', 'recorded'), ('core.supplier_invoice', 'disputed', 'approved'),
  ('core.supplier_invoice', 'disputed', 'void'),
  ('core.task', 'open', 'done'), ('core.task', 'open', 'cancelled'),
  ('core.tax_return_draft', 'prepared', 'filed_externally'), ('core.tax_return_draft', 'prepared', 'void'),
  ('core.tenant', 'active', 'retired'),
  ('core.reconciliation_break', 'open', 'disputed'), ('core.reconciliation_break', 'open', 'resolved'),
  ('core.reconciliation_break', 'open', 'written_off'), ('core.reconciliation_break', 'disputed', 'open'),
  ('core.reconciliation_break', 'disputed', 'resolved'), ('core.reconciliation_break', 'disputed', 'written_off'),
  ('core.hiring_candidate', 'applied', 'interviewed'), ('core.hiring_candidate', 'applied', 'rejected'),
  ('core.hiring_candidate', 'applied', 'withdrawn'), ('core.hiring_candidate', 'interviewed', 'offered'),
  ('core.hiring_candidate', 'interviewed', 'rejected'), ('core.hiring_candidate', 'interviewed', 'withdrawn'),
  ('core.hiring_candidate', 'offered', 'hired'), ('core.hiring_candidate', 'offered', 'rejected'),
  ('core.hiring_candidate', 'offered', 'withdrawn');
COMMENT ON TABLE core.book_status_transition IS 'munim:operational';
REVOKE ALL ON core.book_status_transition FROM PUBLIC;
GRANT SELECT ON core.book_status_transition TO munim_core, munim_svc;

CREATE FUNCTION core.book_status_transition_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  col  text := coalesce(TG_ARGV[0], 'status');
  prev text := to_jsonb(OLD) ->> col;
  next text := to_jsonb(NEW) ->> col;
BEGIN
  IF next IS DISTINCT FROM prev
     AND NOT EXISTS (SELECT 1 FROM core.book_status_transition t
                      WHERE t.table_name = TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME AND t.from_status = prev AND t.to_status = next) THEN
    RAISE EXCEPTION 'illegal_transition: %.% % → %', TG_TABLE_NAME, col, prev, next USING ERRCODE = 'MB004';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.book_status_transition_check() FROM PUBLIC;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bulk_order', 'campaign', 'dispute', 'goal', 'licence', 'maintenance', 'payable', 'payroll_draft',
                           'prep_list', 'receivable', 'reservation', 'roster', 'roster_shift', 'shift', 'stock_count',
                           'supplier_invoice', 'task', 'tax_return_draft', 'tenant', 'reconciliation_break'] LOOP
    EXECUTE format('CREATE TRIGGER status_transition BEFORE UPDATE ON core.%I FOR EACH ROW EXECUTE FUNCTION core.book_status_transition_check()', t);
  END LOOP;
END $$;
CREATE TRIGGER status_transition BEFORE UPDATE ON core.hiring_candidate
  FOR EACH ROW EXECUTE FUNCTION core.book_status_transition_check('stage');

------------------------------------------------------------------------------------------------------------
-- 6. The guard (F1, F2, F3) and its two read helpers
------------------------------------------------------------------------------------------------------------
-- kind: tenant_level (book_scope 'none'), outlets (the set), wide (a tenant-wide row), unresolved (no
-- book_scope row, or a parent row not visible here → never in scope).
CREATE FUNCTION core.book_row_outlets(target text, tenant uuid, r jsonb, OUT kind text, OUT outlets uuid[])
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  bs    core.book_scope;
  tbl   text := target;
  rj    jsonb := r;
  pid   text;
  depth integer := 0;
BEGIN
  LOOP
    SELECT * INTO bs FROM core.book_scope b WHERE b.table_name = tbl;
    IF NOT FOUND OR depth > 3 THEN
      kind := 'unresolved';
      RETURN;
    END IF;
    CASE bs.outlet_kind
      WHEN 'none' THEN
        kind := 'tenant_level';
        RETURN;
      WHEN 'self' THEN
        outlets := ARRAY[(rj ->> 'id')::uuid];
        kind := 'outlets';
        RETURN;
      WHEN 'column' THEN
        IF rj ->> bs.outlet_ref IS NULL THEN
          kind := 'wide';
        ELSE
          outlets := ARRAY[(rj ->> bs.outlet_ref)::uuid];
          kind := 'outlets';
        END IF;
        RETURN;
      WHEN 'array' THEN
        outlets := ARRAY(SELECT x::uuid FROM jsonb_array_elements_text(coalesce(rj -> bs.outlet_ref, '[]')) x);
        kind := CASE WHEN cardinality(outlets) = 0 THEN 'wide' ELSE 'outlets' END;
        RETURN;
      WHEN 'pair' THEN
        outlets := ARRAY[(rj ->> split_part(bs.outlet_ref, ',', 1))::uuid, (rj ->> split_part(bs.outlet_ref, ',', 2))::uuid];
        kind := CASE WHEN array_position(outlets, NULL) IS NULL THEN 'outlets' ELSE 'unresolved' END;
        RETURN;
      ELSE
        pid := rj ->> bs.outlet_ref;
        IF pid IS NULL THEN
          kind := 'wide';
          RETURN;
        END IF;
        EXECUTE format('SELECT to_jsonb(p) FROM %I.%I p WHERE p.tenant_id = $1 AND p.id = $2',
                       split_part(bs.parent_table, '.', 1), split_part(bs.parent_table, '.', 2))
           INTO rj USING tenant, pid::uuid;
        IF rj IS NULL THEN
          kind := 'unresolved';
          RETURN;
        END IF;
        tbl := bs.parent_table;
        depth := depth + 1;
    END CASE;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION core.book_row_outlets(text, uuid, jsonb) FROM PUBLIC;

-- Is this row inside the caller's scope for a command of `scope`? tenant scope (and own/own_order for a
-- member) needs '{*}'; otherwise the row's outlets must all be in app.outlet_ids, a tenant-wide row needs '{*}',
-- a tenant-level record passes, an unresolved row never does.
CREATE FUNCTION core.book_row_in_scope(target text, tenant uuid, r jsonb, scope text, role text, outlet_ids text)
RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  k text;
  o uuid[];
BEGIN
  IF scope = 'tenant' OR (scope IN ('own', 'own_order') AND role IS DISTINCT FROM 'customer') THEN
    RETURN coalesce(outlet_ids = '{*}', false);
  END IF;
  SELECT x.kind, x.outlets INTO k, o FROM core.book_row_outlets(target, tenant, r) x;
  RETURN coalesce(CASE k
    WHEN 'tenant_level' THEN true
    WHEN 'outlets' THEN outlet_ids = '{*}' OR o <@ (nullif(outlet_ids, '{*}'))::uuid[]
    WHEN 'wide' THEN outlet_ids = '{*}'
    ELSE false END, false);
END $$;
REVOKE ALL ON FUNCTION core.book_row_in_scope(text, uuid, jsonb, text, text, text) FROM PUBLIC;

-- F2: is this row the customer's own? `strict` (the NEW row) requires the principal itself; otherwise (the
-- OLD row, a parent order) an order may also be proven by the guest access-token hash in app.guest_access_hash.
CREATE FUNCTION core.book_row_customer_owned(target text, tenant uuid, r jsonb, principal uuid, guest bytea, strict boolean)
RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  bs core.book_scope;
  o  jsonb;
BEGIN
  SELECT * INTO bs FROM core.book_scope b WHERE b.table_name = target;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  CASE bs.customer_kind
    WHEN 'self' THEN
      RETURN coalesce((r ->> 'id')::uuid = principal, false);
    WHEN 'column' THEN
      RETURN coalesce((r ->> bs.customer_ref)::uuid = principal, false)
          OR (NOT strict AND target = 'core.order' AND guest IS NOT NULL
              AND r ->> 'guest_access_hash' = '\x' || encode(guest, 'hex'));
    WHEN 'order' THEN
      SELECT to_jsonb(x) INTO o FROM core."order" x WHERE x.tenant_id = tenant AND x.id = (r ->> bs.customer_ref)::uuid;
      RETURN o IS NOT NULL
         AND (coalesce((o ->> 'customer_id')::uuid = principal, false)
              OR (guest IS NOT NULL AND o ->> 'guest_access_hash' = '\x' || encode(guest, 'hex')));
    ELSE
      RETURN false;
  END CASE;
END $$;
REVOKE ALL ON FUNCTION core.book_row_customer_owned(text, uuid, jsonb, uuid, bytea, boolean) FROM PUBLIC;

-- The guard is SECURITY INVOKER, so its callers need EXECUTE on the read helpers (they read under the
-- caller's own RLS). Only munim_core writes book tables.
GRANT EXECUTE ON FUNCTION core.book_row_outlets(text, uuid, jsonb) TO munim_core;
GRANT EXECUTE ON FUNCTION core.book_row_in_scope(text, uuid, jsonb, text, text, text) TO munim_core;
GRANT EXECUTE ON FUNCTION core.book_row_customer_owned(text, uuid, jsonb, uuid, bytea, boolean) TO munim_core;

-- The guard, re-issued. Branches as 0007 (decision, derivation, own command), plus:
--   decision: the row (NEW and, on UPDATE, OLD) is inside the approver's scope for the draft's command scope;
--   derivation: the source row also satisfies the rule's source_state;
--   own command, member: the row (NEW and OLD) is inside the caller's scope (F1);
--   own command, customer: never under '{*}'; the table is in customer_target_tables; NEW is the customer's
--     own, OLD is the customer's own or a guest order proven by token (F2). No outlet check: shoppers do not
--     depend on outlet scope (ruling); which outlet a storefront order goes to is core-api's (storefront key).
--   origin: stamped on INSERT; on UPDATE kept, except a derivation re-stamps it (F3).
CREATE OR REPLACE FUNCTION core.guard_book_write() RETURNS trigger
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
  s_guest    bytea := decode(nullif(current_setting('app.guest_access_hash', true), ''), 'hex');
  new_j      jsonb := to_jsonb(NEW);
  old_j      jsonb;
  principal  text;
  rule_src   text;
  rule_state text;
  src_id     text;
  src_found  boolean;
  a_scope    text;
  a_tabs     text[];
  a_cust     text[];
  mismatch   text;
  why        text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_j := to_jsonb(OLD);
  END IF;

  -- (2) An approved decision executing in this transaction, within the approver's scope.
  IF s_decision ~ uuid_re AND s_role IS DISTINCT FROM 'customer' THEN
    SELECT ca.scope, ca.target_tables INTO a_scope, a_tabs
      FROM core.decision d
      JOIN core.draft r ON r.tenant_id = d.tenant_id AND r.id = d.draft_id
      JOIN core.command_authority ca ON ca.command_type = r.command_type
     WHERE d.tenant_id = NEW.tenant_id AND d.id = s_decision::uuid
       AND d.verdict IN ('approved', 'edited')
       AND r.status = 'executing' AND r.exec_txid = txid_current();
    IF FOUND THEN
      IF NOT target = ANY (a_tabs) THEN
        mismatch := 'the approved draft''s command type does not list ' || target;
      ELSIF core.book_row_in_scope(target, NEW.tenant_id, new_j, a_scope, s_role, s_outlets)
            AND (old_j IS NULL OR core.book_row_in_scope(target, NEW.tenant_id, old_j, a_scope, s_role, s_outlets)) THEN
        NEW.origin := CASE WHEN TG_OP = 'UPDATE' THEN OLD.origin
                           ELSE jsonb_build_object('kind', 'decision', 'decision_id', s_decision) END;
        RETURN NEW;
      ELSE
        why := 'the row is outside the approver''s outlet scope';
      END IF;
    END IF;
  END IF;

  -- (3) An allow-listed derivation of an existing source row in the rule's source state.
  IF s_rule IS NOT NULL AND s_source IS NOT NULL THEN
    src_id := split_part(s_source, ':', 2);
    -- The table that is probed comes only from the rule row, never from the app.source_ref text.
    SELECT dr.source_table, dr.source_state INTO rule_src, rule_state
      FROM core.derivation_rule dr
     WHERE dr.rule_id = s_rule AND dr.target_table = target AND dr.source_table = split_part(s_source, ':', 1);
    IF rule_src IS NOT NULL AND src_id ~ uuid_re THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I s WHERE s.tenant_id = $1 AND s.id = $2 AND (%s))',
                     split_part(rule_src, '.', 1), split_part(rule_src, '.', 2), rule_state)
         INTO src_found USING NEW.tenant_id, src_id::uuid;
      IF src_found THEN
        NEW.origin := jsonb_build_object('kind', 'derivation', 'rule_id', s_rule, 'source_ref', s_source);
        RETURN NEW;
      END IF;
      why := coalesce(why, 'the derivation''s source row is missing or not in the rule''s source state');
    END IF;
  END IF;

  -- (1) A named person's own command.
  IF s_role IS NOT NULL AND s_cmd IS NOT NULL THEN
    principal := nullif(current_setting(CASE s_role WHEN 'customer' THEN 'app.customer_id'
                                                    WHEN 'operator' THEN 'app.operator_id'
                                                    ELSE 'app.member_id' END, true), '');
    SELECT ca.scope, ca.target_tables, ca.customer_target_tables INTO a_scope, a_tabs, a_cust
      FROM core.command_authority ca
     WHERE ca.command_type = s_cmd AND s_role = ANY (ca.allowed_roles);
    IF principal ~ uuid_re AND a_scope IS NOT NULL THEN
      IF s_role = 'customer' THEN
        IF s_outlets = '{*}' THEN
          why := 'a customer context never has the all-outlet scope';
        ELSIF NOT target = ANY (a_cust) THEN
          why := s_cmd || ' does not let a customer write ' || target;
        ELSIF core.book_row_customer_owned(target, NEW.tenant_id, new_j, principal::uuid, s_guest, true)
              AND (old_j IS NULL OR core.book_row_customer_owned(target, NEW.tenant_id, old_j, principal::uuid, s_guest, false)) THEN
          NEW.origin := CASE WHEN TG_OP = 'UPDATE' THEN OLD.origin
                             ELSE jsonb_build_object('kind', 'command', 'command_type', s_cmd, 'role', s_role, 'principal_id', principal) END;
          RETURN NEW;
        ELSE
          why := 'the row is not this customer''s own';
        END IF;
      ELSIF NOT target = ANY (a_tabs) THEN
        mismatch := s_cmd || ' does not list ' || target;
      ELSIF core.book_row_in_scope(target, NEW.tenant_id, new_j, a_scope, s_role, s_outlets)
            AND (old_j IS NULL OR core.book_row_in_scope(target, NEW.tenant_id, old_j, a_scope, s_role, s_outlets)) THEN
        NEW.origin := CASE WHEN TG_OP = 'UPDATE' THEN OLD.origin
                           ELSE jsonb_build_object('kind', 'command', 'command_type', s_cmd, 'role', s_role, 'principal_id', principal) END;
        RETURN NEW;
      ELSE
        why := 'the row is outside the caller''s outlet scope';
      END IF;
    END IF;
  END IF;

  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'command_table_mismatch: %', mismatch
      USING ERRCODE = 'MB008', HINT = 'core.command_authority.target_tables binds each command type to the book tables it writes';
  END IF;
  RAISE EXCEPTION 'book_write_refused: %', target || coalesce(' — ' || why, '')
    USING ERRCODE = 'MB001',
          HINT = 'needs a person''s own command allowed by core.command_authority within their scope, an executing approved decision, or an allow-listed derivation';
END $$;
REVOKE ALL ON FUNCTION core.guard_book_write() FROM PUBLIC;

------------------------------------------------------------------------------------------------------------
-- 7. F3 — an order's money is fixed at placement; it changes only under the pricing rule orders.reprice
------------------------------------------------------------------------------------------------------------
CREATE FUNCTION core.order_pricing_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.subtotal_minor, NEW.discount_minor, NEW.tax_minor, NEW.total_minor, NEW.currency, NEW.pricing_snapshot)
       IS DISTINCT FROM (OLD.subtotal_minor, OLD.discount_minor, OLD.tax_minor, OLD.total_minor, OLD.currency, OLD.pricing_snapshot)
     AND NOT (coalesce(current_setting('app.posting_rule', true), '') = 'orders.reprice'
              AND coalesce(current_setting('app.source_ref', true), '') = 'core.order:' || OLD.id::text) THEN
    RAISE EXCEPTION 'book_write_refused: core.order — money columns change only under the pricing rule orders.reprice'
      USING ERRCODE = 'MB001';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.order_pricing_frozen() FROM PUBLIC;
CREATE TRIGGER pricing_frozen BEFORE UPDATE ON core."order" FOR EACH ROW EXECUTE FUNCTION core.order_pricing_frozen();

------------------------------------------------------------------------------------------------------------
-- 8. F4 — customer RLS: one RESTRICTIVE policy per tenant table (ANDed with the tenant/outlet policy)
------------------------------------------------------------------------------------------------------------
-- Classes (hand-listed again in tests/manifest.ts):
--   own     — the customer's rows: customer (id), order (customer_id, or the guest token hash), loyalty,
--             reservation, bulk order (customer_id); order children through a visible (own) order;
--   public  — read-only for customers: the catalogue and storefront facts pricing needs;
--   coupon  — read only the codes the request presents (app.coupon_codes = '{CODE,…}');
--   open    — no customer restriction: ticket_counter, pickup_window (placement writes them);
--   deny    — every other tenant table (journal, member, audit, outbox, draft, finding, snapshot, …).
-- In a customer request core-api writes command_log, audit_log, outbox and derived rows only after it clears
-- app.role (set_config('app.role', '', true)) — customers cannot read or write those (db/README.md).
DO $$
DECLARE
  rel   regclass;
  name  text;
  q     text;
  chk   text;
  nc    constant text := $c$((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'customer')$c$;
  cust  constant text := $c$(SELECT nullif(current_setting('app.customer_id', true), '')::uuid)$c$;
  guest constant text := $c$(SELECT decode(nullif(current_setting('app.guest_access_hash', true), ''), 'hex'))$c$;
BEGIN
  FOR rel, name IN
    SELECT c.oid::regclass, s.nspname || '.' || c.relname
      FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
     WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform') AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     ORDER BY 2
  LOOP
    IF name IN ('core.ticket_counter', 'core.pickup_window') THEN
      CONTINUE;
    ELSIF name = 'core.customer' THEN
      q := nc || ' OR id = ' || cust;  chk := q;
    ELSIF name = 'core.order' THEN
      q := nc || ' OR customer_id = ' || cust || ' OR guest_access_hash = ' || guest;  chk := q;
    ELSIF name IN ('core.loyalty_entry', 'core.reservation', 'core.bulk_order') THEN
      q := nc || ' OR customer_id = ' || cust;  chk := q;
    ELSIF name IN ('core.order_line', 'core.order_event', 'core.coupon_use', 'core.tender', 'core.refund', 'core.void',
                   'core.sale_return', 'core.kitchen_ticket') THEN
      q := format('%s OR EXISTS (SELECT 1 FROM core."order" o WHERE o.tenant_id = %2$I.tenant_id AND o.id = %2$I.order_id)',
                  nc, split_part(name, '.', 2));
      chk := q;
    ELSIF name IN ('core.tenant', 'core.outlet', 'core.brand', 'core.channel', 'core.item', 'core.variant',
                   'core.option_group', 'core.option', 'core.price', 'core.deal', 'core.item_availability',
                   'core.outlet_calendar', 'core.prep_time', 'core.recipe_version') THEN
      q := 'true';  chk := nc;
    ELSIF name = 'core.coupon' THEN
      q := nc || $c$ OR code = ANY ((SELECT nullif(current_setting('app.coupon_codes', true), ''))::text[])$c$;  chk := nc;
    ELSE
      q := nc;  chk := nc;
    END IF;
    EXECUTE format('CREATE POLICY customer_scope ON %s AS RESTRICTIVE FOR ALL USING (%s) WITH CHECK (%s)', rel, q, chk);
  END LOOP;
END $$;

-- Guests (orchestrator ruling, 10 Oct): a guest-token principal gets app.role = 'guest' and app.guest_access_hash
-- = hex sha256 of its token (no customer_id). A second RESTRICTIVE policy on every tenant table: a guest reads the
-- one order with that hash and its lines, events, tenders and kitchen tickets, writes nothing, and sees nothing
-- else (not the customer row, not the same customer's other orders, not the catalogue).
DO $$
DECLARE
  rel  regclass;
  name text;
  q    text;
  ng   constant text := $c$((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'guest')$c$;
  hash constant text := $c$(SELECT decode(nullif(current_setting('app.guest_access_hash', true), ''), 'hex'))$c$;
BEGIN
  FOR rel, name IN
    SELECT c.oid::regclass, s.nspname || '.' || c.relname
      FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
     WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform') AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     ORDER BY 2
  LOOP
    q := CASE WHEN name = 'core.order' THEN ng || ' OR guest_access_hash = ' || hash
              WHEN name IN ('core.order_line', 'core.order_event', 'core.tender', 'core.kitchen_ticket')
                THEN format('%s OR EXISTS (SELECT 1 FROM core."order" o WHERE o.tenant_id = %2$I.tenant_id AND o.id = %2$I.order_id)',
                            ng, split_part(name, '.', 2))
              ELSE ng END;
    EXECUTE format('CREATE POLICY guest_scope ON %s AS RESTRICTIVE FOR ALL USING (%s) WITH CHECK (%s)', rel, q, ng);
  END LOOP;
END $$;
-- Shoppers do not depend on outlet scope (ruling): every outlet-scoped permissive policy admits app.role
-- customer / guest, whose rows are then governed only by customer_scope / guest_scope. core-api gives shoppers
-- app.outlet_ids = '{}'.
DO $$
DECLARE
  rel  regclass;
  pred constant text := $c$tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.role', true)) IN ('customer', 'guest')
              OR (SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[]))$c$;
BEGIN
  FOR rel IN SELECT p.polrelid::regclass FROM pg_policy p WHERE p.polname = 'tenant_outlet_isolation' ORDER BY 1 LOOP
    EXECUTE format('ALTER POLICY tenant_outlet_isolation ON %s USING (%s) WITH CHECK (%s)', rel, pred, pred);
  END LOOP;
END $$;

-- The tracker resolves a guest token's hash to its order.
CREATE INDEX order_guest_access_hash_idx ON core."order" (tenant_id, guest_access_hash) WHERE guest_access_hash IS NOT NULL;

------------------------------------------------------------------------------------------------------------
-- 9. #37 — intel runs and their traces: visible only when the caller's outlet scope covers the run's;
-- a '{*}' run only to owner / advisor / judge or a service context (no app.role) holding '{*}'
------------------------------------------------------------------------------------------------------------
DROP POLICY tenant_isolation ON intel.run;
CREATE POLICY tenant_run_scope ON intel.run
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND CASE WHEN outlet_scope = '{*}'
                  THEN (SELECT current_setting('app.outlet_ids', true)) = '{*}'
                       AND (SELECT coalesce(nullif(current_setting('app.role', true), ''), 'service')) IN ('service', 'owner', 'advisor', 'judge')
                  ELSE (SELECT current_setting('app.outlet_ids', true)) = '{*}'
                       OR outlet_scope::uuid[] <@ (SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[] END)
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND CASE WHEN outlet_scope = '{*}'
                  THEN (SELECT current_setting('app.outlet_ids', true)) = '{*}'
                       AND (SELECT coalesce(nullif(current_setting('app.role', true), ''), 'service')) IN ('service', 'owner', 'advisor', 'judge')
                  ELSE (SELECT current_setting('app.outlet_ids', true)) = '{*}'
                       OR outlet_scope::uuid[] <@ (SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[] END);

-- A trace event is visible exactly when its run is (the subquery runs under intel.run's policy).
DROP POLICY tenant_isolation ON intel.trace_event;
CREATE POLICY tenant_via_run ON intel.trace_event
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND EXISTS (SELECT 1 FROM intel.run r WHERE r.tenant_id = trace_event.tenant_id AND r.id = trace_event.run_id))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND EXISTS (SELECT 1 FROM intel.run r WHERE r.tenant_id = trace_event.tenant_id AND r.id = trace_event.run_id));
-- intel_ro.trace_recent evaluates that policy as its owner.
GRANT SELECT (tenant_id, id, outlet_scope) ON intel.run TO munim_view_owner;

------------------------------------------------------------------------------------------------------------
-- 10. #49 — expired-sale override: issued before placement against a cart line, consumed at placement
------------------------------------------------------------------------------------------------------------
-- cart_line_id = the order line id the client will place (client-generated, 02-schema §0). Issued with
-- order_line_id NULL and used_at NULL; placement (orders.place.v1, which now lists this table) inserts the
-- line and sets used_at with order_line_id = cart_line_id, once (core.expired_override_rules, 0005).
ALTER TABLE core.expired_sale_override DROP CONSTRAINT expired_sale_override_tenant_id_order_line_id_fkey;
ALTER TABLE core.expired_sale_override ADD COLUMN cart_line_id uuid;
ALTER TABLE core.expired_sale_override ALTER COLUMN cart_line_id SET NOT NULL;
ALTER TABLE core.expired_sale_override ALTER COLUMN order_line_id DROP NOT NULL;
ALTER TABLE core.expired_sale_override
  ADD FOREIGN KEY (tenant_id, order_line_id) REFERENCES core.order_line (tenant_id, id),
  ADD CONSTRAINT expired_sale_override_cart_line_unique UNIQUE (tenant_id, cart_line_id, batch_id),
  ADD CONSTRAINT expired_sale_override_consumed CHECK ((used_at IS NULL) = (order_line_id IS NULL)
                                                       AND (order_line_id IS NULL OR order_line_id = cart_line_id));
GRANT UPDATE (order_line_id) ON core.expired_sale_override TO munim_core;

------------------------------------------------------------------------------------------------------------
-- 11. #59 #60 #62 #17
------------------------------------------------------------------------------------------------------------
-- Cash rounding (pack cash_rounding_minor): the signed difference between the rounded cash amount taken and
-- the amount due, recorded on a cash tender only.
ALTER TABLE core.tender ADD COLUMN rounding_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE core.tender ADD CONSTRAINT tender_rounding_cash_only CHECK (rounding_minor = 0 OR method = 'cash');

-- Business day: business_date = local date of (now − cutoff), so ticket numbers roll at the cutoff.
-- Invoice series (orchestrator ruling): an order on an aggregator channel whose pack treatment is
-- operator_collects_excluded (IN, CGST Sec 9(5)) takes no number from the per-device gapless series; every other
-- order on a device does. So a device order may now have no invoice number.
ALTER TABLE core."order" DROP CONSTRAINT order_check1;
ALTER TABLE core."order" ADD CONSTRAINT order_invoice_pair CHECK ((invoice_no IS NULL) = (invoice_fy IS NULL)
                                                                 AND (invoice_no IS NULL OR device_id IS NOT NULL));
ALTER TABLE core.outlet ADD COLUMN business_day_cutoff time NOT NULL DEFAULT '04:00';
GRANT UPDATE (business_day_cutoff) ON core.outlet TO munim_core;

CREATE OR REPLACE FUNCTION core.order_assign_numbers() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  outlet_tz    text;
  cutoff       time;
  fy_start     smallint;
  channel_kind text;
  treatment    text;
BEGIN
  SELECT o.tz, o.business_day_cutoff INTO outlet_tz, cutoff FROM core.outlet o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.outlet_id;
  SELECT t.fy_start_month INTO fy_start FROM core.tenant t WHERE t.tenant_id = NEW.tenant_id;
  IF outlet_tz IS NULL OR fy_start IS NULL THEN
    RAISE EXCEPTION 'order_numbers: outlet % not visible in this context', NEW.outlet_id USING ERRCODE = 'MB001';
  END IF;
  NEW.business_date := ((now() AT TIME ZONE outlet_tz) - cutoff)::date;

  INSERT INTO core.ticket_counter AS c (tenant_id, outlet_id, business_date, last_no)
  VALUES (NEW.tenant_id, NEW.outlet_id, NEW.business_date, 1)
  ON CONFLICT (tenant_id, outlet_id, business_date) DO UPDATE SET last_no = c.last_no + 1
  RETURNING c.last_no INTO NEW.ticket_no;

  SELECT ch.kind INTO channel_kind FROM core.channel ch WHERE ch.tenant_id = NEW.tenant_id AND ch.id = NEW.channel_id;
  IF channel_kind LIKE 'aggregator:%' THEN
    SELECT a ->> 'tax_treatment' INTO treatment
      FROM core.tenant t
      JOIN platform.country_pack p ON p.code = t.country_code AND p.status = 'active',
           jsonb_array_elements(p.doc -> 'aggregators') a
     WHERE t.tenant_id = NEW.tenant_id AND a ->> 'code' = substr(channel_kind, 12)
     ORDER BY p.version DESC LIMIT 1;
  END IF;

  IF NEW.device_id IS NULL OR treatment = 'operator_collects_excluded' THEN
    NEW.invoice_fy := NULL;
    NEW.invoice_no := NULL;
  ELSE
    NEW.invoice_fy := extract(year FROM NEW.business_date)::smallint
                      - CASE WHEN extract(month FROM NEW.business_date) < fy_start THEN 1 ELSE 0 END;
    INSERT INTO core.invoice_counter AS c (tenant_id, device_id, fy, last_no)
    VALUES (NEW.tenant_id, NEW.device_id, NEW.invoice_fy, 1)
    ON CONFLICT (tenant_id, device_id, fy) DO UPDATE SET last_no = c.last_no + 1
    RETURNING c.last_no INTO NEW.invoice_no;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.order_assign_numbers() FROM PUBLIC;

-- The zone the tenant brief runs in. NULL = the zone of the tenant's first outlet (created_at, id).
ALTER TABLE core.tenant ADD COLUMN home_tz text CHECK (home_tz ~ '^[A-Za-z]+/[A-Za-z_]+$');
GRANT UPDATE (home_tz) ON core.tenant TO munim_core;

-- Why an executing draft failed (reason code, never raw error text), set with status 'failed' (T-008).
ALTER TABLE core.draft ADD COLUMN failure_reason text CHECK (failure_reason ~ '^[a-z][a-z0-9_]*$');
ALTER TABLE core.draft ADD CONSTRAINT draft_failure_reason_failed CHECK (failure_reason IS NULL OR status = 'failed');
GRANT UPDATE (failure_reason) ON core.draft TO munim_core;

-- Outbox delivery bookkeeping (rider): attempts and a dead mark; the sweeper never claims a dead row.
ALTER TABLE core.outbox ADD COLUMN publish_attempts integer NOT NULL DEFAULT 0 CHECK (publish_attempts >= 0);
ALTER TABLE core.outbox ADD COLUMN dead_at timestamptz;
ALTER TABLE core.outbox ADD CONSTRAINT outbox_dead_unpublished CHECK (dead_at IS NULL OR published_at IS NULL);
GRANT UPDATE (publish_attempts, dead_at) ON core.outbox TO munim_svc;

-- Re-issued with `dead_at IS NULL` (owner, grants and SECURITY DEFINER unchanged: munim_crosstenant, svc only).
CREATE OR REPLACE FUNCTION core.outbox_claim(batch_size integer, min_age interval DEFAULT '30 seconds',
                                             lease interval DEFAULT '2 minutes')
RETURNS SETOF core.outbox
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  UPDATE core.outbox o
     SET claimed_until = now() + lease
    FROM (SELECT c.tenant_id, c.id
            FROM core.outbox c
           WHERE c.published_at IS NULL
             AND c.dead_at IS NULL
             AND c.created_at <= now() - min_age
             AND (c.claimed_until IS NULL OR c.claimed_until < now())
           ORDER BY c.created_at, c.id
           LIMIT least(greatest(batch_size, 0), 1000)
           FOR UPDATE SKIP LOCKED) pick
   WHERE o.tenant_id = pick.tenant_id AND o.id = pick.id
  RETURNING o.*;
$$;
REVOKE ALL ON FUNCTION core.outbox_claim(integer, interval, interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.outbox_claim(integer, interval, interval) TO munim_svc;

------------------------------------------------------------------------------------------------------------
-- 12. Catalog post-conditions, extended (replaces 0007's function; every later migration calls it)
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

  -- F1/F2: book_scope covers exactly the book tables; parents are book_scope rows.
  SELECT string_agg(coalesce(b.table_name, 'core.' || c.relname), ', ') INTO bad
    FROM (SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
           WHERE s.nspname = 'core' AND c.relkind = 'r' AND obj_description(c.oid, 'pg_class') = 'munim:book') c
    FULL JOIN core.book_scope b ON b.table_name = 'core.' || c.relname
   WHERE c.oid IS NULL OR b.table_name IS NULL
      OR (b.parent_table IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.book_scope p WHERE p.table_name = b.parent_table));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: book_scope does not match the book tables: %', migration, bad; END IF;

  -- #23: every book table whose status/stage munim_core may update has a transition trigger.
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

  -- F4: every tenant table but the two placement counters carries the restrictive customer_scope policy.
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

  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace,
         LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform', 'intel_ro', 'munim_meta') AND x.grantee = 0;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: functions executable by PUBLIC: %', migration, bad; END IF;

  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform', 'intel_ro', 'munim_meta')
     AND (p.prosecdef OR p.proowner = 'munim_crosstenant'::regrole)
     AND NOT (p.prosecdef AND p.proowner = 'munim_crosstenant'::regrole
              AND p.oid IN ('core.outbox_claim(integer, interval, interval)'::regprocedure,
                            'core.active_tenants()'::regprocedure,
                            'core.tenant_for_storefront_key(text)'::regprocedure,
                            'core.memberships_for_sub(text)'::regprocedure));
  IF n <> 0 THEN RAISE EXCEPTION '%: unexpected SECURITY DEFINER / munim_crosstenant functions: %', migration, n; END IF;
  SELECT count(*) INTO n FROM pg_proc p WHERE p.prosecdef AND p.proowner = 'munim_crosstenant'::regrole;
  IF n <> 4 THEN RAISE EXCEPTION '%: expected 4 munim_crosstenant definer functions, found %', migration, n; END IF;
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
BEGIN
  IF (SELECT count(*) FROM core.book_scope) <> 92 THEN
    RAISE EXCEPTION '0014: expected 92 book_scope rows, found %', (SELECT count(*) FROM core.book_scope);
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polname = 'customer_scope' AND NOT polpermissive) <> 131 THEN
    RAISE EXCEPTION '0014: expected 131 customer_scope policies, found %', (SELECT count(*) FROM pg_policy WHERE polname = 'customer_scope');
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polname = 'guest_scope' AND NOT polpermissive) <> 133 THEN
    RAISE EXCEPTION '0014: expected 133 guest_scope policies';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'core.outbox_claim(integer, interval, interval)'::regprocedure
                    AND p.prosecdef AND p.proowner = 'munim_crosstenant'::regrole AND p.prosrc LIKE '%dead_at IS NULL%') THEN
    RAISE EXCEPTION '0014: outbox_claim not re-issued as written';
  END IF;
  IF EXISTS (SELECT 1 FROM core.derivation_rule WHERE source_state IS NULL) THEN
    RAISE EXCEPTION '0014: derivation rules without source_state';
  END IF;
  PERFORM munim_meta.assert_catalog('0014');
END $$;
