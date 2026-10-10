-- 0019_mc1a_templates_outlet_rls — W3.0 M-C1a (ADR-014 §12, BOARD W3.0 row m-1), migrator lane m-1, fix forward over
-- 0001–0018. Runs as munim_migrator. Items:
--   O1  Outlet-scoped RLS on the outlet-data tables that still had the tenant-only policy (review R1-m9: latent until
--       outlet-scoped templates exist — they exist from this file on). The R1-m9 list (18) was checked against the
--       catalogue: every core table with an `outlet_id` column and a `tenant_isolation` policy. The check found three
--       more, scoped here too: core.conversation and core.market_signal (outlet data, outlet NULL = tenant-wide) and
--       core.ticket_counter (its counter value is an outlet's order count for a day). Same predicate as every
--       tenant_outlet_isolation policy since 0014, plus `outlet_id IS NULL` (a tenant-wide row stays tenant-visible,
--       as 0015 A3) on the eleven tables where the column is nullable.
--   O2  Their child rows, which carry no outlet column, are readable exactly when their parent is (as 0015 did for
--       amc/maintenance): core.settlement_line (settlement), core.payroll_draft_line (payroll draft), core.tip_pool_share
--       (tip pool), core.message (conversation). NOT core.posting: a parent policy on it made the deferred balance
--       trigger (core.journal_entry_balanced, once per posting at commit) plan a scan of the journal per call inside a
--       large import — seeding the worldgen store world went from 11.6 s to 35.7 s and restaurant_group from 21.8 s to
--       71.6 s (measured 11 Oct, embedded PG 18), quadratic in the import's size. Postings stay tenant-visible; every
--       template reads them through their journal entry (template gate, tests/templates.test.ts).
--   T1  evidence.snapshot_template.min_role gains the 'advisor' rung (settles the reverted W2-R8); the eight finance
--       templates are min_role 'advisor' (advisors are read-only finance users, R27), the six catalogue ones 'manager'.
--       The ladder itself is core-api's (approvals/snapshots.ts RANK, which today ranks advisor with staff — it must
--       change with this file, or staff could open every 'advisor' template). Advisor sits above staff; whether it sits
--       above or below manager is an authority call outside this file (lane report: staff < manager < advisor < owner
--       keeps managers out of finance, as W2-R8 and the finance routes do).
--   T2  numeric_source may be a list (ADR-014 §14 C6): a numeric column names its source as one string or a non-empty
--       array of strings (each 'core.<table>.<column>', 'count:core.<table>' or an intel allow-list entry; the
--       template-scan gate checks every element). Enforced here as a CHECK on the shape; the allow-list is the gate's.
--       Template SQL never ends with ';' (core-api wraps it as a subquery) — also a CHECK.
--   T3  Fourteen templates: catalogue (6, packs/catalogue.md §3), finance (7, packs/finance.md §3, finance.pnl and
--       finance.gst_check as core-api's FINANCE_TEMPLATES wrote them) and finance.margin_bridge (ADR-014 §7.3). Every
--       template runs under the minting context's RLS; tenant and outlet scope come from the minter, `outlet_id`
--       params only narrow it (R40 C4). finance.gst_summary (FINANCE_TEMPLATES, in no pack §3 table) is not installed:
--       it belongs to the non-pack list of M-C1d.
-- New SQLSTATEs: none.

------------------------------------------------------------------------------------------------------------
-- 1. O1 — outlet RLS on the outlet-data tables
------------------------------------------------------------------------------------------------------------
-- Each table must still carry exactly the tenant-only policy this replaces (an unexpected state stops the file).
DO $$
DECLARE
  t       text;
  nul     boolean;
  base    constant text := $c$tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND ((SELECT current_setting('app.role', true)) IN ('customer', 'guest')
              OR (SELECT current_setting('app.outlet_ids', true)) = '{*}'
              $c$;
  own     constant text := $c$OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[]))$c$;
BEGIN
  FOREACH t IN ARRAY ARRAY['bank_line', 'budget', 'bulk_order', 'business_policy', 'conversation', 'expense', 'hiring_candidate',
                           'journal_entry', 'market_signal', 'payroll_draft', 'period_close', 'price', 'reconciliation_break',
                           'reservation', 'review', 'roster', 'settlement', 'staff', 'tax_return_draft', 'ticket_counter', 'tip_pool'] LOOP
    IF (SELECT count(*) FROM pg_policy p WHERE p.polrelid = ('core.' || t)::regclass AND p.polpermissive) <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = ('core.' || t)::regclass AND p.polname = 'tenant_isolation') THEN
      RAISE EXCEPTION '0019: core.% does not carry exactly the tenant_isolation policy 0019 replaces', t;
    END IF;
    SELECT NOT a.attnotnull INTO nul FROM pg_attribute a WHERE a.attrelid = ('core.' || t)::regclass AND a.attname = 'outlet_id';
    EXECUTE format('DROP POLICY tenant_isolation ON core.%I', t);
    EXECUTE format('CREATE POLICY tenant_outlet_isolation ON core.%I USING (%s) WITH CHECK (%s)', t,
                   base || CASE WHEN nul THEN 'OR outlet_id IS NULL ' ELSE '' END || own,
                   base || CASE WHEN nul THEN 'OR outlet_id IS NULL ' ELSE '' END || own);
  END LOOP;
END $$;

------------------------------------------------------------------------------------------------------------
-- 2. O2 — child rows readable exactly when their parent is (the subquery runs under the parent's policy)
------------------------------------------------------------------------------------------------------------
-- USING (reads, and the rows an UPDATE may touch) goes through the parent. WITH CHECK (new rows) stays the tenant
-- check on the three book children: a caller may write a parent and its children in one statement, where the policy
-- cannot see the parent yet, and the book guard already refuses a book row under a parent the writer cannot see
-- (book_scope 'parent', 0014). core.message is operational (no guard), so its WITH CHECK goes through the parent too.
DO $$
DECLARE
  r      record;
  tenant constant text := $c$tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)$c$;
  via    text;
BEGIN
  FOR r IN SELECT * FROM (VALUES ('settlement_line', 'settlement', 'settlement_id', false),
                                 ('payroll_draft_line', 'payroll_draft', 'payroll_draft_id', false), ('tip_pool_share', 'tip_pool', 'tip_pool_id', false),
                                 ('message', 'conversation', 'conversation_id', true)) v(child, parent, fk, check_parent) LOOP
    IF (SELECT count(*) FROM pg_policy p WHERE p.polrelid = ('core.' || r.child)::regclass AND p.polpermissive) <> 1
       OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = ('core.' || r.child)::regclass AND p.polname = 'tenant_isolation') THEN
      RAISE EXCEPTION '0019: core.% does not carry exactly the tenant_isolation policy 0019 replaces', r.child;
    END IF;
    via := format('%s AND EXISTS (SELECT 1 FROM core.%I x WHERE x.tenant_id = %I.tenant_id AND x.id = %I.%I)', tenant, r.parent, r.child, r.child, r.fk);
    EXECUTE format('DROP POLICY tenant_isolation ON core.%I', r.child);
    EXECUTE format('CREATE POLICY tenant_via_parent ON core.%I USING (%s) WITH CHECK (%s)', r.child, via,
                   CASE WHEN r.check_parent THEN via ELSE tenant END);
  END LOOP;
END $$;

------------------------------------------------------------------------------------------------------------
-- 3. T1 + T2 — snapshot_template: the advisor rung, numeric_source as a string or a list, no trailing ';'
------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'evidence.snapshot_template'::regclass AND c.conname = 'snapshot_template_min_role_check')
     IS DISTINCT FROM $d$CHECK ((min_role = ANY (ARRAY['staff'::text, 'manager'::text, 'owner'::text, 'operator'::text])))$d$ THEN
    RAISE EXCEPTION '0019: snapshot_template_min_role_check is not the 0003 CHECK 0019 replaces';
  END IF;
END $$;
ALTER TABLE evidence.snapshot_template DROP CONSTRAINT snapshot_template_min_role_check;
ALTER TABLE evidence.snapshot_template ADD CONSTRAINT snapshot_template_min_role_check
  CHECK (min_role IN ('staff', 'advisor', 'manager', 'owner', 'operator'));
