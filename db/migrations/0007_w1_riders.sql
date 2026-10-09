-- 0007_w1_riders — fixes forward on 0001–0006 (frozen), from the W1 riders of 10 Oct. Runs as munim_migrator.
--   1. Command → table binding (severity 1, found by T-005): core.command_authority gains target_tables; the
--      book guard's own-command and decision branches admit a row only when its table is listed for the
--      command (else MB008 command_table_mismatch). A command type alone can no longer write any book table.
--   2. Writer commands for W1 book tables that had none (void, refund, shift, tender, deal, coupon, waste,
--      count, …). Names follow <module>.<entity>.<verb>.v1 — INFERENCE; the owning module tickets adopt them
--      in contracts or request a rename (T-021, T-022, T-024, T-025).
--   3. Storefront keys + the cross-tenant key lookup, and member tenant discovery by IdP subject — two more
--      SECURITY DEFINER functions owned by munim_crosstenant (EXECUTE munim_core only). Definer objects: 5.
--   4. munim_meta.assert_catalog(): the catalog post-conditions of 0006, extended, callable at the end of
--      every later migration (gotcha 1: assert what Postgres holds, never trust IF NOT EXISTS).
--   5. core.outlet.upi_vpa CHECK (0003) used the repetition count {2,256}; Postgres caps counts at 255, so
--      the check itself raised 2201B on every non-NULL upi_vpa (measured on 0001–0006). Re-issued as {2,255}.
--   6. Stream (T-006): core.outbox.seq — per tenant, commit-ordered: assigned under the per-tenant transaction
--      lock the audit chain takes (held to commit), so a later seq never commits before an earlier one and an
--      SSE cursor on seq never skips a late commit. Replay indexes on outbox and draft.
--   7. Guest order tracking (orchestrator ruling): core.order.guest_access_hash = sha256 of a random token
--      returned once to the guest at placement; possession proves ownership of order:<id> (bad token → 404,
--      gotcha 16 — enforced by core-api; the database stores only the hash).

------------------------------------------------------------------------------------------------------------
-- 1. Command → table binding
------------------------------------------------------------------------------------------------------------
-- '{}' = the command writes no book table (operational rows only, or reads). Every element is checked
-- against the catalog (exists in core, tagged munim:book) by munim_meta.assert_catalog().
ALTER TABLE core.command_authority ADD COLUMN target_tables text[];

UPDATE core.command_authority SET target_tables = t.tables
  FROM (VALUES
    ('tenancy.provision.v1',               ARRAY['core.tenant', 'core.member', 'core.membership', 'core.outlet',
                                                 'core.outlet_calendar', 'core.brand', 'core.channel', 'core.business_policy']),
    ('tenancy.outlet.create.v1',           ARRAY['core.outlet', 'core.outlet_calendar']),
    ('tenancy.member.invite.v1',           ARRAY['core.member', 'core.membership']),
    ('tenancy.brand.create.v1',            ARRAY['core.brand']),
    ('tenancy.channel.create.v1',          ARRAY['core.channel']),
    ('tenancy.device.register.v1',         ARRAY[]::text[]),
    ('catalogue.item.upsert.v1',           ARRAY['core.item', 'core.variant', 'core.option_group', 'core.option',
                                                 'core.option_ingredient_delta']),
    ('catalogue.recipe.version.create.v1', ARRAY['core.recipe_version', 'core.recipe_line']),
    ('catalogue.price.set.v1',             ARRAY['core.price']),
    ('inventory.ingredient.upsert.v1',     ARRAY['core.ingredient']),
    ('inventory.reorder_level.set.v1',     ARRAY['core.reorder_level']),
    ('inventory.stock.receive.v1',         ARRAY['core.goods_received', 'core.grn_line', 'core.batch', 'core.stock_movement',
                                                 'core.purchase_order']),
    ('purchasing.supplier.upsert.v1',      ARRAY['core.supplier', 'core.supplier_price']),
    ('purchasing.po.create.v1',            ARRAY['core.purchase_order', 'core.po_line']),
    ('orders.pickup_window.generate.v1',   ARRAY[]::text[]),
    ('orders.place.v1',                    ARRAY['core.order', 'core.order_line', 'core.order_event', 'core.coupon_use',
                                                 'core.tender']),
    ('storefront.guest.create.v1',         ARRAY['core.customer']),
    ('kitchen.ticket.advance.v1',          ARRAY['core.order', 'core.order_event']),
    -- Approve/reject write operational rows; the approved command's own row governs its book writes.
    ('drafts.approve.v1',                  ARRAY[]::text[]),
    ('drafts.reject.v1',                   ARRAY[]::text[]),
    ('kitchen.prep_list.create.v1',        ARRAY['core.prep_list', 'core.prep_list_line']),
    ('customers.account.link.v1',          ARRAY['core.customer']),
    ('customers.profile.update.v1',        ARRAY['core.customer']),
    ('customers.consent.set.v1',           ARRAY['core.customer']),
    ('customers.data.export.v1',           ARRAY[]::text[]),
    ('customers.erasure.request.v1',       ARRAY['core.customer']),
    ('inventory.expired_sale.override.v1', ARRAY['core.expired_sale_override'])
  ) AS t (command_type, tables)
 WHERE core.command_authority.command_type = t.command_type;

