-- 0022_mc1d_guard_binding_f8_asof — W3 migrator lane M-C1d (m-1), fix forward over 0001–0021. Runs as munim_migrator.
-- Items:
--   G1 (sev 1, NON-ADDITIVE, ledger R45 F11 "M-C1d — guard binding: approved")  The book guard's derivation branch
--       (3) judged only the SOURCE row (it exists, in the rule's source state), never that the written row belongs to it:
--       under purchasing.payable_from_invoice a payable naming another invoice, under inventory.count_adjust a movement
--       at another outlet or of an ingredient the count never counted, passed. 0016 (loyalty) and 0017 (coupon discount,
--       payable re-open) closed it table by table. Now every core.derivation_rule row carries `binding`: a SQL predicate
--       over the source row `s`, the written row `n` and (UPDATE) its old version `o`; branch (3) admits a row only when
--       the source exists, is in the source state AND the binding holds. A row that fails falls through to the next branch
--       exactly as a source-state failure does (MB001 alone, MB008 inside a decision that does not list the table). The
--       binding is NOT NULL, references s and n, and never reads ';' (CHECK) — a rule without one cannot be inserted.
--       The table-specific triggers of 0016/0017 stay (they hold in every branch, not only this one).
--   S1  core.draft.source names one of the eight F8 specialists: 'import', 'member' or 'intel:<catalogue | kitchen |
--       inventory_purchasing | finance | people | customers | compliance | market>' (CHECK draft_source_f8; 0003 admitted
--       any 'intel:<word>'). Not the manager, not forecast: neither proposes (ledger R45 F8, contracts SpecialistId).
--   A1  Version 2 of the 14 templates that read "today" from the wall clock, with a nullable `as_of` date (NULL = today,
--       the v1 output exactly), so a gate pinned to a date returns the same rows whatever day it runs.
--   A2  Columns the pack lanes asked for (orchestrator, 11 Oct), in the same version 2: inventory.expiry_risk + ingredient_id,
--       unit, supplier_id; catalogue.cost_drift + price_id, channel_kind, tax_class; catalogue.recipe_current + unit;
--       market.upcoming forecast_orders → forecast_units; and catalogue.dish_margin v2 + price_id, channel_kind, tax_class.
--   T1  Templates no pack table owns: finance.gst_summary (deferred from M-C1a, db/README.md), inventory.count_variance
--       (requested by inventory and the stock-count screen), and the list templates purchasing.invoices,
--       inventory.counts (b-45) and market.goals (b-47).
-- New SQLSTATEs: none.

------------------------------------------------------------------------------------------------------------
-- 1. G1 — every derivation rule declares what binds its written row to its source
------------------------------------------------------------------------------------------------------------
-- Written only by migrations (munim_core and munim_svc read core.derivation_rule; nobody writes it at run time).
ALTER TABLE core.derivation_rule ADD COLUMN binding text
  CONSTRAINT derivation_rule_binding_check CHECK (position(';' IN binding) = 0 AND binding ~ '\ms\.' AND binding ~ '\mn\.');

-- Journal entries and their postings, for every finance rule: the entry names this rule and this source (a reversal
-- reverses an entry of the same source); a posting hangs on such an entry. finance/post.ts writes exactly these columns
-- (writeEntry: source_type, source_id, posting_rule = the rule it runs under, reverses_id of the same source).
UPDATE core.derivation_rule SET binding = format(
  $b$n.source_type = %L AND n.source_id = s.id AND n.posting_rule = %L AND (n.reverses_id IS NULL OR EXISTS (SELECT 1 FROM core.journal_entry r WHERE r.tenant_id = s.tenant_id AND r.id = n.reverses_id AND r.source_type = %L AND r.source_id = s.id))$b$,
  source_table, rule_id, source_table)
 WHERE target_table = 'core.journal_entry';
UPDATE core.derivation_rule SET binding = format(
  $b$EXISTS (SELECT 1 FROM core.journal_entry je WHERE je.tenant_id = s.tenant_id AND je.id = n.journal_entry_id AND je.source_type = %L AND je.source_id = s.id AND je.posting_rule = %L)$b$,
  source_table, rule_id)
 WHERE target_table = 'core.posting';

