-- 0015_w2_fix — W2 fix list Batch A (docs/plan/W2-FIX-LIST.md, rulings W2-R1..R9), fix forward over 0001–0014.
-- Runs as munim_migrator. Items:
--   A1  Draft-only commands. customers.campaign.create.v1 was refused as an own command by a trigger reading the
--       origin the guard stamped (0011 campaign_from_decision). origin is creation provenance and an UPDATE keeps
--       it (0014 F3), so that test cannot see an own-command UPDATE. The same rule — "only an approved decision"
--       — now sits in the guard's own-command branch, keyed by core.command_authority.draft_only: an own command of
--       a draft-only type is refused with MB001 on INSERT and UPDATE alike; its approved draft (branch 2) is not
--       affected. Draft-only: customers.campaign.create.v1, imports.run.commit.v1 (R28), imports.format.approve.v1
--       (R28), finance.journal.adjust.v1 (packs/finance.md §6, no direct route). The 0011 campaign trigger stays.
--   A2  finance.post_settlement: the settlement must come from a committed import run (import_run_id NOT NULL).
--   A3  Outlet RLS on licence, checklist, asset, goal, task (outlet_id; NULL = tenant-wide) and amc, maintenance
--       (through their asset).
--   A4  Seeded command_authority rows (onboarding, member bind/role/deactivate, GRN receive, storefront cancel/
--       reschedule, order advance/accept/reject, payroll status).
--   A5  W2-R3 refund caps per role: command_authority.role_caps (role → max minor units; absent = uncapped).
--   A6  Derivations: W2-R6 stock reversal; loyalty reversal for refunds of completed orders; supplier invoice and
--       payroll reversal rules; advance posting; transfer_in writes core.batch; a transfer is received under the
--       destination outlet's scope (command_authority.outlet_column).
--   A7  imports.run.commit.v1 writes core.order + core.tender (POS exports); an imported order keeps its bill's
--       business date and takes no invoice number; import_run.failure_reason; expense.import_run_id/external_ref.
--   A8  order_line money columns change only under orders.reprice; coupon edits; erasure reaches reservation,
--       bulk_order and order_line notes; an invoice dispute moves the invoice to disputed; a void moves the order.
--   A9  W2-R4 loyalty policy columns; one earn per order; one break per (settlement line, kind);
--       prep_list_line.done_at; option_ingredient_delta.active; tender.shift_id; customer.merged_into.
--   A10 core.customer_claim_verified_email_guests() (R41, T-035): SECURITY DEFINER owned by munim_crosstenant,
--       EXECUTE munim_core only. Writes through an allow-listed derivation whose source is the caller's own
--       verified profile and which holds only inside this function (current_user = munim_crosstenant).
--   A11 platform.model_role defaults (ADR-010 ids, UNVERIFIED until the live probe); template platform.spend_by_tenant.
-- New SQLSTATEs: none.

------------------------------------------------------------------------------------------------------------
-- 1. command_authority: draft_only (A1), role_caps (A5), outlet_column (A6)
------------------------------------------------------------------------------------------------------------
-- Three new columns on an operational, migration-written table. Privileges: the existing table-level SELECT of
-- munim_core and munim_svc (0003) covers them; nobody holds INSERT/UPDATE (asserted below).
ALTER TABLE core.command_authority
  ADD COLUMN draft_only boolean NOT NULL DEFAULT false,
  ADD COLUMN role_caps jsonb NOT NULL DEFAULT '{}'
    CONSTRAINT command_authority_role_caps_shape CHECK (
      jsonb_typeof(role_caps) = 'object'
      AND NOT jsonb_path_exists(role_caps, '$.* ? (@.type() != "number" || @ < 0 || @ != @.floor())')
      AND NOT jsonb_path_exists(role_caps, '$.keyvalue() ? (!(@.key like_regex "^(owner|manager|staff|advisor|customer|operator|judge)$"))')),
  -- When set, the own-command branch checks the caller's outlet scope against this column of the row instead of
  -- core.book_scope (a transfer is received under its destination outlet only).
  ADD COLUMN outlet_column text CONSTRAINT command_authority_outlet_column_check CHECK (outlet_column ~ '^[a-z_]+$');
REVOKE ALL (draft_only, role_caps, outlet_column) ON core.command_authority FROM PUBLIC;

UPDATE core.command_authority SET draft_only = true
 WHERE command_type IN ('customers.campaign.create.v1', 'imports.run.commit.v1', 'imports.format.approve.v1',
                        'finance.journal.adjust.v1');

-- W2-R3: staff may record refunds up to a cap; managers higher; owner and judge uncapped (INFERENCE: amounts).
UPDATE core.command_authority
   SET allowed_roles = ARRAY['owner', 'manager', 'staff', 'judge'], role_caps = '{"staff": 50000, "manager": 500000}'
 WHERE command_type = 'orders.refund.record.v1';

