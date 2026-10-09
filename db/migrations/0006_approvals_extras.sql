-- 0006_approvals_extras — §2.12 needed nothing beyond 0003 (draft.finding_id's FK waits for intel.finding,
-- M-B 0011), so this migration is the index and post-condition pass over 0001–0005. Runs as munim_migrator.
--
-- 1. A covering index for every foreign key whose first column is tenant_id (Postgres does not index the
--    referencing side). Global-parent FKs (command_type, snapshot template, operator, config draft) are
--    left unindexed: their parents are never deleted or re-keyed (no DELETE grant, keys not updatable).
-- 2. Read-path indexes for the inbox, the outbox sweeper and on-hand stock.
-- 3. Catalog post-conditions for everything in core/evidence/intel/platform, asserted here so the
--    migration itself fails if a later edit breaks an invariant (gotcha 1: never trust IF NOT EXISTS).

CREATE INDEX audit_log_decision_id_fk_idx ON core.audit_log (tenant_id, decision_id);
CREATE INDEX batch_grn_line_id_fk_idx ON core.batch (tenant_id, grn_line_id);
CREATE INDEX batch_ingredient_id_fk_idx ON core.batch (tenant_id, ingredient_id);
CREATE INDEX batch_supplier_id_fk_idx ON core.batch (tenant_id, supplier_id);
CREATE INDEX business_policy_outlet_id_fk_idx ON core.business_policy (tenant_id, outlet_id);
CREATE INDEX coupon_use_customer_id_fk_idx ON core.coupon_use (tenant_id, customer_id);
CREATE INDEX coupon_use_order_id_fk_idx ON core.coupon_use (tenant_id, order_id);
CREATE INDEX decision_decided_by_fk_idx ON core.decision (tenant_id, decided_by);
CREATE INDEX draft_run_id_fk_idx ON core.draft (tenant_id, run_id);
CREATE INDEX expired_sale_override_decided_by_fk_idx ON core.expired_sale_override (tenant_id, decided_by);
CREATE INDEX expired_sale_override_outlet_id_batch_id_fk_idx ON core.expired_sale_override (tenant_id, outlet_id, batch_id);
CREATE INDEX goods_received_outlet_id_fk_idx ON core.goods_received (tenant_id, outlet_id);
CREATE INDEX goods_received_po_id_fk_idx ON core.goods_received (tenant_id, po_id);
CREATE INDEX goods_received_received_by_fk_idx ON core.goods_received (tenant_id, received_by);
CREATE INDEX goods_received_supplier_id_fk_idx ON core.goods_received (tenant_id, supplier_id);
CREATE INDEX grn_line_batch_id_fk_idx ON core.grn_line (tenant_id, batch_id);
CREATE INDEX grn_line_goods_received_id_fk_idx ON core.grn_line (tenant_id, goods_received_id);
CREATE INDEX grn_line_ingredient_id_fk_idx ON core.grn_line (tenant_id, ingredient_id);
CREATE INDEX grn_line_po_line_id_fk_idx ON core.grn_line (tenant_id, po_line_id);
CREATE INDEX item_brand_id_fk_idx ON core.item (tenant_id, brand_id);
CREATE INDEX item_stock_ingredient_id_fk_idx ON core.item (tenant_id, stock_ingredient_id);
CREATE INDEX item_availability_item_id_fk_idx ON core.item_availability (tenant_id, item_id);
CREATE INDEX item_availability_variant_id_fk_idx ON core.item_availability (tenant_id, variant_id);
CREATE INDEX kitchen_ticket_outlet_id_order_id_fk_idx ON core.kitchen_ticket (tenant_id, outlet_id, order_id);
CREATE INDEX option_ingredient_delta_ingredient_id_fk_idx ON core.option_ingredient_delta (tenant_id, ingredient_id);
CREATE INDEX option_option_group_id_fk_idx ON core.option (tenant_id, option_group_id);
CREATE INDEX option_group_item_id_fk_idx ON core.option_group (tenant_id, item_id);
CREATE INDEX order_brand_id_fk_idx ON core."order" (tenant_id, brand_id);
CREATE INDEX order_customer_id_fk_idx ON core."order" (tenant_id, customer_id);
CREATE INDEX order_outlet_id_device_id_fk_idx ON core."order" (tenant_id, outlet_id, device_id);
CREATE INDEX order_outlet_id_pickup_window_id_fk_idx ON core."order" (tenant_id, outlet_id, pickup_window_id);
CREATE INDEX order_event_outlet_id_order_id_fk_idx ON core.order_event (tenant_id, outlet_id, order_id);
CREATE INDEX order_line_item_id_fk_idx ON core.order_line (tenant_id, item_id);
CREATE INDEX order_line_outlet_id_order_id_fk_idx ON core.order_line (tenant_id, outlet_id, order_id);
CREATE INDEX order_line_recipe_version_id_fk_idx ON core.order_line (tenant_id, recipe_version_id);
CREATE INDEX order_line_variant_id_fk_idx ON core.order_line (tenant_id, variant_id);
CREATE INDEX outlet_calendar_outlet_id_fk_idx ON core.outlet_calendar (tenant_id, outlet_id);
CREATE INDEX po_line_ingredient_id_fk_idx ON core.po_line (tenant_id, ingredient_id);
CREATE INDEX prep_list_draft_id_fk_idx ON core.prep_list (tenant_id, draft_id);
CREATE INDEX prep_list_outlet_id_fk_idx ON core.prep_list (tenant_id, outlet_id);
CREATE INDEX prep_list_line_ingredient_id_fk_idx ON core.prep_list_line (tenant_id, ingredient_id);
CREATE INDEX prep_list_line_item_id_fk_idx ON core.prep_list_line (tenant_id, item_id);
CREATE INDEX prep_list_line_prep_list_id_fk_idx ON core.prep_list_line (tenant_id, prep_list_id);
CREATE INDEX prep_time_item_id_fk_idx ON core.prep_time (tenant_id, item_id);
CREATE INDEX price_outlet_id_fk_idx ON core.price (tenant_id, outlet_id);
CREATE INDEX price_variant_id_fk_idx ON core.price (tenant_id, variant_id);
CREATE INDEX purchase_order_negotiation_run_id_fk_idx ON core.purchase_order (tenant_id, negotiation_run_id);
CREATE INDEX purchase_order_supplier_id_fk_idx ON core.purchase_order (tenant_id, supplier_id);
CREATE INDEX recipe_line_ingredient_id_fk_idx ON core.recipe_line (tenant_id, ingredient_id);
CREATE INDEX recipe_line_recipe_version_id_fk_idx ON core.recipe_line (tenant_id, recipe_version_id);
CREATE INDEX recipe_version_variant_id_fk_idx ON core.recipe_version (tenant_id, variant_id);
CREATE INDEX refund_actor_fk_idx ON core.refund (tenant_id, actor);
CREATE INDEX refund_outlet_id_order_id_fk_idx ON core.refund (tenant_id, outlet_id, order_id);
CREATE INDEX refund_tender_id_fk_idx ON core.refund (tenant_id, tender_id);
CREATE INDEX reorder_level_ingredient_id_fk_idx ON core.reorder_level (tenant_id, ingredient_id);
CREATE INDEX sale_return_actor_fk_idx ON core.sale_return (tenant_id, actor);
CREATE INDEX sale_return_order_line_id_fk_idx ON core.sale_return (tenant_id, order_line_id);
CREATE INDEX sale_return_outlet_id_order_id_fk_idx ON core.sale_return (tenant_id, outlet_id, order_id);
CREATE INDEX shift_closed_by_fk_idx ON core.shift (tenant_id, closed_by);
CREATE INDEX shift_opened_by_fk_idx ON core.shift (tenant_id, opened_by);
CREATE INDEX shift_outlet_id_fk_idx ON core.shift (tenant_id, outlet_id);
CREATE INDEX shift_outlet_id_device_id_fk_idx ON core.shift (tenant_id, outlet_id, device_id);
CREATE INDEX stock_count_counted_by_fk_idx ON core.stock_count (tenant_id, counted_by);
CREATE INDEX stock_count_outlet_id_fk_idx ON core.stock_count (tenant_id, outlet_id);
CREATE INDEX stock_count_line_batch_id_fk_idx ON core.stock_count_line (tenant_id, batch_id);
CREATE INDEX stock_count_line_ingredient_id_fk_idx ON core.stock_count_line (tenant_id, ingredient_id);
CREATE INDEX stock_count_line_stock_count_id_fk_idx ON core.stock_count_line (tenant_id, stock_count_id);
CREATE INDEX stock_movement_expired_sale_override_id_batch_id_fk_idx ON core.stock_movement (tenant_id, expired_sale_override_id, batch_id);
CREATE INDEX stock_movement_ingredient_id_fk_idx ON core.stock_movement (tenant_id, ingredient_id);
CREATE INDEX stock_movement_outlet_id_fk_idx ON core.stock_movement (tenant_id, outlet_id);
CREATE INDEX stock_movement_outlet_id_batch_id_fk_idx ON core.stock_movement (tenant_id, outlet_id, batch_id);
CREATE INDEX supplier_invoice_po_id_fk_idx ON core.supplier_invoice (tenant_id, po_id);
CREATE INDEX supplier_invoice_line_ingredient_id_fk_idx ON core.supplier_invoice_line (tenant_id, ingredient_id);
CREATE INDEX supplier_invoice_line_po_line_id_fk_idx ON core.supplier_invoice_line (tenant_id, po_line_id);
CREATE INDEX supplier_price_ingredient_id_fk_idx ON core.supplier_price (tenant_id, ingredient_id);
CREATE INDEX supplier_price_supplier_id_fk_idx ON core.supplier_price (tenant_id, supplier_id);
CREATE INDEX supplier_return_goods_received_id_fk_idx ON core.supplier_return (tenant_id, goods_received_id);
CREATE INDEX supplier_return_outlet_id_fk_idx ON core.supplier_return (tenant_id, outlet_id);
CREATE INDEX supplier_return_returned_by_fk_idx ON core.supplier_return (tenant_id, returned_by);
CREATE INDEX supplier_return_supplier_id_fk_idx ON core.supplier_return (tenant_id, supplier_id);
CREATE INDEX supplier_return_line_batch_id_fk_idx ON core.supplier_return_line (tenant_id, batch_id);
CREATE INDEX supplier_return_line_ingredient_id_fk_idx ON core.supplier_return_line (tenant_id, ingredient_id);
CREATE INDEX supplier_return_line_supplier_return_id_fk_idx ON core.supplier_return_line (tenant_id, supplier_return_id);
CREATE INDEX tender_outlet_id_order_id_fk_idx ON core.tender (tenant_id, outlet_id, order_id);
CREATE INDEX tender_recorded_by_fk_idx ON core.tender (tenant_id, recorded_by);
CREATE INDEX transfer_from_outlet_id_fk_idx ON core.transfer (tenant_id, from_outlet_id);
CREATE INDEX transfer_received_by_fk_idx ON core.transfer (tenant_id, received_by);
CREATE INDEX transfer_sent_by_fk_idx ON core.transfer (tenant_id, sent_by);
CREATE INDEX transfer_to_outlet_id_fk_idx ON core.transfer (tenant_id, to_outlet_id);
CREATE INDEX transfer_line_batch_id_fk_idx ON core.transfer_line (tenant_id, batch_id);
CREATE INDEX transfer_line_ingredient_id_fk_idx ON core.transfer_line (tenant_id, ingredient_id);
CREATE INDEX transfer_line_transfer_id_fk_idx ON core.transfer_line (tenant_id, transfer_id);
CREATE INDEX variant_item_id_fk_idx ON core.variant (tenant_id, item_id);
CREATE INDEX void_actor_fk_idx ON core.void (tenant_id, actor);
CREATE INDEX void_order_line_id_fk_idx ON core.void (tenant_id, order_line_id);
CREATE INDEX void_outlet_id_order_id_fk_idx ON core.void (tenant_id, outlet_id, order_id);
CREATE INDEX waste_log_ingredient_id_fk_idx ON core.waste_log (tenant_id, ingredient_id);
CREATE INDEX waste_log_outlet_id_fk_idx ON core.waste_log (tenant_id, outlet_id);
CREATE INDEX waste_log_outlet_id_batch_id_fk_idx ON core.waste_log (tenant_id, outlet_id, batch_id);
CREATE INDEX waste_log_recorded_by_fk_idx ON core.waste_log (tenant_id, recorded_by);
CREATE INDEX snapshot_minted_by_member_id_fk_idx ON evidence.snapshot (tenant_id, minted_by_member_id);
CREATE INDEX snapshot_run_id_fk_idx ON evidence.snapshot (tenant_id, run_id);