UPDATE core.derivation_rule SET binding = p.binding
  FROM (VALUES
    -- Stock movements: the source's own kind, reference and outlet; the ingredient (and batch) one of the source's lines
    -- where the source has lines. A sale's consumption follows the recipe, so only its order is bound.
    ('inventory.consume_order', 'core.order', 'core.stock_movement',
     $b$n.kind = 'sale_consumption' AND n.ref_type = 'core.order' AND n.ref_id = s.id AND n.outlet_id = s.outlet_id$b$),
    ('inventory.consume_sku', 'core.order', 'core.stock_movement',
     $b$n.kind = 'sale_consumption' AND n.ref_type = 'core.order' AND n.ref_id = s.id AND n.outlet_id = s.outlet_id$b$),
    ('inventory.reverse_order_consumption', 'core.order', 'core.stock_movement',
     $b$n.kind = 'sale_return' AND n.ref_type = 'core.order' AND n.ref_id = s.id AND n.outlet_id = s.outlet_id AND EXISTS (SELECT 1 FROM core.stock_movement c WHERE c.tenant_id = s.tenant_id AND c.ref_type = 'core.order' AND c.ref_id = s.id AND c.kind = 'sale_consumption' AND c.ingredient_id = n.ingredient_id AND c.batch_id IS NOT DISTINCT FROM n.batch_id)$b$),
    ('inventory.receive_grn', 'core.goods_received', 'core.stock_movement',
     $b$n.kind = 'receipt' AND n.ref_type = 'core.goods_received' AND n.ref_id = s.id AND n.outlet_id = s.outlet_id AND EXISTS (SELECT 1 FROM core.grn_line l WHERE l.tenant_id = s.tenant_id AND l.goods_received_id = s.id AND l.ingredient_id = n.ingredient_id AND l.batch_id IS NOT DISTINCT FROM n.batch_id)$b$),
    ('inventory.record_waste', 'core.waste_log', 'core.stock_movement',
     $b$n.kind = 'waste' AND n.ref_type = 'core.waste_log' AND n.ref_id = s.id AND n.outlet_id = s.outlet_id AND n.ingredient_id = s.ingredient_id AND n.batch_id IS NOT DISTINCT FROM s.batch_id$b$),
    ('inventory.transfer_out', 'core.transfer', 'core.stock_movement',
     $b$n.kind = 'transfer_out' AND n.ref_type = 'core.transfer' AND n.ref_id = s.id AND n.outlet_id = s.from_outlet_id AND EXISTS (SELECT 1 FROM core.transfer_line l WHERE l.tenant_id = s.tenant_id AND l.transfer_id = s.id AND l.ingredient_id = n.ingredient_id AND l.batch_id IS NOT DISTINCT FROM n.batch_id)$b$),
    -- Received stock lands in the destination's own batch (0015 R2-S1-7), so only the ingredient is bound to a line.
    ('inventory.transfer_in', 'core.transfer', 'core.stock_movement',
     $b$n.kind = 'transfer_in' AND n.ref_type = 'core.transfer' AND n.ref_id = s.id AND n.outlet_id = s.to_outlet_id AND EXISTS (SELECT 1 FROM core.transfer_line l WHERE l.tenant_id = s.tenant_id AND l.transfer_id = s.id AND l.ingredient_id = n.ingredient_id)$b$),
    ('inventory.transfer_in', 'core.transfer', 'core.batch',
     $b$n.outlet_id = s.to_outlet_id AND EXISTS (SELECT 1 FROM core.transfer_line l WHERE l.tenant_id = s.tenant_id AND l.transfer_id = s.id AND l.ingredient_id = n.ingredient_id)$b$),
    ('inventory.supplier_return', 'core.supplier_return', 'core.stock_movement',
     $b$n.kind = 'supplier_return' AND n.ref_type = 'core.supplier_return' AND n.ref_id = s.id AND n.outlet_id = s.outlet_id AND EXISTS (SELECT 1 FROM core.supplier_return_line l WHERE l.tenant_id = s.tenant_id AND l.supplier_return_id = s.id AND l.ingredient_id = n.ingredient_id AND l.batch_id IS NOT DISTINCT FROM n.batch_id)$b$),
    ('inventory.sale_return', 'core.sale_return', 'core.stock_movement',
     $b$n.kind = 'sale_return' AND n.ref_type = 'core.sale_return' AND n.ref_id = s.id AND n.outlet_id = s.outlet_id AND EXISTS (SELECT 1 FROM core.order_line l JOIN core.item i ON i.tenant_id = l.tenant_id AND i.id = l.item_id WHERE l.tenant_id = s.tenant_id AND l.id = s.order_line_id AND i.stock_ingredient_id = n.ingredient_id)$b$),
    ('inventory.count_adjust', 'core.stock_count', 'core.stock_movement',
     $b$n.kind = 'count_adjust' AND n.ref_type = 'core.stock_count' AND n.ref_id = s.id AND n.outlet_id = s.outlet_id AND EXISTS (SELECT 1 FROM core.stock_count_line l WHERE l.tenant_id = s.tenant_id AND l.stock_count_id = s.id AND l.ingredient_id = n.ingredient_id AND l.batch_id IS NOT DISTINCT FROM n.batch_id)$b$),
    -- The payable of this invoice, to its supplier.
    ('purchasing.payable_from_invoice', 'core.supplier_invoice', 'core.payable',
     $b$n.source_type = 'core.supplier_invoice' AND n.source_id = s.id AND n.supplier_id = s.supplier_id$b$),
    -- Loyalty (0016 loyalty_reverse_binding keeps its own checks): earn on this order for its customer; a reversal of this
    -- order (cancel path) or of this refund's order citing the refund. A reversal's customer is the undone entry's (MB011).
    ('customers.loyalty_earn', 'core.order', 'core.loyalty_entry',
     $b$n.kind = 'earn' AND n.order_id = s.id AND n.customer_id = s.customer_id AND n.refund_id IS NULL$b$),
    ('customers.loyalty_reverse', 'core.order', 'core.loyalty_entry',
     $b$n.kind = 'reverse' AND n.order_id = s.id AND n.refund_id IS NULL$b$),
    ('customers.loyalty_reverse', 'core.refund', 'core.loyalty_entry',
     $b$n.kind = 'reverse' AND n.refund_id = s.id AND n.order_id = s.order_id$b$),
    -- A re-price changes the source order, its own lines and its own coupon uses (before and after the UPDATE).
    ('orders.reprice', 'core.order', 'core.order',
     $b$n.id = s.id AND o.id = s.id$b$),
    ('orders.reprice', 'core.order', 'core.order_line',
     $b$n.order_id = s.id AND o.order_id = s.id$b$),
    ('orders.reprice', 'core.order', 'core.coupon_use',
     $b$n.order_id = s.id AND o.order_id = s.id$b$),
    -- Reconciliation breaks: a line of this settlement (on its channel and outlet), this bank line, this order.
    ('finance.reconcile_settlement', 'core.settlement', 'core.reconciliation_break',
     $b$n.channel_id = s.channel_id AND n.outlet_id IS NOT DISTINCT FROM s.outlet_id AND EXISTS (SELECT 1 FROM core.settlement_line l WHERE l.tenant_id = s.tenant_id AND l.settlement_id = s.id AND l.id = n.settlement_line_id)$b$),
    ('finance.reconcile_bank', 'core.bank_line', 'core.reconciliation_break',
     $b$n.bank_line_id = s.id$b$),
    ('finance.reconcile_order', 'core.order', 'core.reconciliation_break',
     $b$n.order_id = s.id$b$),
    -- The definer functions of 0015–0017 (source = the signed-in customer): rows move TO the source, guests merge INTO it.
    ('customers.merge_verified_email', 'core.customer', 'core.order',       $b$n.customer_id = s.id$b$),
    ('customers.merge_verified_email', 'core.customer', 'core.reservation', $b$n.customer_id = s.id$b$),
    ('customers.merge_verified_email', 'core.customer', 'core.bulk_order',  $b$n.customer_id = s.id$b$),
    ('customers.merge_verified_email', 'core.customer', 'core.coupon_use',  $b$n.customer_id = s.id$b$),
    ('customers.merge_verified_email', 'core.customer', 'core.customer',    $b$n.merged_into = s.id AND n.id <> s.id$b$),
    ('customers.claim_guest_token',    'core.customer', 'core.order',       $b$n.customer_id = s.id$b$),
    ('customers.claim_guest_token',    'core.customer', 'core.coupon_use',  $b$n.customer_id = s.id$b$),
    ('customers.claim_guest_token',    'core.customer', 'core.customer',    $b$n.merged_into = s.id AND n.id <> s.id$b$),
    -- Erasure reaches only the guests already merged into the erased profile.
    ('customers.erase_merged_guests',  'core.customer', 'core.customer',    $b$n.merged_into = s.id AND o.merged_into = s.id$b$)
  ) AS p (rule_id, source_table, target_table, binding)
 WHERE core.derivation_rule.rule_id = p.rule_id AND core.derivation_rule.source_table = p.source_table
   AND core.derivation_rule.target_table = p.target_table;

