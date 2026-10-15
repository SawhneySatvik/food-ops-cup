-- 0030_display_order — T-115 menu display order (lane B1 report §6 items 2–3), migrator lane D, fix forward over 0001–0029.
-- Runs as munim_migrator. Additive: four NOT NULL integer columns with a constant default (metadata only in Postgres 11+: no
-- row is rewritten, no trigger fires, book_guard and origin are untouched) and munim_core's UPDATE lists on three tables
-- re-issued (revoke-then-grant) with the new column added. No table, index, policy, trigger, function, command type or
-- derivation rule is added or changed.
-- Items:
--   P1  `position` (integer ≥ 0, default 0) on core.item, core.variant, core.option_group and core.option: the display order.
--       Reads order by position, then name_key (items within their category), so every row that exists today (all 0) keeps
--       its current order. Book columns (munim:book, book_guard unchanged), written only by catalogue.item.upsert.v1 (its
--       target_tables already list all four tables): a variant's, option group's or option's position is its index in the
--       command's own array (INSERT and UPDATE); an item's is set once, on INSERT, to the tenant's next value (the order the
--       owner added items). No contract field carries it, so core.item.position needs no UPDATE grant.
--       Outlets get no column: no command can carry an outlet position without a tenancy contract field, so the storefront
--       lists outlets by created_at (the order the owner opened them), then name.
--   G   munim_core UPDATE on core.variant, core.option_group, core.option: REVOKE UPDATE (which also drops the column grants),
--       then GRANT the 0029 lists back plus `position`. core.item keeps its 0029 list. INSERT stays table-level (0004).
-- New SQLSTATEs: none (23514 from the CHECKs).

------------------------------------------------------------------------------------------------------------
-- 0. Pre-checks: what this file builds on is the shape it builds on.
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(v.t || ' has ' || coalesce(g.cols, '(none)'), '; ') INTO bad
    FROM (VALUES ('core.item', 'active,barcode,brand_id,category,currency,description,diet,display_name,mrp_minor,name_key,stock_ingredient_id'),
                 ('core.variant', 'active,barcode,description,display_name,name_key'),
                 ('core.option_group', 'description,display_name,max_select,min_select,name_key,required'),
                 ('core.option', 'active,description,display_name,name_key,price_delta_minor')) v(t, cols)
    LEFT JOIN LATERAL (SELECT string_agg(a.attname, ',' ORDER BY a.attname) AS cols FROM pg_attribute a, aclexplode(a.attacl) x
                        WHERE a.attrelid = v.t::regclass AND a.attnum > 0 AND x.grantee = 'munim_core'::regrole AND x.privilege_type = 'UPDATE') g ON true
   WHERE g.cols IS DISTINCT FROM v.cols OR has_table_privilege('munim_core', v.t, 'UPDATE') OR NOT has_table_privilege('munim_core', v.t, 'INSERT');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0030: munim_core grants are not the ones 0030 builds on: %', bad; END IF;

  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attnum > 0 AND NOT attisdropped AND attname = 'position'
                AND attrelid = ANY (ARRAY['core.item', 'core.variant', 'core.option_group', 'core.option', 'core.outlet']::regclass[])) THEN
    RAISE EXCEPTION '0030: a position column already exists';
  END IF;
END $$;

------------------------------------------------------------------------------------------------------------
-- 1. P1 — columns (constant default: no existing row is rewritten; every existing row reads 0)
------------------------------------------------------------------------------------------------------------
ALTER TABLE core.item         ADD COLUMN position integer NOT NULL DEFAULT 0 CONSTRAINT item_position_check         CHECK (position >= 0);
ALTER TABLE core.variant      ADD COLUMN position integer NOT NULL DEFAULT 0 CONSTRAINT variant_position_check      CHECK (position >= 0);
ALTER TABLE core.option_group ADD COLUMN position integer NOT NULL DEFAULT 0 CONSTRAINT option_group_position_check CHECK (position >= 0);
ALTER TABLE core.option       ADD COLUMN position integer NOT NULL DEFAULT 0 CONSTRAINT option_position_check       CHECK (position >= 0);

------------------------------------------------------------------------------------------------------------
-- 2. G — munim_core UPDATE lists: revoke, then grant the 0029 list plus position
------------------------------------------------------------------------------------------------------------
REVOKE UPDATE ON core.variant, core.option_group, core.option FROM munim_core;
GRANT UPDATE (name_key, barcode, active, display_name, description, position) ON core.variant TO munim_core;
GRANT UPDATE (name_key, min_select, max_select, required, display_name, description, position) ON core.option_group TO munim_core;
GRANT UPDATE (name_key, price_delta_minor, active, display_name, description, position) ON core.option TO munim_core;