-- 2. Writers for W1 book tables that no seeded command could write (INFERENCE: names and roles).
INSERT INTO core.command_authority (command_type, allowed_roles, scope, target_tables) VALUES
  ('orders.tender.record.v1',        ARRAY['owner', 'manager', 'staff', 'judge'], 'outlet', ARRAY['core.tender']),
  ('orders.void.record.v1',          ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.void', 'core.order_event']),
  ('orders.refund.record.v1',        ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.refund']),
  ('orders.shift.open.v1',           ARRAY['owner', 'manager', 'staff', 'judge'], 'outlet', ARRAY['core.shift']),
  ('orders.shift.close.v1',          ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.shift']),
  ('orders.sale_return.record.v1',   ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.sale_return']),
  ('catalogue.deal.upsert.v1',       ARRAY['owner', 'manager', 'judge'],          'tenant', ARRAY['core.deal']),
  ('catalogue.coupon.set.v1',        ARRAY['owner', 'manager', 'judge'],          'tenant', ARRAY['core.coupon']),
  ('inventory.waste.record.v1',      ARRAY['owner', 'manager', 'staff', 'judge'], 'outlet', ARRAY['core.waste_log']),
  ('inventory.count.submit.v1',      ARRAY['owner', 'manager', 'staff', 'judge'], 'outlet',
                                     ARRAY['core.stock_count', 'core.stock_count_line', 'core.stock_movement']),
  ('inventory.batch.update.v1',      ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.batch']),
  ('inventory.transfer.create.v1',   ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.transfer', 'core.transfer_line']),
  ('inventory.transfer.receive.v1',  ARRAY['owner', 'manager', 'staff', 'judge'], 'outlet', ARRAY['core.transfer']),
  ('purchasing.po.cancel.v1',        ARRAY['owner', 'manager', 'judge'],          'tenant', ARRAY['core.purchase_order']),
  ('purchasing.invoice.record.v1',   ARRAY['owner', 'manager', 'judge'],          'tenant',
                                     ARRAY['core.supplier_invoice', 'core.supplier_invoice_line']),
  ('purchasing.invoice.approve.v1',  ARRAY['owner', 'judge'],                     'tenant', ARRAY['core.supplier_invoice']),
  ('purchasing.supplier_return.create.v1', ARRAY['owner', 'manager', 'judge'],    'outlet',
                                     ARRAY['core.supplier_return', 'core.supplier_return_line']),
  ('tenancy.outlet.update.v1',       ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.outlet', 'core.outlet_calendar']),
  ('tenancy.policy.set.v1',          ARRAY['owner', 'judge'],                     'tenant', ARRAY['core.business_policy']),
  ('customers.customer.upsert.v1',   ARRAY['owner', 'manager', 'staff', 'judge'], 'outlet', ARRAY['core.customer']);

ALTER TABLE core.command_authority
  ALTER COLUMN target_tables SET NOT NULL,
  ADD CONSTRAINT command_authority_target_tables_check
    CHECK (target_tables = '{}' OR array_to_string(target_tables, ',') ~ '^core\.[a-z_]+(,core\.[a-z_]+)*$');

-- The guard, re-issued (03-architecture §1.3, ADR-013). Unchanged from 0003 except: branches 2 and 1 also
-- require TG_TABLE to be in the command's target_tables (the draft's command type for branch 2). A branch
-- whose only failure is the table binding does not raise at once — a later branch may still admit the row
-- (an approved import's derived postings set both app.decision_id and app.posting_rule). If nothing admits
-- the row and a binding mismatch was seen, MB008 command_table_mismatch; otherwise MB001.
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
  principal  text;
  rule_src   text;
  src_id     text;
  src_found  boolean;
  auth_scope text;
  auth_tabs  text[];
  row_outlet text;
  mismatch   text;
BEGIN
  IF s_decision ~ uuid_re THEN
    SELECT ca.target_tables INTO auth_tabs
      FROM core.decision d
      JOIN core.draft r ON r.tenant_id = d.tenant_id AND r.id = d.draft_id
      JOIN core.command_authority ca ON ca.command_type = r.command_type
     WHERE d.tenant_id = NEW.tenant_id AND d.id = s_decision::uuid
       AND d.verdict IN ('approved', 'edited')
       AND r.status = 'executing' AND r.exec_txid = txid_current();
    IF FOUND THEN
      IF target = ANY (auth_tabs) THEN
        NEW.origin := jsonb_build_object('kind', 'decision', 'decision_id', s_decision);
        RETURN NEW;
      END IF;
      mismatch := 'the approved draft''s command type does not list ' || target;
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
    SELECT ca.scope, ca.target_tables INTO auth_scope, auth_tabs
      FROM core.command_authority ca
     WHERE ca.command_type = s_cmd AND s_role = ANY (ca.allowed_roles);
    row_outlet := to_jsonb(NEW) ->> 'outlet_id';
    IF principal ~ uuid_re AND auth_scope IS NOT NULL
       AND (auth_scope <> 'tenant' OR s_outlets = '{*}')
       AND (row_outlet IS NULL OR s_outlets = '{*}'
            OR row_outlet::uuid = ANY (nullif(s_outlets, '{*}')::uuid[])) THEN
      IF target = ANY (auth_tabs) THEN
        NEW.origin := jsonb_build_object('kind', 'command', 'command_type', s_cmd, 'role', s_role,
                                         'principal_id', principal);
        RETURN NEW;
      END IF;
      mismatch := s_cmd || ' does not list ' || target;
    END IF;
  END IF;

  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'command_table_mismatch: %', mismatch
      USING ERRCODE = 'MB008', HINT = 'core.command_authority.target_tables binds each command type to the book tables it writes';
  END IF;
  RAISE EXCEPTION 'book_write_refused: %', target
    USING ERRCODE = 'MB001',
          HINT = 'needs a person''s own command allowed by core.command_authority, an executing approved decision, or an allow-listed derivation';
END $$;
REVOKE ALL ON FUNCTION core.guard_book_write() FROM PUBLIC;

------------------------------------------------------------------------------------------------------------
-- 3. Storefront keys (operational) and the two cross-tenant lookups
------------------------------------------------------------------------------------------------------------
-- A bespoke storefront presents a key; core-api hashes it (sha256 hex) and resolves the tenant before any
-- tenant context exists. Only the hash is stored. Globally unique, so the lookup needs no tenant.
CREATE TABLE core.storefront_key (
  tenant_id       uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id              uuid        NOT NULL,
  channel_id      uuid        NOT NULL,
  key_hash        text        NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  allowed_origins text[]      NOT NULL DEFAULT '{}'
                    CHECK (allowed_origins = '{}' OR array_to_string(allowed_origins, ' ') ~ '^https?://[^/\s]+( https?://[^/\s]+)*$'),
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT storefront_key_hash_unique UNIQUE (key_hash),
  FOREIGN KEY (tenant_id, channel_id) REFERENCES core.channel (tenant_id, id)
);
CREATE INDEX storefront_key_channel_id_fk_idx ON core.storefront_key (tenant_id, channel_id);
-- Tenant discovery by IdP subject is cross-tenant by design (core.memberships_for_sub).
CREATE INDEX member_idp_sub_idx ON core.member (idp_sub) WHERE idp_sub IS NOT NULL;

ALTER TABLE core.storefront_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.storefront_key FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.storefront_key
  USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid));
COMMENT ON TABLE core.storefront_key IS 'munim:operational';

REVOKE ALL ON core.storefront_key FROM PUBLIC;
GRANT SELECT, INSERT ON core.storefront_key TO munim_core;
GRANT UPDATE (allowed_origins, revoked_at) ON core.storefront_key TO munim_core;
GRANT SELECT ON core.storefront_key TO munim_svc;

-- Returns tenant and channel only, for an unrevoked key of an active tenant.
CREATE FUNCTION core.tenant_for_storefront_key(key_hash text)
RETURNS TABLE (tenant_id uuid, channel_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.tenant_id, k.channel_id
    FROM core.storefront_key k
    JOIN core.tenant t ON t.tenant_id = k.tenant_id AND t.status = 'active'
   WHERE k.key_hash = $1 AND k.revoked_at IS NULL;
$$;

-- Member tenant discovery after sign-in: the tenants where this IdP subject is an active member, with the
-- tenant name and the role — nothing else.
CREATE FUNCTION core.memberships_for_sub(sub text)
RETURNS TABLE (tenant_id uuid, tenant_name text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT ms.tenant_id, t.name, ms.role
    FROM core.member m
    JOIN core.membership ms ON ms.tenant_id = m.tenant_id AND ms.member_id = m.id AND ms.active
    JOIN core.tenant t ON t.tenant_id = m.tenant_id AND t.status = 'active'
   WHERE m.idp_sub = $1 AND m.active
   ORDER BY t.name, ms.tenant_id;
$$;

GRANT SELECT (tenant_id, channel_id, key_hash, revoked_at) ON core.storefront_key TO munim_crosstenant;
GRANT SELECT (tenant_id, id, idp_sub, active) ON core.member TO munim_crosstenant;
GRANT SELECT (tenant_id, member_id, role, active) ON core.membership TO munim_crosstenant;

GRANT CREATE ON SCHEMA core TO munim_crosstenant;
ALTER FUNCTION core.tenant_for_storefront_key(text) OWNER TO munim_crosstenant;
ALTER FUNCTION core.memberships_for_sub(text) OWNER TO munim_crosstenant;
REVOKE CREATE ON SCHEMA core FROM munim_crosstenant;

REVOKE ALL ON FUNCTION core.tenant_for_storefront_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION core.memberships_for_sub(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.tenant_for_storefront_key(text) TO munim_core;
GRANT EXECUTE ON FUNCTION core.memberships_for_sub(text) TO munim_core;

------------------------------------------------------------------------------------------------------------
-- 5. outlet.upi_vpa check (0003 bug, fix forward)
------------------------------------------------------------------------------------------------------------
ALTER TABLE core.outlet DROP CONSTRAINT outlet_upi_vpa_check;
ALTER TABLE core.outlet ADD CONSTRAINT outlet_upi_vpa_check
  CHECK (upi_vpa ~ '^[A-Za-z0-9._-]{2,255}@[A-Za-z][A-Za-z0-9]{1,63}$');

------------------------------------------------------------------------------------------------------------
-- 6. core.outbox.seq and stream replay indexes
------------------------------------------------------------------------------------------------------------
ALTER TABLE core.outbox ADD COLUMN seq bigint;
UPDATE core.outbox o SET seq = n.rn
  FROM (SELECT tenant_id, id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn FROM core.outbox) n
 WHERE o.tenant_id = n.tenant_id AND o.id = n.id;
ALTER TABLE core.outbox ALTER COLUMN seq SET NOT NULL,
  ADD CONSTRAINT outbox_seq_unique UNIQUE (tenant_id, seq);

-- The same lock key as core.audit_log_chain() (0003): one per-tenant commit order for audit and outbox.
-- Values the caller supplies for seq are overwritten.
CREATE FUNCTION core.outbox_seq() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('core.audit_log:' || NEW.tenant_id::text, 0));
  SELECT coalesce(max(o.seq), 0) + 1 INTO NEW.seq FROM core.outbox o WHERE o.tenant_id = NEW.tenant_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.outbox_seq() FROM PUBLIC;
CREATE TRIGGER outbox_seq BEFORE INSERT ON core.outbox FOR EACH ROW EXECUTE FUNCTION core.outbox_seq();

CREATE INDEX outbox_replay_idx ON core.outbox (tenant_id, created_at, id);
CREATE INDEX draft_replay_idx ON core.draft (tenant_id, updated_at, id);

------------------------------------------------------------------------------------------------------------
-- 7. core.order.guest_access_hash
------------------------------------------------------------------------------------------------------------
ALTER TABLE core."order" ADD COLUMN guest_access_hash bytea CONSTRAINT order_guest_access_hash_check CHECK (octet_length(guest_access_hash) = 32);

------------------------------------------------------------------------------------------------------------
-- 4. Catalog post-conditions, re-run at the end of every migration from here on
------------------------------------------------------------------------------------------------------------
CREATE FUNCTION munim_meta.assert_catalog(migration text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  bad text;
  n   integer;
BEGIN
  -- Tags: every core table is munim:book or munim:operational (R29).
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = 'core' AND c.relkind IN ('r', 'p')
     AND coalesce(obj_description(c.oid, 'pg_class'), '') NOT IN ('munim:book', 'munim:operational');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: untagged core tables: %', migration, bad; END IF;

  -- Every book table: the guard trigger (enabled) and a NOT NULL jsonb origin column.
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

  -- The guard fires first among BEFORE ROW triggers on a book table (triggers fire in name order).
  SELECT string_agg(c.relname || '.' || t.tgname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace JOIN pg_trigger t ON t.tgrelid = c.oid
   WHERE s.nspname = 'core' AND obj_description(c.oid, 'pg_class') = 'munim:book' AND NOT t.tgisinternal
     AND (t.tgtype & 2) <> 0 AND (t.tgtype & 1) <> 0 AND t.tgname < 'book_guard';
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: BEFORE ROW triggers sorting before book_guard: %', migration, bad; END IF;

  -- No operational table carries the guard.
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_trigger t ON t.tgrelid = c.oid AND t.tgfoid = 'core.guard_book_write()'::regprocedure
   WHERE obj_description(c.oid, 'pg_class') IS DISTINCT FROM 'munim:book';
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: guard on non-book tables: %', migration, bad; END IF;

  -- Command → table binding: every listed table is a core book table; every book table is writable by
  -- some command or derivation (no orphan book table).
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

  -- Every tenant table in core/evidence/intel/platform: RLS enabled AND forced AND at least one policy.
  SELECT string_agg(s.nspname || '.' || c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform') AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
          OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: tenant tables without forced RLS + policy: %', migration, bad; END IF;

  -- Every tenant-leading FK has an index whose leading columns are exactly the FK columns (pg_index).
  SELECT string_agg(c.conrelid::regclass::text || '(' || c.conname || ')', ', ') INTO bad
    FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace s ON s.oid = cl.relnamespace
   WHERE c.contype = 'f' AND s.nspname IN ('core', 'evidence', 'intel', 'platform')
     AND (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) = 'tenant_id'
     AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid
           AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] @> c.conkey
           AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] <@ c.conkey);
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: FKs without a covering index: %', migration, bad; END IF;

  -- No FK cascades (a cascade is a book write that bypasses the guard).
  SELECT string_agg(c.conrelid::regclass::text || '(' || c.conname || ')', ', ') INTO bad
    FROM pg_constraint c JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace s ON s.oid = cl.relnamespace
   WHERE c.contype = 'f' AND s.nspname IN ('core', 'evidence', 'intel', 'platform')
     AND (c.confdeltype <> 'a' OR c.confupdtype <> 'a');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: cascading FKs: %', migration, bad; END IF;

  -- No table privilege for PUBLIC, and no DELETE/TRUNCATE for any role but the owner, in our schemas.
  SELECT string_agg(DISTINCT s.nspname || '.' || c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace,
         LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform', 'intel_ro', 'munim_meta') AND c.relkind IN ('r', 'v', 'p')
     AND (x.grantee = 0 OR (x.privilege_type IN ('DELETE', 'TRUNCATE') AND x.grantee <> c.relowner));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: PUBLIC grants or DELETE/TRUNCATE grants on: %', migration, bad; END IF;

  -- No function in our schemas is executable by PUBLIC.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad
    FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace,
         LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform', 'intel_ro', 'munim_meta') AND x.grantee = 0;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: functions executable by PUBLIC: %', migration, bad; END IF;

  -- SECURITY DEFINER functions = exactly the four munim_crosstenant functions; it also owns exactly the
  -- view platform.tenant_registry.
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

  -- intel_ro holds only views, each owned by munim_view_owner (NOBYPASSRLS: base-table RLS applies).
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = 'intel_ro' AND (c.relkind <> 'v' OR c.relowner <> 'munim_view_owner'::regrole);
  IF bad IS NOT NULL THEN RAISE EXCEPTION '%: intel_ro objects not views owned by munim_view_owner: %', migration, bad; END IF;
END $$;
REVOKE ALL ON FUNCTION munim_meta.assert_catalog(text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM core.command_authority WHERE target_tables IS NULL) THEN
    RAISE EXCEPTION '0007: command_authority rows without target_tables';
  END IF;
  -- The two lookups are definer functions owned by munim_crosstenant, executable by munim_core only.
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.oid IN ('core.tenant_for_storefront_key(text)'::regprocedure, 'core.memberships_for_sub(text)'::regprocedure)
         AND p.prosecdef AND p.proowner = 'munim_crosstenant'::regrole
         AND has_function_privilege('munim_core', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('munim_svc', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('munim_intel_ro', p.oid, 'EXECUTE')) <> 2 THEN
    RAISE EXCEPTION '0007: lookup functions not owned/granted as written';
  END IF;
  -- The unique index the storefront lookup relies on (gotcha 1).
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = 'core.storefront_key'::regclass AND i.indisunique
                    AND i.indkey::text = (SELECT attnum::text FROM pg_attribute
                                           WHERE attrelid = 'core.storefront_key'::regclass AND attname = 'key_hash')) THEN
    RAISE EXCEPTION '0007: unique index on storefront_key.key_hash missing';
  END IF;
  -- Indexes as written (gotcha 1: a same-name index with other columns would pass IF NOT EXISTS).
  IF (SELECT count(*) FROM (VALUES ('core.outbox_replay_idx', 'tenant_id,created_at,id'),
                                   ('core.draft_replay_idx', 'tenant_id,updated_at,id'),
                                   ('core.outbox_seq_unique', 'tenant_id,seq')) v(ix, cols)
       WHERE (SELECT string_agg(a.attname, ',' ORDER BY k.ord)
                FROM pg_index i
               CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
               WHERE i.indexrelid = v.ix::regclass) = v.cols) <> 3 THEN
    RAISE EXCEPTION '0007: replay / seq indexes not as written';
  END IF;
  PERFORM munim_meta.assert_catalog('0007');
END $$;