ALTER TABLE core.derivation_rule ALTER COLUMN binding SET NOT NULL;

-- The reversal binding looks up an order's consumption by reference; core-api's inventory and import paths query
-- movements the same way (seams.ts, write.ts).
CREATE INDEX stock_movement_ref_idx ON core.stock_movement (tenant_id, ref_type, ref_id);

------------------------------------------------------------------------------------------------------------
-- 2. G1 — the guard, re-issued. Identical to 0017 except the derivation branch (3), which also evaluates the binding.
------------------------------------------------------------------------------------------------------------
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
  rule_bind  text;
  src_id     text;
  src_found  boolean;
  src_bound  boolean;
  a_scope    text;
  a_tabs     text[];
  a_cust     text[];
  a_draft    boolean;
  a_col      text;
  in_scope   boolean;
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

  -- (3) An allow-listed derivation of an existing source row in the rule's source state, the written row bound to it.
  IF s_rule IS NOT NULL AND s_source IS NOT NULL THEN
    src_id := split_part(s_source, ':', 2);
    -- The table that is probed comes only from the rule row, never from the app.source_ref text.
    SELECT dr.source_table, dr.source_state, dr.binding INTO rule_src, rule_state, rule_bind
      FROM core.derivation_rule dr
     WHERE dr.rule_id = s_rule AND dr.target_table = target AND dr.source_table = split_part(s_source, ':', 1);
    IF rule_src IS NOT NULL AND src_id ~ uuid_re THEN
      -- 0022 (R45 F11): s = the source row, n = the written row, o = its old version (all NULL on INSERT).
      EXECUTE format('SELECT (%s), (%s) FROM %I.%I s, jsonb_populate_record(NULL::%I.%I, $3) n, jsonb_populate_record(NULL::%I.%I, $4) o WHERE s.tenant_id = $1 AND s.id = $2',
                     rule_state, coalesce(rule_bind, 'false'), split_part(rule_src, '.', 1), split_part(rule_src, '.', 2),
                     TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_TABLE_SCHEMA, TG_TABLE_NAME)
         INTO src_found, src_bound USING NEW.tenant_id, src_id::uuid, new_j, old_j;
      IF src_found AND src_bound THEN
        NEW.origin := CASE WHEN TG_OP = 'UPDATE' THEN OLD.origin
                           ELSE jsonb_build_object('kind', 'derivation', 'rule_id', s_rule, 'source_ref', s_source) END;
        RETURN NEW;
      END IF;
      why := coalesce(why, CASE WHEN src_found
                                THEN format('row %s does not belong to the source of %s (%s:%s)', new_j ->> 'id', s_rule, rule_src, src_id)
                                ELSE 'the derivation''s source row is missing or not in the rule''s source state' END);
    END IF;
  END IF;

  -- (1) A named person's own command.
  IF s_role IS NOT NULL AND s_cmd IS NOT NULL THEN
    principal := nullif(current_setting(CASE s_role WHEN 'customer' THEN 'app.customer_id'
                                                    WHEN 'operator' THEN 'app.operator_id'
                                                    ELSE 'app.member_id' END, true), '');
    SELECT ca.scope, ca.target_tables, ca.customer_target_tables, ca.draft_only, ca.outlet_column
      INTO a_scope, a_tabs, a_cust, a_draft, a_col
      FROM core.command_authority ca
     WHERE ca.command_type = s_cmd AND s_role = ANY (ca.allowed_roles);
    IF principal ~ uuid_re AND a_scope IS NOT NULL THEN
      IF a_draft THEN
        why := s_cmd || ' is draft-only: it runs only by approving its draft';
      ELSIF s_role = 'customer' THEN
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
      ELSE
        IF a_col IS NULL THEN
          in_scope := core.book_row_in_scope(target, NEW.tenant_id, new_j, a_scope, s_role, s_outlets)
                      AND (old_j IS NULL OR core.book_row_in_scope(target, NEW.tenant_id, old_j, a_scope, s_role, s_outlets));
        ELSE
          in_scope := coalesce(s_outlets = '{*}'
                               OR ((new_j ->> a_col)::uuid = ANY (nullif(s_outlets, '{*}')::uuid[])
                                   AND (old_j IS NULL OR (old_j ->> a_col)::uuid = ANY (nullif(s_outlets, '{*}')::uuid[]))), false);
        END IF;
        IF in_scope THEN
          NEW.origin := CASE WHEN TG_OP = 'UPDATE' THEN OLD.origin
                             ELSE jsonb_build_object('kind', 'command', 'command_type', s_cmd, 'role', s_role, 'principal_id', principal) END;
          RETURN NEW;
        END IF;
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
-- 3. S1 — a draft's source names one of the eight specialists (ledger R45 F8)
------------------------------------------------------------------------------------------------------------
-- The 0003 inline CHECK admits any 'intel:<word>'. Existing rows are counted first: a hosted draft from a retired id
-- would fail the ADD — refused loudly with the count, never rewritten here.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM core.draft
   WHERE source NOT IN ('import', 'member', 'intel:catalogue', 'intel:kitchen', 'intel:inventory_purchasing', 'intel:finance',
                        'intel:people', 'intel:customers', 'intel:compliance', 'intel:market');
  IF n > 0 THEN
    RAISE EXCEPTION '0022: % draft(s) carry a source outside the F8 specialists — relabel them by an approved decision first', n;
  END IF;
END $$;
ALTER TABLE core.draft ADD CONSTRAINT draft_source_f8
  CHECK (source IN ('import', 'member', 'intel:catalogue', 'intel:kitchen', 'intel:inventory_purchasing', 'intel:finance',
                    'intel:people', 'intel:customers', 'intel:compliance', 'intel:market'));