-- A numeric column (integer / numeric) names its source: a non-empty string, or a non-empty array of non-empty strings.
ALTER TABLE evidence.snapshot_template ADD CONSTRAINT snapshot_template_numeric_sourced
  CHECK (NOT jsonb_path_exists(columns, '$[*] ? ((@.type == "integer" || @.type == "numeric")
           && !(exists(@.numeric_source ? (@.type() == "string" && @ != "")) && !exists(@.numeric_source[*] ? (@.type() != "string" || @ == ""))))'));
-- core-api runs a template as `SELECT … FROM (<sql>) t`: a trailing ';' would break it.
ALTER TABLE evidence.snapshot_template ADD CONSTRAINT snapshot_template_sql_no_semicolon CHECK (sql !~ ';\s*$');

------------------------------------------------------------------------------------------------------------
-- 4. T3 — catalogue templates (packs/catalogue.md §3), min_role manager
------------------------------------------------------------------------------------------------------------
-- Shared by dish_margin, menu_matrix and deal_cost: the true unit cost of each item on :to (recipe version valid on
-- :to; each line at the latest landed cost received in scope on or before :to, else the latest supplier price quoted
-- in the line's own unit; uplifted by the larger of the recipe's waste allowance and the waste observed in scope over
-- :from..:to). A shop SKU is one base unit of its stock record. `lines_unpriced` > 0 → no cost (the margin abstains).
DO $$
DECLARE
  cost constant text := $f$WITH pk AS (
  SELECT (cp.doc -> 'tax' ->> 'price_display') = 'inclusive' AS inclusive, cp.doc -> 'tax' -> 'classes' AS classes
    FROM core.tenant t JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
   WHERE cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')),
conv (from_unit, to_unit, f) AS (VALUES ('kg', 'g', 1000::numeric), ('g', 'kg', 0.001), ('l', 'ml', 1000), ('ml', 'l', 0.001)),
rv AS (
  SELECT DISTINCT ON (r.item_id) r.tenant_id, r.item_id, r.id, r.yield_qty_milli
    FROM core.recipe_version r
   WHERE r.variant_id IS NULL AND r.valid_from <= :to::date AND (r.valid_to IS NULL OR r.valid_to > :to::date)
   ORDER BY r.item_id, r.valid_from DESC, r.version DESC),
lc AS (
  SELECT DISTINCT ON (m.ingredient_id) m.ingredient_id, m.unit, m.unit_cost_per_1000_minor AS per1000
    FROM core.stock_movement m JOIN core.outlet o ON o.tenant_id = m.tenant_id AND o.id = m.outlet_id
   WHERE m.kind = 'receipt' AND m.unit_cost_per_1000_minor IS NOT NULL AND (m.at AT TIME ZONE o.tz)::date <= :to::date
     AND (:outlet_id::uuid IS NULL OR m.outlet_id = :outlet_id::uuid)
   ORDER BY m.ingredient_id, m.at DESC, m.id DESC),
sp AS (
  SELECT DISTINCT ON (s.ingredient_id, s.unit) s.ingredient_id, s.unit, s.unit_price_minor * 1000 AS per1000
    FROM core.supplier_price s
   WHERE s.observed_at::date <= :to::date
   ORDER BY s.ingredient_id, s.unit, s.observed_at DESC, s.id DESC),
ow AS (
  SELECT m.ingredient_id,
         round(coalesce(-sum(m.qty_milli) FILTER (WHERE m.kind = 'waste'), 0) * 10000
               / nullif(-sum(m.qty_milli) FILTER (WHERE m.kind = 'sale_consumption'), 0)) AS bp
    FROM core.stock_movement m JOIN core.outlet o ON o.tenant_id = m.tenant_id AND o.id = m.outlet_id
   WHERE (:outlet_id::uuid IS NULL OR m.outlet_id = :outlet_id::uuid)
     AND (m.at AT TIME ZONE o.tz)::date BETWEEN :from::date AND :to::date
   GROUP BY m.ingredient_id),
src AS (
  SELECT rv.item_id, rv.id AS recipe_version_id, rv.yield_qty_milli, r.ingredient_id, r.qty_milli, r.unit, r.waste_pct_bp
    FROM rv JOIN core.recipe_line r ON r.tenant_id = rv.tenant_id AND r.recipe_version_id = rv.id
  UNION ALL
  SELECT i.id, NULL, 1000, i.stock_ingredient_id, 1000, g.base_unit, 0
    FROM core.item i JOIN core.ingredient g ON g.tenant_id = i.tenant_id AND g.id = i.stock_ingredient_id
   WHERE NOT EXISTS (SELECT 1 FROM rv WHERE rv.item_id = i.id)),
lines AS (
  SELECT rl.item_id, rl.recipe_version_id, rl.yield_qty_milli, rl.qty_milli, rl.waste_pct_bp,
         coalesce(ow.bp, 0) AS observed_bp,
         coalesce(CASE WHEN lc.unit = rl.unit THEN lc.per1000 ELSE lc.per1000 * cv.f END, sp.per1000) AS per1000
    FROM src rl
    LEFT JOIN ow ON ow.ingredient_id = rl.ingredient_id
    LEFT JOIN lc ON lc.ingredient_id = rl.ingredient_id
    LEFT JOIN conv cv ON cv.from_unit = rl.unit AND cv.to_unit = lc.unit
    LEFT JOIN sp ON sp.ingredient_id = rl.ingredient_id AND sp.unit = rl.unit),
cost AS (
  SELECT item_id, recipe_version_id,
         count(*) FILTER (WHERE per1000 IS NULL) AS lines_unpriced,
         sum(qty_milli * per1000 * (10000 + greatest(waste_pct_bp, observed_bp))) / (10000000.0 * min(yield_qty_milli)) AS unit_cost,
         sum(qty_milli * per1000 * greatest(observed_bp - waste_pct_bp, 0)) / (10000000.0 * min(yield_qty_milli)) AS excess_unit,
         round(sum(qty_milli * waste_pct_bp) / nullif(sum(qty_milli), 0)) AS recipe_waste_bp,
         round(sum(qty_milli * observed_bp) / nullif(sum(qty_milli), 0)) AS observed_waste_bp
    FROM lines GROUP BY item_id, recipe_version_id)$f$;
  sales_src constant jsonb := '["core.order_line.qty_milli", "core.order_line.unit_price_minor", "core.order_line.line_discount_minor", "core.order_line.tax_minor"]';
  cost_src  constant jsonb := '["core.recipe_line.qty_milli", "core.recipe_line.waste_pct_bp", "core.recipe_version.yield_qty_milli", "core.stock_movement.unit_cost_per_1000_minor", "core.stock_movement.qty_milli", "core.supplier_price.unit_price_minor"]';
  window_params constant jsonb := '{"outlet_id": {"type": ["string", "null"], "format": "uuid"},
                                     "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}';
BEGIN
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
    'catalogue.dish_margin', 1,
    cost || $q$,
sold AS (
  SELECT ol.item_id, sum(ol.qty_milli) AS qty_milli,
         sum(round(ol.qty_milli * ol.unit_price_minor / 1000.0) - ol.line_discount_minor
             - CASE WHEN pk.inclusive THEN ol.tax_minor ELSE 0 END) AS net_minor
    FROM core."order" o
    JOIN core.order_line ol ON ol.tenant_id = o.tenant_id AND ol.order_id = o.id
    JOIN core.channel ch ON ch.tenant_id = o.tenant_id AND ch.id = o.channel_id
    CROSS JOIN pk
   WHERE o.status = 'completed' AND o.business_date BETWEEN :from::date AND :to::date
     AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)
     AND (:channel_kind::text IS NULL OR ch.kind = :channel_kind::text)
   GROUP BY ol.item_id),
policy AS (
  SELECT b.target_margin_bp FROM core.business_policy b
   WHERE b.valid_from <= :to::date AND (b.valid_to IS NULL OR b.valid_to > :to::date)
     AND (b.outlet_id IS NULL OR b.outlet_id = :outlet_id::uuid)
   ORDER BY b.outlet_id IS NULL, b.valid_from DESC, b.id LIMIT 1),
rate AS (
  SELECT DISTINCT ON (p.item_id) p.item_id, (c ->> 'rate_bp')::integer AS rate_bp
    FROM core.price p CROSS JOIN pk CROSS JOIN LATERAL jsonb_array_elements(pk.classes) c
   WHERE c ->> 'code' = p.tax_class AND (:outlet_id::uuid IS NULL OR p.outlet_id = :outlet_id::uuid)
     AND p.valid_from <= :to::date AND (p.valid_to IS NULL OR p.valid_to > :to::date)
   ORDER BY p.item_id, p.valid_from DESC, p.id),
m AS (
  SELECT s.item_id, c.recipe_version_id, s.qty_milli, s.net_minor, c.lines_unpriced, c.recipe_waste_bp, c.observed_waste_bp,
         CASE WHEN c.lines_unpriced = 0 THEN c.unit_cost END AS unit_cost,
         CASE WHEN c.lines_unpriced = 0 THEN c.excess_unit END AS excess_unit
    FROM sold s LEFT JOIN cost c ON c.item_id = s.item_id)
SELECT m.item_id, m.recipe_version_id,
       round(m.qty_milli / 1000.0)::bigint AS units_sold,
       rank() OVER (ORDER BY m.qty_milli DESC)::bigint AS units_rank,
       m.net_minor::bigint AS net_sales_minor,
       round(m.unit_cost)::bigint AS unit_cost_minor,
       m.observed_waste_bp::bigint AS observed_waste_bp,
       m.recipe_waste_bp::bigint AS recipe_waste_bp,
       (m.net_minor - round(m.qty_milli * m.unit_cost / 1000))::bigint AS margin_minor,
       greatest(round(m.qty_milli * m.unit_cost / 1000) - m.net_minor, 0)::bigint AS loss_minor,
       round((m.net_minor - round(m.qty_milli * m.unit_cost / 1000)) * 10000 / nullif(m.net_minor, 0))::bigint AS margin_bp,
       round(m.qty_milli * m.excess_unit / 1000)::bigint AS excess_waste_minor,
       round(m.unit_cost * 10000 / nullif(10000 - (SELECT target_margin_bp FROM policy), 0)
             * (10000 + CASE WHEN (SELECT inclusive FROM pk) THEN coalesce(r.rate_bp, 0) ELSE 0 END) / 10000)::bigint AS suggested_price_minor,
       m.lines_unpriced::bigint AS lines_unpriced
  FROM m LEFT JOIN rate r ON r.item_id = m.item_id
 ORDER BY units_rank, m.item_id$q$,
    jsonb_build_object('type', 'object', 'required', '["outlet_id", "channel_kind", "from", "to"]'::jsonb, 'additionalProperties', false,
      'properties', window_params || '{"channel_kind": {"type": ["string", "null"]}}'),
    jsonb_build_array(
      '{"name": "item_id", "type": "uuid"}'::jsonb,
      '{"name": "recipe_version_id", "type": "uuid"}'::jsonb,
      '{"name": "units_sold", "type": "integer", "numeric_source": "core.order_line.qty_milli"}'::jsonb,
      '{"name": "units_rank", "type": "integer", "numeric_source": "core.order_line.qty_milli"}'::jsonb,
      jsonb_build_object('name', 'net_sales_minor', 'type', 'integer', 'numeric_source', sales_src),
      jsonb_build_object('name', 'unit_cost_minor', 'type', 'integer', 'numeric_source', cost_src),
      '{"name": "observed_waste_bp", "type": "integer", "numeric_source": "core.stock_movement.qty_milli"}'::jsonb,
      '{"name": "recipe_waste_bp", "type": "integer", "numeric_source": ["core.recipe_line.waste_pct_bp", "core.recipe_line.qty_milli"]}'::jsonb,
      jsonb_build_object('name', 'margin_minor', 'type', 'integer', 'numeric_source', sales_src || cost_src),
      jsonb_build_object('name', 'loss_minor', 'type', 'integer', 'numeric_source', sales_src || cost_src),
      jsonb_build_object('name', 'margin_bp', 'type', 'integer', 'numeric_source', sales_src || cost_src),
      jsonb_build_object('name', 'excess_waste_minor', 'type', 'integer', 'numeric_source', cost_src || '["core.order_line.qty_milli"]'),
      jsonb_build_object('name', 'suggested_price_minor', 'type', 'integer', 'numeric_source', cost_src || '["core.business_policy.target_margin_bp"]'),
      '{"name": "lines_unpriced", "type": "integer", "numeric_source": "count:core.recipe_line"}'::jsonb),
    'manager');

  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
    'catalogue.menu_matrix', 1,
    cost || $q$,
sold AS (
  SELECT ol.item_id, sum(ol.qty_milli) AS qty_milli,
         sum(round(ol.qty_milli * ol.unit_price_minor / 1000.0) - ol.line_discount_minor
             - CASE WHEN pk.inclusive THEN ol.tax_minor ELSE 0 END) AS net_minor
    FROM core."order" o
    JOIN core.order_line ol ON ol.tenant_id = o.tenant_id AND ol.order_id = o.id
    CROSS JOIN pk
   WHERE o.status = 'completed' AND o.business_date BETWEEN :from::date AND :to::date
     AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)
   GROUP BY ol.item_id),
m AS (
  SELECT s.item_id, s.qty_milli,
         s.net_minor - round(s.qty_milli * CASE WHEN c.lines_unpriced = 0 THEN c.unit_cost END / 1000) AS margin,
         count(*) OVER () AS n, sum(s.qty_milli) OVER () AS all_qty
    FROM sold s LEFT JOIN cost c ON c.item_id = s.item_id),