UPDATE core.command_authority SET outlet_column = 'to_outlet_id' WHERE command_type = 'inventory.transfer.receive.v1';

------------------------------------------------------------------------------------------------------------
-- 2. A4 — seeded commands (names from W2-FIX-LIST A4; shapes as the T-020/T-025/T-032 test shims, checked)
------------------------------------------------------------------------------------------------------------
INSERT INTO core.command_authority (command_type, allowed_roles, scope, target_tables, customer_target_tables) VALUES
  ('tenancy.onboard.v1',             ARRAY['owner'],                                         'tenant',
                                     ARRAY['core.tenant', 'core.member', 'core.membership', 'core.outlet', 'core.outlet_calendar',
                                           'core.brand', 'core.channel', 'core.business_policy', 'core.account'], '{}'),
  ('tenancy.member.bind.v1',         ARRAY['owner', 'manager', 'staff', 'advisor', 'judge'], 'outlet', ARRAY['core.member'], '{}'),
  ('tenancy.member.role.set.v1',     ARRAY['owner'],                                         'tenant', ARRAY['core.membership'], '{}'),
  ('tenancy.member.deactivate.v1',   ARRAY['owner'],                                         'tenant', ARRAY['core.member', 'core.membership'], '{}'),
  ('purchasing.grn.receive.v1',      ARRAY['owner', 'manager', 'staff', 'judge'],            'outlet',
                                     ARRAY['core.goods_received', 'core.grn_line', 'core.batch', 'core.purchase_order'], '{}'),
  ('storefront.order.cancel.v1',     ARRAY['customer'],                                      'own_order',
                                     ARRAY['core.order', 'core.order_event'], ARRAY['core.order', 'core.order_event']),
  ('storefront.order.reschedule.v1', ARRAY['customer'],                                      'own_order',
                                     ARRAY['core.order', 'core.order_event'], ARRAY['core.order', 'core.order_event']),
  ('orders.order.advance.v1',        ARRAY['owner', 'manager', 'staff', 'judge'],            'outlet', ARRAY['core.order', 'core.order_event'], '{}'),
  ('orders.order.accept.v1',         ARRAY['owner', 'manager', 'staff', 'judge'],            'outlet', ARRAY['core.order', 'core.order_event'], '{}'),
  ('orders.order.reject.v1',         ARRAY['owner', 'manager', 'staff', 'judge'],            'outlet', ARRAY['core.order', 'core.order_event'], '{}'),
  ('people.payroll_draft.status.v1', ARRAY['owner'],                                         'outlet', ARRAY['core.payroll_draft'], '{}');

-- A7: a POS-export import commits bills as orders and their tenders.
UPDATE core.command_authority SET target_tables = target_tables || ARRAY['core.order', 'core.tender']
 WHERE command_type = 'imports.run.commit.v1';
-- A8: a void may move the order's status; an invoice dispute moves the invoice to disputed; erasure anonymises
-- the notes a customer left on reservations, bulk orders and order lines.
UPDATE core.command_authority SET target_tables = target_tables || ARRAY['core.order']
 WHERE command_type = 'orders.void.record.v1';
UPDATE core.command_authority SET target_tables = target_tables || ARRAY['core.supplier_invoice']
 WHERE command_type = 'purchasing.invoice.dispute.v1';
UPDATE core.command_authority
   SET target_tables = target_tables || ARRAY['core.reservation', 'core.bulk_order', 'core.order_line'],
       customer_target_tables = customer_target_tables || ARRAY['core.reservation', 'core.bulk_order', 'core.order_line']
 WHERE command_type = 'customers.erasure.request.v1';