------------------------------------------------------------------------------------------------------------
-- 4. A1 — an `as_of` date for every template that read "today" from the wall clock
------------------------------------------------------------------------------------------------------------
-- Version 2 of each: the same SQL with every "today" (the outlet's business date now; deal_inputs also the server's
-- current_date) wrapped as coalesce(:as_of::date, <today>). as_of NULL = today, so v2 at NULL is v1 exactly; a date
-- anchors every window at that business date. Balances (stock on hand, advances outstanding) stay as recorded now —
-- as_of moves the anchor, it does not replay the books to that date (INFERENCE: what the worldgen gates need, whose
-- plants sit at fixed dates from their AS_OF while the gate runs later). The param is nullable but, as every named
-- param, must be supplied (core-api runTemplate / mintSnapshot): a caller passes "as_of": null for today.
-- Verified list (every template whose SQL reads now() / current_date, measured on the migrated DB): the M-C1bc list
-- (0021 README) plus market.signal_uplift (its lookback ends at "today" too) and two 0019 templates that read the server's
-- current_date: catalogue.cost_drift (its `since` window ends today) and catalogue.recipe_current (no date param).
DO $$
DECLARE
  p_o  constant text := '((now() AT TIME ZONE o.tz) - o.business_day_cutoff)::date';
  p_ou constant text := '((now() AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date';
  p_g  constant text := $p$((now() AT TIME ZONE coalesce(ou.tz, t.home_tz, 'UTC')) - coalesce(ou.business_day_cutoff, time '00:00'))::date$p$;
  r    record;
  v1   evidence.snapshot_template;
  q    text;
  k    integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('inventory.shortfall',         p_o, 1, 0), ('inventory.expiry_risk',      p_ou, 1, 0),
      ('purchasing.deal_inputs',      p_o, 1, 7), ('forecast.slot_profile',      p_ou, 2, 0),
      ('people.advances_open',        p_o, 1, 0), ('compliance.energy_per_order', p_o, 1, 0),
      ('market.signal_uplift',        p_o, 1, 0), ('market.upcoming',            p_o, 1, 0),
      ('market.competitor_gap',       p_o, 1, 0), ('market.goal_progress',       p_g, 1, 0),
      ('market.goal_baseline',        p_o, 1, 0),
      -- 0019 (M-C1a): "now" is the server's current_date (not the outlet's business date — kept as v1 has it at NULL).
      ('catalogue.cost_drift',        p_o, 0, 6), ('catalogue.recipe_current',   p_o, 0, 3)) AS x (id, pat, n_today, n_current_date)
  LOOP
    SELECT * INTO v1 FROM evidence.snapshot_template WHERE id = r.id AND version = 1;
    k := (length(v1.sql) - length(replace(v1.sql, r.pat, ''))) / length(r.pat);
    IF k <> r.n_today OR (length(v1.sql) - length(replace(v1.sql, 'current_date', ''))) / 12 <> r.n_current_date THEN
      RAISE EXCEPTION '0022: % v1 reads today % time(s) and current_date % time(s), expected % and %', r.id, k,
        (length(v1.sql) - length(replace(v1.sql, 'current_date', ''))) / 12, r.n_today, r.n_current_date;
    END IF;
    q := replace(v1.sql, r.pat, 'coalesce(:as_of::date, ' || r.pat || ')');
    q := replace(q, 'current_date', 'coalesce(:as_of::date, current_date)');
    INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
    VALUES (r.id, 2, q,
            jsonb_set(jsonb_set(v1.params_schema, '{required}', (v1.params_schema -> 'required') || '["as_of"]'),
                      '{properties,as_of}', '{"type": ["string", "null"], "format": "date"}'),
            v1.columns, v1.min_role);
  END LOOP;
END $$;

-- inventory.dead_stock compared a timestamp with now() − :days; v2 anchors at the end of the as_of business day at each
-- outlet ((as_of + 1) + cutoff, outlet-local), else now(). bool_and over outlets with stock = v1's "max(last sold) is
-- NULL or before the anchor" when every outlet shares the anchor (as_of NULL: now()).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
SELECT 'inventory.dead_stock', 2,
  $q$WITH oh AS (
  SELECT m.outlet_id, m.ingredient_id, sum(m.qty_milli) AS qty,
         max(m.at) FILTER (WHERE m.kind = 'sale_consumption') AS last_sold,
         (SELECT r.unit_cost_per_1000_minor FROM core.stock_movement r
           WHERE r.outlet_id = m.outlet_id AND r.ingredient_id = m.ingredient_id AND r.kind = 'receipt' AND r.unit_cost_per_1000_minor IS NOT NULL
           ORDER BY r.at DESC, r.id DESC LIMIT 1) AS per1000
    FROM core.stock_movement m
   WHERE :outlet_id::uuid IS NULL OR m.outlet_id = :outlet_id::uuid
   GROUP BY m.outlet_id, m.ingredient_id),
an AS (
  SELECT o.id, coalesce(((:as_of::date + 1) + o.business_day_cutoff) AT TIME ZONE o.tz, now()) AS at FROM core.outlet o)
SELECT oh.ingredient_id, sum(oh.qty)::bigint AS on_hand_qty_milli, round(sum(oh.qty * oh.per1000 / 1000000.0))::bigint AS value_minor,
       max(oh.last_sold) AS last_sold_at
  FROM oh JOIN an ON an.id = oh.outlet_id
 WHERE oh.qty > 0
 GROUP BY oh.ingredient_id
HAVING bool_and(oh.last_sold IS NULL OR oh.last_sold < an.at - make_interval(days => :days::int))
 ORDER BY oh.ingredient_id$q$,
  jsonb_set(jsonb_set(params_schema, '{required}', (params_schema -> 'required') || '["as_of"]'),
            '{properties,as_of}', '{"type": ["string", "null"], "format": "date"}'),
  columns, min_role
  FROM evidence.snapshot_template WHERE id = 'inventory.dead_stock' AND version = 1;