k AS (
  -- Menu engineering: popular = at least 70% of an even share of units; profitable = contribution per unit at or
  -- above the menu's average (priced items only).
  SELECT m.*, round(m.qty_milli * 10000 / nullif(m.all_qty, 0)) AS share_bp,
         sum(m.margin) OVER () / nullif(sum(m.qty_milli) FILTER (WHERE m.margin IS NOT NULL) OVER (), 0) AS avg_cm
    FROM m)
SELECT k.item_id, k.share_bp::bigint AS units_share_bp, k.margin::bigint AS margin_minor,
       CASE WHEN k.margin IS NULL THEN NULL
            WHEN k.share_bp * k.n >= 7000 AND k.margin / nullif(k.qty_milli, 0) >= k.avg_cm THEN 'star'
            WHEN k.share_bp * k.n >= 7000 THEN 'plough_horse'
            WHEN k.margin / nullif(k.qty_milli, 0) >= k.avg_cm THEN 'puzzle'
            ELSE 'dog' END AS class
  FROM k
 ORDER BY k.share_bp DESC, k.item_id$q$,
    jsonb_build_object('type', 'object', 'required', '["outlet_id", "from", "to"]'::jsonb, 'additionalProperties', false, 'properties', window_params),
    jsonb_build_array(
      '{"name": "item_id", "type": "uuid"}'::jsonb,
      '{"name": "units_share_bp", "type": "integer", "numeric_source": "core.order_line.qty_milli"}'::jsonb,
      jsonb_build_object('name', 'margin_minor', 'type', 'integer', 'numeric_source', sales_src || cost_src),
      '{"name": "class", "type": "text"}'::jsonb),
    'manager');

  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
    'catalogue.deal_cost', 1,
    cost || $q$,
dl AS (
  -- The deal a line was priced under is the row ref the pricing function stored on the order (one deal per line).
  SELECT substring(r.ref FROM 'core\.deal:([0-9a-f-]{36})')::uuid AS deal_id, o.id AS order_id, ol.item_id, ol.qty_milli,
         ol.line_discount_minor,
         round(ol.qty_milli * ol.unit_price_minor / 1000.0) - ol.line_discount_minor
           - CASE WHEN pk.inclusive THEN ol.tax_minor ELSE 0 END AS net_minor
    FROM core."order" o
    JOIN core.order_line ol ON ol.tenant_id = o.tenant_id AND ol.order_id = o.id
    CROSS JOIN pk
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(o.pricing_snapshot -> 'lines', '[]')) sl
    CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(sl -> 'deal_refs', '[]')) r(ref)
   WHERE o.status = 'completed' AND o.business_date BETWEEN :from::date AND :to::date
     AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)
     AND sl ->> 'line_id' = ol.id::text AND r.ref ~ 'core\.deal:[0-9a-f-]{36}')
SELECT dl.deal_id, count(DISTINCT dl.order_id)::bigint AS orders, sum(dl.line_discount_minor)::bigint AS discount_minor,
       CASE WHEN bool_and(c.lines_unpriced = 0)
            THEN greatest(sum(round(dl.qty_milli * c.unit_cost / 1000)) - sum(dl.net_minor), 0) END::bigint AS deal_loss_minor
  FROM dl LEFT JOIN cost c ON c.item_id = dl.item_id
 GROUP BY dl.deal_id
 ORDER BY dl.deal_id$q$,
    jsonb_build_object('type', 'object', 'required', '["outlet_id", "from", "to"]'::jsonb, 'additionalProperties', false, 'properties', window_params),
    jsonb_build_array(
      '{"name": "deal_id", "type": "uuid"}'::jsonb,
      '{"name": "orders", "type": "integer", "numeric_source": "count:core.order"}'::jsonb,
      '{"name": "discount_minor", "type": "integer", "numeric_source": "core.order_line.line_discount_minor"}'::jsonb,
      jsonb_build_object('name', 'deal_loss_minor', 'type', 'integer', 'numeric_source', sales_src || cost_src)),
    'manager');
END $$;

INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'catalogue.cost_drift', 1,
  $q$WITH conv (from_unit, to_unit, f) AS (VALUES ('kg', 'g', 1000::numeric), ('g', 'kg', 0.001), ('l', 'ml', 1000), ('ml', 'l', 0.001)),
pr AS (
  -- The item's current price in scope (counter first, then the highest), and the day it was set.
  SELECT DISTINCT ON (p.item_id) p.item_id, p.amount_minor, p.valid_from
    FROM core.price p
   WHERE (:outlet_id::uuid IS NULL OR p.outlet_id = :outlet_id::uuid)
     AND p.valid_from <= current_date AND (p.valid_to IS NULL OR p.valid_to > current_date)
   ORDER BY p.item_id, p.channel_kind = 'counter' DESC, p.amount_minor DESC, p.id),
src AS (
  -- Cost basis per item: recipe lines with the recipe's own waste allowance (observed waste is dish_margin's); a shop
  -- SKU is one base unit of its stock record.
  SELECT r.item_id, r.yield_qty_milli, l.ingredient_id, l.qty_milli, l.unit, l.waste_pct_bp
    FROM core.recipe_version r JOIN core.recipe_line l ON l.tenant_id = r.tenant_id AND l.recipe_version_id = r.id
   WHERE r.id = (SELECT x.id FROM core.recipe_version x WHERE x.item_id = r.item_id AND x.variant_id IS NULL
                    AND x.valid_from <= current_date AND (x.valid_to IS NULL OR x.valid_to > current_date)
                  ORDER BY x.valid_from DESC, x.version DESC LIMIT 1)
  UNION ALL
  SELECT i.id, 1000, i.stock_ingredient_id, 1000, g.base_unit, 0
    FROM core.item i JOIN core.ingredient g ON g.tenant_id = i.tenant_id AND g.id = i.stock_ingredient_id
   WHERE NOT EXISTS (SELECT 1 FROM core.recipe_version x WHERE x.item_id = i.id)),
sales AS (
  SELECT ol.item_id, o.business_date AS d, sum(ol.qty_milli) AS qty_milli
    FROM core."order" o JOIN core.order_line ol ON ol.tenant_id = o.tenant_id AND ol.order_id = o.id
   WHERE o.status = 'completed' AND o.business_date >= :since::date
     AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)
   GROUP BY ol.item_id, o.business_date),
days AS (
  SELECT pr.item_id, pr.valid_from AS d FROM pr
  UNION SELECT pr.item_id, current_date FROM pr
  UNION SELECT s.item_id, s.d FROM sales s JOIN pr ON pr.item_id = s.item_id),
dc AS (
  -- Unit cost of an item on day d: each line at the latest landed cost on or before d, else the first one after it
  -- (the earliest known cost); null when a line has never been received.
  SELECT dy.item_id, dy.d,
         CASE WHEN bool_and(c.per1000 IS NOT NULL)
              THEN sum(s.qty_milli * CASE WHEN c.unit = s.unit THEN c.per1000 ELSE c.per1000 * cv.f END * (10000 + s.waste_pct_bp))
                   / (10000000.0 * min(s.yield_qty_milli)) END AS unit_cost
    FROM days dy
    JOIN src s ON s.item_id = dy.item_id
    LEFT JOIN LATERAL (
      SELECT m.unit, m.unit_cost_per_1000_minor AS per1000
        FROM core.stock_movement m JOIN core.outlet o ON o.tenant_id = m.tenant_id AND o.id = m.outlet_id
       WHERE m.ingredient_id = s.ingredient_id AND m.kind = 'receipt' AND m.unit_cost_per_1000_minor IS NOT NULL
         AND (:outlet_id::uuid IS NULL OR m.outlet_id = :outlet_id::uuid)
       ORDER BY (m.at AT TIME ZONE o.tz)::date > dy.d,
                CASE WHEN (m.at AT TIME ZONE o.tz)::date <= dy.d THEN -extract(epoch FROM m.at) ELSE extract(epoch FROM m.at) END,
                m.id DESC LIMIT 1) c ON true
    LEFT JOIN conv cv ON cv.from_unit = s.unit AND cv.to_unit = c.unit
   GROUP BY dy.item_id, dy.d),
x AS (
  SELECT pr.item_id, pr.amount_minor,
         (SELECT dc.unit_cost FROM dc WHERE dc.item_id = pr.item_id AND dc.d = pr.valid_from) AS cost_then,
         (SELECT dc.unit_cost FROM dc WHERE dc.item_id = pr.item_id AND dc.d = current_date) AS cost_now
    FROM pr)
