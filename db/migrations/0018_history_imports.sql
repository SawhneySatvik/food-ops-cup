-- 0018_history_imports — dated synthetic history through the approved-import path (ledger R44 b, c; R28), migrator
-- lane h-1, fix forward over 0001–0017. Runs as munim_migrator. Items:
--   K1  Two history import kinds: 'pos_bills' (POS bills with lines, channel, brand, customer, tender split, refunds,
--       voids — parser pos_bills_v2) and 'waste_log' (waste entries — parser waste_log_v1), on core.document,
--       core.import_format and core.import_run. Nothing else about a run changes: parse → preview → draft →
--       approval → commit under the approver's decision (0014 import_run rules).
--   K2  imports.run.commit.v1 also writes core.order_line, core.refund, core.void and core.waste_log (the rows a person
--       approves). It does NOT list core.journal_entry, core.posting or core.stock_movement: those stay derivations
--       of the approved rows (finance.post_order / post_tender / post_refund, inventory.consume_order / consume_sku /
--       record_waste), judged by the guard's derivation branch with each rule's source state.
--   K3  core.write_derived(groups jsonb): the batched form of "set app.posting_rule + app.source_ref, INSERT the derived
--       rows" for many sources in ONE statement — one network round trip instead of one per row (R44c: the hosted
--       commit spent 94% of its time in round trips, measured 10 Oct). SECURITY INVOKER: the caller's grants, RLS and
--       the book guard judge every row exactly as they judge the same INSERTs sent one at a time. No bypass, no
--       session_replication_role. EXECUTE munim_core only.
-- What a history row is NOT given: a device invoice number (0015 order_assign_numbers: an order inserted under an
-- approved imports.run.commit.v1 draft keeps its own business date and takes no invoice number). Ticket numbers come
-- from the bill date's own counter; core-api refuses (quarantines) any history row dated on or after the outlet's
-- current business date, so a history row never takes a number from the live day's series.
-- New SQLSTATEs: none.

------------------------------------------------------------------------------------------------------------
-- 1. K1 — history kinds
------------------------------------------------------------------------------------------------------------
-- The inline CHECKs of 0009 carry PostgreSQL's default names; each is asserted to exist before it is replaced.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_constraint
       WHERE (conrelid, conname) IN (('core.document'::regclass, 'document_kind_check'),
                                     ('core.import_format'::regclass, 'import_format_kind_check'),
                                     ('core.import_run'::regclass, 'import_run_kind_check'))
         AND contype = 'c') <> 3 THEN
    RAISE EXCEPTION '0018: the 0009 kind CHECKs are not where 0018 expects them';
  END IF;
END $$;

ALTER TABLE core.document DROP CONSTRAINT document_kind_check;
ALTER TABLE core.document ADD CONSTRAINT document_kind_check
  CHECK (kind IN ('supplier_invoice', 'payout_statement', 'bank_statement', 'pos_export', 'tally_export', 'aggregator_orders',
                  'market_signal', 'menu', 'price_list', 'chat_export', 'agreement', 'licence', 'other',
                  'pos_bills', 'waste_log'));
ALTER TABLE core.import_format DROP CONSTRAINT import_format_kind_check;
ALTER TABLE core.import_format ADD CONSTRAINT import_format_kind_check
  CHECK (kind IN ('payout_statement', 'bank_statement', 'pos_export', 'tally_export', 'aggregator_orders', 'supplier_invoice',
                  'market_signal', 'menu', 'price_list', 'reviews',
                  'pos_bills', 'waste_log'));
ALTER TABLE core.import_run DROP CONSTRAINT import_run_kind_check;
ALTER TABLE core.import_run ADD CONSTRAINT import_run_kind_check
  CHECK (kind IN ('payout_statement', 'bank_statement', 'pos_export', 'tally_export', 'aggregator_orders', 'supplier_invoice',
                  'market_signal', 'menu', 'price_list', 'reviews',
                  'pos_bills', 'waste_log'));