-- A2 — columns the pack lanes asked for (orchestrator, 11 Oct: b-45 Inventory & Purchasing, b-47 Menu & Pricing + Market),
-- folded into the same version 2 where one is cut above (one new version per template, never two), appended after the pack
-- columns so every v1 column keeps its name and place — except market.upcoming, whose forecast_orders is renamed
-- forecast_units in v2 (it sums forecast item units, not orders; v1 keeps the pack's name). Each edit is a text edit of the
-- SQL anchored on a phrase that occurs exactly once (asserted). No new numeric column: ids and text only.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      -- inventory.expiry_risk (b-45): the batch's ingredient, its base unit, and the supplier of the latest receipt into
      -- the batch (else the latest GRN receipt of the ingredient at the outlet — a transferred batch); NULL without one.
      ('inventory.expiry_risk',
       $o$       round(greatest(u.remaining - round(u.fefo_use), 0) * u.per1000 / 1000000.0)::bigint AS at_risk_minor
  FROM u
$o$,
       $n$       round(greatest(u.remaining - round(u.fefo_use), 0) * u.per1000 / 1000000.0)::bigint AS at_risk_minor,
       u.ingredient_id, g.base_unit AS unit,
       (SELECT gr.supplier_id FROM core.stock_movement r
          JOIN core.goods_received gr ON gr.tenant_id = r.tenant_id AND gr.id = r.ref_id
         WHERE r.tenant_id = u.tenant_id AND r.kind = 'receipt' AND r.ref_type = 'core.goods_received'
           AND (r.batch_id = u.id OR (r.outlet_id = u.outlet_id AND r.ingredient_id = u.ingredient_id))
         ORDER BY (r.batch_id = u.id) IS TRUE DESC, r.at DESC, r.id DESC LIMIT 1) AS supplier_id
  FROM u JOIN core.ingredient g ON g.tenant_id = u.tenant_id AND g.id = u.ingredient_id
$n$),
      -- catalogue.cost_drift (b-47): the pr row's own price id, channel kind and tax class (price_id = the §4 dedupe suffix).
      ('catalogue.cost_drift',
       $o$  SELECT DISTINCT ON (p.item_id) p.item_id, p.amount_minor, p.valid_from
$o$,
       $n$  SELECT DISTINCT ON (p.item_id) p.item_id, p.amount_minor, p.valid_from, p.id AS price_id, p.channel_kind, p.tax_class
$n$),
      ('catalogue.cost_drift',
       $o$  SELECT pr.item_id, pr.amount_minor,
$o$,
       $n$  SELECT pr.item_id, pr.amount_minor, pr.price_id, pr.channel_kind, pr.tax_class,
$n$),
      ('catalogue.cost_drift',
       $o$END::bigint AS cost_drift_minor
  FROM x
$o$,
       $n$END::bigint AS cost_drift_minor,
       x.price_id, x.channel_kind, x.tax_class
  FROM x
$n$),
      -- catalogue.recipe_current (b-47): each line's own unit.
      ('catalogue.recipe_current',
       $o$       coalesce(ow.bp, 0)::bigint AS observed_waste_bp
  FROM rv
$o$,
       $n$       coalesce(ow.bp, 0)::bigint AS observed_waste_bp, rl.unit
  FROM rv
$n$),
      -- market.upcoming (b-47): the column is forecast units.
      ('market.upcoming', 'round(x.units)::bigint AS forecast_orders', 'round(x.units)::bigint AS forecast_units')
    ) AS x (id, old, new)
  LOOP
    IF (SELECT (length(sql) - length(replace(sql, r.old, ''))) / length(r.old) FROM evidence.snapshot_template WHERE id = r.id AND version = 2) <> 1 THEN
      RAISE EXCEPTION '0022: % v2 does not contain the A2 anchor exactly once: %', r.id, left(r.old, 60);
    END IF;
    UPDATE evidence.snapshot_template SET sql = replace(sql, r.old, r.new) WHERE id = r.id AND version = 2;
  END LOOP;
  UPDATE evidence.snapshot_template SET columns = columns || '[{"name": "ingredient_id", "type": "uuid"}, {"name": "unit", "type": "text"}, {"name": "supplier_id", "type": "uuid"}]'
   WHERE id = 'inventory.expiry_risk' AND version = 2;
  UPDATE evidence.snapshot_template SET columns = columns || '[{"name": "price_id", "type": "uuid"}, {"name": "channel_kind", "type": "text"}, {"name": "tax_class", "type": "text"}]'
   WHERE id = 'catalogue.cost_drift' AND version = 2;
  UPDATE evidence.snapshot_template SET columns = columns || '[{"name": "unit", "type": "text"}]'
   WHERE id = 'catalogue.recipe_current' AND version = 2;
  UPDATE evidence.snapshot_template
     SET columns = (SELECT jsonb_agg(CASE WHEN c ->> 'name' = 'forecast_orders' THEN jsonb_set(c, '{name}', '"forecast_units"') ELSE c END ORDER BY k)
                      FROM jsonb_array_elements(columns) WITH ORDINALITY e(c, k))
   WHERE id = 'market.upcoming' AND version = 2;
END $$;

-- catalogue.dish_margin v2 (b-47; it has a date window, so no as_of): the item's current price in scope on :to — counter
-- first, then the highest, cost_drift's pr rule — as price_id, channel_kind, tax_class, appended after the pack columns.
DO $$
DECLARE
  v1    evidence.snapshot_template;
  a_cte constant text := $o$    FROM sold s LEFT JOIN cost c ON c.item_id = s.item_id)
SELECT m.item_id, m.recipe_version_id,$o$;
  a_end constant text := $o$       m.lines_unpriced::bigint AS lines_unpriced
  FROM m LEFT JOIN rate r ON r.item_id = m.item_id$o$;