-- cost_drift_minor: Σ over units sold since :since × (that day's unit cost − the cost when the price was set).
SELECT x.item_id, x.amount_minor::bigint AS price_minor, round(x.cost_then)::bigint AS cost_then_minor,
       round(x.cost_now)::bigint AS cost_now_minor,
       round((x.cost_now - x.cost_then) * 10000 / nullif(x.cost_then, 0))::bigint AS cost_change_bp,
       CASE WHEN x.cost_then IS NOT NULL
            THEN round(coalesce((SELECT sum(s.qty_milli * (dc.unit_cost - x.cost_then)) / 1000
                                   FROM sales s JOIN dc ON dc.item_id = s.item_id AND dc.d = s.d WHERE s.item_id = x.item_id), 0)) END::bigint AS cost_drift_minor
  FROM x
 WHERE x.item_id IN (SELECT item_id FROM src)
 ORDER BY x.item_id$q$,
  '{"type": "object", "required": ["outlet_id", "since"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "since": {"type": "string", "format": "date"}}}',
  '[{"name": "item_id", "type": "uuid"},
    {"name": "price_minor", "type": "integer", "numeric_source": "core.price.amount_minor"},
    {"name": "cost_then_minor", "type": "integer", "numeric_source": ["core.recipe_line.qty_milli", "core.recipe_line.waste_pct_bp", "core.recipe_version.yield_qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]},
    {"name": "cost_now_minor", "type": "integer", "numeric_source": ["core.recipe_line.qty_milli", "core.recipe_line.waste_pct_bp", "core.recipe_version.yield_qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]},
    {"name": "cost_change_bp", "type": "integer", "numeric_source": ["core.recipe_line.qty_milli", "core.recipe_line.waste_pct_bp", "core.recipe_version.yield_qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]},
    {"name": "cost_drift_minor", "type": "integer", "numeric_source": ["core.recipe_line.qty_milli", "core.recipe_line.waste_pct_bp", "core.recipe_version.yield_qty_milli", "core.stock_movement.unit_cost_per_1000_minor", "core.order_line.qty_milli"]}]',
  'manager');

INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'catalogue.sku_price_check', 1,
  $q$WITH pk AS (
  SELECT (cp.doc -> 'tax' ->> 'price_display') = 'inclusive' AS inclusive, cp.doc -> 'tax' -> 'classes' AS classes
    FROM core.tenant t JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
   WHERE cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')),
pr AS (
  -- The shelf price per SKU on :to (the highest current price in scope when several outlets or channels apply), as
  -- the buyer pays it: tax-inclusive (the MRP comparison, pack printed_price rule).
  SELECT DISTINCT ON (p.item_id) p.item_id, i.stock_ingredient_id, i.mrp_minor AS item_mrp, p.amount_minor,
         CASE WHEN pk.inclusive THEN p.amount_minor
              ELSE p.amount_minor + round(p.amount_minor * coalesce((tc.c ->> 'rate_bp')::integer, 0) / 10000.0) END AS incl_minor
    FROM core.price p
    JOIN core.item i ON i.tenant_id = p.tenant_id AND i.id = p.item_id AND i.kind = 'sku'
    CROSS JOIN pk
    LEFT JOIN LATERAL (SELECT c FROM jsonb_array_elements(pk.classes) c WHERE c ->> 'code' = p.tax_class) tc ON true
   WHERE (:outlet_id::uuid IS NULL OR p.outlet_id = :outlet_id::uuid)
     AND p.valid_from <= :to::date AND (p.valid_to IS NULL OR p.valid_to > :to::date)
   ORDER BY p.item_id, p.amount_minor DESC, p.id),
oh AS (
  -- Stock on hand per batch on :to, in scope.
  SELECT m.ingredient_id, m.batch_id, sum(m.qty_milli) AS qty_milli
    FROM core.stock_movement m JOIN core.outlet o ON o.tenant_id = m.tenant_id AND o.id = m.outlet_id
   WHERE (:outlet_id::uuid IS NULL OR m.outlet_id = :outlet_id::uuid) AND (m.at AT TIME ZONE o.tz)::date <= :to::date
   GROUP BY m.ingredient_id, m.batch_id HAVING sum(m.qty_milli) > 0),
bm AS (
  SELECT oh.ingredient_id, oh.qty_milli, b.mrp_minor FROM oh JOIN core.batch b ON b.id = oh.batch_id WHERE b.mrp_minor IS NOT NULL),
lc AS (
  SELECT DISTINCT ON (m.ingredient_id) m.ingredient_id, m.unit_cost_per_1000_minor AS per1000
    FROM core.stock_movement m JOIN core.outlet o ON o.tenant_id = m.tenant_id AND o.id = m.outlet_id
   WHERE m.kind = 'receipt' AND m.unit_cost_per_1000_minor IS NOT NULL AND (m.at AT TIME ZONE o.tz)::date <= :to::date
     AND (:outlet_id::uuid IS NULL OR m.outlet_id = :outlet_id::uuid)
   ORDER BY m.ingredient_id, m.at DESC, m.id DESC),
sold AS (
  SELECT ol.item_id, sum(ol.qty_milli) AS qty_milli,
         sum(round(ol.qty_milli * ol.unit_price_minor / 1000.0) - ol.line_discount_minor
             - CASE WHEN pk.inclusive THEN ol.tax_minor ELSE 0 END) AS net_minor
    FROM core."order" o
    JOIN core.order_line ol ON ol.tenant_id = o.tenant_id AND ol.order_id = o.id
    CROSS JOIN pk
   WHERE o.status = 'completed' AND o.business_date BETWEEN :from::date AND :to::date
     AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)
   GROUP BY ol.item_id),
x AS (
  SELECT pr.item_id, pr.amount_minor, pr.incl_minor,
         coalesce((SELECT min(bm.mrp_minor) FROM bm WHERE bm.ingredient_id = pr.stock_ingredient_id), pr.item_mrp) AS mrp_minor,
         round(lc.per1000 / 1000.0) AS landed_cost_minor,
         coalesce(s.qty_milli, 0) AS sold_milli, coalesce(s.net_minor, 0) AS net_minor,
         lc.per1000,
         (SELECT sum(greatest(pr.incl_minor - bm.mrp_minor, 0) * bm.qty_milli / 1000.0) FROM bm WHERE bm.ingredient_id = pr.stock_ingredient_id) AS above_on_hand
    FROM pr
    LEFT JOIN lc ON lc.ingredient_id = pr.stock_ingredient_id
    LEFT JOIN sold s ON s.item_id = pr.item_id)
-- above_mrp_minor: the excess over MRP on every unit sold in the window plus every unit on hand from a batch printed
-- below the shelf price (a sale of those is refused, so the exposure is the stock). below_cost_minor: landed cost of
-- the units sold minus what they sold for, when positive.
SELECT x.item_id, x.amount_minor::bigint AS price_minor, x.mrp_minor::bigint AS mrp_minor, x.landed_cost_minor::bigint AS landed_cost_minor,
       round(x.sold_milli / 1000.0)::bigint AS units,
       round(greatest(x.incl_minor - x.mrp_minor, 0) * x.sold_milli / 1000.0 + coalesce(x.above_on_hand, 0))::bigint AS above_mrp_minor,
       greatest(round(x.sold_milli * x.per1000 / 1000000.0) - x.net_minor, 0)::bigint AS below_cost_minor
  FROM x
 ORDER BY x.item_id$q$,
  '{"type": "object", "required": ["outlet_id", "from", "to"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
  '[{"name": "item_id", "type": "uuid"},
    {"name": "price_minor", "type": "integer", "numeric_source": "core.price.amount_minor"},
    {"name": "mrp_minor", "type": "integer", "numeric_source": ["core.batch.mrp_minor", "core.item.mrp_minor"]},
    {"name": "landed_cost_minor", "type": "integer", "numeric_source": "core.stock_movement.unit_cost_per_1000_minor"},
    {"name": "units", "type": "integer", "numeric_source": "core.order_line.qty_milli"},
    {"name": "above_mrp_minor", "type": "integer", "numeric_source": ["core.price.amount_minor", "core.batch.mrp_minor", "core.item.mrp_minor", "core.stock_movement.qty_milli", "core.order_line.qty_milli"]},
    {"name": "below_cost_minor", "type": "integer", "numeric_source": ["core.stock_movement.unit_cost_per_1000_minor", "core.order_line.qty_milli", "core.order_line.unit_price_minor", "core.order_line.line_discount_minor", "core.order_line.tax_minor"]}]',
  'manager');

INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'catalogue.recipe_current', 1,
  $q$WITH rv AS (
  SELECT r.tenant_id, r.id, r.yield_qty_milli
    FROM core.recipe_version r
   WHERE r.item_id = :item_id::uuid AND r.variant_id IS NULL AND r.valid_from <= current_date
     AND (r.valid_to IS NULL OR r.valid_to > current_date)
   ORDER BY r.valid_from DESC, r.version DESC LIMIT 1),
ow AS (
  -- Observed waste over the last 28 days in scope (INFERENCE window): waste ÷ sale consumption, in bp.
  SELECT m.ingredient_id,
         round(coalesce(-sum(m.qty_milli) FILTER (WHERE m.kind = 'waste'), 0) * 10000
               / nullif(-sum(m.qty_milli) FILTER (WHERE m.kind = 'sale_consumption'), 0)) AS bp
    FROM core.stock_movement m JOIN core.outlet o ON o.tenant_id = m.tenant_id AND o.id = m.outlet_id
   WHERE (:outlet_id::uuid IS NULL OR m.outlet_id = :outlet_id::uuid)
     AND (m.at AT TIME ZONE o.tz)::date > current_date - 28
   GROUP BY m.ingredient_id)
SELECT rv.id AS recipe_version_id,
       ((SELECT max(x.version) FROM core.recipe_version x WHERE x.item_id = :item_id::uuid AND x.variant_id IS NULL) + 1)::bigint AS next_version,
       rv.yield_qty_milli, rl.ingredient_id, rl.qty_milli, rl.waste_pct_bp::bigint AS waste_pct_bp,
       coalesce(ow.bp, 0)::bigint AS observed_waste_bp
  FROM rv
  JOIN core.recipe_line rl ON rl.tenant_id = rv.tenant_id AND rl.recipe_version_id = rv.id
  LEFT JOIN ow ON ow.ingredient_id = rl.ingredient_id
 ORDER BY rl.ingredient_id, rl.id$q$,
  '{"type": "object", "required": ["item_id", "outlet_id"], "additionalProperties": false,
    "properties": {"item_id": {"type": "string", "format": "uuid"}, "outlet_id": {"type": ["string", "null"], "format": "uuid"}}}',
  '[{"name": "recipe_version_id", "type": "uuid"},
    {"name": "next_version", "type": "integer", "numeric_source": "core.recipe_version.version"},
    {"name": "yield_qty_milli", "type": "integer", "numeric_source": "core.recipe_version.yield_qty_milli"},
    {"name": "ingredient_id", "type": "uuid"},
    {"name": "qty_milli", "type": "integer", "numeric_source": "core.recipe_line.qty_milli"},
    {"name": "waste_pct_bp", "type": "integer", "numeric_source": "core.recipe_line.waste_pct_bp"},
    {"name": "observed_waste_bp", "type": "integer", "numeric_source": "core.stock_movement.qty_milli"}]',
  'manager');

------------------------------------------------------------------------------------------------------------
-- 5. T3 — finance templates (packs/finance.md §3) + finance.margin_bridge (ADR-014 §7.3), min_role advisor
------------------------------------------------------------------------------------------------------------
-- finance.pnl and finance.gst_check: core-api's FINANCE_TEMPLATES (services/core-api/src/modules/finance/read.ts) with
-- the role codes resolved (core-domain finance ROLES / PNL_GROUPS: cogs 5000 + 5100, channel fees 6000 + 6010, labour
-- 6300, output tax 2100). Same columns and numeric sources as written there; min_role moves from owner to advisor (T1).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'finance.pnl', 1,
  $q$SELECT coalesce((CASE :group_by::text WHEN 'outlet' THEN je.outlet_id WHEN 'brand' THEN je.brand_id WHEN 'channel' THEN je.channel_id END)::text, 'unassigned') AS key,
       coalesce(-sum(p.amount_minor) FILTER (WHERE a.type = 'income'), 0)::bigint AS revenue_minor,
       coalesce(sum(p.amount_minor) FILTER (WHERE a.code IN ('5000', '5100')), 0)::bigint AS cogs_minor,
       coalesce(sum(p.amount_minor) FILTER (WHERE a.code IN ('6000', '6010')), 0)::bigint AS channel_fees_minor,
       coalesce(sum(p.amount_minor) FILTER (WHERE a.code IN ('6300')), 0)::bigint AS labour_minor,
       coalesce(sum(p.amount_minor) FILTER (WHERE a.type = 'expense' AND a.code NOT IN ('5000', '5100', '6000', '6010', '6300')), 0)::bigint AS other_minor,
       (-sum(p.amount_minor))::bigint AS net_minor
  FROM core.journal_entry je
  JOIN core.posting p ON p.tenant_id = je.tenant_id AND p.journal_entry_id = je.id
  JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id
 WHERE a.type IN ('income', 'expense') AND :group_by::text IN ('outlet', 'brand', 'channel')
   AND je.entry_date >= :period_month::date AND je.entry_date < (:period_month::date + interval '1 month')
 GROUP BY 1 ORDER BY 1$q$,
  '{"type": "object", "required": ["period_month", "group_by"], "additionalProperties": false,
    "properties": {"period_month": {"type": "string", "format": "date"}, "group_by": {"type": "string", "enum": ["outlet", "brand", "channel"]}}}',
  '[{"name": "key", "type": "text"},
    {"name": "revenue_minor", "type": "integer", "numeric_source": "core.posting.amount_minor"},
    {"name": "cogs_minor", "type": "integer", "numeric_source": "core.posting.amount_minor"},
    {"name": "channel_fees_minor", "type": "integer", "numeric_source": "core.posting.amount_minor"},
    {"name": "labour_minor", "type": "integer", "numeric_source": "core.posting.amount_minor"},
    {"name": "other_minor", "type": "integer", "numeric_source": "core.posting.amount_minor"},
    {"name": "net_minor", "type": "integer", "numeric_source": "core.posting.amount_minor"}]',
  'advisor');

INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'finance.gst_check', 1,
  $q$WITH excluded AS (
  -- Orders whose tax the operator pays (pack aggregators with tax_treatment operator_collects_excluded) are not the
  -- merchant's output tax: the same reading as finance.post_order.
  SELECT 'aggregator:' || (a ->> 'code') AS kind
    FROM core.tenant t
    JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
    CROSS JOIN LATERAL jsonb_array_elements(cp.doc -> 'aggregators') a
   WHERE a ->> 'tax_treatment' = 'operator_collects_excluded'
     AND cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')),
ot AS (
  SELECT o.outlet_id, sum(o.tax_minor)::bigint AS order_tax_minor
    FROM core."order" o JOIN core.channel ch ON ch.tenant_id = o.tenant_id AND ch.id = o.channel_id
   WHERE o.status = 'completed' AND o.business_date >= :period_month::date AND o.business_date < (:period_month::date + interval '1 month')
     AND ch.kind NOT IN (SELECT kind FROM excluded)
   GROUP BY o.outlet_id),
pt AS (
  SELECT je.outlet_id, (-sum(p.amount_minor))::bigint AS posted_tax_minor
    FROM core.journal_entry je
    JOIN core.posting p ON p.tenant_id = je.tenant_id AND p.journal_entry_id = je.id
    JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id
   WHERE je.posting_rule = 'finance.post_order' AND a.code IN ('2100')
     AND je.entry_date >= :period_month::date AND je.entry_date < (:period_month::date + interval '1 month')
   GROUP BY je.outlet_id)
SELECT coalesce(ot.outlet_id, pt.outlet_id) AS outlet_id, coalesce(ot.order_tax_minor, 0) AS order_tax_minor,
       coalesce(pt.posted_tax_minor, 0) AS posted_tax_minor, coalesce(pt.posted_tax_minor, 0) - coalesce(ot.order_tax_minor, 0) AS diff_minor
  FROM ot FULL JOIN pt ON pt.outlet_id = ot.outlet_id
 ORDER BY 1$q$,
  '{"type": "object", "required": ["period_month"], "additionalProperties": false,
    "properties": {"period_month": {"type": "string", "format": "date"}}}',
  '[{"name": "outlet_id", "type": "uuid"},
    {"name": "order_tax_minor", "type": "integer", "numeric_source": "core.order.tax_minor"},
    {"name": "posted_tax_minor", "type": "integer", "numeric_source": "core.posting.amount_minor"},
    {"name": "diff_minor", "type": "integer", "numeric_source": "core.posting.amount_minor"}]',
  'advisor');

INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'finance.unapproved_deductions', 1,
  $q$WITH s AS (
  -- The channel-month's payout lines: settlements whose period ends in :month, in scope.
  SELECT st.tenant_id, st.channel_id, sum(sl.ad_fee_minor) AS ad_fee, sum(sl.promo_share_minor) AS promo,
         sum(sl.gross_minor) FILTER (WHERE sl.line_kind = 'order') AS order_gross
    FROM core.settlement st
    JOIN core.settlement_line sl ON sl.tenant_id = st.tenant_id AND sl.settlement_id = st.id
   WHERE date_trunc('month', st.period_to) = date_trunc('month', :month::date)
     AND (:channel_id::uuid IS NULL OR st.channel_id = :channel_id::uuid)
     AND (:outlet_id::uuid IS NULL OR st.outlet_id = :outlet_id::uuid)
   GROUP BY st.tenant_id, st.channel_id),
x AS (
  -- What the owner agreed for that month (no terms: every allowance is unknown, so nothing is called unapproved).
  SELECT s.channel_id, s.ad_fee, s.promo, ct.ads_opted_in,
         CASE WHEN ct.id IS NULL THEN NULL WHEN ct.ads_opted_in THEN least(s.ad_fee, coalesce(ct.ad_spend_cap_minor, s.ad_fee)) ELSE 0 END AS ad_allowed,
         CASE WHEN ct.id IS NULL THEN NULL ELSE least(s.promo, round(coalesce(s.order_gross, 0) * ct.promo_share_bp / 10000.0)) END AS promo_allowed
    FROM s
    LEFT JOIN core.channel_terms ct ON ct.tenant_id = s.tenant_id AND ct.channel_id = s.channel_id
     AND date_trunc('month', :month::date)::date >= ct.valid_from AND (ct.valid_to IS NULL OR date_trunc('month', :month::date)::date < ct.valid_to))
SELECT x.channel_id, x.ad_fee::bigint AS ad_fee_minor, x.promo::bigint AS promo_share_minor,
       x.ad_allowed::bigint AS ad_allowed_minor, x.promo_allowed::bigint AS promo_allowed_minor,
       (x.ad_fee - x.ad_allowed + x.promo - x.promo_allowed)::bigint AS unapproved_minor, x.ads_opted_in
  FROM x
 ORDER BY x.channel_id$q$,
  '{"type": "object", "required": ["channel_id", "month", "outlet_id"], "additionalProperties": false,
    "properties": {"channel_id": {"type": ["string", "null"], "format": "uuid"}, "month": {"type": "string", "format": "date"},
                   "outlet_id": {"type": ["string", "null"], "format": "uuid"}}}',
  '[{"name": "channel_id", "type": "uuid"},
    {"name": "ad_fee_minor", "type": "integer", "numeric_source": "core.settlement_line.ad_fee_minor"},
    {"name": "promo_share_minor", "type": "integer", "numeric_source": "core.settlement_line.promo_share_minor"},
    {"name": "ad_allowed_minor", "type": "integer", "numeric_source": ["core.channel_terms.ad_spend_cap_minor", "core.settlement_line.ad_fee_minor"]},
    {"name": "promo_allowed_minor", "type": "integer", "numeric_source": ["core.channel_terms.promo_share_bp", "core.settlement_line.gross_minor", "core.settlement_line.promo_share_minor"]},
    {"name": "unapproved_minor", "type": "integer", "numeric_source": ["core.settlement_line.ad_fee_minor", "core.settlement_line.promo_share_minor", "core.channel_terms.ad_spend_cap_minor", "core.channel_terms.promo_share_bp", "core.settlement_line.gross_minor"]},
    {"name": "ads_opted_in", "type": "boolean"}]',
  'advisor');

INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'finance.settlement_vs_orders', 1,
  $q$WITH op AS (
  -- Aggregator channels whose operator collects the order's tax (pack aggregators, tax_treatment operator_collects_excluded).
  SELECT 'aggregator:' || (a ->> 'code') AS kind
    FROM core.tenant t
    JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
    CROSS JOIN LATERAL jsonb_array_elements(cp.doc -> 'aggregators') a
   WHERE a ->> 'tax_treatment' = 'operator_collects_excluded'
     AND cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')),
l AS (
  -- expected net = gross − contracted commission − tax withheld (the order's own tax where the operator collects it,
  -- the statement's figure otherwise, packs/finance.md §2) − refunds we recorded on that order; short = expected − paid.
  SELECT sl.id AS settlement_line_id, sl.matched_order_id, o.total_minor AS order_total, sl.commission_minor, sl.net_minor,
         round(sl.gross_minor * ct.commission_bp / 10000.0) AS expected_commission,
         coalesce((SELECT sum(r.amount_minor) FROM core.refund r WHERE r.tenant_id = sl.tenant_id AND r.order_id = sl.matched_order_id), 0) AS refund,
         sl.gross_minor - round(sl.gross_minor * ct.commission_bp / 10000.0)
           - CASE WHEN o.id IS NOT NULL AND ch.kind IN (SELECT kind FROM op) THEN o.tax_minor ELSE sl.tax_withheld_minor END
           - coalesce((SELECT sum(r.amount_minor) FROM core.refund r WHERE r.tenant_id = sl.tenant_id AND r.order_id = sl.matched_order_id), 0)
           AS expected_net,
         st.period_to
    FROM core.settlement st
    JOIN core.settlement_line sl ON sl.tenant_id = st.tenant_id AND sl.settlement_id = st.id AND sl.line_kind = 'order'
    JOIN core.channel ch ON ch.tenant_id = st.tenant_id AND ch.id = st.channel_id
    LEFT JOIN core."order" o ON o.tenant_id = sl.tenant_id AND o.id = sl.matched_order_id
    LEFT JOIN core.channel_terms ct ON ct.tenant_id = st.tenant_id AND ct.channel_id = st.channel_id
     AND st.period_to >= ct.valid_from AND (ct.valid_to IS NULL OR st.period_to < ct.valid_to)
   WHERE st.period_to BETWEEN :from::date AND :to::date
     AND (:channel_id::uuid IS NULL OR st.channel_id = :channel_id::uuid)
     AND (:outlet_id::uuid IS NULL OR st.outlet_id = :outlet_id::uuid))
SELECT settlement_line_id, matched_order_id, order_total_minor, commission_minor, net_minor, expected_commission_minor,
       refund_minor, expected_net_minor, short_minor
  FROM (SELECT 0 AS k, l.period_to, l.settlement_line_id, l.matched_order_id, l.order_total::bigint AS order_total_minor,
               l.commission_minor::bigint AS commission_minor, l.net_minor::bigint AS net_minor,
               l.expected_commission::bigint AS expected_commission_minor, l.refund::bigint AS refund_minor,
               l.expected_net::bigint AS expected_net_minor, (l.expected_net - l.net_minor)::bigint AS short_minor
          FROM l
        UNION ALL
        -- The Σ row: null ids, every amount summed.
        SELECT 1, NULL, NULL, NULL, coalesce(sum(l.order_total), 0)::bigint, coalesce(sum(l.commission_minor), 0)::bigint, coalesce(sum(l.net_minor), 0)::bigint,
               coalesce(sum(l.expected_commission), 0)::bigint, coalesce(sum(l.refund), 0)::bigint, coalesce(sum(l.expected_net), 0)::bigint,
               coalesce(sum(l.expected_net - l.net_minor), 0)::bigint
          FROM l) z
 ORDER BY z.k, z.period_to, z.settlement_line_id$q$,
  '{"type": "object", "required": ["channel_id", "from", "to", "outlet_id"], "additionalProperties": false,
    "properties": {"channel_id": {"type": ["string", "null"], "format": "uuid"}, "from": {"type": "string", "format": "date"},
                   "to": {"type": "string", "format": "date"}, "outlet_id": {"type": ["string", "null"], "format": "uuid"}}}',
  '[{"name": "settlement_line_id", "type": "uuid"},
    {"name": "matched_order_id", "type": "uuid"},
    {"name": "order_total_minor", "type": "integer", "numeric_source": "core.order.total_minor"},
    {"name": "commission_minor", "type": "integer", "numeric_source": "core.settlement_line.commission_minor"},
    {"name": "net_minor", "type": "integer", "numeric_source": "core.settlement_line.net_minor"},
    {"name": "expected_commission_minor", "type": "integer", "numeric_source": ["core.settlement_line.gross_minor", "core.channel_terms.commission_bp"]},
    {"name": "refund_minor", "type": "integer", "numeric_source": "core.refund.amount_minor"},
    {"name": "expected_net_minor", "type": "integer", "numeric_source": ["core.settlement_line.gross_minor", "core.channel_terms.commission_bp", "core.order.tax_minor", "core.settlement_line.tax_withheld_minor", "core.refund.amount_minor"]},
    {"name": "short_minor", "type": "integer", "numeric_source": ["core.settlement_line.gross_minor", "core.channel_terms.commission_bp", "core.order.tax_minor", "core.settlement_line.tax_withheld_minor", "core.refund.amount_minor", "core.settlement_line.net_minor"]}]',
  'advisor');

INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'finance.missing_payouts', 1,
  $q$WITH op AS (
  SELECT 'aggregator:' || (a ->> 'code') AS kind
    FROM core.tenant t
    JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
    CROSS JOIN LATERAL jsonb_array_elements(cp.doc -> 'aggregators') a
   WHERE a ->> 'tax_treatment' = 'operator_collects_excluded'
     AND cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')),
done AS (
  -- Completed aggregator orders and the business day they completed on (the completion event, else the order's date).
  SELECT o.id, o.total_minor, o.tax_minor, o.channel_id, ch.kind, o.external_ref,
         coalesce((SELECT max((e.at AT TIME ZONE ou.tz)::date) FROM core.order_event e
                    WHERE e.tenant_id = o.tenant_id AND e.order_id = o.id AND e.to_status = 'completed'), o.business_date) AS completed_on
    FROM core."order" o
    JOIN core.channel ch ON ch.tenant_id = o.tenant_id AND ch.id = o.channel_id AND ch.kind LIKE 'aggregator:%'
    JOIN core.outlet ou ON ou.tenant_id = o.tenant_id AND ou.id = o.outlet_id
   WHERE o.status = 'completed' AND o.business_date <= :as_of::date
     AND (:channel_id::uuid IS NULL OR o.channel_id = :channel_id::uuid)
     AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)),
m AS (
  -- Never on a payout line (matched, or by the channel's own order reference). Every such order is listed with its age;
  -- the channel's cycle and the "missing" threshold are the detector's (packs/finance.md §4).
  SELECT d.id, d.total_minor, (:as_of::date - d.completed_on) AS days_unsettled,
         d.total_minor - round(d.total_minor * coalesce(ct.commission_bp, 0) / 10000.0)
           - CASE WHEN d.kind IN (SELECT kind FROM op) THEN d.tax_minor ELSE 0 END AS expected_net
    FROM done d
    LEFT JOIN core.channel_terms ct ON ct.channel_id = d.channel_id
     AND d.completed_on >= ct.valid_from AND (ct.valid_to IS NULL OR d.completed_on < ct.valid_to)
   WHERE NOT EXISTS (SELECT 1 FROM core.settlement_line sl JOIN core.settlement st ON st.tenant_id = sl.tenant_id AND st.id = sl.settlement_id
                      WHERE st.channel_id = d.channel_id
                        AND (sl.matched_order_id = d.id OR (d.external_ref IS NOT NULL AND sl.external_order_ref = d.external_ref))))
SELECT order_id, order_total_minor, expected_net_minor, days_unsettled
  FROM (SELECT 0 AS k, m.id AS order_id, m.total_minor::bigint AS order_total_minor, m.expected_net::bigint AS expected_net_minor,
               m.days_unsettled::bigint AS days_unsettled
          FROM m
        UNION ALL
        -- The Σ row.
        SELECT 1, NULL, coalesce(sum(m.total_minor), 0)::bigint, coalesce(sum(m.expected_net), 0)::bigint, NULL FROM m) z
 ORDER BY z.k, z.days_unsettled DESC, z.order_id$q$,
  '{"type": "object", "required": ["channel_id", "as_of", "outlet_id"], "additionalProperties": false,
    "properties": {"channel_id": {"type": ["string", "null"], "format": "uuid"}, "as_of": {"type": "string", "format": "date"},
                   "outlet_id": {"type": ["string", "null"], "format": "uuid"}}}',
  '[{"name": "order_id", "type": "uuid"},
    {"name": "order_total_minor", "type": "integer", "numeric_source": "core.order.total_minor"},
    {"name": "expected_net_minor", "type": "integer", "numeric_source": ["core.order.total_minor", "core.channel_terms.commission_bp", "core.order.tax_minor"]},
    {"name": "days_unsettled", "type": "integer", "numeric_source": ["core.order_event.at", "core.order.business_date"]}]',
  'advisor');

INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'finance.tender_vs_bank', 1,
  $q$WITH ou AS (
  -- Outlets in the minter's scope (core.outlet itself is tenant-visible), narrowed by :outlet_id.
  SELECT o.id, o.tz, o.business_day_cutoff, o.upi_vpa FROM core.outlet o
   WHERE (:outlet_id::uuid IS NULL OR o.id = :outlet_id::uuid)
     AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
          OR o.id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[]))),
t AS (
  -- Tenders by business day (the outlet's zone and day cutoff), with the shift that recorded them.
  SELECT ((t.at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date AS d, t.amount_minor, t.shift_id
    FROM core.tender t JOIN ou ON ou.id = t.outlet_id
   WHERE t.method = :method::text),
tb AS (SELECT d, sum(amount_minor) AS tendered FROM t WHERE d BETWEEN :from::date AND :to::date GROUP BY d),
bk AS (
  -- Bank credits for the method: lines of the outlet, or tenant-wide lines paid to the outlet's own UPI VPA.
  SELECT b.value_date AS d, sum(b.amount_minor) AS credited
    FROM core.bank_line b
   WHERE b.amount_minor > 0 AND b.method = :method::text AND b.value_date BETWEEN :from::date AND :to::date
     AND (b.outlet_id IN (SELECT id FROM ou) OR (b.outlet_id IS NULL AND b.payee_vpa IN (SELECT upi_vpa FROM ou)))
   GROUP BY b.value_date),
v AS (
  SELECT ((x.at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date AS d, count(*) AS voids, sum(x.amount_minor) AS void_minor
    FROM core.void x JOIN ou ON ou.id = x.outlet_id
   GROUP BY 1),
med AS (
  -- The median voids per trading day over the window (days with tenders count, with 0 voids if none).
  SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY coalesce(v.voids, 0)))::bigint AS m
    FROM tb LEFT JOIN v ON v.d = tb.d),
sm AS (
  -- The member whose shift took most of the day's tendered amount for the method.
  SELECT DISTINCT ON (t.d) t.d, s.opened_by
    FROM t JOIN core.shift s ON s.id = t.shift_id
   WHERE t.d BETWEEN :from::date AND :to::date
   GROUP BY t.d, s.opened_by
   ORDER BY t.d, sum(t.amount_minor) DESC, s.opened_by),
days AS (SELECT d FROM tb UNION SELECT d FROM bk)
SELECT days.d AS business_on, coalesce(tb.tendered, 0)::bigint AS tendered_minor, coalesce(bk.credited, 0)::bigint AS credited_minor,
       (coalesce(tb.tendered, 0) - coalesce(bk.credited, 0))::bigint AS gap_minor,
       coalesce(v.voids, 0)::bigint AS voids, coalesce(v.void_minor, 0)::bigint AS void_minor,
       (SELECT m FROM med) AS outlet_median_voids, sm.opened_by AS shift_member_id
  FROM days
  LEFT JOIN tb ON tb.d = days.d
  LEFT JOIN bk ON bk.d = days.d
  LEFT JOIN v ON v.d = days.d
  LEFT JOIN sm ON sm.d = days.d
 ORDER BY days.d$q$,
  '{"type": "object", "required": ["outlet_id", "method", "from", "to"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "method": {"type": "string", "enum": ["cash", "card", "upi"]},
                   "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
  '[{"name": "business_on", "type": "date"},
    {"name": "tendered_minor", "type": "integer", "numeric_source": "core.tender.amount_minor"},
    {"name": "credited_minor", "type": "integer", "numeric_source": "core.bank_line.amount_minor"},
    {"name": "gap_minor", "type": "integer", "numeric_source": ["core.tender.amount_minor", "core.bank_line.amount_minor"]},
    {"name": "voids", "type": "integer", "numeric_source": "count:core.void"},
    {"name": "void_minor", "type": "integer", "numeric_source": "core.void.amount_minor"},
    {"name": "outlet_median_voids", "type": "integer", "numeric_source": "count:core.void"},
    {"name": "shift_member_id", "type": "uuid"}]',
  'advisor');

INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'finance.close_status', 1,
  $q$WITH mo AS (SELECT :period_month::date AS m0, (:period_month::date + interval '1 month')::date AS m1),
pk AS (
  SELECT cp.doc ->> 'payroll_scope' AS payroll_scope
    FROM core.tenant t JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
   WHERE cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')),
ou AS (
  -- Outlets in the minter's scope (core.outlet itself is tenant-visible), narrowed by :outlet_id.
  SELECT o.id, o.tz, o.business_day_cutoff FROM core.outlet o
   WHERE (:outlet_id::uuid IS NULL OR o.id = :outlet_id::uuid)
     AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
          OR o.id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[]))),
ord AS (
  SELECT o.outlet_id, o.channel_id, o.business_date, ch.kind
    FROM core."order" o JOIN ou ON ou.id = o.outlet_id JOIN core.channel ch ON ch.tenant_id = o.tenant_id AND ch.id = o.channel_id, mo
   WHERE o.status = 'completed' AND o.business_date >= mo.m0 AND o.business_date < mo.m1),