------------------------------------------------------------------------------------------------------------
-- 3. Derivation rules (A2, A6, A8, A10). db/derivation-rules.json lists every row (gate: DB = file).
------------------------------------------------------------------------------------------------------------
-- Rows as (rule, source, target) triples, then each rule's source state (the 0014 form; packages/core-domain's
-- rule-parity test reads these triples from the migration files).
INSERT INTO core.derivation_rule (rule_id, source_table, target_table) VALUES
  -- W2-R6: a cancelled or rejected order gives its consumed stock back.
  ('inventory.reverse_order_consumption', 'core.order',            'core.stock_movement'),
  -- A received transfer creates the destination batch (expiry carried from the source batch).
  ('inventory.transfer_in',               'core.transfer',         'core.batch'),
  -- An approved invoice that is disputed or voided, and an approved payroll that is voided, reverse their entries.
  -- A later re-approval re-posts as the reversal of that reversal (reverses_id = the reversal's id), which neither
  -- journal_entry_one_reversal nor journal_entry_one_per_source_rule blocks.
  ('finance.reverse_supplier_invoice',    'core.supplier_invoice', 'core.journal_entry'),
  ('finance.reverse_supplier_invoice',    'core.supplier_invoice', 'core.posting'),
  ('finance.reverse_payroll',             'core.payroll_draft',    'core.journal_entry'),
  ('finance.reverse_payroll',             'core.payroll_draft',    'core.posting'),
  ('finance.post_advance',                'core.advance',          'core.journal_entry'),
  ('finance.post_advance',                'core.advance',          'core.posting'),
  -- Re-pricing an order (push-back, reschedule) keeps its lines equal to the header.
  ('orders.reprice',                      'core.order',            'core.order_line'),
  -- R41 verified-email merge (A10), see its source state below.
  ('customers.merge_verified_email',      'core.customer',         'core.order'),
  ('customers.merge_verified_email',      'core.customer',         'core.reservation'),
  ('customers.merge_verified_email',      'core.customer',         'core.bulk_order'),
  ('customers.merge_verified_email',      'core.customer',         'core.customer');

-- Every row of a rule carries the same state (transfer_in and reprice keep the state 0014 gave them).
UPDATE core.derivation_rule SET source_state = p.state
  FROM (VALUES
    ('inventory.reverse_order_consumption', $s$s.status IN ('cancelled', 'rejected')$s$),
    ('inventory.transfer_in',               $s$s.status = 'received'$s$),
    ('finance.reverse_supplier_invoice',    $s$s.status IN ('disputed', 'void')$s$),
    ('finance.reverse_payroll',             $s$s.status = 'void'$s$),
    ('finance.post_advance',                'true'),
    ('orders.reprice',                      $s$s.status IN ('placed', 'accepted')$s$),
    -- The source is the caller's own verified, live, signed-in profile, and the rule holds only inside
    -- core.customer_claim_verified_email_guests() (the only code that runs as munim_crosstenant and writes these
    -- tables) — a request that merely sets app.posting_rule gets nothing from it.
    ('customers.merge_verified_email',
     $s$s.id = nullif(current_setting('app.customer_id', true), '')::uuid AND NOT s.is_guest AND s.erased_at IS NULL AND s.email_verified_at IS NOT NULL AND current_user = 'munim_crosstenant'$s$)
  ) AS p (rule_id, state)
 WHERE core.derivation_rule.rule_id = p.rule_id;

-- A2: a settlement posts only from a committed import run (a NULL run no longer passes).
UPDATE core.derivation_rule
   SET source_state = $s$s.import_run_id IS NOT NULL AND EXISTS (SELECT 1 FROM core.import_run r WHERE r.tenant_id = s.tenant_id AND r.id = s.import_run_id AND r.status = 'committed')$s$
 WHERE rule_id = 'finance.post_settlement';
-- A6: loyalty taken back on cancellation/rejection, and on a refund of a completed order.
UPDATE core.derivation_rule
   SET source_state = $s$(s.status IN ('cancelled', 'rejected') OR (s.status = 'completed' AND EXISTS (SELECT 1 FROM core.refund f WHERE f.tenant_id = s.tenant_id AND f.order_id = s.id)))$s$
 WHERE rule_id = 'customers.loyalty_reverse';

------------------------------------------------------------------------------------------------------------
-- 4. The guard, re-issued. Unchanged from 0014 except, in the own-command branch (1):
--    A1: a command with draft_only is refused (MB001) — it runs only as an approved draft (branch 2);
--    A6: a command with outlet_column checks the row's (NEW and OLD) value of that column against app.outlet_ids
--        instead of core.book_scope.
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
  src_id     text;
  src_found  boolean;
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
-- 5. A3 — outlet RLS on the compliance and goal tables
------------------------------------------------------------------------------------------------------------
-- Same predicate as every tenant_outlet_isolation policy since 0014 (shoppers are governed by the restrictive
-- customer_scope / guest_scope policies, which deny these tables), plus: outlet_id NULL = a tenant-wide row,
-- visible to every member of the tenant.
DO $$
DECLARE
  t    text;
  pred constant text := $c$tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.role', true)) IN ('customer', 'guest')
              OR (SELECT current_setting('app.outlet_ids', true)) = '{*}'
              OR outlet_id IS NULL
              OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[]))$c$;
BEGIN
  FOREACH t IN ARRAY ARRAY['licence', 'checklist', 'asset', 'goal', 'task'] LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON core.%I', t);
    EXECUTE format('CREATE POLICY tenant_outlet_isolation ON core.%I USING (%s) WITH CHECK (%s)', t, pred, pred);
  END LOOP;