------------------------------------------------------------------------------------------------------------
-- 3. Post-conditions (read back what Postgres holds; never trust IF NOT EXISTS)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
  four constant text[] := ARRAY['core.item', 'core.variant', 'core.option_group', 'core.option'];
BEGIN
  SELECT string_agg(x, ', ') INTO bad FROM (
    -- P1: the four columns, integer, NOT NULL, default 0; core.outlet has none.
    SELECT 'columns' AS x WHERE (SELECT string_agg(c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod)
                                                   || CASE WHEN a.attnotnull THEN ':notnull' ELSE '' END || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), 'nodefault'),
                                                   ',' ORDER BY c.relname)
                                   FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                                   LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                                  WHERE c.relnamespace = 'core'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped AND a.attname = 'position')
      IS DISTINCT FROM 'item.position:integer:notnull:0,option.position:integer:notnull:0,option_group.position:integer:notnull:0,variant.position:integer:notnull:0'
    UNION ALL
    -- The CHECKs, as written.
    SELECT 'checks' WHERE (SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), ' | ' ORDER BY conname) FROM pg_constraint
                            WHERE conrelid = ANY (four::regclass[]) AND contype = 'c' AND conname ~ '_position_check$')
      -- (ruleutils quotes the name: POSITION is a keyword, though not reserved for column names)
      IS DISTINCT FROM 'item_position_check=CHECK (("position" >= 0)) | option_group_position_check=CHECK (("position" >= 0))'
                    || ' | option_position_check=CHECK (("position" >= 0)) | variant_position_check=CHECK (("position" >= 0))'
    UNION ALL
    -- G: munim_core's UPDATE lists exactly as granted (no table-level UPDATE; core.item without position); INSERT table-level.
    SELECT 'core-update:' || v.t FROM (VALUES
        ('core.item', 'active,barcode,brand_id,category,currency,description,diet,display_name,mrp_minor,name_key,stock_ingredient_id'),
        ('core.variant', 'active,barcode,description,display_name,name_key,position'),
        ('core.option_group', 'description,display_name,max_select,min_select,name_key,position,required'),
        ('core.option', 'active,description,display_name,name_key,position,price_delta_minor')) v(t, cols)
     WHERE has_table_privilege('munim_core', v.t, 'UPDATE') OR NOT has_table_privilege('munim_core', v.t, 'SELECT,INSERT')
        OR (SELECT string_agg(a.attname, ',' ORDER BY a.attname) FROM pg_attribute a, aclexplode(a.attacl) x
             WHERE a.attrelid = v.t::regclass AND a.attnum > 0 AND x.grantee = 'munim_core'::regrole AND x.privilege_type = 'UPDATE') IS DISTINCT FROM v.cols
    UNION ALL
    -- No other role writes position; only munim_core and munim_svc read it; nobody DELETEs.
    SELECT 'others:' || r || '.' || t FROM unnest(ARRAY['munim_svc', 'munim_intel_ro', 'munim_crosstenant', 'munim_view_owner', 'munim_platform']) r, unnest(four) t
     WHERE has_column_privilege(r, t, 'position', 'INSERT') OR has_column_privilege(r, t, 'position', 'UPDATE')
        OR (r <> 'munim_svc' AND has_column_privilege(r, t, 'position', 'SELECT'))
        OR has_table_privilege(r, t, 'DELETE')
    UNION ALL
    -- RLS still enabled and forced on the four (isolation is untouched: no policy is created or dropped here).
    SELECT 'rls:' || c.relname FROM pg_class c WHERE c.oid = ANY (four::regclass[]) AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
    UNION ALL
    -- Still book tables behind the guard.
    SELECT 'book:' || c.relname FROM pg_class c WHERE c.oid = ANY (four::regclass[])
       AND (obj_description(c.oid, 'pg_class') IS DISTINCT FROM 'munim:book'
            OR NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'book_guard' AND t.tgenabled = 'O'))
    UNION ALL
    -- No row carries a position yet (this file writes none).
    SELECT 'rows' WHERE EXISTS (SELECT 1 FROM core.item WHERE position <> 0) OR EXISTS (SELECT 1 FROM core.variant WHERE position <> 0)
       OR EXISTS (SELECT 1 FROM core.option_group WHERE position <> 0) OR EXISTS (SELECT 1 FROM core.option WHERE position <> 0)) y;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0030: display order columns not as written: %', bad; END IF;

  PERFORM munim_meta.assert_catalog('0030');
END $$;