-- Inbox replay by updated_at (03-architecture §1.8).
CREATE INDEX draft_inbox_idx ON core.draft (tenant_id, status, updated_at);
-- Sweeper: unpublished rows only, across tenants. The one index that does not lead with tenant_id: the
-- sweeper is cross-tenant by design (core.outbox_claim) and the partial predicate keeps it tiny.
CREATE INDEX outbox_unpublished_idx ON core.outbox (created_at, id) WHERE published_at IS NULL;
-- On-hand = Σ qty_milli per outlet and ingredient (02-schema §2.5).
CREATE INDEX stock_movement_on_hand_idx ON core.stock_movement (tenant_id, outlet_id, ingredient_id, at);

DO $$
DECLARE
  bad text;
  n   integer;
BEGIN
  -- Tags: every core table is munim:book or munim:operational (R29).
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = 'core' AND c.relkind IN ('r', 'p')
     AND coalesce(obj_description(c.oid, 'pg_class'), '') NOT IN ('munim:book', 'munim:operational');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0006: untagged core tables: %', bad; END IF;

  -- Every book table: the guard trigger, enabled, and a NOT NULL jsonb origin column.
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = 'core' AND c.relkind = 'r' AND obj_description(c.oid, 'pg_class') = 'munim:book'
     AND (NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
                       WHERE t.tgrelid = c.oid AND t.tgname = 'book_guard' AND t.tgenabled = 'O'
                         AND t.tgfoid = 'core.guard_book_write()'::regprocedure)
          OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                          WHERE a.attrelid = c.oid AND a.attname = 'origin' AND a.attnotnull
                            AND a.atttypid = 'jsonb'::regtype));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0006: book tables without guard/origin: %', bad; END IF;

  -- No operational table carries the guard (it would refuse service writes the grants allow).
  SELECT string_agg(c.relname, ', ') INTO bad
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
    JOIN pg_catalog.pg_trigger t ON t.tgrelid = c.oid AND t.tgfoid = 'core.guard_book_write()'::regprocedure
   WHERE obj_description(c.oid, 'pg_class') IS DISTINCT FROM 'munim:book';
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0006: guard on non-book tables: %', bad; END IF;

  -- Every tenant table in core/evidence/intel/platform: RLS enabled AND forced AND at least one policy.
  SELECT string_agg(s.nspname || '.' || c.relname, ', ') INTO bad
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform') AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity
          OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid = c.oid));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0006: tenant tables without forced RLS + policy: %', bad; END IF;

  -- Every tenant-leading FK has an index whose leading columns are exactly the FK columns (pg_index).
  SELECT string_agg(c.conrelid::regclass::text || '(' || c.conname || ')', ', ') INTO bad
    FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class cl ON cl.oid = c.conrelid
    JOIN pg_catalog.pg_namespace s ON s.oid = cl.relnamespace
   WHERE c.contype = 'f' AND s.nspname IN ('core', 'evidence', 'intel', 'platform')
     AND (SELECT a.attname FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1]) = 'tenant_id'
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = c.conrelid
           AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] @> c.conkey
           AND (string_to_array(i.indkey::text, ' ')::int2[])[1:cardinality(c.conkey)] <@ c.conkey);
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0006: FKs without a covering index: %', bad; END IF;

  -- No table privilege for PUBLIC, and no DELETE/TRUNCATE for any munim role, in our schemas.
  SELECT string_agg(DISTINCT s.nspname || '.' || c.relname, ', ') INTO bad
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace s ON s.oid = c.relnamespace,
         LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform', 'intel_ro', 'munim_meta') AND c.relkind IN ('r', 'v', 'p')
     AND (x.grantee = 0
          OR (x.privilege_type IN ('DELETE', 'TRUNCATE') AND x.grantee <> c.relowner));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0006: PUBLIC grants or DELETE/TRUNCATE grants on: %', bad; END IF;

  -- No function in our schemas is executable by PUBLIC.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace,
         LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform', 'intel_ro', 'munim_meta') AND x.grantee = 0;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0006: functions executable by PUBLIC: %', bad; END IF;

  -- munim_crosstenant owns exactly outbox_claim, active_tenants (the only SECURITY DEFINER functions)
  -- and the tenant_registry view.
  SELECT count(*) INTO n FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace
   WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform', 'intel_ro', 'munim_meta')
     AND (p.prosecdef OR p.proowner = 'munim_crosstenant'::regrole)
     AND NOT (p.prosecdef AND p.proowner = 'munim_crosstenant'::regrole
              AND p.oid IN ('core.outbox_claim(integer, interval, interval)'::regprocedure,
                            'core.active_tenants()'::regprocedure));
  IF n <> 0 THEN RAISE EXCEPTION '0006: unexpected SECURITY DEFINER / munim_crosstenant functions: %', n; END IF;
  SELECT count(*) INTO n FROM pg_catalog.pg_class c WHERE c.relowner = 'munim_crosstenant'::regrole;
  IF n <> 1 OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                            WHERE c.oid = 'platform.tenant_registry'::regclass AND c.relowner = 'munim_crosstenant'::regrole) THEN
    RAISE EXCEPTION '0006: munim_crosstenant must own exactly the view platform.tenant_registry';
  END IF;
END $$;
