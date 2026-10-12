-- 0029_storefront_display — T-099 storefront API completeness (docs/kit/gaps.md G-01, G-04; orchestrator rider G-14),
-- migrator lane b-99, fix forward over 0001–0028. Runs as munim_migrator. Additive: nine nullable columns with named
-- CHECKs, munim_core's UPDATE column lists re-issued (revoke-then-grant) with them added, one SECURITY DEFINER read
-- re-created with one more OUT column, one column SELECT for munim_crosstenant. No row is written or rewritten; no table,
-- policy, trigger, command type or derivation rule is added or changed.
-- Items:
--   D1  Owner-entered display text (G-01): display_name (1–120 chars) and description (1–500) on core.item, core.variant,
--       core.option_group and core.option, and core.item.diet ('veg', 'non_veg', 'egg', 'vegan'; the country packs carry no
--       diet list, so the CHECK is the list). NULL = not set: a client shows the item's name_key (G-01 fallback). They are
--       columns of book tables (munim:book, book_guard unchanged), written only by catalogue.item.upsert.v1 (its
--       target_tables already list all four tables). Plain text: nothing renders them as HTML (gotcha 15).
--       No category table exists — core.item.category is already the owner's own text (≤ 100, 0004) — so categories get
--       no new column.
--   D2  core.outlet.phone (G-04): E.164 (same pattern as core.customer's contract phone), written only by
--       tenancy.outlet.create.v1 / tenancy.outlet.update.v1 (target core.outlet). Which tax ids are public is the pack's
--       (`tax_ids[].on_receipt`), not the schema's.
--   G   munim_core UPDATE: REVOKE UPDATE on each of the five tables (which also drops its column grants), then GRANT the
--       0004/0005/0003/0014 lists back plus the new columns. No other role gains anything on the new columns beyond the
--       table-level SELECT it already holds (munim_core, munim_svc).
--   X1  core.cares_network_listings gains OUT outlet_tz (= core.outlet.tz) as its LAST column (G-14: a Cares listing's
--       pickup times render in the outlet's zone). The OUT list is the function's result type, so it is dropped and
--       created (CREATE OR REPLACE cannot change it), then owned, revoked and granted exactly as 0028 §12;
--       munim_crosstenant gains SELECT (tz) on core.outlet. Same signature, so assert_catalog's definer list holds.
-- New SQLSTATEs: none (23514 from the CHECKs).

------------------------------------------------------------------------------------------------------------
-- 0. Pre-checks: what this file builds on is the shape it builds on.
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(v.t || ' has ' || coalesce(g.cols, '(none)'), '; ') INTO bad
    FROM (VALUES ('core.item', 'active,barcode,brand_id,category,currency,mrp_minor,name_key,stock_ingredient_id'),
                 ('core.variant', 'active,barcode,name_key'),
                 ('core.option_group', 'max_select,min_select,name_key,required'),
                 ('core.option', 'active,name_key,price_delta_minor'),
                 ('core.outlet', 'accepting_orders,address,business_day_cutoff,busy_extra_min,cancel_window_min,default_prep_min,name,'
                              || 'pickup_lead_min,pickup_slot_min,reschedule_window_min,tax_ids,tz,upi_vpa')) v(t, cols)
    LEFT JOIN LATERAL (SELECT string_agg(a.attname, ',' ORDER BY a.attname) AS cols FROM pg_attribute a, aclexplode(a.attacl) x
                        WHERE a.attrelid = v.t::regclass AND a.attnum > 0 AND x.grantee = 'munim_core'::regrole AND x.privilege_type = 'UPDATE') g ON true
   WHERE g.cols IS DISTINCT FROM v.cols OR has_table_privilege('munim_core', v.t, 'UPDATE');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0029: munim_core UPDATE lists are not the ones 0029 re-issues: %', bad; END IF;

  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attnum > 0 AND NOT attisdropped
                AND ((attrelid = ANY (ARRAY['core.item', 'core.variant', 'core.option_group', 'core.option']::regclass[]) AND attname IN ('display_name', 'description'))
                  OR (attrelid = 'core.item'::regclass AND attname = 'diet') OR (attrelid = 'core.outlet'::regclass AND attname = 'phone'))) THEN
    RAISE EXCEPTION '0029: a display / diet / phone column already exists';
  END IF;

  IF pg_get_function_result('core.cares_network_listings(text, uuid, uuid, uuid, integer)'::regprocedure)
     IS DISTINCT FROM 'TABLE(listing_id uuid, city_code text, business_name text, outlet_name text, pickup_from timestamp with time zone, '
                   || 'pickup_to timestamp with time zone, recipient_name text, recipient_simulated boolean, lines jsonb)' THEN
    RAISE EXCEPTION '0029: core.cares_network_listings does not return the 0028 columns 0029 extends';
  END IF;
  IF has_column_privilege('munim_crosstenant', 'core.outlet', 'tz', 'SELECT') THEN
    RAISE EXCEPTION '0029: munim_crosstenant already reads core.outlet.tz';
  END IF;
END $$;

------------------------------------------------------------------------------------------------------------
-- 1. D1 + D2 — columns (nullable, no default: no existing row changes)
------------------------------------------------------------------------------------------------------------
ALTER TABLE core.item
  ADD COLUMN display_name text CONSTRAINT item_display_name_check CHECK (char_length(display_name) BETWEEN 1 AND 120),
  ADD COLUMN description  text CONSTRAINT item_description_check  CHECK (char_length(description) BETWEEN 1 AND 500),
  ADD COLUMN diet         text CONSTRAINT item_diet_check         CHECK (diet IN ('veg', 'non_veg', 'egg', 'vegan'));
ALTER TABLE core.variant
  ADD COLUMN display_name text CONSTRAINT variant_display_name_check CHECK (char_length(display_name) BETWEEN 1 AND 120),
  ADD COLUMN description  text CONSTRAINT variant_description_check  CHECK (char_length(description) BETWEEN 1 AND 500);
ALTER TABLE core.option_group
  ADD COLUMN display_name text CONSTRAINT option_group_display_name_check CHECK (char_length(display_name) BETWEEN 1 AND 120),
  ADD COLUMN description  text CONSTRAINT option_group_description_check  CHECK (char_length(description) BETWEEN 1 AND 500);
ALTER TABLE core.option
  ADD COLUMN display_name text CONSTRAINT option_display_name_check CHECK (char_length(display_name) BETWEEN 1 AND 120),
  ADD COLUMN description  text CONSTRAINT option_description_check  CHECK (char_length(description) BETWEEN 1 AND 500);
ALTER TABLE core.outlet
  ADD COLUMN phone text CONSTRAINT outlet_phone_check CHECK (phone ~ '^\+[1-9][0-9]{6,14}$');

------------------------------------------------------------------------------------------------------------
-- 2. G — munim_core UPDATE lists: revoke, then grant the prior list plus the new columns
------------------------------------------------------------------------------------------------------------
REVOKE UPDATE ON core.item, core.variant, core.option_group, core.option, core.outlet FROM munim_core;
GRANT UPDATE (name_key, category, brand_id, barcode, stock_ingredient_id, active, mrp_minor, currency, display_name, description, diet)
  ON core.item TO munim_core;
GRANT UPDATE (name_key, barcode, active, display_name, description) ON core.variant TO munim_core;
GRANT UPDATE (name_key, min_select, max_select, required, display_name, description) ON core.option_group TO munim_core;
GRANT UPDATE (name_key, price_delta_minor, active, display_name, description) ON core.option TO munim_core;
GRANT UPDATE (name, tz, address, tax_ids, accepting_orders, busy_extra_min, default_prep_min, cancel_window_min, reschedule_window_min,
  pickup_slot_min, pickup_lead_min, upi_vpa, business_day_cutoff, phone) ON core.outlet TO munim_core;

------------------------------------------------------------------------------------------------------------
-- 3. X1 — core.cares_network_listings + outlet_tz (0028 §11 body, one column appended)
------------------------------------------------------------------------------------------------------------
DROP FUNCTION core.cares_network_listings(text, uuid, uuid, uuid, integer);
CREATE FUNCTION core.cares_network_listings(p_city text, p_tenant uuid, p_listing uuid, p_after uuid, p_limit integer)
RETURNS TABLE (listing_id uuid, city_code text, business_name text, outlet_name text, pickup_from timestamptz, pickup_to timestamptz,
               recipient_name text, recipient_simulated boolean, lines jsonb, outlet_tz text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT l.id, co.city_code, pr.public_name, o.name, l.pickup_from, l.pickup_to, rc.name, rc.simulated,
         (SELECT jsonb_agg(jsonb_build_object('line_no', ll.line_no, 'food_kind', ll.food_kind, 'label_key', i.name_key, 'label', g.name,
                                              'qty_milli', ll.qty_milli, 'unit', ll.unit, 'expires_on', ll.expires_on) ORDER BY ll.line_no)
            FROM core.cares_listing_line ll
            LEFT JOIN core.item i ON i.tenant_id = ll.tenant_id AND i.id = ll.item_id
            LEFT JOIN core.ingredient g ON g.tenant_id = ll.tenant_id AND g.id = ll.ingredient_id
           WHERE ll.tenant_id = l.tenant_id AND ll.listing_id = l.id),
         o.tz
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

GRANT SELECT (tz) ON core.outlet TO munim_crosstenant;
GRANT CREATE ON SCHEMA core TO munim_crosstenant;
ALTER FUNCTION core.cares_network_listings(text, uuid, uuid, uuid, integer) OWNER TO munim_crosstenant;
REVOKE CREATE ON SCHEMA core FROM munim_crosstenant;
REVOKE ALL ON FUNCTION core.cares_network_listings(text, uuid, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.cares_network_listings(text, uuid, uuid, uuid, integer) TO munim_core;

------------------------------------------------------------------------------------------------------------
-- 4. Post-conditions (read back what Postgres holds; never trust IF NOT EXISTS)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
  five constant text[] := ARRAY['core.item', 'core.variant', 'core.option_group', 'core.option', 'core.outlet'];
BEGIN
  SELECT string_agg(x, ', ') INTO bad FROM (
    -- D1 + D2: the nine columns, text, nullable, no default.
    SELECT 'columns' AS x WHERE (SELECT string_agg(c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod)
                                                   || CASE WHEN a.attnotnull THEN ':notnull' ELSE '' END || CASE WHEN a.atthasdef THEN ':default' ELSE '' END,
                                                   ',' ORDER BY c.relname, a.attname)
                                   FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                                  WHERE a.attrelid = ANY (five::regclass[]) AND a.attnum > 0 AND NOT a.attisdropped
                                    AND a.attname IN ('display_name', 'description', 'diet', 'phone'))
      IS DISTINCT FROM 'item.description:text,item.diet:text,item.display_name:text,option.description:text,option.display_name:text,'
                    || 'option_group.description:text,option_group.display_name:text,outlet.phone:text,variant.description:text,variant.display_name:text'
    UNION ALL
    -- The CHECKs, as written.
    SELECT 'checks' WHERE (SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), ' | ' ORDER BY conname) FROM pg_constraint
                            WHERE conrelid = ANY (five::regclass[]) AND contype = 'c'
                              AND conname ~ '_(display_name|description|diet|phone)_check$')
      IS DISTINCT FROM $d$item_description_check=CHECK (((char_length(description) >= 1) AND (char_length(description) <= 500)))$d$
                    || $d$ | item_diet_check=CHECK ((diet = ANY (ARRAY['veg'::text, 'non_veg'::text, 'egg'::text, 'vegan'::text])))$d$
                    || $d$ | item_display_name_check=CHECK (((char_length(display_name) >= 1) AND (char_length(display_name) <= 120)))$d$
                    || $d$ | option_description_check=CHECK (((char_length(description) >= 1) AND (char_length(description) <= 500)))$d$
                    || $d$ | option_display_name_check=CHECK (((char_length(display_name) >= 1) AND (char_length(display_name) <= 120)))$d$
                    || $d$ | option_group_description_check=CHECK (((char_length(description) >= 1) AND (char_length(description) <= 500)))$d$
                    || $d$ | option_group_display_name_check=CHECK (((char_length(display_name) >= 1) AND (char_length(display_name) <= 120)))$d$
                    || $d$ | outlet_phone_check=CHECK ((phone ~ '^\+[1-9][0-9]{6,14}$'::text))$d$
                    || $d$ | variant_description_check=CHECK (((char_length(description) >= 1) AND (char_length(description) <= 500)))$d$
                    || $d$ | variant_display_name_check=CHECK (((char_length(display_name) >= 1) AND (char_length(display_name) <= 120)))$d$
    UNION ALL
    -- G: munim_core's UPDATE lists exactly as granted (no table-level UPDATE).
    SELECT 'core-update:' || v.t FROM (VALUES
        ('core.item', 'active,barcode,brand_id,category,currency,description,diet,display_name,mrp_minor,name_key,stock_ingredient_id'),
        ('core.variant', 'active,barcode,description,display_name,name_key'),
        ('core.option_group', 'description,display_name,max_select,min_select,name_key,required'),
        ('core.option', 'active,description,display_name,name_key,price_delta_minor'),
        ('core.outlet', 'accepting_orders,address,business_day_cutoff,busy_extra_min,cancel_window_min,default_prep_min,name,phone,'
                     || 'pickup_lead_min,pickup_slot_min,reschedule_window_min,tax_ids,tz,upi_vpa')) v(t, cols)
     WHERE has_table_privilege('munim_core', v.t, 'UPDATE') OR NOT has_table_privilege('munim_core', v.t, 'SELECT')
        OR (SELECT string_agg(a.attname, ',' ORDER BY a.attname) FROM pg_attribute a, aclexplode(a.attacl) x
             WHERE a.attrelid = v.t::regclass AND a.attnum > 0 AND x.grantee = 'munim_core'::regrole AND x.privilege_type = 'UPDATE') IS DISTINCT FROM v.cols
    UNION ALL
    -- No other role writes the five tables' new columns; only munim_core and munim_svc read them; nobody DELETEs.
    SELECT 'others:' || r || '.' || c FROM unnest(ARRAY['munim_svc', 'munim_intel_ro', 'munim_crosstenant', 'munim_view_owner', 'munim_platform']) r,
           unnest(ARRAY['core.item:display_name', 'core.item:description', 'core.item:diet', 'core.variant:display_name', 'core.variant:description',
                        'core.option_group:display_name', 'core.option_group:description', 'core.option:display_name', 'core.option:description',
                        'core.outlet:phone']) c
     WHERE has_column_privilege(r, split_part(c, ':', 1), split_part(c, ':', 2), 'INSERT') OR has_column_privilege(r, split_part(c, ':', 1), split_part(c, ':', 2), 'UPDATE')
        OR (r <> 'munim_svc' AND has_column_privilege(r, split_part(c, ':', 1), split_part(c, ':', 2), 'SELECT'))
        OR has_table_privilege(r, split_part(c, ':', 1), 'DELETE')
    UNION ALL
    -- RLS still enabled and forced on the five (isolation is untouched: no policy is created or dropped here).
    SELECT 'rls:' || c.relname FROM pg_class c WHERE c.oid = ANY (five::regclass[]) AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
    UNION ALL
    -- Still book tables behind the guard.
    SELECT 'book:' || c.relname FROM pg_class c WHERE c.oid = ANY (five::regclass[])
       AND (obj_description(c.oid, 'pg_class') IS DISTINCT FROM 'munim:book'
            OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'book_guard' AND t.tgenabled = 'O'))
    UNION ALL
    -- X1: the re-created read — result columns, owner, definer, STABLE, pinned search_path, EXECUTE munim_core only, read-only body.
    SELECT 'definer' FROM pg_proc p WHERE p.oid = 'core.cares_network_listings(text, uuid, uuid, uuid, integer)'::regprocedure
       AND (pg_get_function_result(p.oid) IS DISTINCT FROM 'TABLE(listing_id uuid, city_code text, business_name text, outlet_name text, '
                || 'pickup_from timestamp with time zone, pickup_to timestamp with time zone, recipient_name text, recipient_simulated boolean, lines jsonb, outlet_tz text)'
            OR NOT p.prosecdef OR p.proowner <> 'munim_crosstenant'::regrole OR p.provolatile <> 's'
            OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']
            OR NOT has_function_privilege('munim_core', p.oid, 'EXECUTE')
            OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee NOT IN (p.proowner, 'munim_core'::regrole))
            OR p.prosrc ~* '\m(insert|update|delete|merge|truncate|copy|nextval|setval|set_config|pg_advisory\w*)\M')
    UNION ALL
    -- X1: munim_crosstenant reads exactly these core.outlet columns, and no table-level privilege there.
    SELECT 'crosstenant-outlet' WHERE (SELECT string_agg(a.attname || ':' || x.privilege_type, ',' ORDER BY a.attname) FROM pg_attribute a, aclexplode(a.attacl) x
                                        WHERE a.attrelid = 'core.outlet'::regclass AND x.grantee = 'munim_crosstenant'::regrole)
                                       IS DISTINCT FROM 'id:SELECT,name:SELECT,tenant_id:SELECT,tz:SELECT'
       OR has_table_privilege('munim_crosstenant', 'core.outlet', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
       OR has_schema_privilege('munim_crosstenant', 'core', 'CREATE')
    UNION ALL
    -- No row carries a new value yet (this file writes none).
    SELECT 'rows' WHERE EXISTS (SELECT 1 FROM core.item WHERE display_name IS NOT NULL OR description IS NOT NULL OR diet IS NOT NULL)
       OR EXISTS (SELECT 1 FROM core.variant WHERE display_name IS NOT NULL OR description IS NOT NULL)
       OR EXISTS (SELECT 1 FROM core.option_group WHERE display_name IS NOT NULL OR description IS NOT NULL)
       OR EXISTS (SELECT 1 FROM core.option WHERE display_name IS NOT NULL OR description IS NOT NULL)
       OR EXISTS (SELECT 1 FROM core.outlet WHERE phone IS NOT NULL)) y;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0029: storefront display columns not as written: %', bad; END IF;

  PERFORM munim_meta.assert_catalog('0029');
END $$;
