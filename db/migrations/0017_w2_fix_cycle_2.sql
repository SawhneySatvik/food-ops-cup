-- 0017_w2_fix_cycle_2 — W2 fix cycle 2, migrator row m-5, fix forward over 0001–0016. Runs as munim_migrator. Items:
--   O1 (sev 1, guarantee)  origin is creation provenance and is never re-stamped. The guard's derivation branch
--            (0014, re-issued 0015) re-stamped NEW.origin on UPDATE, so every reprice, merge and erase overwrote how
--            the row came to be. It now keeps OLD.origin on UPDATE, as the command and decision branches already do.
--            Later changes trace through core.audit_log only (project gotcha 34). No other guard change.
--   P1 (sev 2)  purchasing.invoice.approve.v1 may write core.payable — only to re-open the payable of a disputed
--            invoice it re-approves (disputed → open, nothing else). Any other payable write under approve → MB001.
--   C1 (sev 2, R41 erasure gap)  core.customer_claim_guest_token(): the guest-token claim of
--            customers.account.link.v1, done by the database. It moves the token's order (and that order's coupon
--            uses) to the signed-in caller and, when the guest profile it came from has no orders, reservations or
--            bulk orders left, marks that profile merged_into the caller — so core.customer_erase_merged_guests()
--            erases it with the caller. SECURITY DEFINER, owner munim_crosstenant, EXECUTE munim_core only.
--   R2-S3-7  orders.reprice may change core.coupon_use.discount_minor, for the coupon uses of the re-priced order
--            only (the rule's source order, in its source state). No other column.
-- New SQLSTATEs: none (refusals use MB001).

------------------------------------------------------------------------------------------------------------
-- 1. O1 — the guard, re-issued. Identical to 0015 except the derivation branch (3): on UPDATE it keeps OLD.origin.
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
        NEW.origin := CASE WHEN TG_OP = 'UPDATE' THEN OLD.origin
                           ELSE jsonb_build_object('kind', 'derivation', 'rule_id', s_rule, 'source_ref', s_source) END;
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
-- 2. P1 — re-approving a disputed invoice re-opens its payable
------------------------------------------------------------------------------------------------------------
UPDATE core.command_authority SET target_tables = target_tables || ARRAY['core.payable']
 WHERE command_type = 'purchasing.invoice.approve.v1';

-- The guard binds a command to tables, not to transitions, so the binding above alone would let approve write any
-- payable change book_status_transition allows (paid, void…). Under purchasing.invoice.approve.v1 — the caller's
-- own command, or the command type of the approved draft executing in this transaction — a payable may only be
--   inserted by purchasing.payable_from_invoice (the origin the guard just stamped says so), or
--   moved disputed → open with no other column changed, its source supplier invoice already approved
--   (the approve handler sets the invoice to approved first).
-- Anything else → MB001. Writes under every other command are not looked at. Runs after book_guard (name order).
CREATE FUNCTION core.payable_under_invoice_approve() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  cmd     text := nullif(current_setting('app.command_type', true), '');
  drafted text;
BEGIN
  SELECT r.command_type INTO drafted
    FROM core.decision d JOIN core.draft r ON r.tenant_id = d.tenant_id AND r.id = d.draft_id
   WHERE d.tenant_id = NEW.tenant_id AND d.id::text = nullif(current_setting('app.decision_id', true), '')
     AND d.verdict IN ('approved', 'edited') AND r.status = 'executing' AND r.exec_txid = txid_current();
  IF 'purchasing.invoice.approve.v1' NOT IN (coalesce(cmd, ''), coalesce(drafted, '')) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.origin ->> 'kind' = 'derivation' AND NEW.origin ->> 'rule_id' = 'purchasing.payable_from_invoice' THEN
      RETURN NEW;
    END IF;
  ELSIF OLD.status = 'disputed' AND NEW.status = 'open'
        AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status')
        AND OLD.source_type = 'core.supplier_invoice'
        AND EXISTS (SELECT 1 FROM core.supplier_invoice i
                     WHERE i.tenant_id = OLD.tenant_id AND i.id = OLD.source_id AND i.status = 'approved') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'book_write_refused: core.payable — purchasing.invoice.approve.v1 only re-opens the payable of the invoice it re-approves (disputed → open)'
    USING ERRCODE = 'MB001';
END $$;
REVOKE ALL ON FUNCTION core.payable_under_invoice_approve() FROM PUBLIC;
CREATE TRIGGER under_invoice_approve BEFORE INSERT OR UPDATE ON core.payable
  FOR EACH ROW EXECUTE FUNCTION core.payable_under_invoice_approve();

------------------------------------------------------------------------------------------------------------
-- 3. Derivation rules (R2-S3-7, C1). db/derivation-rules.json lists every row (gate: DB = file).
------------------------------------------------------------------------------------------------------------
INSERT INTO core.derivation_rule (rule_id, source_table, target_table) VALUES
  -- A re-price also re-splits the order's coupon discount (the freeze in section 4 binds the row to the order).
  ('orders.reprice',              'core.order',    'core.coupon_use'),
  -- The guest-token claim (section 5), see its source state below.
  ('customers.claim_guest_token', 'core.customer', 'core.order'),
  ('customers.claim_guest_token', 'core.customer', 'core.coupon_use'),
  ('customers.claim_guest_token', 'core.customer', 'core.customer');

UPDATE core.derivation_rule SET source_state = p.state
  FROM (VALUES
    -- Same state as the rule's other rows (0014).
    ('orders.reprice', 'core.order', 'core.coupon_use', $s$s.status IN ('placed', 'accepted')$s$),
    -- The source is the caller's own signed-in, live, unmerged profile, and the rule holds only inside
    -- core.customer_claim_guest_token() (current_user = munim_crosstenant); a request that merely sets
    -- app.posting_rule gets nothing from it. The token proof is the function's own (it finds the order by
    -- app.guest_access_hash before the move clears the hash).
    ('customers.claim_guest_token', 'core.customer', 'core.order',
     $s$s.id = nullif(current_setting('app.customer_id', true), '')::uuid AND NOT s.is_guest AND s.idp_sub IS NOT NULL AND s.erased_at IS NULL AND s.merged_into IS NULL AND current_user = 'munim_crosstenant'$s$),
    ('customers.claim_guest_token', 'core.customer', 'core.coupon_use',
     $s$s.id = nullif(current_setting('app.customer_id', true), '')::uuid AND NOT s.is_guest AND s.idp_sub IS NOT NULL AND s.erased_at IS NULL AND s.merged_into IS NULL AND current_user = 'munim_crosstenant'$s$),
    ('customers.claim_guest_token', 'core.customer', 'core.customer',
     $s$s.id = nullif(current_setting('app.customer_id', true), '')::uuid AND NOT s.is_guest AND s.idp_sub IS NOT NULL AND s.erased_at IS NULL AND s.merged_into IS NULL AND current_user = 'munim_crosstenant'$s$)
  ) AS p (rule_id, source_table, target_table, state)
 WHERE core.derivation_rule.rule_id = p.rule_id AND core.derivation_rule.source_table = p.source_table
   AND core.derivation_rule.target_table = p.target_table;