END $$;

-- An AMC or a maintenance job is visible exactly when its asset is (the subquery runs under asset's policy).
DROP POLICY tenant_isolation ON core.amc;
CREATE POLICY tenant_via_asset ON core.amc
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND EXISTS (SELECT 1 FROM core.asset a WHERE a.tenant_id = amc.tenant_id AND a.id = amc.asset_id))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND EXISTS (SELECT 1 FROM core.asset a WHERE a.tenant_id = amc.tenant_id AND a.id = amc.asset_id));
DROP POLICY tenant_isolation ON core.maintenance;
CREATE POLICY tenant_via_asset ON core.maintenance
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND EXISTS (SELECT 1 FROM core.asset a WHERE a.tenant_id = maintenance.tenant_id AND a.id = maintenance.asset_id))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND EXISTS (SELECT 1 FROM core.asset a WHERE a.tenant_id = maintenance.tenant_id AND a.id = maintenance.asset_id));

------------------------------------------------------------------------------------------------------------
-- 6. A7 — imports
------------------------------------------------------------------------------------------------------------
-- Why a run failed (reason code, never raw parser text), set by the parser (munim_svc) with status 'failed'.
ALTER TABLE core.import_run ADD COLUMN failure_reason text CONSTRAINT import_run_failure_reason_check CHECK (failure_reason ~ '^[a-z][a-z0-9_]*$');
ALTER TABLE core.import_run ADD CONSTRAINT import_run_failure_reason_failed CHECK (failure_reason IS NULL OR status = 'failed');
REVOKE ALL (failure_reason) ON core.import_run FROM PUBLIC;
GRANT UPDATE (failure_reason) ON core.import_run TO munim_svc;

-- An imported expense carries its run and the source voucher reference (re-importing the same voucher → 23505).
ALTER TABLE core.expense ADD COLUMN import_run_id uuid, ADD COLUMN external_ref text
  CONSTRAINT expense_external_ref_check CHECK (length(external_ref) BETWEEN 1 AND 100);
ALTER TABLE core.expense ADD FOREIGN KEY (tenant_id, import_run_id) REFERENCES core.import_run (tenant_id, id);
ALTER TABLE core.expense ADD CONSTRAINT expense_external_ref_unique UNIQUE (tenant_id, external_ref);
CREATE INDEX expense_import_run_id_fk_idx ON core.expense (tenant_id, import_run_id);
REVOKE ALL (import_run_id, external_ref) ON core.expense FROM PUBLIC;

-- Re-issued from 0014: an order inserted under an approved imports.run.commit.v1 draft (a POS export bill) keeps
-- the business date it carries (the bill's, not today's) and never takes a number from the device invoice series
-- (the source POS issued it; external_ref keeps it). Every other order is numbered exactly as before.
CREATE OR REPLACE FUNCTION core.order_assign_numbers() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  outlet_tz    text;
  cutoff       time;
  fy_start     smallint;
  channel_kind text;
  treatment    text;
  imported     boolean;
BEGIN
  SELECT o.tz, o.business_day_cutoff INTO outlet_tz, cutoff FROM core.outlet o WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.outlet_id;
  SELECT t.fy_start_month INTO fy_start FROM core.tenant t WHERE t.tenant_id = NEW.tenant_id;
  IF outlet_tz IS NULL OR fy_start IS NULL THEN
    RAISE EXCEPTION 'order_numbers: outlet % not visible in this context', NEW.outlet_id USING ERRCODE = 'MB001';
  END IF;
  imported := EXISTS (SELECT 1 FROM core.decision d JOIN core.draft r ON r.tenant_id = d.tenant_id AND r.id = d.draft_id
                       WHERE d.tenant_id = NEW.tenant_id AND d.id::text = nullif(current_setting('app.decision_id', true), '')
                         AND d.verdict IN ('approved', 'edited') AND r.command_type = 'imports.run.commit.v1'
                         AND r.status = 'executing' AND r.exec_txid = txid_current());
  IF NOT imported OR NEW.business_date IS NULL THEN
    NEW.business_date := ((now() AT TIME ZONE outlet_tz) - cutoff)::date;
  END IF;

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

  IF NEW.device_id IS NULL OR imported OR treatment = 'operator_collects_excluded' THEN
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