------------------------------------------------------------------------------------------------------------
-- 2. K2 — what an approved import may write
------------------------------------------------------------------------------------------------------------
UPDATE core.command_authority
   SET target_tables = target_tables || ARRAY['core.order_line', 'core.refund', 'core.void', 'core.waste_log']
 WHERE command_type = 'imports.run.commit.v1';

------------------------------------------------------------------------------------------------------------
-- 3. K3 — core.write_derived(groups jsonb)
------------------------------------------------------------------------------------------------------------
-- groups: [{rule, source_ref, journal_entry: [...], posting: [...], stock_movement: [...]}, …] in write order. Per
-- group: app.posting_rule := rule, app.source_ref := source_ref (transaction-local, as underRule does), then the
-- group's rows, entries before their postings. Previous values are restored at the end. The columns that say what a
-- row derives from are taken from the group, never from the row: an entry's posting_rule / source_type / source_id and
-- a movement's ref_type / ref_id are the group's rule and source, so a row cannot be judged under one source and
-- labelled with another; a posting must belong to an entry of its own group. tenant_id is app.tenant_id (RLS WITH
-- CHECK would refuse any other). created_by of a movement is app.member_id, as inventory's insertMovement writes it.
-- Everything else (origin, guard, currency, period, balance, unit-cost and numbering triggers) is the tables' own.
CREATE FUNCTION core.write_derived(groups jsonb) RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  g         jsonb;
  n         integer := 0;
  k         integer;
  rule      text;
  src       text;
  src_table text;
  src_id    uuid;
  prev_rule text := coalesce(current_setting('app.posting_rule', true), '');
  prev_src  text := coalesce(current_setting('app.source_ref', true), '');