------------------------------------------------------------------------------------------------------------
-- 4. R2-S3-7 — coupon_use.discount_minor follows a re-price of its own order
------------------------------------------------------------------------------------------------------------
-- The guard's derivation branch checks the SOURCE order's state, not that the written row belongs to it: under
-- orders.reprice for order A it would admit a coupon use of order B. This freeze (as core.order_line_pricing_frozen,
-- 0016) admits a discount change only under orders.reprice with app.source_ref = this row's own order, that order
-- in the coupon_use rule row's source state — whichever guard branch admitted the write.
CREATE FUNCTION core.coupon_use_pricing_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  state text;
  ok    boolean := false;
BEGIN
  IF NEW.discount_minor IS DISTINCT FROM OLD.discount_minor THEN
    IF coalesce(current_setting('app.posting_rule', true), '') = 'orders.reprice'
       AND coalesce(current_setting('app.source_ref', true), '') = 'core.order:' || OLD.order_id::text THEN
      SELECT dr.source_state INTO state FROM core.derivation_rule dr
       WHERE dr.rule_id = 'orders.reprice' AND dr.source_table = 'core.order' AND dr.target_table = 'core.coupon_use';
      IF state IS NOT NULL THEN
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM core."order" s WHERE s.tenant_id = $1 AND s.id = $2 AND (%s))', state)
           INTO ok USING OLD.tenant_id, OLD.order_id;
      END IF;
    END IF;
    IF NOT coalesce(ok, false) THEN
      RAISE EXCEPTION 'book_write_refused: core.coupon_use — discount_minor changes only under the pricing rule orders.reprice for its own order, while that order is in its source state'
        USING ERRCODE = 'MB001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.coupon_use_pricing_frozen() FROM PUBLIC;