------------------------------------------------------------------------------------------------------------
-- 7. A8 — grants and the order_line pricing freeze
------------------------------------------------------------------------------------------------------------
-- An order line's money is fixed at placement; it changes only under orders.reprice for that line's order (as
-- core."order" since 0014 F3). Its note may be anonymised (customers.erasure.request.v1).
CREATE FUNCTION core.order_line_pricing_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (NEW.unit_price_minor, NEW.line_discount_minor, NEW.tax_minor)
       IS DISTINCT FROM (OLD.unit_price_minor, OLD.line_discount_minor, OLD.tax_minor)
     AND NOT (coalesce(current_setting('app.posting_rule', true), '') = 'orders.reprice'
              AND coalesce(current_setting('app.source_ref', true), '') = 'core.order:' || OLD.order_id::text) THEN
    RAISE EXCEPTION 'book_write_refused: core.order_line — money columns change only under the pricing rule orders.reprice'
      USING ERRCODE = 'MB001';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.order_line_pricing_frozen() FROM PUBLIC;
CREATE TRIGGER pricing_frozen BEFORE UPDATE ON core.order_line FOR EACH ROW EXECUTE FUNCTION core.order_line_pricing_frozen();

GRANT UPDATE (unit_price_minor, line_discount_minor, tax_minor, note) ON core.order_line TO munim_core;
GRANT UPDATE (requires_customer, min_spend_minor, outlet_ids) ON core.coupon TO munim_core;

------------------------------------------------------------------------------------------------------------
-- 8. A9 — columns and indexes
------------------------------------------------------------------------------------------------------------
-- W2-R4: loyalty earn rate (1 point per loyalty_earn_per_minor of net) and point value, per policy version.
-- Privileges: munim_core's table-level INSERT on business_policy (0003) covers them; no UPDATE (a new policy
-- version is a new row).
ALTER TABLE core.business_policy
  ADD COLUMN loyalty_earn_per_minor bigint NOT NULL DEFAULT 1000
    CONSTRAINT business_policy_loyalty_earn_check CHECK (loyalty_earn_per_minor > 0),
  ADD COLUMN loyalty_point_value_minor bigint NOT NULL DEFAULT 10
    CONSTRAINT business_policy_loyalty_value_check CHECK (loyalty_point_value_minor >= 0);
REVOKE ALL (loyalty_earn_per_minor, loyalty_point_value_minor) ON core.business_policy FROM PUBLIC;

CREATE UNIQUE INDEX loyalty_entry_one_earn_per_order ON core.loyalty_entry (tenant_id, order_id) WHERE kind = 'earn';
CREATE UNIQUE INDEX reconciliation_break_one_per_line_kind ON core.reconciliation_break (tenant_id, settlement_line_id, kind);

ALTER TABLE core.prep_list_line ADD COLUMN done_at timestamptz;
REVOKE ALL (done_at) ON core.prep_list_line FROM PUBLIC;
GRANT UPDATE (done_at) ON core.prep_list_line TO munim_core;

ALTER TABLE core.option_ingredient_delta ADD COLUMN active boolean NOT NULL DEFAULT true;
REVOKE ALL (active) ON core.option_ingredient_delta FROM PUBLIC;
GRANT UPDATE (active) ON core.option_ingredient_delta TO munim_core;

-- The till session a tender was taken in (insert-only, like the rest of the tender row).
ALTER TABLE core.tender ADD COLUMN shift_id uuid;
ALTER TABLE core.tender ADD FOREIGN KEY (tenant_id, shift_id) REFERENCES core.shift (tenant_id, id);
CREATE INDEX tender_shift_id_fk_idx ON core.tender (tenant_id, shift_id);
REVOKE ALL (shift_id) ON core.tender FROM PUBLIC;

-- The profile a guest profile was merged into (A10). Set only by core.customer_claim_verified_email_guests().
ALTER TABLE core.customer ADD COLUMN merged_into uuid CONSTRAINT customer_merged_into_other CHECK (merged_into <> id);
ALTER TABLE core.customer ADD FOREIGN KEY (tenant_id, merged_into) REFERENCES core.customer (tenant_id, id);
CREATE INDEX customer_merged_into_fk_idx ON core.customer (tenant_id, merged_into);
REVOKE ALL (merged_into) ON core.customer FROM PUBLIC;