BEGIN
  SELECT * INTO v1 FROM evidence.snapshot_template WHERE id = 'catalogue.dish_margin' AND version = 1;
  IF (length(v1.sql) - length(replace(v1.sql, a_cte, ''))) / length(a_cte) <> 1 OR (length(v1.sql) - length(replace(v1.sql, a_end, ''))) / length(a_end) <> 1 THEN
    RAISE EXCEPTION '0022: catalogue.dish_margin v1 is not the 0019 text the v2 edit expects';
  END IF;
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
  VALUES ('catalogue.dish_margin', 2,
          replace(replace(v1.sql, a_cte, $n$    FROM sold s LEFT JOIN cost c ON c.item_id = s.item_id),
cp AS (
  SELECT DISTINCT ON (p.item_id) p.item_id, p.id AS price_id, p.channel_kind, p.tax_class
    FROM core.price p
   WHERE (:outlet_id::uuid IS NULL OR p.outlet_id = :outlet_id::uuid)
     AND p.valid_from <= :to::date AND (p.valid_to IS NULL OR p.valid_to > :to::date)
   ORDER BY p.item_id, p.channel_kind = 'counter' DESC, p.amount_minor DESC, p.id)
SELECT m.item_id, m.recipe_version_id,$n$),
            a_end, $n$       m.lines_unpriced::bigint AS lines_unpriced,
       cp.price_id, cp.channel_kind, cp.tax_class
  FROM m LEFT JOIN rate r ON r.item_id = m.item_id LEFT JOIN cp ON cp.item_id = m.item_id$n$),
          v1.params_schema,
          v1.columns || '[{"name": "price_id", "type": "uuid"}, {"name": "channel_kind", "type": "text"}, {"name": "tax_class", "type": "text"}]',
          v1.min_role);
END $$;

------------------------------------------------------------------------------------------------------------
-- 5. T1 — templates with no pack table, deferred from M-C1a (db/README.md) and requested by a consumer
------------------------------------------------------------------------------------------------------------
-- finance.gst_summary: core-api's FINANCE_TEMPLATES SQL (services/core-api/src/modules/finance/read.ts; T-026's gate
-- finance-month.test.ts runs it against hand values) with the role codes resolved (core-domain finance ROLES: output tax
-- 2100, input tax 1300). min_role advisor, as 0019 moved finance.pnl and finance.gst_check (core-api wrote owner):
-- INFERENCE — the advisor is the read-only finance role (R27).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'finance.gst_summary', 1,
  $q$SELECT coalesce(je.outlet_id::text, 'unassigned') AS key,
       coalesce(-sum(p.amount_minor) FILTER (WHERE a.code IN ('2100')), 0)::bigint AS output_tax_minor,
       coalesce(sum(p.amount_minor) FILTER (WHERE a.code IN ('1300')), 0)::bigint AS input_tax_minor,
       (coalesce(-sum(p.amount_minor) FILTER (WHERE a.code IN ('2100')), 0)
        - coalesce(sum(p.amount_minor) FILTER (WHERE a.code IN ('1300')), 0))::bigint AS net_payable_minor
  FROM core.journal_entry je
  JOIN core.posting p ON p.tenant_id = je.tenant_id AND p.journal_entry_id = je.id
  JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id
 WHERE a.code IN ('2100', '1300')
   AND je.entry_date >= :period_month::date AND je.entry_date < (:period_month::date + interval '1 month')
 GROUP BY 1 ORDER BY 1$q$,
  '{"type": "object", "required": ["period_month"], "additionalProperties": false,
    "properties": {"period_month": {"type": "string", "format": "date"}}}',
  '[{"name": "key", "type": "text"},
    {"name": "output_tax_minor", "type": "integer", "numeric_source": "core.posting.amount_minor"},
    {"name": "input_tax_minor", "type": "integer", "numeric_source": "core.posting.amount_minor"},
    {"name": "net_payable_minor", "type": "integer", "numeric_source": "core.posting.amount_minor"}]',
  'advisor');

-- inventory.count_variance (requested by inventory, services/core-api/src/modules/inventory/read.ts; screen
-- manager-staff-ops M1 "variance value per line and in total"): one row per line of the count — expected, counted,
-- variance = counted − expected — valued at the count outlet's last receipt cost on or before counted_at (pack §2:
-- value = qty_milli × per1000 ÷ 1,000,000, rounded per line); then the Σ row (ids NULL) = Σ of the rounded line values,
-- so the total shown is the sum of the lines shown. Lines are read through their count (outlet scope). Columns are an
-- INFERENCE (no pack table).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'inventory.count_variance', 1,
  $q$WITH c AS (
  SELECT sc.tenant_id, sc.id, sc.outlet_id, sc.counted_at FROM core.stock_count sc WHERE sc.id = :count_id::uuid),
l AS (
  SELECT l.id AS line_id, l.ingredient_id, l.batch_id, l.expected_qty_milli, l.counted_qty_milli,
         l.counted_qty_milli - l.expected_qty_milli AS variance,
         round((l.counted_qty_milli - l.expected_qty_milli)
               * (SELECT r.unit_cost_per_1000_minor FROM core.stock_movement r
                   WHERE r.tenant_id = c.tenant_id AND r.outlet_id = c.outlet_id AND r.ingredient_id = l.ingredient_id
                     AND r.kind = 'receipt' AND r.unit_cost_per_1000_minor IS NOT NULL AND r.at <= c.counted_at
                   ORDER BY r.at DESC, r.id DESC LIMIT 1) / 1000000.0) AS value
    FROM c JOIN core.stock_count_line l ON l.tenant_id = c.tenant_id AND l.stock_count_id = c.id)
SELECT x.line_id, x.ingredient_id, x.batch_id, x.expected_qty_milli, x.counted_qty_milli, x.variance_qty_milli, x.variance_value_minor
  FROM (SELECT l.line_id, l.ingredient_id, l.batch_id, l.expected_qty_milli::bigint AS expected_qty_milli,
               l.counted_qty_milli::bigint AS counted_qty_milli, l.variance::bigint AS variance_qty_milli,
               l.value::bigint AS variance_value_minor, 0 AS k
          FROM l
        UNION ALL
        SELECT NULL, NULL, NULL, NULL, NULL, NULL, sum(l.value)::bigint, 1 FROM l) x
 ORDER BY x.k, x.line_id$q$,
  '{"type": "object", "required": ["count_id"], "additionalProperties": false,
    "properties": {"count_id": {"type": "string", "format": "uuid"}}}',
  '[{"name": "line_id", "type": "uuid"},
    {"name": "ingredient_id", "type": "uuid"},
    {"name": "batch_id", "type": "uuid"},
    {"name": "expected_qty_milli", "type": "integer", "numeric_source": "core.stock_count_line.expected_qty_milli"},
    {"name": "counted_qty_milli", "type": "integer", "numeric_source": "core.stock_count_line.counted_qty_milli"},
    {"name": "variance_qty_milli", "type": "integer", "numeric_source": ["core.stock_count_line.counted_qty_milli", "core.stock_count_line.expected_qty_milli"]},
    {"name": "variance_value_minor", "type": "integer", "numeric_source": ["core.stock_count_line.counted_qty_milli", "core.stock_count_line.expected_qty_milli",
       "core.stock_movement.unit_cost_per_1000_minor"]}]',
  'manager');

