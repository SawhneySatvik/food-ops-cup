-- 0026_w3_founder_decisions — ledger R47 (migrator lane m-1), fix forward over 0001–0025. Runs as munim_migrator.
-- Additive only: five nullable columns, one column grant, two template versions. No row is written or rewritten.
-- Items:
--   D1  platform.model_role + input_price_per_mtok_minor, output_price_per_mtok_minor (bigint, whole minor units of
--       price_currency per 1,000,000 tokens) and price_currency (char(3)). All three NULL ("not priced") or all three set.
--       bigint, as every money column here and as core's platform draft path (rider-core) validates them: the list prices
--       of today's model roles per 1M tokens are whole cents (US$0.30, 2.50, 1.50, 7.50, 0.15); a sub-minor price (US$0.075
--       = 7.5 cents) cannot be stored and must be rounded UP by the operator (the cap then errs early, never late). 0 is a
--       legal price (R47 D8: free fallback models), NULL is "no price" and intel refuses a live call on such a role (R47 D1:
--       "a live role with no price refuses live calls").
--       The 0015 seed rows stay NULL: no price is invented here. Written only by the operator's approved config draft (R24):
--       munim_platform gains UPDATE on exactly these three columns (its INSERT and everyone's SELECT are table-level, 0002);
--       munim_core and munim_svc read them (the internal model-roles read runs as munim_svc), nobody else writes them.
--       No trigger: an approved draft applies exactly as signed. Clearing the price when a draft changes the model and
--       omits the price group is core's (rider-core apply(), orchestrator ruling); the database never rewrites a price.
--   D7  core.business_policy + negotiation_target_bp and negotiation_walkaway_bp, basis points of the reference (last)
--       price, each nullable and each 1..20000; when both are set, target ≤ walk-away. A pair with one bound unset is
--       judged on the EFFECTIVE pair (the other bound's default) by core, which the database cannot see (rider-core's
--       validation, orchestrator ruling). NULL = unset: the R47 defaults (target 9500, walk-away 11000) are applied in code, not
--       here — a column DEFAULT would stamp 9500/11000 on every existing policy row, a figure no person approved (One
--       Guarantee clause 1), and would make "unset" indistinguishable from "chose 95/110". Written by the owner's own
--       tenancy.policy.set.v1 (0007: owner, judge; tenant; core.business_policy — asserted below from the live row), whose
--       new version is a new row: munim_core's table-level INSERT covers the columns; no UPDATE grant (as 0015's loyalty
--       columns).
--   D6  people.labour_vs_demand v2 (R47 D6: excess priced at the extra staff's rate). Changes from v1:
--         - Every CTE is per outlet (v1 grouped hours, orders, forecast and the norm by day and slot only, so with outlet_id
--           NULL two outlets were summed into one row and judged against one merged norm). New column outlet_id.
--         - excess_min = attended − orders × norm (≥ 0; NULL without a norm), rounded once — new column.
--         - excess_cost_minor = the excess minutes priced at the rates of the staff beyond the demand norm: the slot's
--           attending staff are ranked cheapest hourly rate first (staff_id breaks ties) and the excess minutes are filled
--           from that list, each person contributing at most the minutes they attended in the slot; cost = Σ allocated
--           minutes × that person's rate ÷ 60, rounded once (v1: × the minute-weighted rate of everyone present).
--           Cheapest-first is a lower bound on what the surplus costs (it never overstates a "₹ found" figure, the project rules
--           hard rule 5) and depends on the attendance rows only, not on who clocked in last. Rate = core-api's people rule
--           (hourly wage, or monthly salary × 60 ÷ contract minutes), as v1.
--         - One Σ row per (outlet, weekday, slot) over the window FIRST (business_on NULL; weekday 'mon'..'sun'), each cell
--           the Σ of the day rows' cells below it (NULL when every day cell is NULL), ordered outlet, ISO weekday, slot; then
--           the day rows ordered outlet, day, slot. New column weekday (on day rows too).
--         - Unchanged: params, min_role, the norm (median over the 8 weeks before each day, same outlet, weekday and slot, of
--           attended minutes per order, slots with orders only), the hours, orders and forecast definitions.
--       Columns: v1's eight in v1's order, then outlet_id, weekday, excess_min.
--   D3  purchasing.deal_inputs v3 (R47 D3: margin from selling price for items with no recipe), v2's SQL (0022, as_of) with:
--         - margin_at_quote_bp = the lowest margin over v2's dishes (unchanged: current recipe uses the quoted ingredient,
--           priced at the average net selling price over 28 days) AND the shop SKUs that stock it: items kind 'sku' whose
--           stock_ingredient_id is the quoted ingredient and that have no recipe (fuse's rule). A SKU sells one base unit of
--           its stock record (core-domain consumeSku), so its unit cost at quote = the quote's unit price converted to the
--           ingredient's base unit; its selling price = the lowest current catalogue price (core.price, no variant) at the
--           quote's outlets in the minter's scope, valid on each outlet's today (as_of anchored), net of tax when the pack's
--           prices are tax-inclusive (amount × 10000 ÷ (10000 + the class's rate_bp), as catalogue.sku_price_check reads the
--           pack); margin = (net − unit cost) × 10000 ÷ net, rounded. A SKU with no current price in scope or a quote unit
--           that does not convert has no margin (like v2's unsold or unpriced dishes) and drops out of the minimum.
--         - margin_rule_applies (boolean, new last column): true when some item sells the ingredient — a dish whose current
--           recipe uses it, or a recipe-less SKU stocked by it; false otherwise (packaging: no item sells it), and then
--           margin_at_quote_bp is NULL and the review skips the margin rule (R47 D3). true with a NULL margin = a sellable
--           item whose margin cannot be computed (cannot verify, as before).
--         - pk also reads the pack's tax classes (for the net price). Everything else is v2's text, byte for byte.
--       Columns: v2's nine, then margin_rule_applies. Params and min_role = v2's.
-- New SQLSTATEs: none.

------------------------------------------------------------------------------------------------------------
-- 0. Pre-checks: what this file builds on is the shape it builds on.
------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'platform' AND table_name = 'model_role'
               AND column_name IN ('input_price_per_mtok_minor', 'output_price_per_mtok_minor', 'price_currency')) THEN
    RAISE EXCEPTION '0026: platform.model_role already has price columns';
  END IF;
  IF (SELECT count(*) FROM platform.model_role) <> 6 THEN
    RAISE EXCEPTION '0026: expected the 6 model roles of 0015';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'core' AND table_name = 'business_policy'
               AND column_name IN ('negotiation_target_bp', 'negotiation_walkaway_bp')) THEN
    RAISE EXCEPTION '0026: core.business_policy already has negotiation bounds';
  END IF;
  -- D7 rides on the owner's own policy command: it must still be owner/judge, tenant scope, own command, writing business_policy.
  IF NOT EXISTS (SELECT 1 FROM core.command_authority WHERE command_type = 'tenancy.policy.set.v1'
                    AND allowed_roles @> ARRAY['owner'] AND allowed_roles <@ ARRAY['owner', 'judge'] AND scope = 'tenant'
                    AND 'core.business_policy' = ANY (target_tables) AND NOT draft_only) THEN
    RAISE EXCEPTION '0026: tenancy.policy.set.v1 is not the 0007 owner command on core.business_policy';
  END IF;
  IF (SELECT array_agg(version ORDER BY version) FROM evidence.snapshot_template WHERE id = 'people.labour_vs_demand') IS DISTINCT FROM ARRAY[1] THEN
    RAISE EXCEPTION '0026: people.labour_vs_demand is not exactly version 1';
  END IF;
  IF (SELECT array_agg(version ORDER BY version) FROM evidence.snapshot_template WHERE id = 'purchasing.deal_inputs') IS DISTINCT FROM ARRAY[1, 2] THEN
    RAISE EXCEPTION '0026: purchasing.deal_inputs is not exactly versions 1 and 2';
  END IF;
END $$;

------------------------------------------------------------------------------------------------------------
-- 1. D1 — per-role AI prices (operator config, changed only through an approved config draft, R24)
------------------------------------------------------------------------------------------------------------
ALTER TABLE platform.model_role
  ADD COLUMN input_price_per_mtok_minor bigint,
  ADD COLUMN output_price_per_mtok_minor bigint,
  ADD COLUMN price_currency char(3),
  ADD CONSTRAINT model_role_price_nonnegative CHECK (input_price_per_mtok_minor >= 0 AND output_price_per_mtok_minor >= 0),
  ADD CONSTRAINT model_role_price_currency_format CHECK (price_currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT model_role_price_all_or_none CHECK ((input_price_per_mtok_minor IS NULL) = (output_price_per_mtok_minor IS NULL)
                                                     AND (input_price_per_mtok_minor IS NULL) = (price_currency IS NULL));
REVOKE ALL (input_price_per_mtok_minor, output_price_per_mtok_minor, price_currency) ON platform.model_role FROM PUBLIC;
GRANT UPDATE (input_price_per_mtok_minor, output_price_per_mtok_minor, price_currency) ON platform.model_role TO munim_platform;

------------------------------------------------------------------------------------------------------------
-- 2. D7 — negotiation bounds per business (owner's policy; defaults 9500 / 11000 live in code)
------------------------------------------------------------------------------------------------------------
ALTER TABLE core.business_policy
  ADD COLUMN negotiation_target_bp integer
    CONSTRAINT business_policy_negotiation_target_check CHECK (negotiation_target_bp BETWEEN 1 AND 20000),
  ADD COLUMN negotiation_walkaway_bp integer
    CONSTRAINT business_policy_negotiation_walkaway_check CHECK (negotiation_walkaway_bp BETWEEN 1 AND 20000),
  ADD CONSTRAINT business_policy_negotiation_order_check CHECK (negotiation_target_bp <= negotiation_walkaway_bp);
REVOKE ALL (negotiation_target_bp, negotiation_walkaway_bp) ON core.business_policy FROM PUBLIC;

------------------------------------------------------------------------------------------------------------
-- 3. D6 — people.labour_vs_demand v2 (per outlet; excess at the extra staff's rate; Σ rows first)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  rate constant text := $r$CASE WHEN s.pay_basis = 'hourly' THEN s.wage_rate_minor::numeric
                     ELSE s.monthly_salary_minor::numeric * 60 / s.contract_min_per_month END$r$;
  rate_src constant jsonb := '["core.staff.wage_rate_minor", "core.staff.monthly_salary_minor", "core.staff.contract_min_per_month"]';
  v1 evidence.snapshot_template;
BEGIN
  SELECT * INTO v1 FROM evidence.snapshot_template WHERE id = 'people.labour_vs_demand' AND version = 1;
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
    'people.labour_vs_demand', 2,
    $q$WITH sl AS (SELECT make_interval(mins => :slot_minutes::int) AS w),
iv AS (
  SELECT 'a' AS k, t.outlet_id, t.staff_id, t.clock_in_at AT TIME ZONE ou.tz AS s, t.clock_out_at AT TIME ZONE ou.tz AS e, $q$ || rate || $q$ AS rate, ou.business_day_cutoff AS cut
    FROM core.attendance t JOIN core.staff s ON s.tenant_id = t.tenant_id AND s.id = t.staff_id
    JOIN core.outlet ou ON ou.tenant_id = t.tenant_id AND ou.id = t.outlet_id
   WHERE t.clock_out_at IS NOT NULL AND (:outlet_id::uuid IS NULL OR t.outlet_id = :outlet_id::uuid)
     AND (t.clock_in_at AT TIME ZONE ou.tz)::date BETWEEN :from::date - 56 AND :to::date + 1
  UNION ALL
  SELECT 'r', r.outlet_id, r.staff_id, r.starts_at AT TIME ZONE ou.tz, r.ends_at AT TIME ZONE ou.tz, NULL, ou.business_day_cutoff
    FROM core.roster_shift r JOIN core.outlet ou ON ou.tenant_id = r.tenant_id AND ou.id = r.outlet_id
   WHERE r.status = 'scheduled' AND (:outlet_id::uuid IS NULL OR r.outlet_id = :outlet_id::uuid)
     AND (r.starts_at AT TIME ZONE ou.tz)::date BETWEEN :from::date - 56 AND :to::date + 1),
pieces AS (
  SELECT iv.k, iv.outlet_id, iv.staff_id, (b.b - iv.cut)::date AS d, to_char(b.b, 'HH24:MI') AS slot, iv.rate,
         extract(epoch FROM least(iv.e, b.b + sl.w) - greatest(iv.s, b.b)) / 60 AS mins
    FROM iv CROSS JOIN sl
    CROSS JOIN LATERAL generate_series(date_bin(sl.w, iv.s, timestamp '2001-01-01'), iv.e - interval '1 microsecond', sl.w) b(b)),
lab AS (
  SELECT p.outlet_id, p.d, p.slot, sum(p.mins) FILTER (WHERE p.k = 'a') AS att, sum(p.mins) FILTER (WHERE p.k = 'r') AS ros
    FROM pieces p GROUP BY p.outlet_id, p.d, p.slot),
-- Each attending person's minutes in the slot, and the minutes of everyone cheaper (rate, then staff_id) before them.
who AS (
  SELECT a.*, coalesce(sum(a.mins) OVER (PARTITION BY a.outlet_id, a.d, a.slot ORDER BY a.rate, a.staff_id
                                         ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
    FROM (SELECT p.outlet_id, p.d, p.slot, p.staff_id, min(p.rate) AS rate, sum(p.mins) AS mins
            FROM pieces p WHERE p.k = 'a' GROUP BY p.outlet_id, p.d, p.slot, p.staff_id) a),
dem AS (
  SELECT o.outlet_id, o.business_date AS d, to_char(date_bin(sl.w, o.created_at AT TIME ZONE ou.tz, timestamp '2001-01-01'), 'HH24:MI') AS slot, count(*) AS n
    FROM core."order" o JOIN core.outlet ou ON ou.tenant_id = o.tenant_id AND ou.id = o.outlet_id CROSS JOIN sl
   WHERE o.status = 'completed' AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)
     AND o.business_date BETWEEN :from::date - 56 AND :to::date
   GROUP BY 1, 2, 3),
fc AS (
  SELECT p.outlet_id, p.business_on AS d, to_char(p.slot_start, 'HH24:MI') AS slot, sum(p.qty_milli) / 1000.0 AS units
    FROM intel.forecast_point p
    JOIN (SELECT r.id, r.method FROM intel.forecast_run r
           WHERE EXISTS (SELECT 1 FROM intel.forecast_point x WHERE x.tenant_id = r.tenant_id AND x.forecast_run_id = r.id AND x.slot_start IS NOT NULL)
           ORDER BY r.created_at DESC, r.id DESC LIMIT 1) fr ON fr.id = p.forecast_run_id AND fr.method = p.method
   WHERE p.slot_start IS NOT NULL AND p.business_on BETWEEN :from::date AND :to::date AND (:outlet_id::uuid IS NULL OR p.outlet_id = :outlet_id::uuid)
   GROUP BY 1, 2, 3),
allk AS (
  SELECT outlet_id, d, slot FROM lab UNION SELECT outlet_id, d, slot FROM dem),
h AS (
  SELECT k.outlet_id, k.d, k.slot, coalesce(lab.att, 0) AS att, coalesce(lab.ros, 0) AS ros, coalesce(dem.n, 0) AS n
    FROM allk k LEFT JOIN lab ON lab.outlet_id = k.outlet_id AND lab.d = k.d AND lab.slot = k.slot
    LEFT JOIN dem ON dem.outlet_id = k.outlet_id AND dem.d = k.d AND dem.slot = k.slot),
x AS (
  SELECT h.*,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY b.att / b.n) FROM h b
           WHERE b.outlet_id = h.outlet_id AND b.slot = h.slot AND b.n > 0 AND b.d BETWEEN h.d - 56 AND h.d - 7
             AND extract(dow FROM b.d) = extract(dow FROM h.d)) AS norm
    FROM h WHERE h.d BETWEEN :from::date AND :to::date),
ex AS (
  SELECT x.*, CASE WHEN x.norm IS NOT NULL THEN greatest(x.att - x.n * x.norm, 0) END AS excess FROM x),
-- The excess minutes filled from the cheapest attending staff first: each person gives at most their own minutes.
cost AS (
  SELECT ex.outlet_id, ex.d, ex.slot, sum(least(w.mins, greatest(ex.excess - w.before, 0)) * w.rate) / 60 AS cost
    FROM ex JOIN who w ON w.outlet_id = ex.outlet_id AND w.d = ex.d AND w.slot = ex.slot
   WHERE ex.excess IS NOT NULL
   GROUP BY ex.outlet_id, ex.d, ex.slot),
day AS (
  SELECT ex.outlet_id, ex.d, ex.slot, extract(isodow FROM ex.d) AS dow, to_char(ex.d, 'dy') AS weekday,
         round(ex.att)::bigint AS att, round(ex.ros)::bigint AS ros, ex.n::bigint AS n, round(fc.units)::bigint AS fco,
         round(ex.n * ex.norm)::bigint AS needed, round(ex.excess)::bigint AS excess_min,
         CASE WHEN ex.excess IS NOT NULL THEN round(coalesce(c.cost, 0)) END::bigint AS cost
    FROM ex LEFT JOIN fc ON fc.outlet_id = ex.outlet_id AND fc.d = ex.d AND fc.slot = ex.slot
    LEFT JOIN cost c ON c.outlet_id = ex.outlet_id AND c.d = ex.d AND c.slot = ex.slot),
r AS (
  SELECT 0 AS grp, d.outlet_id, NULL::date AS d, d.dow, d.weekday, d.slot, sum(d.att)::bigint AS att, sum(d.ros)::bigint AS ros,
         sum(d.n)::bigint AS n, sum(d.fco)::bigint AS fco, sum(d.needed)::bigint AS needed, sum(d.excess_min)::bigint AS excess_min,
         sum(d.cost)::bigint AS cost
    FROM day d GROUP BY d.outlet_id, d.dow, d.weekday, d.slot
  UNION ALL
  SELECT 1, d.outlet_id, d.d, d.dow, d.weekday, d.slot, d.att, d.ros, d.n, d.fco, d.needed, d.excess_min, d.cost FROM day d)
SELECT r.d AS business_on, r.slot AS slot_start, r.att AS attended_min, r.ros AS rostered_min, r.n AS orders, r.fco AS forecast_orders,
       r.needed AS needed_min, r.cost AS excess_cost_minor, r.outlet_id, r.weekday, r.excess_min
  FROM r
 ORDER BY r.grp, r.outlet_id, r.d, r.dow, r.slot$q$,
    v1.params_schema,
    jsonb_build_array(
      '{"name": "business_on", "type": "date"}'::jsonb,
      '{"name": "slot_start", "type": "text"}'::jsonb,
      '{"name": "attended_min", "type": "integer", "numeric_source": ["core.attendance.clock_in_at", "core.attendance.clock_out_at"]}'::jsonb,
      '{"name": "rostered_min", "type": "integer", "numeric_source": ["core.roster_shift.starts_at", "core.roster_shift.ends_at"]}'::jsonb,
      '{"name": "orders", "type": "integer", "numeric_source": "count:core.order"}'::jsonb,
      '{"name": "forecast_orders", "type": "integer", "numeric_source": "intel.forecast_point.qty_milli"}'::jsonb,
      '{"name": "needed_min", "type": "integer", "numeric_source": ["count:core.order", "core.attendance.clock_in_at", "core.attendance.clock_out_at"]}'::jsonb,
      jsonb_build_object('name', 'excess_cost_minor', 'type', 'integer', 'numeric_source',
        '["count:core.order", "core.attendance.clock_in_at", "core.attendance.clock_out_at"]'::jsonb || rate_src),
      '{"name": "outlet_id", "type": "uuid"}'::jsonb,
      '{"name": "weekday", "type": "text"}'::jsonb,
      '{"name": "excess_min", "type": "integer", "numeric_source": ["count:core.order", "core.attendance.clock_in_at", "core.attendance.clock_out_at"]}'::jsonb),
    v1.min_role);
END $$;

------------------------------------------------------------------------------------------------------------
-- 4. D3 — purchasing.deal_inputs v3 (v2 + shop SKUs priced from the catalogue; margin_rule_applies)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  v2 evidence.snapshot_template;
  q  text;
  -- [anchor in v2, replacement]: each anchor must occur exactly once in v2's text.
  edits constant text[][] := ARRAY[
    [$a$SELECT (cp.doc -> 'tax' ->> 'price_display') = 'inclusive' AS inclusive
$a$,
     $a$SELECT (cp.doc -> 'tax' ->> 'price_display') = 'inclusive' AS inclusive, cp.doc -> 'tax' -> 'classes' AS classes
$a$],
    [$a$pol AS (
$a$,
     $a$-- 0026 (R47 D3): shop SKUs stocked by the quoted ingredient with no recipe (fuse's rule); one item = one base unit.
sku AS (
  SELECT i.id AS item_id,
         round((nt.net - q.unit_price_minor * CASE WHEN g.base_unit = q.unit THEN 1 ELSE cv.f END) * 10000 / nullif(nt.net, 0)) AS bp
    FROM q JOIN core.item i ON i.tenant_id = q.tenant_id AND i.stock_ingredient_id = q.ingredient_id AND i.kind = 'sku'
    JOIN core.ingredient g ON g.tenant_id = i.tenant_id AND g.id = i.stock_ingredient_id
    LEFT JOIN conv cv ON cv.from_unit = g.base_unit AND cv.to_unit = q.unit
    LEFT JOIN LATERAL (
      SELECT min(CASE WHEN pk.inclusive THEN pr.amount_minor * 10000.0 / (10000 + coalesce((tc.c ->> 'rate_bp')::integer, 0))
                      ELSE pr.amount_minor END) AS net
        FROM core.price pr JOIN ou ON ou.id = pr.outlet_id CROSS JOIN pk
        LEFT JOIN LATERAL (SELECT c FROM jsonb_array_elements(pk.classes) c WHERE c ->> 'code' = pr.tax_class) tc ON true
       WHERE pr.item_id = i.id AND pr.variant_id IS NULL AND pr.valid_from <= ou.today AND (pr.valid_to IS NULL OR pr.valid_to > ou.today)) nt ON true
   WHERE NOT EXISTS (SELECT 1 FROM core.recipe_version rv WHERE rv.tenant_id = i.tenant_id AND rv.item_id = i.id AND rv.variant_id IS NULL)),
pol AS (
$a$],
    [$a$       (SELECT min(round((s.unit_net - c.unit_cost) * 10000 / nullif(s.unit_net, 0)))
          FROM costed c JOIN sold s ON s.item_id = c.item_id WHERE c.unpriced = 0)::bigint AS margin_at_quote_bp,
$a$,
     $a$       (SELECT min(m.bp) FROM (SELECT round((s.unit_net - c.unit_cost) * 10000 / nullif(s.unit_net, 0)) AS bp
                                 FROM costed c JOIN sold s ON s.item_id = c.item_id WHERE c.unpriced = 0
                               UNION ALL SELECT sku.bp FROM sku) m)::bigint AS margin_at_quote_bp,
$a$],
    [$a$(SELECT min_payment_days FROM pol)::bigint AS min_payment_days
  FROM q$a$,
     $a$(SELECT min_payment_days FROM pol)::bigint AS min_payment_days,
       (EXISTS (SELECT 1 FROM costed) OR EXISTS (SELECT 1 FROM sku)) AS margin_rule_applies
  FROM q$a$]];
  i integer;
BEGIN
  SELECT * INTO v2 FROM evidence.snapshot_template WHERE id = 'purchasing.deal_inputs' AND version = 2;
  q := v2.sql;
  FOR i IN 1 .. array_length(edits, 1) LOOP
    IF (length(q) - length(replace(q, edits[i][1], ''))) / length(edits[i][1]) <> 1 THEN
      RAISE EXCEPTION '0026: deal_inputs v2 anchor % does not occur exactly once', i;
    END IF;
    q := replace(q, edits[i][1], edits[i][2]);
  END LOOP;
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
  VALUES ('purchasing.deal_inputs', 3, q, v2.params_schema,
          (SELECT jsonb_agg(CASE WHEN c ->> 'name' = 'margin_at_quote_bp'
                                 THEN jsonb_set(c, '{numeric_source}', (c -> 'numeric_source') || '["core.price.amount_minor"]')
                                 ELSE c END ORDER BY k)
             FROM jsonb_array_elements(v2.columns) WITH ORDINALITY e(c, k))
          || '[{"name": "margin_rule_applies", "type": "boolean"}]'::jsonb,
          v2.min_role);
END $$;

------------------------------------------------------------------------------------------------------------
-- 5. Post-conditions (read back what Postgres holds)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  -- D1: the three columns as declared (bigint ×2, char(3)), nullable, no default; the constraints as written; no
  -- row priced; no trigger on the table other than 0002's touch_updated_at (a signed draft applies as signed); who may
  -- write them.
  SELECT string_agg(x, ', ') INTO bad FROM (
    SELECT 'columns' AS x WHERE (SELECT string_agg(column_name || ':' || data_type || ':' || coalesce(numeric_precision::text, '') || ','
                                                    || coalesce(numeric_scale::text, '') || coalesce(character_maximum_length::text, '') || ':'
                                                    || is_nullable || ':' || coalesce(column_default, 'none'), ' ' ORDER BY column_name)
                                   FROM information_schema.columns WHERE table_schema = 'platform' AND table_name = 'model_role'
                                    AND column_name IN ('input_price_per_mtok_minor', 'output_price_per_mtok_minor', 'price_currency'))
      IS DISTINCT FROM 'input_price_per_mtok_minor:bigint:64,0:YES:none output_price_per_mtok_minor:bigint:64,0:YES:none price_currency:character:,3:YES:none'
    UNION ALL
    SELECT 'checks' WHERE (SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), ' | ' ORDER BY conname) FROM pg_constraint
                            WHERE conrelid = 'platform.model_role'::regclass AND conname LIKE 'model_role_price_%')
      IS DISTINCT FROM 'model_role_price_all_or_none=CHECK ((((input_price_per_mtok_minor IS NULL) = (output_price_per_mtok_minor IS NULL)) AND ((input_price_per_mtok_minor IS NULL) = (price_currency IS NULL))))'
                    || ' | model_role_price_currency_format=CHECK ((price_currency ~ ''^[A-Z]{3}$''::text))'
                    || ' | model_role_price_nonnegative=CHECK (((input_price_per_mtok_minor >= 0) AND (output_price_per_mtok_minor >= 0)))'
    UNION ALL
    SELECT 'rows' WHERE EXISTS (SELECT 1 FROM platform.model_role WHERE input_price_per_mtok_minor IS NOT NULL OR output_price_per_mtok_minor IS NOT NULL
                                                                    OR price_currency IS NOT NULL)
    UNION ALL
    SELECT 'triggers' WHERE (SELECT string_agg(t.tgname, ',' ORDER BY t.tgname) FROM pg_trigger t
                               WHERE t.tgrelid = 'platform.model_role'::regclass AND NOT t.tgisinternal) IS DISTINCT FROM 'touch_updated_at'
    UNION ALL
    SELECT 'grants:' || c || ':' || r FROM unnest(ARRAY['input_price_per_mtok_minor', 'output_price_per_mtok_minor', 'price_currency']) c,
           unnest(ARRAY['munim_platform', 'munim_core', 'munim_svc', 'munim_intel_ro', 'public']) r
     WHERE has_column_privilege(r, 'platform.model_role', c, 'UPDATE') <> (r = 'munim_platform')
        OR has_column_privilege(r, 'platform.model_role', c, 'SELECT') <> (r IN ('munim_platform', 'munim_core', 'munim_svc'))
        OR has_column_privilege(r, 'platform.model_role', c, 'INSERT') <> (r = 'munim_platform')) y;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0026: D1 platform.model_role prices not as written: %', bad; END IF;

  -- D7: two integer columns, nullable, no default; the two range checks and the order check; no existing row carries a
  -- bound; munim_core inserts them (a new policy version) and updates neither; the owner's policy command still targets
  -- the table.
  SELECT string_agg(x, ', ') INTO bad FROM (
    SELECT 'columns' AS x WHERE (SELECT string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, 'none'), ' ' ORDER BY column_name)
                                   FROM information_schema.columns WHERE table_schema = 'core' AND table_name = 'business_policy'
                                    AND column_name IN ('negotiation_target_bp', 'negotiation_walkaway_bp'))
      IS DISTINCT FROM 'negotiation_target_bp:integer:YES:none negotiation_walkaway_bp:integer:YES:none'
    UNION ALL
    SELECT 'checks' WHERE (SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), ' | ' ORDER BY conname) FROM pg_constraint
                            WHERE conrelid = 'core.business_policy'::regclass AND conname LIKE 'business_policy_negotiation_%')
      IS DISTINCT FROM 'business_policy_negotiation_order_check=CHECK ((negotiation_target_bp <= negotiation_walkaway_bp))'
                    || ' | business_policy_negotiation_target_check=CHECK (((negotiation_target_bp >= 1) AND (negotiation_target_bp <= 20000)))'
                    || ' | business_policy_negotiation_walkaway_check=CHECK (((negotiation_walkaway_bp >= 1) AND (negotiation_walkaway_bp <= 20000)))'
    UNION ALL
    SELECT 'rows' WHERE EXISTS (SELECT 1 FROM core.business_policy WHERE negotiation_target_bp IS NOT NULL OR negotiation_walkaway_bp IS NOT NULL)
    UNION ALL
    SELECT 'grants:' || c FROM unnest(ARRAY['negotiation_target_bp', 'negotiation_walkaway_bp']) c
     WHERE NOT has_column_privilege('munim_core', 'core.business_policy', c, 'INSERT') OR NOT has_column_privilege('munim_core', 'core.business_policy', c, 'SELECT')
        OR NOT has_column_privilege('munim_svc', 'core.business_policy', c, 'SELECT')
        OR has_column_privilege('munim_core', 'core.business_policy', c, 'UPDATE') OR has_column_privilege('munim_svc', 'core.business_policy', c, 'INSERT, UPDATE')
        OR has_column_privilege('munim_intel_ro', 'core.business_policy', c, 'SELECT, INSERT, UPDATE')
        OR has_column_privilege('munim_platform', 'core.business_policy', c, 'SELECT, INSERT, UPDATE')
        OR has_column_privilege('public', 'core.business_policy', c, 'SELECT, INSERT, UPDATE')
    UNION ALL
    SELECT 'authority' WHERE NOT EXISTS (SELECT 1 FROM core.command_authority WHERE command_type = 'tenancy.policy.set.v1'
                                            AND 'core.business_policy' = ANY (target_tables) AND NOT draft_only)) y;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0026: D7 core.business_policy negotiation bounds not as written: %', bad; END IF;

  -- D6 + D3: the new versions are the latest, with the previous version's params and role, the columns as written, and the
  -- shape of each change in the SQL.
  SELECT string_agg(x, ', ') INTO bad FROM (
    SELECT 'latest:' || t.id AS x FROM (VALUES ('people.labour_vs_demand', 2), ('purchasing.deal_inputs', 3)) t(id, v)
     WHERE (SELECT max(version) FROM evidence.snapshot_template WHERE id = t.id) <> t.v
    UNION ALL
    SELECT 'shape:' || n.id FROM evidence.snapshot_template n JOIN evidence.snapshot_template p ON p.id = n.id AND p.version = n.version - 1
     WHERE (n.id, n.version) IN (('people.labour_vs_demand', 2), ('purchasing.deal_inputs', 3))
       AND (n.params_schema IS DISTINCT FROM p.params_schema OR n.min_role IS DISTINCT FROM p.min_role
            OR (SELECT string_agg(c ->> 'name', ',' ORDER BY k) FROM jsonb_array_elements(n.columns) WITH ORDINALITY e(c, k))
               IS DISTINCT FROM (SELECT string_agg(c ->> 'name', ',' ORDER BY k) FROM jsonb_array_elements(p.columns) WITH ORDINALITY e(c, k))
                                || CASE n.id WHEN 'people.labour_vs_demand' THEN ',outlet_id,weekday,excess_min' ELSE ',margin_rule_applies' END)
    UNION ALL
    SELECT 'margin-source' FROM evidence.snapshot_template t
     WHERE t.id = 'purchasing.deal_inputs' AND t.version = 3
       AND NOT (SELECT c -> 'numeric_source' FROM jsonb_array_elements(t.columns) c WHERE c ->> 'name' = 'margin_at_quote_bp') ? 'core.price.amount_minor'
    UNION ALL
    SELECT 'sql:people.labour_vs_demand' FROM evidence.snapshot_template t WHERE t.id = 'people.labour_vs_demand' AND t.version = 2
       AND (position('ORDER BY a.rate, a.staff_id' IN t.sql) = 0
            OR position('sum(least(w.mins, greatest(ex.excess - w.before, 0)) * w.rate) / 60' IN t.sql) = 0
            OR position('WHERE b.outlet_id = h.outlet_id AND b.slot = h.slot' IN t.sql) = 0
            OR position('SELECT 0 AS grp, d.outlet_id, NULL::date AS d' IN t.sql) = 0
            OR position('ORDER BY r.grp, r.outlet_id, r.d, r.dow, r.slot' IN t.sql) = 0
            OR t.sql ~* '(now\(|current_date|current_timestamp|localtimestamp|clock_timestamp|transaction_timestamp|statement_timestamp)')
    UNION ALL
    SELECT 'sql:purchasing.deal_inputs' FROM evidence.snapshot_template t WHERE t.id = 'purchasing.deal_inputs' AND t.version = 3
       AND (position('UNION ALL SELECT sku.bp FROM sku' IN t.sql) = 0
            OR position('i.stock_ingredient_id = q.ingredient_id AND i.kind = ''sku''' IN t.sql) = 0
            OR position('pr.valid_from <= ou.today AND (pr.valid_to IS NULL OR pr.valid_to > ou.today)' IN t.sql) = 0
            OR position('(EXISTS (SELECT 1 FROM costed) OR EXISTS (SELECT 1 FROM sku)) AS margin_rule_applies' IN t.sql) = 0
            -- every "today" of v3 is v2's (as_of-anchored): no new wall-clock read
            OR (length(t.sql) - length(replace(t.sql, 'now()', ''))) / 5
               <> (SELECT (length(sql) - length(replace(sql, 'now()', ''))) / 5 FROM evidence.snapshot_template WHERE id = t.id AND version = 2)
            OR (length(t.sql) - length(replace(t.sql, 'current_date', ''))) / 12
               <> (SELECT (length(sql) - length(replace(sql, 'current_date', ''))) / 12 FROM evidence.snapshot_template WHERE id = t.id AND version = 2))) y;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0026: template versions not as written: %', bad; END IF;

  PERFORM munim_meta.assert_catalog('0026');
END $$;