------------------------------------------------------------------------------------------------------------
-- 9. A10 — R41 verified-email merge (T-035)
------------------------------------------------------------------------------------------------------------
-- Called inside the customer's own customers.account.link.v1 (app.role = customer, app.customer_id = the caller).
-- No arguments: the tenant and the caller come only from the request context. If the caller's own profile is
-- signed in (idp_sub), live, not a guest and has a verified email, every live, unmerged guest profile of this
-- tenant with the same email (case-insensitive) hands its orders, reservations and bulk orders to the caller and
-- is marked merged_into = caller. Loyalty rows stay where they are. Returns one row per changed book row, for the
-- caller's audit entries (every row must be audited): each moved order, reservation and bulk order with its previous
-- customer, and each merged guest profile (entity_id = from_customer_id = the guest), ordered by entity, entity_id.
-- Writes pass the book guard through customers.merge_verified_email.
CREATE FUNCTION core.customer_claim_verified_email_guests()
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
    ), g AS (
      UPDATE core.customer x SET merged_into = me WHERE x.tenant_id = t AND x.id = ANY (guests)
      RETURNING x.id
    )
    SELECT u.entity, u.entity_id, u.from_customer_id
      FROM (SELECT 'core.order'::text AS entity, o.id AS entity_id, o.customer_id AS from_customer_id FROM o
            UNION ALL SELECT 'core.reservation', r.id, r.customer_id FROM r
            UNION ALL SELECT 'core.bulk_order', b.id, b.customer_id FROM b
            UNION ALL SELECT 'core.customer', g.id, g.id FROM g) u
     ORDER BY u.entity, u.entity_id;
  PERFORM set_config('app.posting_rule', prev_rule, true), set_config('app.source_ref', prev_src, true);
END $$;

-- What the function (and the triggers it fires, which run as its owner) needs, column by column. munim_crosstenant
-- is NOLOGIN with no members but the migrator; it acts only through its definer functions. UPDATE (home_tz) on
-- core.tenant exists only because core.assert_tenant_currency() reads the tenant FOR SHARE, which needs an UPDATE
-- privilege; the book guard still refuses any tenant write here.
GRANT SELECT (tenant_id, id, email, is_guest, idp_sub, email_verified_at, erased_at, merged_into) ON core.customer TO munim_crosstenant;
GRANT UPDATE (merged_into) ON core.customer TO munim_crosstenant;
GRANT SELECT (tenant_id, id, customer_id), UPDATE (customer_id) ON core."order" TO munim_crosstenant;
GRANT SELECT (tenant_id, id, customer_id), UPDATE (customer_id) ON core.reservation TO munim_crosstenant;
GRANT SELECT (tenant_id, id, customer_id), UPDATE (customer_id) ON core.bulk_order TO munim_crosstenant;
GRANT SELECT ON core.derivation_rule, core.order_status_transition, core.book_status_transition TO munim_crosstenant;
GRANT SELECT (tenant_id, base_currency), UPDATE (home_tz) ON core.tenant TO munim_crosstenant;

GRANT CREATE ON SCHEMA core TO munim_crosstenant;
ALTER FUNCTION core.customer_claim_verified_email_guests() OWNER TO munim_crosstenant;
REVOKE CREATE ON SCHEMA core FROM munim_crosstenant;
REVOKE ALL ON FUNCTION core.customer_claim_verified_email_guests() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.customer_claim_verified_email_guests() TO munim_core;

------------------------------------------------------------------------------------------------------------
-- 10. A11 — model roles and the operator spend template
------------------------------------------------------------------------------------------------------------
-- ADR-010 role → model (UNVERIFIED until the live probe; probed_at stays NULL). An operator's existing choice is
-- kept (DO NOTHING). Never a gemini-2.5 id (CHECK, 0002).
INSERT INTO platform.model_role (role, provider, model_id, location) VALUES
  ('router',  'gemini', 'gemini-3.5-flash-lite', 'global'),
  ('extract', 'gemini', 'gemini-3.5-flash-lite', 'global'),
  ('narrate', 'gemini', 'gemini-3.5-flash-lite', 'global'),
  ('reason',  'gemini', 'gemini-3.8-flash',      'global'),
  ('vision',  'gemini', 'gemini-3.8-flash',      'global'),
  ('embed',   'gemini', 'gemini-embedding-001',  'global')
ON CONFLICT (role) DO NOTHING;

-- Operator-level (min_role operator): one tenant's model spend by month, role, provider and model. Minted by
-- /platform/v1/snapshots under that tenant's context (core-api adds :tenant_id).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'platform.spend_by_tenant', 1,
  $tpl$SELECT date_trunc('month', s.at)::date AS month, s.role, s.provider, s.model_id, s.currency,
       sum(s.amount_minor)::bigint AS amount_minor
  FROM intel.intel_spend s
 WHERE s.tenant_id = :tenant_id::uuid
 GROUP BY 1, 2, 3, 4, 5
 ORDER BY 1, 2, 3, 4, 5$tpl$,
  '{"type": "object", "properties": {}, "additionalProperties": false}',
  '[{"name": "month", "type": "date"},
    {"name": "role", "type": "text"},
    {"name": "provider", "type": "text"},
    {"name": "model_id", "type": "text"},
    {"name": "currency", "type": "text"},
    {"name": "amount_minor", "type": "integer", "numeric_source": "intel.intel_spend.amount_minor"}]',
  'operator');