CREATE TRIGGER pricing_frozen BEFORE UPDATE ON core.coupon_use FOR EACH ROW EXECUTE FUNCTION core.coupon_use_pricing_frozen();

-- Exactly one column, to the one writer (no UPDATE on coupon_use existed for munim_core before).
REVOKE UPDATE (discount_minor) ON core.coupon_use FROM PUBLIC;
GRANT UPDATE (discount_minor) ON core.coupon_use TO munim_core;

------------------------------------------------------------------------------------------------------------
-- 5. C1 — the guest-token claim, with the guest profile merged when nothing is left on it
------------------------------------------------------------------------------------------------------------
-- Called inside the customer's own customers.account.link.v1 (app.role = customer, app.customer_id = the caller,
-- app.guest_access_hash = hex(sha256(token))) INSTEAD of a direct UPDATE of core."order": the move clears the
-- order's hash (0016 guest_hash_clear), so the token proof must be read here, before the move, in the same call.
-- No arguments: tenant, caller and token come only from the request context.
-- Claims nothing (returns 0 rows — answer not_found) unless: the caller's profile is signed in (idp_sub), live, not a
-- guest and not merged; exactly one order of this tenant carries the hash; and that order has no customer or a live,
-- unmerged, token-only guest profile (is_guest, no idp_sub) — an order on a signed-in profile is never moved by a
-- leaked link. Then, under customers.claim_guest_token:
--   the order moves to the caller (its hash is cleared by 0016's trigger);
--   that order's coupon uses held by the guest move with it (as the verified-email merge, 0016 R1-m4);
--   if the guest profile has no order, reservation or bulk order left, it is marked merged_into = the caller, so
--   core.customer_erase_merged_guests() erases it when the caller is erased (R41). Loyalty rows stay where they are.
-- Returns one row per changed book row, ordered by (entity, entity_id), for the caller's audit entries (every row must
-- be audited): ('core.order', order, previous customer or NULL), ('core.coupon_use', id, guest) per moved coupon use,
-- ('core.customer', guest, guest) when the guest profile was merged.
CREATE FUNCTION core.customer_claim_guest_token()
RETURNS TABLE (entity text, entity_id uuid, from_customer_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t         uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  me        uuid := nullif(current_setting('app.customer_id', true), '')::uuid;
  token     bytea := decode(nullif(current_setting('app.guest_access_hash', true), ''), 'hex');
  prev_rule text := coalesce(current_setting('app.posting_rule', true), '');
  prev_src  text := coalesce(current_setting('app.source_ref', true), '');
  hits      uuid[];
  claimed   uuid;
  guest     uuid;
  coupons   uuid[];
  merged    boolean := false;
BEGIN
  IF current_setting('app.role', true) IS DISTINCT FROM 'customer'
     OR current_setting('app.command_type', true) IS DISTINCT FROM 'customers.account.link.v1'
     OR t IS NULL OR me IS NULL OR token IS NULL OR length(token) <> 32 THEN
    RAISE EXCEPTION 'book_write_refused: the guest-token claim runs only in the customer''s own customers.account.link.v1, with the token''s hash'
      USING ERRCODE = 'MB001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.customer c
                  WHERE c.tenant_id = t AND c.id = me AND NOT c.is_guest AND c.idp_sub IS NOT NULL
                    AND c.erased_at IS NULL AND c.merged_into IS NULL) THEN
    RETURN;
  END IF;
  SELECT array_agg(o.id) INTO hits FROM core."order" o WHERE o.tenant_id = t AND o.guest_access_hash = token;
  IF cardinality(hits) IS DISTINCT FROM 1 THEN
    RETURN;
  END IF;
  -- Locked and re-checked: a concurrent claim of the same token clears the hash, and then this finds nothing.
  SELECT o.id, o.customer_id INTO claimed, guest FROM core."order" o
   WHERE o.tenant_id = t AND o.id = hits[1] AND o.guest_access_hash = token FOR UPDATE;
  IF claimed IS NULL OR guest IS NOT DISTINCT FROM me THEN
    RETURN;
  END IF;
  IF guest IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core.customer g
                                        WHERE g.tenant_id = t AND g.id = guest AND g.is_guest AND g.idp_sub IS NULL
                                          AND g.erased_at IS NULL AND g.merged_into IS NULL) THEN
    RETURN;
  END IF;

  PERFORM set_config('app.posting_rule', 'customers.claim_guest_token', true),
          set_config('app.source_ref', 'core.customer:' || me::text, true);
  UPDATE core."order" x SET customer_id = me WHERE x.tenant_id = t AND x.id = claimed;
  IF guest IS NOT NULL THEN
    WITH cu AS (
      UPDATE core.coupon_use x SET customer_id = me
       WHERE x.tenant_id = t AND x.order_id = claimed AND x.customer_id = guest
      RETURNING x.id
    )
    SELECT array_agg(cu.id ORDER BY cu.id) INTO coupons FROM cu;
    -- Separate statements, so these see the order already moved.
    IF NOT EXISTS (SELECT 1 FROM core."order" o WHERE o.tenant_id = t AND o.customer_id = guest)
       AND NOT EXISTS (SELECT 1 FROM core.reservation r WHERE r.tenant_id = t AND r.customer_id = guest)
       AND NOT EXISTS (SELECT 1 FROM core.bulk_order b WHERE b.tenant_id = t AND b.customer_id = guest) THEN
      UPDATE core.customer x SET merged_into = me WHERE x.tenant_id = t AND x.id = guest;
      merged := true;
    END IF;
  END IF;
  RETURN QUERY
    SELECT u.e, u.i, u.f
      FROM (SELECT 'core.order'::text AS e, claimed AS i, guest AS f
            UNION ALL SELECT 'core.coupon_use', c.id, guest FROM unnest(coupons) AS c (id)
            UNION ALL SELECT 'core.customer', guest, guest WHERE merged) u
     ORDER BY u.e, u.i;
  PERFORM set_config('app.posting_rule', prev_rule, true), set_config('app.source_ref', prev_src, true);