-- pos_days_closed: every trading day (a completed order) has a closed shift that opened on that business day.
pos AS (
  SELECT count(*) AS open_count FROM (SELECT DISTINCT outlet_id, business_date FROM ord) d
   WHERE NOT EXISTS (SELECT 1 FROM core.shift s JOIN ou ON ou.id = s.outlet_id
                      WHERE s.outlet_id = d.outlet_id AND s.status = 'closed'
                        AND ((s.opened_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date = d.business_date)),
-- settlements_imported: every completed aggregator order's day lies inside a settlement period of its channel.
stl AS (
  SELECT count(*) AS open_count FROM ord
   WHERE ord.kind LIKE 'aggregator:%'
     AND NOT EXISTS (SELECT 1 FROM core.settlement s WHERE s.channel_id = ord.channel_id
                        AND ord.business_date BETWEEN s.period_from AND s.period_to)),
-- bank_imported: bank lines reach the month's last day (open_count = days of the month after the last line).
bnk AS (
  SELECT (mo.m1 - 1) - coalesce((SELECT max(b.value_date) FROM core.bank_line b
                                  WHERE b.value_date < mo.m1 AND (:outlet_id::uuid IS NULL OR b.outlet_id IS NULL OR b.outlet_id = :outlet_id::uuid)),
                                 mo.m0 - 1) AS open_count
    FROM mo),
-- breaks_resolved: open reconciliation breaks (disputed ones count as handled).
brk AS (
  SELECT count(*) AS open_count FROM core.reconciliation_break r
   WHERE r.status = 'open' AND (:outlet_id::uuid IS NULL OR r.outlet_id IS NULL OR r.outlet_id = :outlet_id::uuid)),
-- supplier_invoices_matched: invoices dated in the month not yet approved, plus goods received in the month whose
-- purchase order has no live invoice.
inv AS (
  SELECT (SELECT count(*) FROM core.supplier_invoice i, mo WHERE i.invoice_date >= mo.m0 AND i.invoice_date < mo.m1 AND i.status IN ('recorded', 'disputed'))
       + (SELECT count(*) FROM core.goods_received g JOIN ou ON ou.id = g.outlet_id, mo
           WHERE ((g.received_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date >= mo.m0
             AND ((g.received_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date < mo.m1
             AND (g.po_id IS NULL OR NOT EXISTS (SELECT 1 FROM core.supplier_invoice i WHERE i.po_id = g.po_id AND i.status <> 'void'))) AS open_count),
-- stock_counted: each outlet in scope has a submitted count in the month's last three days.
cnt AS (
  SELECT count(*) AS open_count FROM ou, mo
   WHERE NOT EXISTS (SELECT 1 FROM core.stock_count c WHERE c.outlet_id = ou.id AND c.status = 'submitted'
                        AND ((c.counted_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date BETWEEN mo.m1 - 3 AND mo.m1 - 1)),
-- payroll_approved: where the pack prepares payroll (payroll_scope 'drafts'), each outlet with staff has a live payroll
-- draft for the month.
pay AS (
  SELECT CASE WHEN (SELECT payroll_scope FROM pk) = 'drafts'
              THEN (SELECT count(*) FROM ou, mo
                     WHERE EXISTS (SELECT 1 FROM core.staff s WHERE s.outlet_id = ou.id)
                       AND NOT EXISTS (SELECT 1 FROM core.payroll_draft p WHERE p.outlet_id = ou.id AND p.period_month = mo.m0
                                          AND p.status IN ('approved', 'paid_externally')))
              ELSE 0 END AS open_count),
-- gst_zero_diff: outlets whose completed orders' own-liability tax differs from the output tax posted from them.
gst AS (
  SELECT count(*) AS open_count FROM (
    SELECT o.outlet_id FROM core."order" o JOIN ou ON ou.id = o.outlet_id
      JOIN core.channel ch ON ch.tenant_id = o.tenant_id AND ch.id = o.channel_id, mo
     WHERE o.status = 'completed' AND o.business_date >= mo.m0 AND o.business_date < mo.m1
       AND ch.kind NOT IN (SELECT 'aggregator:' || (a ->> 'code') FROM core.tenant t
                             JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
                             CROSS JOIN LATERAL jsonb_array_elements(cp.doc -> 'aggregators') a
                            WHERE a ->> 'tax_treatment' = 'operator_collects_excluded'
                              AND cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active'))
     GROUP BY o.outlet_id, mo.m0, mo.m1
    HAVING sum(o.tax_minor) <> coalesce((SELECT -sum(p.amount_minor) FROM core.journal_entry je
                                          JOIN core.posting p ON p.tenant_id = je.tenant_id AND p.journal_entry_id = je.id
                                          JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id
                                         WHERE je.posting_rule = 'finance.post_order' AND a.code = '2100' AND je.outlet_id = o.outlet_id
                                           AND je.entry_date >= mo.m0 AND je.entry_date < mo.m1), 0)) g),
-- pnl_produced: the month has income or expense postings.
pnl AS (
  SELECT CASE WHEN EXISTS (SELECT 1 FROM core.journal_entry je JOIN core.posting p ON p.tenant_id = je.tenant_id AND p.journal_entry_id = je.id
                              JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id, mo
                             WHERE a.type IN ('income', 'expense') AND je.entry_date >= mo.m0 AND je.entry_date < mo.m1
                               AND (:outlet_id::uuid IS NULL OR je.outlet_id = :outlet_id::uuid)) THEN 0 ELSE 1 END AS open_count)
SELECT x.item_code, x.open_count = 0 AS done, x.open_count::bigint AS open_count
  FROM (VALUES (1, 'pos_days_closed', (SELECT open_count FROM pos)), (2, 'settlements_imported', (SELECT open_count FROM stl)),
               (3, 'bank_imported', (SELECT open_count FROM bnk)), (4, 'breaks_resolved', (SELECT open_count FROM brk)),
               (5, 'supplier_invoices_matched', (SELECT open_count FROM inv)), (6, 'stock_counted', (SELECT open_count FROM cnt)),
               (7, 'payroll_approved', (SELECT open_count FROM pay)), (8, 'gst_zero_diff', (SELECT open_count FROM gst)),
               (9, 'pnl_produced', (SELECT open_count FROM pnl))) x(n, item_code, open_count)
 ORDER BY x.n$q$,
  '{"type": "object", "required": ["period_month", "outlet_id"], "additionalProperties": false,
    "properties": {"period_month": {"type": "string", "format": "date"}, "outlet_id": {"type": ["string", "null"], "format": "uuid"}}}',
  '[{"name": "item_code", "type": "text"},
    {"name": "done", "type": "boolean"},
    {"name": "open_count", "type": "integer", "numeric_source": ["count:core.order", "count:core.shift", "count:core.settlement", "core.bank_line.value_date",
                                                               "count:core.reconciliation_break", "count:core.supplier_invoice", "count:core.goods_received",
                                                               "count:core.stock_count", "count:core.staff", "count:core.payroll_draft", "core.order.tax_minor",
                                                               "core.posting.amount_minor"]}]',
  'advisor');

-- finance.margin_bridge (ADR-014 §7.3): the change in margin from :compare_month to :period_month, decomposed. Each row
-- is a component's level in each month, so Σ prior rows = last month's margin, Σ current rows = this month's, and Σ
-- delta rows = margin_delta_minor exactly (the closing Σ row, from postings: the accounting identity). The revenue rows
-- explain completed orders' sales (volume, price, discounts); the COGS rows explain the COGS postings (supplier price,
-- waste, and volume/mix as the rest); fees, labour and other are the P&L groups. `unexplained` is what the named rows
-- leave: income not from completed orders' sales (refunds, loyalty redemptions, cash rounding).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'finance.margin_bridge', 1,
  $q$WITH pk AS (
  SELECT (cp.doc -> 'tax' ->> 'price_display') = 'inclusive' AS inclusive
    FROM core.tenant t JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
   WHERE cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')),
mo (mth, m0, m1) AS (VALUES ('p', :compare_month::date, (:compare_month::date + interval '1 month')::date),
                            ('c', :period_month::date, (:period_month::date + interval '1 month')::date)),
-- Each month's P&L from postings (finance.pnl's groups): margin = −Σ income and expense postings.
gl AS (
  SELECT mo.mth,
         coalesce(-sum(x.amount_minor) FILTER (WHERE x.type = 'income'), 0) AS revenue,
         coalesce(sum(x.amount_minor) FILTER (WHERE x.code IN ('5000', '5100')), 0) AS cogs,
         coalesce(sum(x.amount_minor) FILTER (WHERE x.code IN ('6000', '6010')), 0) AS fees,
         coalesce(sum(x.amount_minor) FILTER (WHERE x.code IN ('6300')), 0) AS labour,
         coalesce(sum(x.amount_minor) FILTER (WHERE x.type = 'expense' AND x.code NOT IN ('5000', '5100', '6000', '6010', '6300')), 0) AS other,
         coalesce(-sum(x.amount_minor), 0) AS margin
    FROM mo
    LEFT JOIN (SELECT je.entry_date, p.amount_minor, a.type, a.code
                 FROM core.journal_entry je
                 JOIN core.posting p ON p.tenant_id = je.tenant_id AND p.journal_entry_id = je.id
                 JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id
                WHERE a.type IN ('income', 'expense')) x ON x.entry_date >= mo.m0 AND x.entry_date < mo.m1
   GROUP BY mo.mth),
-- Completed orders: gross before discounts (net of tax) and the discounts given, by business date.
ords AS (
  SELECT mo.mth, coalesce(sum(o.total_minor - o.tax_minor + o.discount_minor), 0) AS gross, coalesce(sum(o.discount_minor), 0) AS disc
    FROM mo LEFT JOIN core."order" o ON o.status = 'completed' AND o.business_date >= mo.m0 AND o.business_date < mo.m1
   GROUP BY mo.mth),
-- Per item and month: units and gross as priced (net of tax), for the price effect.
items AS (
  SELECT mo.mth, ol.item_id, sum(ol.qty_milli) AS q,
         sum(round(ol.qty_milli * ol.unit_price_minor / 1000.0) - CASE WHEN pk.inclusive THEN ol.tax_minor ELSE 0 END) AS g
    FROM mo
    JOIN core."order" o ON o.status = 'completed' AND o.business_date >= mo.m0 AND o.business_date < mo.m1
    JOIN core.order_line ol ON ol.tenant_id = o.tenant_id AND ol.order_id = o.id
    CROSS JOIN pk
   GROUP BY mo.mth, ol.item_id),
-- Price effect: this month's units of each item sold in both months, at this month's minus last month's average price.
rp AS (
  SELECT coalesce(sum(c.g - round(c.q * p.g / p.q)), 0) AS e
    FROM items c JOIN items p ON p.item_id = c.item_id AND p.mth = 'p' AND p.q <> 0
   WHERE c.mth = 'c'),
-- Receipts per ingredient and month at landed cost, for the supplier-price effect (this month's receipts at this
-- month's minus last month's average cost).
rc AS (
  SELECT mo.mth, m.ingredient_id, sum(m.qty_milli) AS q, sum(round(m.qty_milli * m.unit_cost_per_1000_minor / 1000000.0)) AS v
    FROM mo
    JOIN core.stock_movement m ON m.kind = 'receipt' AND m.unit_cost_per_1000_minor IS NOT NULL
    JOIN core.outlet o ON o.tenant_id = m.tenant_id AND o.id = m.outlet_id
   WHERE (m.at AT TIME ZONE o.tz)::date >= mo.m0 AND (m.at AT TIME ZONE o.tz)::date < mo.m1
   GROUP BY mo.mth, m.ingredient_id),
sp AS (
  SELECT coalesce(sum(c.v - round(c.q * p.v / p.q)), 0) AS e
    FROM rc c JOIN rc p ON p.ingredient_id = c.ingredient_id AND p.mth = 'p' AND p.q <> 0
   WHERE c.mth = 'c'),
-- Waste per month, valued at the latest landed cost before the month's end (else the first one after it).
wq AS (
  SELECT mo.mth, mo.m1, m.ingredient_id, -sum(m.qty_milli) AS q
    FROM mo
    JOIN core.stock_movement m ON m.kind = 'waste'
    JOIN core.outlet o ON o.tenant_id = m.tenant_id AND o.id = m.outlet_id
   WHERE (m.at AT TIME ZONE o.tz)::date >= mo.m0 AND (m.at AT TIME ZONE o.tz)::date < mo.m1
   GROUP BY mo.mth, mo.m1, m.ingredient_id),
wv AS (
  SELECT mo.mth, coalesce(sum(round(wq.q * c.per1000 / 1000000.0)), 0) AS w
    FROM mo
    LEFT JOIN wq ON wq.mth = mo.mth
    LEFT JOIN LATERAL (
      SELECT m.unit_cost_per_1000_minor AS per1000
        FROM core.stock_movement m JOIN core.outlet o ON o.tenant_id = m.tenant_id AND o.id = m.outlet_id
       WHERE m.ingredient_id = wq.ingredient_id AND m.kind = 'receipt' AND m.unit_cost_per_1000_minor IS NOT NULL
       ORDER BY (m.at AT TIME ZONE o.tz)::date >= wq.m1,
                CASE WHEN (m.at AT TIME ZONE o.tz)::date < wq.m1 THEN -extract(epoch FROM m.at) ELSE extract(epoch FROM m.at) END,
                m.id DESC LIMIT 1) c ON true
   GROUP BY mo.mth),
v AS (
  SELECT gp.margin AS mp, gc.margin AS mc, op.gross AS gp_, oc.gross AS gc_, op.disc AS dp, oc.disc AS dc,
         gp.cogs AS cp, gc.cogs AS cc, gp.fees AS fp, gc.fees AS fc, gp.labour AS lp, gc.labour AS lc_, gp.other AS xp, gc.other AS xc,
         wp.w AS wp_, wc.w AS wc_, (SELECT e FROM rp) AS pe, (SELECT e FROM sp) AS se
    FROM gl gp, gl gc, ords op, ords oc, wv wp, wv wc
   WHERE gp.mth = 'p' AND gc.mth = 'c' AND op.mth = 'p' AND oc.mth = 'c' AND wp.mth = 'p' AND wc.mth = 'c'),
r (n, component, prior_minor, current_minor) AS (
  SELECT 1, 'revenue_volume', v.gp_, v.gc_ - v.pe FROM v UNION ALL
  SELECT 2, 'revenue_price', 0, v.pe FROM v UNION ALL
  SELECT 3, 'deal_discount', -v.dp, -v.dc FROM v UNION ALL
  SELECT 4, 'cogs_supplier_price', 0, -v.se FROM v UNION ALL
  SELECT 5, 'cogs_volume_mix', -v.cp + v.wp_, -v.cc + v.wc_ + v.se FROM v UNION ALL
  SELECT 6, 'waste', -v.wp_, -v.wc_ FROM v UNION ALL
  SELECT 7, 'channel_fees', -v.fp, -v.fc FROM v UNION ALL
  SELECT 8, 'labour', -v.lp, -v.lc_ FROM v UNION ALL
  SELECT 9, 'other', -v.xp, -v.xc FROM v UNION ALL
  SELECT 10, 'unexplained', v.mp - (v.gp_ - v.dp - v.cp - v.fp - v.lp - v.xp), v.mc - (v.gc_ - v.dc - v.cc - v.fc - v.lc_ - v.xc) FROM v UNION ALL
  SELECT 11, 'margin_delta_minor', v.mp, v.mc FROM v)
SELECT r.component, r.prior_minor::bigint AS prior_minor, r.current_minor::bigint AS current_minor,
       (r.current_minor - r.prior_minor)::bigint AS delta_minor,
       round((r.current_minor - r.prior_minor) * 10000.0 / nullif(abs((SELECT mc - mp FROM v)), 0))::bigint AS share_bp
  FROM r
 ORDER BY r.n$q$,
  '{"type": "object", "required": ["period_month", "compare_month"], "additionalProperties": false,
    "properties": {"period_month": {"type": "string", "format": "date"}, "compare_month": {"type": "string", "format": "date"}}}',
  '[{"name": "component", "type": "text"},
    {"name": "prior_minor", "type": "integer", "numeric_source": ["core.posting.amount_minor", "core.order.total_minor", "core.order.tax_minor", "core.order.discount_minor", "core.order_line.qty_milli", "core.order_line.unit_price_minor", "core.order_line.tax_minor", "core.stock_movement.qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]},
    {"name": "current_minor", "type": "integer", "numeric_source": ["core.posting.amount_minor", "core.order.total_minor", "core.order.tax_minor", "core.order.discount_minor", "core.order_line.qty_milli", "core.order_line.unit_price_minor", "core.order_line.tax_minor", "core.stock_movement.qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]},
    {"name": "delta_minor", "type": "integer", "numeric_source": ["core.posting.amount_minor", "core.order.total_minor", "core.order.tax_minor", "core.order.discount_minor", "core.order_line.qty_milli", "core.order_line.unit_price_minor", "core.order_line.tax_minor", "core.stock_movement.qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]},
    {"name": "share_bp", "type": "integer", "numeric_source": ["core.posting.amount_minor", "core.order.total_minor", "core.order.tax_minor", "core.order.discount_minor", "core.order_line.qty_milli", "core.order_line.unit_price_minor", "core.order_line.tax_minor", "core.stock_movement.qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]}]',
  'advisor');

------------------------------------------------------------------------------------------------------------
-- 6. Post-conditions
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  -- O1: the 21 tables carry exactly one permissive policy, tenant_outlet_isolation, with the outlet predicate; the
  -- eleven nullable ones also admit outlet_id IS NULL, the ten NOT NULL ones do not.
  SELECT string_agg(v.t, ', ') INTO bad
    FROM (VALUES ('bank_line', true), ('budget', true), ('bulk_order', false), ('business_policy', true), ('conversation', true),
                 ('expense', true), ('hiring_candidate', false), ('journal_entry', true), ('market_signal', true), ('payroll_draft', false),
                 ('period_close', true), ('price', false), ('reconciliation_break', true), ('reservation', false), ('review', false),
                 ('roster', false), ('settlement', true), ('staff', false), ('tax_return_draft', true), ('ticket_counter', false),
                 ('tip_pool', false)) v(t, nul)
   WHERE (SELECT count(*) FROM pg_policy p WHERE p.polrelid = ('core.' || v.t)::regclass AND p.polpermissive) <> 1
      OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = ('core.' || v.t)::regclass AND p.polpermissive
                        AND p.polname = 'tenant_outlet_isolation'
                        AND pg_get_expr(p.polqual, p.polrelid) LIKE '%outlet_id = ANY%'
                        AND pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%outlet_id = ANY%'
                        AND (pg_get_expr(p.polqual, p.polrelid) LIKE '%outlet_id IS NULL%') = v.nul
                        AND (pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%outlet_id IS NULL%') = v.nul)
      OR (SELECT a.attnotnull FROM pg_attribute a WHERE a.attrelid = ('core.' || v.t)::regclass AND a.attname = 'outlet_id') = v.nul;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0019: outlet policies not as written on: %', bad; END IF;

  -- O2: the four children are read through their parent; only message also checks new rows through it. core.posting
  -- keeps exactly its tenant-only policy.
  IF (SELECT count(*) FROM pg_policy p WHERE p.polrelid = 'core.posting'::regclass AND p.polpermissive) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = 'core.posting'::regclass AND p.polname = 'tenant_isolation') THEN
    RAISE EXCEPTION '0019: core.posting is not tenant-only as written';
  END IF;
  SELECT string_agg(v.c, ', ') INTO bad
    FROM (VALUES ('settlement_line', 'settlement', false), ('payroll_draft_line', 'payroll_draft', false),
                 ('tip_pool_share', 'tip_pool', false), ('message', 'conversation', true)) v(c, parent, check_parent)
   WHERE (SELECT count(*) FROM pg_policy p WHERE p.polrelid = ('core.' || v.c)::regclass AND p.polpermissive) <> 1
      OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = ('core.' || v.c)::regclass AND p.polname = 'tenant_via_parent'
                        AND pg_get_expr(p.polqual, p.polrelid) LIKE '%FROM core.' || v.parent || ' x%'
                        AND (pg_get_expr(p.polwithcheck, p.polrelid) LIKE '%FROM core.' || v.parent || ' x%') = v.check_parent);
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0019: parent policies not as written on: %', bad; END IF;

  -- T1/T2: the three CHECKs, as written.
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'evidence.snapshot_template'::regclass AND c.conname = 'snapshot_template_min_role_check')
     IS DISTINCT FROM $d$CHECK ((min_role = ANY (ARRAY['staff'::text, 'advisor'::text, 'manager'::text, 'owner'::text, 'operator'::text])))$d$
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'evidence.snapshot_template'::regclass
                       AND c.conname = 'snapshot_template_numeric_sourced' AND c.contype = 'c' AND c.convalidated)
     OR NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'evidence.snapshot_template'::regclass
                       AND c.conname = 'snapshot_template_sql_no_semicolon' AND c.contype = 'c' AND c.convalidated) THEN
    RAISE EXCEPTION '0019: snapshot_template CHECKs not as written';
  END IF;

  -- T3: exactly these fourteen templates (plus the two of 0005 / 0015), each at its min_role.
  SELECT string_agg(coalesce(t.id, v.id), ', ') INTO bad
    FROM (VALUES ('catalogue.dish_margin', 'manager'), ('catalogue.menu_matrix', 'manager'), ('catalogue.cost_drift', 'manager'),
                 ('catalogue.deal_cost', 'manager'), ('catalogue.sku_price_check', 'manager'), ('catalogue.recipe_current', 'manager'),
                 ('finance.unapproved_deductions', 'advisor'), ('finance.settlement_vs_orders', 'advisor'),
                 ('finance.missing_payouts', 'advisor'), ('finance.tender_vs_bank', 'advisor'), ('finance.pnl', 'advisor'),
                 ('finance.gst_check', 'advisor'), ('finance.close_status', 'advisor'), ('finance.margin_bridge', 'advisor'),
                 ('inventory.below_reorder', 'manager'), ('platform.spend_by_tenant', 'operator')) v(id, min_role)
    FULL JOIN evidence.snapshot_template t ON t.id = v.id AND t.version = 1
   WHERE t.id IS NULL OR v.id IS NULL OR t.min_role <> v.min_role;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0019: templates not as written: %', bad; END IF;

  PERFORM munim_meta.assert_catalog('0019');
END $$;