------------------------------------------------------------------------------------------------------------
-- 11. Catalog post-conditions: assert_catalog re-issued (definer set + the A10 function), then this file's own
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

  -- SECURITY DEFINER functions = exactly the five munim_crosstenant functions; it also owns exactly the view
  -- platform.tenant_registry.
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform', 'intel_ro', 'munim_meta')
     AND (p.prosecdef OR p.proowner = 'munim_crosstenant'::regrole)
     AND NOT (p.prosecdef AND p.proowner = 'munim_crosstenant'::regrole
              AND p.oid IN ('core.outbox_claim(integer, interval, interval)'::regprocedure,
                            'core.active_tenants()'::regprocedure,
                            'core.tenant_for_storefront_key(text)'::regprocedure,
                            'core.memberships_for_sub(text)'::regprocedure,
                            'core.customer_claim_verified_email_guests()'::regprocedure));
  IF n <> 0 THEN RAISE EXCEPTION '%: unexpected SECURITY DEFINER / munim_crosstenant functions: %', migration, n; END IF;
  SELECT count(*) INTO n FROM pg_proc p WHERE p.prosecdef AND p.proowner = 'munim_crosstenant'::regrole;
  IF n <> 5 THEN RAISE EXCEPTION '%: expected 5 munim_crosstenant definer functions, found %', migration, n; END IF;
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
  n   integer;
  bad text;