END $$;

-- What the function (and the triggers it fires, which run as munim_crosstenant) needs beyond 0015/0016: reading the
-- token hash and the coupon use's order. Everything else it touches was granted for the verified-email merge.
GRANT SELECT (guest_access_hash) ON core."order" TO munim_crosstenant;
GRANT SELECT (order_id) ON core.coupon_use TO munim_crosstenant;

GRANT CREATE ON SCHEMA core TO munim_crosstenant;
ALTER FUNCTION core.customer_claim_guest_token() OWNER TO munim_crosstenant;
REVOKE CREATE ON SCHEMA core FROM munim_crosstenant;
REVOKE ALL ON FUNCTION core.customer_claim_guest_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.customer_claim_guest_token() TO munim_core;

------------------------------------------------------------------------------------------------------------
-- 6. Catalog post-conditions: assert_catalog re-issued (seven definer functions), then this file's own
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

  -- SECURITY DEFINER functions = exactly the seven munim_crosstenant functions; it also owns exactly the view
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
                            'core.customer_claim_guest_token()'::regprocedure));
  IF n <> 0 THEN RAISE EXCEPTION '%: unexpected SECURITY DEFINER / munim_crosstenant functions: %', migration, n; END IF;
  SELECT count(*) INTO n FROM pg_proc p WHERE p.prosecdef AND p.proowner = 'munim_crosstenant'::regrole;
  IF n <> 7 THEN RAISE EXCEPTION '%: expected 7 munim_crosstenant definer functions, found %', migration, n; END IF;
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
  src text;
  bad text;