-- List templates the pack lanes' detectors enumerate from (orchestrator, 11 Oct; columns as requested, no pack table).
-- purchasing.invoices (b-45): the invoices dated :from … :to that are not void — the ids a detector feeds to invoice_vs_po
-- and invoice_duplicates. Tenant-level (an invoice carries no outlet, as invoice_vs_po).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'purchasing.invoices', 1,
  $q$SELECT i.id AS supplier_invoice_id, i.supplier_id, i.invoice_date, i.total_minor::bigint AS total_minor, i.currency::text AS currency
  FROM core.supplier_invoice i
 WHERE i.status <> 'void' AND i.invoice_date >= :from::date AND i.invoice_date <= :to::date
 ORDER BY i.invoice_date, i.id$q$,
  '{"type": "object", "required": ["from", "to"], "additionalProperties": false,
    "properties": {"from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
  '[{"name": "supplier_invoice_id", "type": "uuid"},
    {"name": "supplier_id", "type": "uuid"},
    {"name": "invoice_date", "type": "date"},
    {"name": "total_minor", "type": "integer", "numeric_source": "core.supplier_invoice.total_minor"},
    {"name": "currency", "type": "text"}]',
  'manager');

-- inventory.counts (b-45): the submitted counts whose business date (the outlet's zone and cutoff) lies in :from … :to, in
-- the minter's outlet scope (core.stock_count's own outlet RLS); outlet_id NULL = every outlet in scope. Feeds shrinkage.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'inventory.counts', 1,
  $q$SELECT sc.id AS count_id, sc.outlet_id, sc.counted_at
  FROM core.stock_count sc JOIN core.outlet o ON o.tenant_id = sc.tenant_id AND o.id = sc.outlet_id
 WHERE sc.status = 'submitted' AND (:outlet_id::uuid IS NULL OR sc.outlet_id = :outlet_id::uuid)
   AND ((sc.counted_at AT TIME ZONE o.tz) - o.business_day_cutoff)::date BETWEEN :from::date AND :to::date
 ORDER BY sc.counted_at, sc.id$q$,
  '{"type": "object", "required": ["outlet_id", "from", "to"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "from": {"type": "string", "format": "date"},
                   "to": {"type": "string", "format": "date"}}}',
  '[{"name": "count_id", "type": "uuid"}, {"name": "outlet_id", "type": "uuid"}, {"name": "counted_at", "type": "timestamptz"}]',
  'manager');

-- market.goals (b-47): the active goals in the minter's scope (core.goal's outlet RLS: an outlet's goals, and tenant-wide
-- ones for every member); outlet_id narrows to that outlet's own goals, NULL lists all (tenant-wide included) —
-- INFERENCE: a tenant-wide goal is no one outlet's. period_start / period_end = period_from / due_on.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'market.goals', 1,
  $q$SELECT g.id AS goal_id, g.outlet_id, g.metric, g.period_from AS period_start, g.due_on AS period_end
  FROM core.goal g
 WHERE g.status = 'active' AND (:outlet_id::uuid IS NULL OR g.outlet_id = :outlet_id::uuid)
 ORDER BY g.period_from, g.id$q$,
  '{"type": "object", "required": ["outlet_id"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}}}',
  '[{"name": "goal_id", "type": "uuid"}, {"name": "outlet_id", "type": "uuid"}, {"name": "metric", "type": "text"},
    {"name": "period_start", "type": "date"}, {"name": "period_end", "type": "date"}]',
  'manager');

------------------------------------------------------------------------------------------------------------
-- 6. Post-conditions (positive: each reads back as written)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
  src text;