BEGIN
  -- A1: exactly the four draft-only commands.
  IF (SELECT array_agg(command_type ORDER BY command_type) FROM core.command_authority WHERE draft_only)
     IS DISTINCT FROM ARRAY['customers.campaign.create.v1', 'finance.journal.adjust.v1', 'imports.format.approve.v1', 'imports.run.commit.v1'] THEN
    RAISE EXCEPTION '0015: draft_only set is not as written';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'core.guard_book_write()'::regprocedure
                    AND prosrc LIKE '%IF a_draft THEN%' AND prosrc LIKE '%a_col IS NULL%') THEN
    RAISE EXCEPTION '0015: guard not re-issued as written';
  END IF;
  -- A4/A5/A7/A8: the seeded rows read back as written.
  IF (SELECT count(*) FROM core.command_authority WHERE command_type IN ('tenancy.onboard.v1', 'tenancy.member.bind.v1',
        'tenancy.member.role.set.v1', 'tenancy.member.deactivate.v1', 'purchasing.grn.receive.v1', 'storefront.order.cancel.v1',
        'storefront.order.reschedule.v1', 'orders.order.advance.v1', 'orders.order.accept.v1', 'orders.order.reject.v1',
        'people.payroll_draft.status.v1')) <> 11 THEN
    RAISE EXCEPTION '0015: A4 command rows missing';
  END IF;
  IF (SELECT target_tables FROM core.command_authority WHERE command_type = 'tenancy.onboard.v1')
     IS DISTINCT FROM (SELECT target_tables FROM core.command_authority WHERE command_type = 'tenancy.provision.v1') THEN
    RAISE EXCEPTION '0015: tenancy.onboard.v1 must write exactly what tenancy.provision.v1 writes';
  END IF;
  IF (SELECT role_caps FROM core.command_authority WHERE command_type = 'orders.refund.record.v1') <> '{"staff": 50000, "manager": 500000}'
     OR NOT (SELECT 'staff' = ANY (allowed_roles) FROM core.command_authority WHERE command_type = 'orders.refund.record.v1') THEN
    RAISE EXCEPTION '0015: refund caps not as written';
  END IF;
  IF NOT (SELECT ARRAY['core.order', 'core.tender'] <@ target_tables FROM core.command_authority WHERE command_type = 'imports.run.commit.v1') THEN
    RAISE EXCEPTION '0015: imports.run.commit.v1 not bound to order/tender';
  END IF;
  -- A2: the settlement rule's source state requires a run.
  IF NOT EXISTS (SELECT 1 FROM core.derivation_rule WHERE rule_id = 'finance.post_settlement'
                    AND source_state LIKE 's.import_run_id IS NOT NULL AND %') THEN
    RAISE EXCEPTION '0015: finance.post_settlement source_state not as written';
  END IF;
  -- A3: the seven tables carry the new policies (and not the tenant-only one).
  IF (SELECT count(*) FROM pg_policy p WHERE p.polname = 'tenant_outlet_isolation' AND p.polpermissive
        AND p.polrelid IN ('core.licence'::regclass, 'core.checklist'::regclass, 'core.asset'::regclass, 'core.goal'::regclass, 'core.task'::regclass)
        AND pg_get_expr(p.polqual, p.polrelid) LIKE '%outlet_id IS NULL%') <> 5
     OR (SELECT count(*) FROM pg_policy p WHERE p.polname = 'tenant_via_asset'
        AND p.polrelid IN ('core.amc'::regclass, 'core.maintenance'::regclass)) <> 2
     OR EXISTS (SELECT 1 FROM pg_policy p WHERE p.polname = 'tenant_isolation'
        AND p.polrelid IN ('core.licence'::regclass, 'core.checklist'::regclass, 'core.asset'::regclass, 'core.goal'::regclass,
                           'core.task'::regclass, 'core.amc'::regclass, 'core.maintenance'::regclass)) THEN
    RAISE EXCEPTION '0015: A3 outlet policies not as written';
  END IF;
  -- Indexes as written (gotcha 1).
  SELECT string_agg(v.ix, ', ') INTO bad
    FROM (VALUES ('core.loyalty_entry_one_earn_per_order', 'tenant_id,order_id', true),
                 ('core.reconciliation_break_one_per_line_kind', 'tenant_id,settlement_line_id,kind', true),
                 ('core.expense_external_ref_unique', 'tenant_id,external_ref', true),
                 ('core.expense_import_run_id_fk_idx', 'tenant_id,import_run_id', false),
                 ('core.tender_shift_id_fk_idx', 'tenant_id,shift_id', false),
                 ('core.customer_merged_into_fk_idx', 'tenant_id,merged_into', false)) v(ix, cols, uniq)
   WHERE to_regclass(v.ix) IS NULL
      OR (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
            FROM pg_index i
           CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
            JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
           WHERE i.indexrelid = to_regclass(v.ix)) IS DISTINCT FROM v.cols
      OR (SELECT i.indisunique FROM pg_index i WHERE i.indexrelid = to_regclass(v.ix)) IS DISTINCT FROM v.uniq;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0015: indexes not as written: %', bad; END IF;
  IF (SELECT pg_get_expr(i.indpred, i.indrelid) FROM pg_index i WHERE i.indexrelid = 'core.loyalty_entry_one_earn_per_order'::regclass)
     IS DISTINCT FROM '(kind = ''earn''::text)' THEN
    RAISE EXCEPTION '0015: loyalty_entry_one_earn_per_order predicate not as written';
  END IF;
  -- New columns: exactly the privileges written (positive and negative).
  IF NOT has_column_privilege('munim_svc', 'core.import_run', 'failure_reason', 'UPDATE')
     OR has_column_privilege('munim_core', 'core.import_run', 'failure_reason', 'UPDATE')
     OR NOT has_column_privilege('munim_core', 'core.prep_list_line', 'done_at', 'UPDATE')
     OR NOT has_column_privilege('munim_core', 'core.option_ingredient_delta', 'active', 'UPDATE')
     OR NOT has_column_privilege('munim_core', 'core.order_line', 'tax_minor', 'UPDATE')
     OR has_column_privilege('munim_core', 'core.order_line', 'item_id', 'UPDATE')
     OR has_column_privilege('munim_core', 'core.tender', 'shift_id', 'UPDATE')
     OR has_column_privilege('munim_core', 'core.customer', 'merged_into', 'UPDATE')
     OR NOT has_column_privilege('munim_crosstenant', 'core.customer', 'merged_into', 'UPDATE')
     OR has_column_privilege('munim_core', 'core.expense', 'external_ref', 'UPDATE')
     OR has_column_privilege('munim_svc', 'core.expense', 'import_run_id', 'INSERT')
     OR has_table_privilege('munim_core', 'core.command_authority', 'INSERT,UPDATE')
     OR has_table_privilege('munim_crosstenant', 'core.customer', 'SELECT')
     OR has_column_privilege('munim_crosstenant', 'core.customer', 'name', 'SELECT') THEN
    RAISE EXCEPTION '0015: new column privileges not as written';
  END IF;
  -- A10: owner, definer, EXECUTE munim_core only.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'core.customer_claim_verified_email_guests()'::regprocedure
                    AND p.prosecdef AND p.proowner = 'munim_crosstenant'::regrole
                    AND has_function_privilege('munim_core', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('munim_svc', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('munim_platform', p.oid, 'EXECUTE')
                    AND NOT has_function_privilege('munim_intel_ro', p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION '0015: verified-email merge function not owned/granted as written';
  END IF;
  -- A11.
  SELECT count(*) INTO n FROM platform.model_role WHERE model_id !~* 'gemini-2\.5';
  IF n <> 6 THEN RAISE EXCEPTION '0015: expected 6 model roles, found %', n; END IF;
  IF NOT EXISTS (SELECT 1 FROM evidence.snapshot_template WHERE id = 'platform.spend_by_tenant' AND min_role = 'operator') THEN
    RAISE EXCEPTION '0015: platform.spend_by_tenant missing';
  END IF;
  PERFORM munim_meta.assert_catalog('0015');
END $$;