BEGIN
  IF jsonb_typeof(groups) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'write_derived: groups must be a JSON array' USING ERRCODE = '22023';
  END IF;
  FOR g IN SELECT value FROM jsonb_array_elements(groups) LOOP
    rule := g ->> 'rule';
    src := g ->> 'source_ref';
    IF jsonb_typeof(g) IS DISTINCT FROM 'object' OR rule IS NULL OR src IS NULL
       OR src !~ '^core\.[a-z_]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR EXISTS (SELECT 1 FROM jsonb_object_keys(g) x WHERE x NOT IN ('rule', 'source_ref', 'journal_entry', 'posting', 'stock_movement')) THEN
      RAISE EXCEPTION 'write_derived: a group is {rule, source_ref, journal_entry?, posting?, stock_movement?}' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_to_recordset(coalesce(g -> 'posting', '[]')) AS x (journal_entry_id uuid)
                WHERE NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(coalesce(g -> 'journal_entry', '[]')) AS e (id uuid)
                                   WHERE e.id = x.journal_entry_id)) THEN
      RAISE EXCEPTION 'write_derived: a posting must belong to an entry of its own group' USING ERRCODE = '22023';
    END IF;
    src_table := split_part(src, ':', 1);
    src_id := split_part(src, ':', 2)::uuid;
    PERFORM set_config('app.posting_rule', rule, true), set_config('app.source_ref', src, true);

    INSERT INTO core.journal_entry (tenant_id, id, outlet_id, brand_id, channel_id, entry_date, source_type, source_id, posting_rule,
                                    reverses_id, memo_key)
    SELECT current_setting('app.tenant_id')::uuid, x.id, x.outlet_id, x.brand_id, x.channel_id, x.entry_date, src_table, src_id, rule,
           x.reverses_id, x.memo_key
      FROM jsonb_to_recordset(coalesce(g -> 'journal_entry', '[]')) AS x (id uuid, outlet_id uuid, brand_id uuid, channel_id uuid,
           entry_date date, reverses_id uuid, memo_key text);
    GET DIAGNOSTICS k = ROW_COUNT;
    n := n + k;

    INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency)
    SELECT current_setting('app.tenant_id')::uuid, x.id, x.journal_entry_id, x.account_id, x.amount_minor, x.currency
      FROM jsonb_to_recordset(coalesce(g -> 'posting', '[]')) AS x (id uuid, journal_entry_id uuid, account_id uuid, amount_minor bigint,
           currency char(3));
    GET DIAGNOSTICS k = ROW_COUNT;
    n := n + k;

    INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, kind, ref_type, ref_id,
                                     unit_cost_per_1000_minor, currency, expired_sale_override_id, at, created_by)
    SELECT current_setting('app.tenant_id')::uuid, x.id, x.outlet_id, x.ingredient_id, x.batch_id, x.qty_milli, x.unit, x.kind,
           src_table, src_id, x.unit_cost_per_1000_minor, x.currency, x.expired_sale_override_id, coalesce(x.at, now()),
           nullif(current_setting('app.member_id', true), '')::uuid
      FROM jsonb_to_recordset(coalesce(g -> 'stock_movement', '[]')) AS x (id uuid, outlet_id uuid, ingredient_id uuid, batch_id uuid,
           qty_milli bigint, unit text, kind text, unit_cost_per_1000_minor bigint, currency char(3), expired_sale_override_id uuid,
           at timestamptz);
    GET DIAGNOSTICS k = ROW_COUNT;
    n := n + k;
  END LOOP;
  PERFORM set_config('app.posting_rule', prev_rule, true), set_config('app.source_ref', prev_src, true);
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION core.write_derived(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.write_derived(jsonb) TO munim_core;

------------------------------------------------------------------------------------------------------------
-- 4. Post-conditions (positive: each reads back as written)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  def text;
BEGIN
  -- K1: the three CHECKs list both history kinds and every kind they listed before.
  FOR def IN SELECT pg_get_constraintdef(oid) FROM pg_constraint
              WHERE (conrelid, conname) IN (('core.document'::regclass, 'document_kind_check'),
                                            ('core.import_format'::regclass, 'import_format_kind_check'),
                                            ('core.import_run'::regclass, 'import_run_kind_check'))
  LOOP
    IF def NOT LIKE '%''pos_bills''::text%' OR def NOT LIKE '%''waste_log''::text%' OR def NOT LIKE '%''pos_export''::text%'
       OR def NOT LIKE '%''payout_statement''::text%' OR def NOT LIKE '%''market_signal''::text%' THEN
      RAISE EXCEPTION '0018: kind CHECK not as written: %', def;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_constraint
       WHERE conrelid IN ('core.document'::regclass, 'core.import_format'::regclass, 'core.import_run'::regclass)
         AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%pos_bills%') <> 3 THEN
    RAISE EXCEPTION '0018: expected exactly three kind CHECKs naming pos_bills';
  END IF;

  -- K2: the binding, exactly (0008, 0011 review, 0015 A7, 0018), and nothing derived.
  IF (SELECT array_agg(t ORDER BY t) FROM core.command_authority, unnest(target_tables) t WHERE command_type = 'imports.run.commit.v1')
       IS DISTINCT FROM ARRAY['core.bank_line', 'core.expense', 'core.order', 'core.order_line', 'core.refund', 'core.review',
                              'core.settlement', 'core.settlement_line', 'core.supplier_invoice', 'core.supplier_invoice_line', 'core.tender', 'core.void',
                              'core.waste_log']
     OR NOT (SELECT draft_only FROM core.command_authority WHERE command_type = 'imports.run.commit.v1') THEN
    RAISE EXCEPTION '0018: imports.run.commit.v1 binding not as written: %',
      (SELECT array_agg(t ORDER BY t) FROM core.command_authority, unnest(target_tables) t WHERE command_type = 'imports.run.commit.v1');
  END IF;

  -- K3: invoker (not definer), owned by munim_migrator, pinned search_path, EXECUTE munim_core only.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = 'core.write_derived(jsonb)'::regprocedure
                    AND NOT p.prosecdef AND p.proowner = 'munim_migrator'::regrole
                    AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
                    AND has_function_privilege('munim_core', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('munim_svc', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('munim_platform', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('munim_intel_ro', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION '0018: core.write_derived not owned/granted as written';
  END IF;

  PERFORM munim_meta.assert_catalog('0018');
END $$;