BEGIN
  -- G1: every rule row bound (the column is NOT NULL and CHECKed), and the count of rows is the derivation-rules.json count (54).
  IF (SELECT count(*) FROM core.derivation_rule WHERE binding IS NOT NULL) <> 54
     OR EXISTS (SELECT 1 FROM core.derivation_rule WHERE binding IS NULL)
     OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'core.derivation_rule'::regclass AND attname = 'binding' AND attnotnull)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'core.derivation_rule'::regclass AND conname = 'derivation_rule_binding_check'
                       AND contype = 'c' AND convalidated) THEN
    RAISE EXCEPTION '0022: derivation rules not all bound (% rows, % bound)',
      (SELECT count(*) FROM core.derivation_rule), (SELECT count(*) FROM core.derivation_rule WHERE binding IS NOT NULL);
  END IF;
  -- Who reads and writes the rules (the 0003 / 0015 table grants, which the new column inherits — read, not assumed): the
  -- guard runs as the writer, so every book writer reads `binding`; nobody but the owner (migrations) writes a rule.
  IF NOT (has_column_privilege('munim_core', 'core.derivation_rule', 'binding', 'SELECT')
          AND has_column_privilege('munim_svc', 'core.derivation_rule', 'binding', 'SELECT')
          AND has_column_privilege('munim_crosstenant', 'core.derivation_rule', 'binding', 'SELECT'))
     OR has_column_privilege('munim_intel_ro', 'core.derivation_rule', 'binding', 'SELECT')
     OR has_column_privilege('public', 'core.derivation_rule', 'binding', 'SELECT')
     OR EXISTS (SELECT 1 FROM unnest(ARRAY['public', 'munim_core', 'munim_svc', 'munim_crosstenant', 'munim_platform', 'munim_intel_ro']) r(role)
                 WHERE has_table_privilege(r.role, 'core.derivation_rule', 'INSERT, UPDATE, DELETE, TRUNCATE')) THEN
    RAISE EXCEPTION '0022: core.derivation_rule privileges are not read-only for the runtime roles';
  END IF;
  SELECT string_agg(rule_id || ':' || target_table, ', ') INTO bad FROM core.derivation_rule
   WHERE target_table = 'core.journal_entry' AND position('n.posting_rule = ' || quote_literal(rule_id) IN binding) = 0;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0022: journal entry bindings do not name their rule: %', bad; END IF;

  -- The guard reads the binding in branch (3) and still keeps the creation origin on UPDATE (0017 O1).
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'core.guard_book_write()'::regprocedure;
  IF position('dr.binding INTO rule_src, rule_state, rule_bind' IN src) = 0
     OR position('INTO src_found, src_bound USING NEW.tenant_id, src_id::uuid, new_j, old_j' IN src) = 0
     OR position($p$ELSE jsonb_build_object('kind', 'derivation', 'rule_id', s_rule, 'source_ref', s_source) END;$p$ IN src) = 0 THEN
    RAISE EXCEPTION '0022: core.guard_book_write() is not the 0022 guard';
  END IF;

  IF (SELECT array_agg(a.attname::text ORDER BY k.n) FROM pg_index i
        CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY k(attnum, n)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       WHERE i.indexrelid = 'core.stock_movement_ref_idx'::regclass AND i.indrelid = 'core.stock_movement'::regclass)
     IS DISTINCT FROM ARRAY['tenant_id', 'ref_type', 'ref_id'] THEN
    RAISE EXCEPTION '0022: core.stock_movement_ref_idx is not (tenant_id, ref_type, ref_id)';
  END IF;

  -- S1: the F8 source CHECK, exactly.
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'core.draft'::regclass AND conname = 'draft_source_f8'
         AND contype = 'c' AND convalidated)
     IS DISTINCT FROM $d$CHECK ((source = ANY (ARRAY['import'::text, 'member'::text, 'intel:catalogue'::text, 'intel:kitchen'::text, 'intel:inventory_purchasing'::text, 'intel:finance'::text, 'intel:people'::text, 'intel:customers'::text, 'intel:compliance'::text, 'intel:market'::text])))$d$ THEN
    RAISE EXCEPTION '0022: core.draft draft_source_f8 is not the F8 list';
  END IF;

  -- A1 + A2: exactly these 15 templates have a version 2 — the 14 with a nullable as_of (dish_margin has none) — with
  -- v1's role, and v1's columns (market.upcoming: forecast_orders renamed forecast_units) plus the A2 ones appended;
  -- and no template's latest version reads the clock except as the as_of fallback.
  SELECT string_agg(coalesce(v.id, t.id), ', ') INTO bad
    FROM (VALUES ('inventory.shortfall', true, '[]'::jsonb), ('inventory.dead_stock', true, '[]'), ('purchasing.deal_inputs', true, '[]'),
                 ('forecast.slot_profile', true, '[]'), ('people.advances_open', true, '[]'), ('compliance.energy_per_order', true, '[]'),
                 ('market.signal_uplift', true, '[]'), ('market.upcoming', true, '[]'), ('market.competitor_gap', true, '[]'),
                 ('market.goal_progress', true, '[]'), ('market.goal_baseline', true, '[]'),
                 ('inventory.expiry_risk', true, '[{"name": "ingredient_id", "type": "uuid"}, {"name": "unit", "type": "text"}, {"name": "supplier_id", "type": "uuid"}]'),
                 ('catalogue.cost_drift', true, '[{"name": "price_id", "type": "uuid"}, {"name": "channel_kind", "type": "text"}, {"name": "tax_class", "type": "text"}]'),
                 ('catalogue.recipe_current', true, '[{"name": "unit", "type": "text"}]'),
                 ('catalogue.dish_margin', false, '[{"name": "price_id", "type": "uuid"}, {"name": "channel_kind", "type": "text"}, {"name": "tax_class", "type": "text"}]')
         ) v(id, as_of, extra)
    FULL JOIN (SELECT t2.* FROM evidence.snapshot_template t2 WHERE t2.version = 2) t ON t.id = v.id
    LEFT JOIN evidence.snapshot_template t1 ON t1.id = v.id AND t1.version = 1
   WHERE t.id IS NULL OR v.id IS NULL OR t1.id IS NULL
      OR t.columns IS DISTINCT FROM (CASE WHEN v.id = 'market.upcoming'
                                          THEN replace(t1.columns::text, '"forecast_orders"', '"forecast_units"')::jsonb ELSE t1.columns END) || v.extra
      OR t.min_role IS DISTINCT FROM t1.min_role
      OR (t.params_schema -> 'required') ? 'as_of' IS DISTINCT FROM v.as_of
      OR (v.as_of AND (t.params_schema #> '{properties,as_of}' IS DISTINCT FROM '{"type": ["string", "null"], "format": "date"}'::jsonb
                       OR position(':as_of::date' IN t.sql) = 0))
      OR (NOT v.as_of AND t.params_schema IS DISTINCT FROM t1.params_schema);
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0022: version-2 templates not as written: %', bad; END IF;
  SELECT string_agg(t.id || ' v' || t.version, ', ') INTO bad
    FROM evidence.snapshot_template t
   WHERE t.version = (SELECT max(x.version) FROM evidence.snapshot_template x WHERE x.id = t.id)
     AND regexp_replace(t.sql,
           'coalesce\(:as_of::date, (\(\(now\(\) AT TIME ZONE [a-z]+\.tz\) - [a-z]+\.business_day_cutoff\)::date|\(\(now\(\) AT TIME ZONE coalesce\(ou\.tz, t\.home_tz, ''UTC''\)\) - coalesce\(ou\.business_day_cutoff, time ''00:00''\)\)::date|current_date)\)'
           || '|coalesce\(\(\(:as_of::date \+ 1\) \+ o\.business_day_cutoff\) AT TIME ZONE o\.tz, now\(\)\)', '', 'g')
         ~* '(now\(|current_date|current_timestamp|localtimestamp|clock_timestamp|transaction_timestamp|statement_timestamp)';
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0022: templates still reading the wall clock outside as_of: %', bad; END IF;

  -- T1: the five non-pack templates, at their roles.
  IF (SELECT array_agg(id || ':' || version || ':' || min_role ORDER BY id) FROM evidence.snapshot_template
       WHERE id IN ('finance.gst_summary', 'inventory.count_variance', 'purchasing.invoices', 'inventory.counts', 'market.goals'))
     IS DISTINCT FROM ARRAY['finance.gst_summary:1:advisor', 'inventory.count_variance:1:manager', 'inventory.counts:1:manager',
                            'market.goals:1:manager', 'purchasing.invoices:1:manager'] THEN
    RAISE EXCEPTION '0022: the non-pack templates are not as written';
  END IF;

  PERFORM munim_meta.assert_catalog('0022');
END $$;