BEGIN
  -- O1: every origin assignment in the guard keeps OLD.origin on UPDATE; no bare derivation stamp is left.
  SELECT prosrc INTO src FROM pg_proc WHERE oid = 'core.guard_book_write()'::regprocedure;
  IF (SELECT count(*) FROM regexp_matches(src, 'NEW\.origin := CASE WHEN TG_OP = ''UPDATE'' THEN OLD\.origin', 'g')) <> 4
     OR (SELECT count(*) FROM regexp_matches(src, 'NEW\.origin :=', 'g')) <> 4
     OR position($p$ELSE jsonb_build_object('kind', 'derivation', 'rule_id', s_rule, 'source_ref', s_source) END;$p$ IN src) = 0
     OR src NOT LIKE '%IF a_draft THEN%' OR src NOT LIKE '%a_col IS NULL%' THEN
    RAISE EXCEPTION '0017: guard not re-issued as written';
  END IF;

  -- P1: approve lists core.payable; the narrowing trigger is present and enabled.
  IF NOT (SELECT 'core.payable' = ANY (target_tables) FROM core.command_authority WHERE command_type = 'purchasing.invoice.approve.v1')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'core.payable'::regclass AND tgname = 'under_invoice_approve'
                       AND tgfoid = 'core.payable_under_invoice_approve()'::regprocedure AND tgenabled = 'O'
                       AND (tgtype & 1) <> 0 AND (tgtype & 2) <> 0 AND (tgtype & 4) <> 0 AND (tgtype & 16) <> 0) THEN
    RAISE EXCEPTION '0017: P1 approve → payable binding not as written';
  END IF;

  -- R2-S3-7 and C1: the rule rows read back as written.
  IF (SELECT array_agg(target_table ORDER BY target_table) FROM core.derivation_rule WHERE rule_id = 'orders.reprice')
       IS DISTINCT FROM ARRAY['core.coupon_use', 'core.order', 'core.order_line']
     OR (SELECT count(DISTINCT source_state) FROM core.derivation_rule WHERE rule_id = 'orders.reprice') <> 1
     OR (SELECT array_agg(target_table ORDER BY target_table) FROM core.derivation_rule WHERE rule_id = 'customers.claim_guest_token'
           AND source_table = 'core.customer') IS DISTINCT FROM ARRAY['core.coupon_use', 'core.customer', 'core.order']
     OR (SELECT count(*) FROM core.derivation_rule WHERE rule_id = 'customers.claim_guest_token') <> 3
     OR (SELECT count(*) FROM core.derivation_rule WHERE rule_id = 'customers.claim_guest_token'
           AND source_state LIKE 's.id = nullif(current_setting(''app.customer_id'', true), '''')::uuid AND %'
           AND source_state LIKE '% AND current_user = ''munim_crosstenant''') <> 3 THEN
    RAISE EXCEPTION '0017: derivation rules not as written';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'core.coupon_use'::regclass AND tgname = 'pricing_frozen'
                    AND tgfoid = 'core.coupon_use_pricing_frozen()'::regprocedure AND tgenabled = 'O') THEN
    RAISE EXCEPTION '0017: coupon_use pricing freeze missing';
  END IF;

  -- C1: owner, definer, search_path, EXECUTE munim_core only.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad
    FROM pg_proc p
   WHERE p.oid = 'core.customer_claim_guest_token()'::regprocedure
     AND NOT (p.prosecdef AND p.proowner = 'munim_crosstenant'::regrole
              AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
              AND has_function_privilege('munim_core', p.oid, 'EXECUTE')
              AND NOT has_function_privilege('munim_svc', p.oid, 'EXECUTE')
              AND NOT has_function_privilege('munim_platform', p.oid, 'EXECUTE')
              AND NOT has_function_privilege('munim_intel_ro', p.oid, 'EXECUTE'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0017: claim function not owned/granted as written: %', bad; END IF;

  -- Column privileges, positive and negative.
  IF NOT has_column_privilege('munim_core', 'core.coupon_use', 'discount_minor', 'UPDATE')
     OR has_column_privilege('munim_core', 'core.coupon_use', 'customer_id', 'UPDATE')
     OR has_column_privilege('munim_core', 'core.coupon_use', 'order_id', 'UPDATE')
     OR has_column_privilege('munim_svc', 'core.coupon_use', 'discount_minor', 'UPDATE')
     OR has_column_privilege('munim_crosstenant', 'core.coupon_use', 'discount_minor', 'UPDATE')
     OR NOT has_column_privilege('munim_crosstenant', 'core.coupon_use', 'order_id', 'SELECT')
     OR NOT has_column_privilege('munim_crosstenant', 'core."order"', 'guest_access_hash', 'SELECT')
     OR has_column_privilege('munim_crosstenant', 'core."order"', 'guest_access_hash', 'UPDATE')
     OR has_column_privilege('munim_crosstenant', 'core."order"', 'total_minor', 'SELECT')
     OR has_column_privilege('munim_core', 'core."order"', 'guest_access_hash', 'UPDATE')
     OR has_column_privilege('munim_crosstenant', 'core.customer', 'name', 'SELECT') THEN
    RAISE EXCEPTION '0017: column privileges not as written';
  END IF;

  PERFORM munim_meta.assert_catalog('0017');
END $$;
