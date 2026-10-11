-- 0021_mc1bc_pack_templates_history_kinds — W3 merged migrator lane M-C1bc (BOARD W3 consolidation: M-C1b + M-C1c) and
-- the T-093 DB rider (BOARD "Added 11 Oct"), migrator lane m-1, fix forward over 0001–0020. Runs as munim_migrator.
-- Additive only. Items:
--   H1  Two more history import kinds: 'shift_log' (parser shift_log_v1: closed drawer shifts — float, counted cash,
--       tenders by shift as a control total) and 'stock_count' (parser stock_count_v1: dated stock counts and their lines),
--       on core.document, core.import_format and core.import_run (the 0018 CHECKs, widened).
--   H2  imports.run.commit.v1 (draft-only) also writes core.shift, core.stock_count and core.stock_count_line — the rows a
--       person approves. It still does not list core.stock_movement: a count's adjustment is a derivation (H3). No
--       tender-to-shift link is added: core.tender.shift_id stays insert-only (0015) and a history shift reaches its
--       tenders by drawer and time window, exactly as orders' expectedCash does for a live shift.
--   H3  Derivation rule inventory.count_adjust: core.stock_count → core.stock_movement, source state
--       s.status = 'submitted' (an open or cancelled count adjusts nothing). The guard's derivation branch still judges
--       the SOURCE row only, not that the written movement belongs to it (the W2 carry-over M-C1d generalises).
--   T1  Snapshot templates for the remaining packs, columns exactly as their §3 tables: kitchen (5), inventory and
--       purchasing (10 new; inventory.below_reorder stays the 0005 v1 — see below), forecast (5), people (6), customers
--       and growth (7), compliance and assets (5), market and strategy (6) = 44. Every numeric column names its sources
--       (numeric_source, 0019); no SQL ends with ';'; every named param must be supplied (nullable ones take null).
--       `outlet_id` is nullable everywhere (null = every outlet in the minter's scope) and only narrows it (R40 C4).
--       Tables without an outlet column are read through their outlet-bearing parent (coupon_use → order, advance →
--       staff, stock_count_line → stock_count, grn_line → goods_received, supplier_quote → intel.run) so a scoped minter
--       never sees another outlet's child rows. Tenant-level by nature (no outlet anywhere in their data): purchasing
--       invoices, supplier prices and POs, coupons, viability cases.
--       min_role: manager, except people.payroll_lines and market.viability ('advisor': pay lines and ledger margins are
--       finance, which managers stay out of — W2-R8, payroll drafts are owner-only commands).
--       inventory.below_reorder: its 0005 v1 (no params; columns outlet_id, ingredient_id, ingredient_name, on_hand_milli,
--       min_qty_milli, par_qty_milli) differs from the pack's (param outlet_id; ingredient_id, on_hand_qty_milli,
--       min_qty_milli, par_qty_milli). A v2 would be the version core-api mints (latest), and its required outlet_id param
--       would refuse every existing `params: {}` caller (core-api approvals/intel-api/platform tests). Left as v1; the
--       decision is reported, not taken here.
-- New SQLSTATEs: none.

------------------------------------------------------------------------------------------------------------
-- 1. H1 — history kinds shift_log and stock_count
------------------------------------------------------------------------------------------------------------
-- Each CHECK must read exactly as 0018 wrote it (an unexpected state stops the file).
DO $$
DECLARE
  v record;
BEGIN
  FOR v IN SELECT * FROM (VALUES
      ('core.document', 'document_kind_check',
       $d$CHECK ((kind = ANY (ARRAY['supplier_invoice'::text, 'payout_statement'::text, 'bank_statement'::text, 'pos_export'::text, 'tally_export'::text, 'aggregator_orders'::text, 'market_signal'::text, 'menu'::text, 'price_list'::text, 'chat_export'::text, 'agreement'::text, 'licence'::text, 'other'::text, 'pos_bills'::text, 'waste_log'::text])))$d$),
      ('core.import_format', 'import_format_kind_check',
       $d$CHECK ((kind = ANY (ARRAY['payout_statement'::text, 'bank_statement'::text, 'pos_export'::text, 'tally_export'::text, 'aggregator_orders'::text, 'supplier_invoice'::text, 'market_signal'::text, 'menu'::text, 'price_list'::text, 'reviews'::text, 'pos_bills'::text, 'waste_log'::text])))$d$),
      ('core.import_run', 'import_run_kind_check',
       $d$CHECK ((kind = ANY (ARRAY['payout_statement'::text, 'bank_statement'::text, 'pos_export'::text, 'tally_export'::text, 'aggregator_orders'::text, 'supplier_invoice'::text, 'market_signal'::text, 'menu'::text, 'price_list'::text, 'reviews'::text, 'pos_bills'::text, 'waste_log'::text])))$d$)
    ) x(t, c, def) LOOP
    IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = v.t::regclass AND conname = v.c AND contype = 'c')
       IS DISTINCT FROM v.def THEN
      RAISE EXCEPTION '0021: % on % is not the 0018 CHECK 0021 replaces', v.c, v.t;
    END IF;
  END LOOP;
END $$;

ALTER TABLE core.document DROP CONSTRAINT document_kind_check;
ALTER TABLE core.document ADD CONSTRAINT document_kind_check
  CHECK (kind IN ('supplier_invoice', 'payout_statement', 'bank_statement', 'pos_export', 'tally_export', 'aggregator_orders',
                  'market_signal', 'menu', 'price_list', 'chat_export', 'agreement', 'licence', 'other',
                  'pos_bills', 'waste_log', 'shift_log', 'stock_count'));
ALTER TABLE core.import_format DROP CONSTRAINT import_format_kind_check;
ALTER TABLE core.import_format ADD CONSTRAINT import_format_kind_check
  CHECK (kind IN ('payout_statement', 'bank_statement', 'pos_export', 'tally_export', 'aggregator_orders', 'supplier_invoice',
                  'market_signal', 'menu', 'price_list', 'reviews',
                  'pos_bills', 'waste_log', 'shift_log', 'stock_count'));
ALTER TABLE core.import_run DROP CONSTRAINT import_run_kind_check;
ALTER TABLE core.import_run ADD CONSTRAINT import_run_kind_check
  CHECK (kind IN ('payout_statement', 'bank_statement', 'pos_export', 'tally_export', 'aggregator_orders', 'supplier_invoice',
                  'market_signal', 'menu', 'price_list', 'reviews',
                  'pos_bills', 'waste_log', 'shift_log', 'stock_count'));

------------------------------------------------------------------------------------------------------------
-- 2. H2 — what an approved import may write: drawer shifts and stock counts
------------------------------------------------------------------------------------------------------------
-- A history shift is inserted closed in one row (the 0004 CHECK: closed ⇔ closed_by, closed_at, counted, expected and
-- variance all set, variance = counted − expected); a history count is inserted 'submitted' with its lines. Both are
-- book tables: the decision of the imports.run.commit.v1 draft is their origin, inside the approver's outlet scope
-- (book_scope: shift and stock_count by their own outlet_id, a count line through its count).
UPDATE core.command_authority
   SET target_tables = target_tables || ARRAY['core.shift', 'core.stock_count', 'core.stock_count_line']
 WHERE command_type = 'imports.run.commit.v1';

------------------------------------------------------------------------------------------------------------
-- 3. H3 — inventory.count_adjust: a submitted count's adjustment movements are its derivation
------------------------------------------------------------------------------------------------------------
-- db/derivation-rules.json lists the row (gate: DB = file).
INSERT INTO core.derivation_rule (rule_id, source_table, target_table, source_state) VALUES
  ('inventory.count_adjust', 'core.stock_count', 'core.stock_movement', $s$s.status = 'submitted'$s$);

------------------------------------------------------------------------------------------------------------
-- 4. T1 — kitchen templates (packs/kitchen.md §3), min_role manager
------------------------------------------------------------------------------------------------------------
-- A ticket's time is ready_at − accepted_at (both set; untimed tickets are only counted by ticket_coverage); its slot
-- is the 30-minute slot of accepted_at, outlet-local ('HH24:MI'); its day is its order's business date.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'kitchen.ticket_times', 1,
  $q$WITH t AS (
  SELECT DISTINCT ON (k.id, ol.item_id) k.id, k.outlet_id, k.station, ol.item_id,
         extract(epoch FROM k.ready_at - k.accepted_at)::bigint AS sec, coalesce(k.ready_at > k.due_at, false) AS late,
         to_char(date_bin('30 minutes', k.accepted_at AT TIME ZONE ou.tz, timestamp '2001-01-01'), 'HH24:MI') AS slot
    FROM core.kitchen_ticket k
    JOIN core."order" o ON o.tenant_id = k.tenant_id AND o.id = k.order_id
    JOIN core.order_line ol ON ol.tenant_id = k.tenant_id AND ol.order_id = k.order_id
    JOIN core.outlet ou ON ou.tenant_id = k.tenant_id AND ou.id = k.outlet_id
   WHERE k.accepted_at IS NOT NULL AND k.ready_at IS NOT NULL
     AND o.business_date BETWEEN :from::date AND :to::date
     AND (:outlet_id::uuid IS NULL OR k.outlet_id = :outlet_id::uuid)
   ORDER BY k.id, ol.item_id)
SELECT t.station, t.item_id, t.slot AS slot_start, count(*)::bigint AS tickets,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY t.sec)::bigint AS p50_sec,
       percentile_disc(0.8) WITHIN GROUP (ORDER BY t.sec)::bigint AS p80_sec,
       count(*) FILTER (WHERE t.late)::bigint AS late_tickets,
       -- The prep time configured for the item at the station on :to (the largest across the outlets in scope).
       (SELECT max(p.prep_sec) FROM core.prep_time p
         WHERE p.item_id = t.item_id AND p.station = t.station AND p.outlet_id IN (SELECT DISTINCT x.outlet_id FROM t x)
           AND p.valid_from <= :to::date AND (p.valid_to IS NULL OR p.valid_to > :to::date))::bigint AS configured_prep_sec
  FROM t
 GROUP BY t.station, t.item_id, t.slot
 ORDER BY t.station, t.item_id, t.slot$q$,
  '{"type": "object", "required": ["outlet_id", "from", "to"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"},
                   "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
  '[{"name": "station", "type": "text"},
    {"name": "item_id", "type": "uuid"},
    {"name": "slot_start", "type": "text"},
    {"name": "tickets", "type": "integer", "numeric_source": "count:core.kitchen_ticket"},
    {"name": "p50_sec", "type": "integer", "numeric_source": ["core.kitchen_ticket.accepted_at", "core.kitchen_ticket.ready_at"]},
    {"name": "p80_sec", "type": "integer", "numeric_source": ["core.kitchen_ticket.accepted_at", "core.kitchen_ticket.ready_at"]},
    {"name": "late_tickets", "type": "integer", "numeric_source": ["count:core.kitchen_ticket", "core.kitchen_ticket.ready_at", "core.kitchen_ticket.due_at"]},
    {"name": "configured_prep_sec", "type": "integer", "numeric_source": "core.prep_time.prep_sec"}]',
  'manager');

-- This week (business dates :week_start … +6) against the four weeks before, per station and slot; rows for slots with
-- tickets this week. The last row is the Σ row (station and slot NULL): late_loss_minor = the week's refunds with reason
-- 'late' + the totals of orders cancelled after their promised time.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'kitchen.ticket_drift', 1,
  $q$WITH t AS (
  SELECT k.station, to_char(date_bin('30 minutes', k.accepted_at AT TIME ZONE ou.tz, timestamp '2001-01-01'), 'HH24:MI') AS slot,
         extract(epoch FROM k.ready_at - k.accepted_at)::bigint AS sec, o.business_date >= :week_start::date AS is_now
    FROM core.kitchen_ticket k
    JOIN core."order" o ON o.tenant_id = k.tenant_id AND o.id = k.order_id
    JOIN core.outlet ou ON ou.tenant_id = k.tenant_id AND ou.id = k.outlet_id
   WHERE k.accepted_at IS NOT NULL AND k.ready_at IS NOT NULL
     AND o.business_date >= :week_start::date - 28 AND o.business_date < :week_start::date + 7
     AND (:outlet_id::uuid IS NULL OR k.outlet_id = :outlet_id::uuid)),
g AS (
  SELECT t.station, t.slot, count(*) FILTER (WHERE t.is_now) AS n_now, count(*) FILTER (WHERE NOT t.is_now) AS n_base,
         percentile_disc(0.8) WITHIN GROUP (ORDER BY t.sec) FILTER (WHERE t.is_now) AS p80_now,
         percentile_disc(0.8) WITHIN GROUP (ORDER BY t.sec) FILTER (WHERE NOT t.is_now) AS p80_base
    FROM t GROUP BY t.station, t.slot),
loss AS (
  SELECT (SELECT coalesce(sum(f.amount_minor), 0)
            FROM core.refund f JOIN core.outlet ou ON ou.tenant_id = f.tenant_id AND ou.id = f.outlet_id
           WHERE f.reason_code = 'late' AND ((f.at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date >= :week_start::date
             AND ((f.at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date < :week_start::date + 7
             AND (:outlet_id::uuid IS NULL OR f.outlet_id = :outlet_id::uuid))
       + (SELECT coalesce(sum(o.total_minor), 0)
            FROM core."order" o
           WHERE o.status = 'cancelled' AND o.business_date >= :week_start::date AND o.business_date < :week_start::date + 7
             AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)
             AND EXISTS (SELECT 1 FROM core.order_event e
                          WHERE e.tenant_id = o.tenant_id AND e.order_id = o.id AND e.kind = 'status' AND e.to_status = 'cancelled'
                            AND o.promised_at IS NOT NULL AND e.at > o.promised_at)) AS m)
SELECT * FROM (
  SELECT g.station, g.slot AS slot_start, g.n_now::bigint AS tickets_now, g.p80_now::bigint AS p80_now_sec, g.p80_base::bigint AS p80_base_sec,
         round((g.p80_now - g.p80_base) * 10000.0 / nullif(g.p80_base, 0))::bigint AS drift_bp,
         round(g.n_now * 4 * 10000.0 / nullif(g.n_base, 0))::bigint AS load_ratio_bp,
         NULL::bigint AS late_loss_minor
    FROM g WHERE g.n_now > 0
   ORDER BY g.station, g.slot) r
UNION ALL
SELECT NULL, NULL, NULL, NULL, NULL, NULL, NULL, loss.m::bigint FROM loss$q$,
  '{"type": "object", "required": ["outlet_id", "week_start"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "week_start": {"type": "string", "format": "date"}}}',
  '[{"name": "station", "type": "text"},
    {"name": "slot_start", "type": "text"},
    {"name": "tickets_now", "type": "integer", "numeric_source": "count:core.kitchen_ticket"},
    {"name": "p80_now_sec", "type": "integer", "numeric_source": ["core.kitchen_ticket.accepted_at", "core.kitchen_ticket.ready_at"]},
    {"name": "p80_base_sec", "type": "integer", "numeric_source": ["core.kitchen_ticket.accepted_at", "core.kitchen_ticket.ready_at"]},
    {"name": "drift_bp", "type": "integer", "numeric_source": ["core.kitchen_ticket.accepted_at", "core.kitchen_ticket.ready_at"]},
    {"name": "load_ratio_bp", "type": "integer", "numeric_source": "count:core.kitchen_ticket"},
    {"name": "late_loss_minor", "type": "integer", "numeric_source": ["core.refund.amount_minor", "core.order.total_minor"]}]',
  'manager');

-- One week (business dates :week_start … +6): remake voids (reason 'remake') per station — the station configured for
-- the voided item at its outlet (core.prep_time, valid on the void's day), else 'unassigned'; then the Σ row (station
-- NULL) with the week's totals, its completed orders, the overprep waste (waste entries with reason 'overprep', valued
-- at the outlet's last receipt cost of the ingredient on or before the waste) and the median of the 8 weeks before.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'kitchen.remakes_overprep', 1,
  $q$WITH v AS (
  SELECT coalesce((SELECT p.station FROM core.prep_time p
                    WHERE p.item_id = ol.item_id AND p.outlet_id = vd.outlet_id AND p.valid_from <= vd.d AND (p.valid_to IS NULL OR p.valid_to > vd.d)
                    ORDER BY p.valid_from DESC, p.station LIMIT 1), 'unassigned') AS station, vd.amount_minor
    FROM (SELECT x.*, ((x.at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date AS d
            FROM core.void x JOIN core.outlet ou ON ou.tenant_id = x.tenant_id AND ou.id = x.outlet_id
           WHERE x.reason_code = 'remake' AND (:outlet_id::uuid IS NULL OR x.outlet_id = :outlet_id::uuid)) vd
    LEFT JOIN core.order_line ol ON ol.tenant_id = vd.tenant_id AND ol.id = vd.order_line_id
   WHERE vd.d >= :week_start::date AND vd.d < :week_start::date + 7),
w AS (
  -- Overprep waste of the week and the 8 before it, by week number (0 = this week, 1…8 = the weeks before).
  SELECT (:week_start::date - d.d + 6) / 7 AS wk,
         -m.qty_milli * (SELECT r.unit_cost_per_1000_minor FROM core.stock_movement r
                          JOIN core.outlet ro ON ro.tenant_id = r.tenant_id AND ro.id = r.outlet_id
                         WHERE r.outlet_id = m.outlet_id AND r.ingredient_id = m.ingredient_id AND r.kind = 'receipt'
                           AND r.unit_cost_per_1000_minor IS NOT NULL AND ((r.at AT TIME ZONE ro.tz) - ro.business_day_cutoff)::date <= d.d
                         ORDER BY r.at DESC, r.id DESC LIMIT 1) / 1000000.0 AS value
    FROM core.stock_movement m
    JOIN core.waste_log wl ON wl.tenant_id = m.tenant_id AND wl.id = m.ref_id AND m.ref_type = 'core.waste_log'
    JOIN core.outlet ou ON ou.tenant_id = m.tenant_id AND ou.id = m.outlet_id
    CROSS JOIN LATERAL (SELECT ((m.at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date AS d) d
   WHERE m.kind = 'waste' AND wl.reason = 'overprep' AND (:outlet_id::uuid IS NULL OR m.outlet_id = :outlet_id::uuid)
     AND d.d >= :week_start::date - 56 AND d.d < :week_start::date + 7),
wk AS (
  SELECT n.wk, coalesce(sum(w.value), 0) AS value FROM generate_series(0, 8) n(wk) LEFT JOIN w ON w.wk = n.wk GROUP BY n.wk)
SELECT * FROM (
  SELECT v.station, count(*)::bigint AS remakes, sum(v.amount_minor)::bigint AS remake_minor, NULL::bigint AS orders,
         NULL::bigint AS overprep_minor, NULL::bigint AS median_overprep_minor
    FROM v GROUP BY v.station ORDER BY v.station) s
UNION ALL
SELECT NULL, (SELECT count(*) FROM v)::bigint, (SELECT coalesce(sum(v.amount_minor), 0) FROM v)::bigint,
       (SELECT count(*) FROM core."order" o
         WHERE o.status = 'completed' AND o.business_date >= :week_start::date AND o.business_date < :week_start::date + 7
           AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid))::bigint,
       round((SELECT value FROM wk WHERE wk.wk = 0))::bigint,
       round((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY wk.value) FROM wk WHERE wk.wk BETWEEN 1 AND 8))::bigint$q$,
  '{"type": "object", "required": ["outlet_id", "week_start"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "week_start": {"type": "string", "format": "date"}}}',
  '[{"name": "station", "type": "text"},
    {"name": "remakes", "type": "integer", "numeric_source": "count:core.void"},
    {"name": "remake_minor", "type": "integer", "numeric_source": "core.void.amount_minor"},
    {"name": "orders", "type": "integer", "numeric_source": "count:core.order"},
    {"name": "overprep_minor", "type": "integer", "numeric_source": ["core.stock_movement.qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]},
    {"name": "median_overprep_minor", "type": "integer", "numeric_source": ["core.stock_movement.qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]}]',
  'manager');

-- Prep for :business_date: each ingredient's forecast use (the latest forecast run with points for the day, its own
-- method's points only — every run stores both methods), through the recipe valid that day (with its waste allowance,
-- converted to the ingredient's base unit), beside the stock on hand now and the par level. prep_qty_milli = the
-- forecast use, capped at the stock on hand (never below 0).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'kitchen.prep_need', 1,
  $q$WITH conv (from_unit, to_unit, f) AS (VALUES ('kg', 'g', 1000::numeric), ('g', 'kg', 0.001), ('l', 'ml', 1000), ('ml', 'l', 0.001)),
fr AS (
  SELECT r.id, r.method FROM intel.forecast_run r
   WHERE EXISTS (SELECT 1 FROM intel.forecast_point p WHERE p.forecast_run_id = r.id AND p.business_on = :business_date::date
                    AND (:outlet_id::uuid IS NULL OR p.outlet_id = :outlet_id::uuid))
   ORDER BY r.created_at DESC, r.id DESC LIMIT 1),
fp AS (
  SELECT p.item_id, sum(p.qty_milli) AS qty_milli
    FROM intel.forecast_point p JOIN fr ON fr.id = p.forecast_run_id AND fr.method = p.method
   WHERE p.business_on = :business_date::date AND p.slot_start IS NULL AND p.item_id IS NOT NULL
     AND (:outlet_id::uuid IS NULL OR p.outlet_id = :outlet_id::uuid)
   GROUP BY p.item_id),
need AS (
  SELECT rl.ingredient_id,
         sum(fp.qty_milli * rl.qty_milli * (10000 + rl.waste_pct_bp) / (10000.0 * rv.yield_qty_milli)
             * CASE WHEN rl.unit = g.base_unit THEN 1 ELSE cv.f END) AS qty
    FROM fp
    JOIN core.recipe_version rv ON rv.item_id = fp.item_id AND rv.variant_id IS NULL
     AND rv.valid_from <= :business_date::date AND (rv.valid_to IS NULL OR rv.valid_to > :business_date::date)
    JOIN core.recipe_line rl ON rl.tenant_id = rv.tenant_id AND rl.recipe_version_id = rv.id
    JOIN core.ingredient g ON g.tenant_id = rl.tenant_id AND g.id = rl.ingredient_id
    LEFT JOIN conv cv ON cv.from_unit = rl.unit AND cv.to_unit = g.base_unit
   GROUP BY rl.ingredient_id),
oh AS (
  SELECT m.ingredient_id, sum(m.qty_milli) AS qty FROM core.stock_movement m
   WHERE (:outlet_id::uuid IS NULL OR m.outlet_id = :outlet_id::uuid) AND m.ingredient_id IN (SELECT ingredient_id FROM need)
   GROUP BY m.ingredient_id),
par AS (
  SELECT r.ingredient_id, sum(r.par_qty_milli) AS qty FROM core.reorder_level r
   WHERE (:outlet_id::uuid IS NULL OR r.outlet_id = :outlet_id::uuid) GROUP BY r.ingredient_id)
SELECT need.ingredient_id, round(need.qty)::bigint AS forecast_qty_milli, coalesce(oh.qty, 0)::bigint AS on_hand_qty_milli,
       par.qty::bigint AS par_qty_milli, least(round(need.qty), greatest(coalesce(oh.qty, 0), 0))::bigint AS prep_qty_milli
  FROM need LEFT JOIN oh ON oh.ingredient_id = need.ingredient_id LEFT JOIN par ON par.ingredient_id = need.ingredient_id
 WHERE need.qty IS NOT NULL
 ORDER BY need.ingredient_id$q$,
  '{"type": "object", "required": ["outlet_id", "business_date"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "business_date": {"type": "string", "format": "date"}}}',
  '[{"name": "ingredient_id", "type": "uuid"},
    {"name": "forecast_qty_milli", "type": "integer", "numeric_source": ["intel.forecast_point.qty_milli", "core.recipe_line.qty_milli", "core.recipe_line.waste_pct_bp", "core.recipe_version.yield_qty_milli"]},
    {"name": "on_hand_qty_milli", "type": "integer", "numeric_source": "core.stock_movement.qty_milli"},
    {"name": "par_qty_milli", "type": "integer", "numeric_source": "core.reorder_level.par_qty_milli"},
    {"name": "prep_qty_milli", "type": "integer", "numeric_source": ["intel.forecast_point.qty_milli", "core.recipe_line.qty_milli", "core.recipe_line.waste_pct_bp", "core.recipe_version.yield_qty_milli", "core.stock_movement.qty_milli"]}]',
  'manager');

-- Tickets of orders in the window, how many carry both timestamps, and the share (floor, bp).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'kitchen.ticket_coverage', 1,
  $q$SELECT count(*)::bigint AS tickets,
       count(*) FILTER (WHERE k.accepted_at IS NOT NULL AND k.ready_at IS NOT NULL)::bigint AS timed_tickets,
       (count(*) FILTER (WHERE k.accepted_at IS NOT NULL AND k.ready_at IS NOT NULL) * 10000 / nullif(count(*), 0))::bigint AS coverage_bp
  FROM core.kitchen_ticket k
  JOIN core."order" o ON o.tenant_id = k.tenant_id AND o.id = k.order_id
 WHERE o.business_date BETWEEN :from::date AND :to::date
   AND (:outlet_id::uuid IS NULL OR k.outlet_id = :outlet_id::uuid)$q$,
  '{"type": "object", "required": ["outlet_id", "from", "to"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"},
                   "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
  '[{"name": "tickets", "type": "integer", "numeric_source": "count:core.kitchen_ticket"},
    {"name": "timed_tickets", "type": "integer", "numeric_source": "count:core.kitchen_ticket"},
    {"name": "coverage_bp", "type": "integer", "numeric_source": "count:core.kitchen_ticket"}]',
  'manager');

------------------------------------------------------------------------------------------------------------
-- 5. T1 — inventory and purchasing templates (packs/inventory-purchasing.md §3), min_role manager
------------------------------------------------------------------------------------------------------------
-- Pack §2: on-hand = Σ stock_movement.qty_milli (movements are in the ingredient's base unit), valued at the last
-- receipt cost (unit_cost_per_1000_minor: per 1000 base units, so value = qty_milli × per1000 / 1,000,000). "Today" is
-- each outlet's own business date now (its zone and cutoff) where the pack gives no date param.
-- `fuse` (shared): forecast use per outlet, day and ingredient — the latest forecast run with a point the minter can
-- see, that run's own method only (every run stores both methods' points), whole-day points of named items, through
-- the recipe valid that day (waste allowance included, converted to the base unit); a shop SKU with no recipe is one
-- base unit of its stock record.
DO $$
DECLARE
  fuse constant text := $f$conv (from_unit, to_unit, f) AS (VALUES ('kg', 'g', 1000::numeric), ('g', 'kg', 0.001), ('l', 'ml', 1000), ('ml', 'l', 0.001)),
fr AS (
  SELECT r.id, r.method FROM intel.forecast_run r
   WHERE EXISTS (SELECT 1 FROM intel.forecast_point p WHERE p.tenant_id = r.tenant_id AND p.forecast_run_id = r.id)
   ORDER BY r.created_at DESC, r.id DESC LIMIT 1),
fuse AS (
  SELECT p.outlet_id, p.business_on, x.ingredient_id, sum(x.qty) AS qty
    FROM fr JOIN intel.forecast_point p ON p.forecast_run_id = fr.id AND p.method = fr.method
    CROSS JOIN LATERAL (
      SELECT rl.ingredient_id,
             p.qty_milli * rl.qty_milli * (10000 + rl.waste_pct_bp) / (10000.0 * rv.yield_qty_milli)
               * CASE WHEN rl.unit = g.base_unit THEN 1 ELSE cv.f END AS qty
        FROM core.recipe_version rv
        JOIN core.recipe_line rl ON rl.tenant_id = rv.tenant_id AND rl.recipe_version_id = rv.id
        JOIN core.ingredient g ON g.tenant_id = rl.tenant_id AND g.id = rl.ingredient_id
        LEFT JOIN conv cv ON cv.from_unit = rl.unit AND cv.to_unit = g.base_unit
       WHERE rv.item_id = p.item_id AND rv.variant_id IS NULL AND rv.valid_from <= p.business_on
         AND (rv.valid_to IS NULL OR rv.valid_to > p.business_on)
      UNION ALL
      SELECT i.stock_ingredient_id, p.qty_milli::numeric
        FROM core.item i
       WHERE i.id = p.item_id AND i.kind = 'sku'
         AND NOT EXISTS (SELECT 1 FROM core.recipe_version rv WHERE rv.item_id = i.id AND rv.variant_id IS NULL)) x
   WHERE p.slot_start IS NULL AND p.item_id IS NOT NULL
   GROUP BY p.outlet_id, p.business_on, x.ingredient_id)$f$;
  fuse_src constant jsonb := '["intel.forecast_point.qty_milli", "core.recipe_line.qty_milli", "core.recipe_line.waste_pct_bp", "core.recipe_version.yield_qty_milli"]';
  -- core.purchase_order is tenant-visible (tenant-level command scope): a PO counts for a scoped minter only when one
  -- of its outlets is in the minter's scope.
  po_scope constant text := $c$((SELECT current_setting('app.outlet_ids', true)) = '{*}'
          OR po.outlet_ids && (SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])$c$;
BEGIN
  -- Need over the next :lead_days business days (tomorrow … today + lead_days) against stock on hand and the open
  -- committed POs (the quantity not yet received) due by then, summed over the outlets in scope. INFERENCE (pack gives no
  -- formula): proposed_min = the need over the lead time; proposed_par = the need over the lead time + 7 days.
  -- stockout_on = the first day the projected stock (on hand + POs due by that day − cumulative need) is below 0.
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
    'inventory.shortfall', 1,
    'WITH ' || fuse || $q$,
ou AS (
  SELECT o.id, ((now() AT TIME ZONE o.tz) - o.business_day_cutoff)::date AS today FROM core.outlet o
   WHERE :outlet_id::uuid IS NULL OR o.id = :outlet_id::uuid),
d AS (
  SELECT f.ingredient_id, f.business_on - ou.today AS k, sum(f.qty) AS qty
    FROM fuse f JOIN ou ON ou.id = f.outlet_id
   WHERE f.business_on > ou.today AND f.business_on <= ou.today + :lead_days::int + 7
   GROUP BY f.ingredient_id, f.business_on - ou.today),
need AS (
  SELECT d.ingredient_id, sum(d.qty) FILTER (WHERE d.k <= :lead_days::int) AS lead_qty, sum(d.qty) AS par_qty
    FROM d GROUP BY d.ingredient_id),
oh AS (
  SELECT m.ingredient_id, sum(m.qty_milli) AS qty FROM core.stock_movement m
   WHERE m.outlet_id IN (SELECT id FROM ou) AND m.ingredient_id IN (SELECT ingredient_id FROM need) GROUP BY m.ingredient_id),
po AS (
  SELECT pl.ingredient_id, greatest(coalesce(po.expected_on - (SELECT min(today) FROM ou), 0), 1) AS k,
         greatest(pl.qty_milli - coalesce((SELECT sum(g.qty_milli) FROM core.grn_line g
                                            JOIN core.goods_received gr ON gr.tenant_id = g.tenant_id AND gr.id = g.goods_received_id
                                           WHERE g.tenant_id = pl.tenant_id AND g.po_line_id = pl.id), 0), 0) AS qty
    FROM core.purchase_order po JOIN core.po_line pl ON pl.tenant_id = po.tenant_id AND pl.po_id = po.id
   WHERE po.status = 'committed' AND $q$ || po_scope || $q$
     AND (:outlet_id::uuid IS NULL OR :outlet_id::uuid = ANY (po.outlet_ids))
     AND (po.expected_on IS NULL OR po.expected_on <= (SELECT min(today) FROM ou) + :lead_days::int)),
proj AS (
  SELECT need.ingredient_id, k.k,
         coalesce(oh.qty, 0) + coalesce((SELECT sum(po.qty) FROM po WHERE po.ingredient_id = need.ingredient_id AND po.k <= k.k), 0)
           - coalesce((SELECT sum(d.qty) FROM d WHERE d.ingredient_id = need.ingredient_id AND d.k <= k.k), 0) AS left_qty
    FROM need CROSS JOIN generate_series(1, :lead_days::int) k(k) LEFT JOIN oh ON oh.ingredient_id = need.ingredient_id)
SELECT need.ingredient_id, round(coalesce(need.lead_qty, 0))::bigint AS need_qty_milli,
       round(coalesce(need.lead_qty, 0))::bigint AS proposed_min_qty_milli, round(need.par_qty)::bigint AS proposed_par_qty_milli,
       coalesce(oh.qty, 0)::bigint AS on_hand_qty_milli,
       coalesce((SELECT sum(po.qty) FROM po WHERE po.ingredient_id = need.ingredient_id), 0)::bigint AS open_po_qty_milli,
       greatest(round(coalesce(need.lead_qty, 0)) - coalesce(oh.qty, 0)
                - coalesce((SELECT sum(po.qty) FROM po WHERE po.ingredient_id = need.ingredient_id), 0), 0)::bigint AS shortfall_qty_milli,
       (SELECT min(today) FROM ou) + (SELECT min(p.k) FROM proj p WHERE p.ingredient_id = need.ingredient_id AND p.left_qty < 0) AS stockout_on
  FROM need LEFT JOIN oh ON oh.ingredient_id = need.ingredient_id
 ORDER BY need.ingredient_id$q$,
    '{"type": "object", "required": ["outlet_id", "lead_days"], "additionalProperties": false,
      "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "lead_days": {"type": "integer", "minimum": 1, "maximum": 30}}}',
    jsonb_build_array(
      '{"name": "ingredient_id", "type": "uuid"}'::jsonb,
      jsonb_build_object('name', 'need_qty_milli', 'type', 'integer', 'numeric_source', fuse_src),
      jsonb_build_object('name', 'proposed_min_qty_milli', 'type', 'integer', 'numeric_source', fuse_src),
      jsonb_build_object('name', 'proposed_par_qty_milli', 'type', 'integer', 'numeric_source', fuse_src),
      '{"name": "on_hand_qty_milli", "type": "integer", "numeric_source": "core.stock_movement.qty_milli"}'::jsonb,
      '{"name": "open_po_qty_milli", "type": "integer", "numeric_source": ["core.po_line.qty_milli", "core.grn_line.qty_milli"]}'::jsonb,
      jsonb_build_object('name', 'shortfall_qty_milli', 'type', 'integer', 'numeric_source',
        fuse_src || '["core.stock_movement.qty_milli", "core.po_line.qty_milli", "core.grn_line.qty_milli"]'),
      '{"name": "stockout_on", "type": "date"}'::jsonb),
    'manager');

  -- Batches expiring in :days days (today included, already-expired batches excluded) that still hold stock, with the
  -- forecast use of their ingredient at their outlet before the expiry day, first-expiring batch first (FEFO): a batch
  -- is credited with what is left of that use after the batches of the same ingredient that expire before it.
  -- at_risk = remaining − use (≥ 0), valued at the batch's own receipt cost (else the outlet's last receipt cost).
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
    'inventory.expiry_risk', 1,
    'WITH ' || fuse || $q$,
b AS (
  SELECT bt.id, bt.outlet_id, bt.ingredient_id, bt.expires_on, td.today, sum(m.qty_milli) AS remaining
    FROM core.batch bt
    JOIN core.outlet ou ON ou.tenant_id = bt.tenant_id AND ou.id = bt.outlet_id
    CROSS JOIN LATERAL (SELECT ((now() AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date AS today) td
    JOIN core.stock_movement m ON m.tenant_id = bt.tenant_id AND m.outlet_id = bt.outlet_id AND m.batch_id = bt.id
   WHERE bt.expires_on IS NOT NULL AND bt.expires_on >= td.today AND bt.expires_on <= td.today + :days::int
     AND (:outlet_id::uuid IS NULL OR bt.outlet_id = :outlet_id::uuid)
   GROUP BY bt.id, bt.outlet_id, bt.ingredient_id, bt.expires_on, td.today
  HAVING sum(m.qty_milli) > 0),
u AS (
  SELECT b.*,
         greatest(coalesce((SELECT sum(f.qty) FROM fuse f WHERE f.outlet_id = b.outlet_id AND f.ingredient_id = b.ingredient_id
                              AND f.business_on >= b.today AND f.business_on < b.expires_on), 0)
                  - coalesce((SELECT sum(e.remaining) FROM b e WHERE e.outlet_id = b.outlet_id AND e.ingredient_id = b.ingredient_id
                                AND (e.expires_on, e.id) < (b.expires_on, b.id)), 0), 0) AS fefo_use,
         coalesce((SELECT r.unit_cost_per_1000_minor FROM core.stock_movement r
                    WHERE r.tenant_id = b.tenant_id AND r.batch_id = b.id AND r.kind = 'receipt' AND r.unit_cost_per_1000_minor IS NOT NULL
                    ORDER BY r.at DESC, r.id DESC LIMIT 1),
                  (SELECT r.unit_cost_per_1000_minor FROM core.stock_movement r
                    WHERE r.outlet_id = b.outlet_id AND r.ingredient_id = b.ingredient_id AND r.kind = 'receipt' AND r.unit_cost_per_1000_minor IS NOT NULL
                    ORDER BY r.at DESC, r.id DESC LIMIT 1)) AS per1000
    FROM (SELECT b.*, bt.tenant_id FROM b JOIN core.batch bt ON bt.id = b.id) b)
SELECT u.id AS batch_id, u.expires_on AS expiry_on, (u.expires_on - u.today)::bigint AS days_to_expiry,
       EXISTS (SELECT 1 FROM core.item i WHERE i.kind = 'sku' AND i.stock_ingredient_id = u.ingredient_id) AS is_sku,
       u.remaining::bigint AS remaining_qty_milli, round(least(u.fefo_use, u.remaining))::bigint AS use_before_expiry_qty_milli,
       greatest(u.remaining - round(u.fefo_use), 0)::bigint AS at_risk_qty_milli,
       round(greatest(u.remaining - round(u.fefo_use), 0) * u.per1000 / 1000000.0)::bigint AS at_risk_minor
  FROM u
 ORDER BY u.expires_on, u.id$q$,
    '{"type": "object", "required": ["outlet_id", "days"], "additionalProperties": false,
      "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "days": {"type": "integer", "minimum": 0, "maximum": 365}}}',
    jsonb_build_array(
      '{"name": "batch_id", "type": "uuid"}'::jsonb,
      '{"name": "expiry_on", "type": "date"}'::jsonb,
      '{"name": "days_to_expiry", "type": "integer", "numeric_source": "core.batch.expires_on"}'::jsonb,
      '{"name": "is_sku", "type": "boolean"}'::jsonb,
      '{"name": "remaining_qty_milli", "type": "integer", "numeric_source": "core.stock_movement.qty_milli"}'::jsonb,
      jsonb_build_object('name', 'use_before_expiry_qty_milli', 'type', 'integer', 'numeric_source', fuse_src || '["core.stock_movement.qty_milli"]'),
      jsonb_build_object('name', 'at_risk_qty_milli', 'type', 'integer', 'numeric_source', fuse_src || '["core.stock_movement.qty_milli"]'),
      jsonb_build_object('name', 'at_risk_minor', 'type', 'integer', 'numeric_source',
        fuse_src || '["core.stock_movement.qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]')),
    'manager');

  -- What a deal review needs about one simulated-supplier quote (pack §6 deal review). Scope = the outlets of the quote's
  -- run (its outlet_scope) that the minter may see: every figure below reads only those outlets (and tenant-wide rows).
  -- INFERENCE (pack gives no windows): need = forecast use of the quoted ingredient over the next 7 days at those
  -- outlets; use in shelf life = over the next shelf_life_days days (30 when the ingredient has none); budget left =
  -- the month's 'purchases' budgets minus the POs (committed or received) created that month; margin at quote = the
  -- lowest margin over the dishes whose current recipe uses the ingredient, priced at their average net selling price
  -- over the last 28 days and costed with the ingredient at the quoted price, every other line at its last receipt cost.
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
    'purchasing.deal_inputs', 1,
    'WITH ' || fuse || $q$,
q AS (
  SELECT q.*, r.outlet_scope FROM intel.supplier_quote q JOIN intel.run r ON r.tenant_id = q.tenant_id AND r.id = q.run_id WHERE q.id = :quote_id::uuid),
pk AS (
  SELECT (cp.doc -> 'tax' ->> 'price_display') = 'inclusive' AS inclusive
    FROM core.tenant t JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
   WHERE cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')),
ou AS (
  SELECT o.id, ((now() AT TIME ZONE o.tz) - o.business_day_cutoff)::date AS today FROM core.outlet o, q
   WHERE ('*' = ANY (q.outlet_scope) OR o.id::text = ANY (q.outlet_scope))
     AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
          OR o.id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[]))),
use AS (
  SELECT coalesce(sum(f.qty) FILTER (WHERE f.business_on <= ou.today + 7), 0) AS need,
         coalesce(sum(f.qty) FILTER (WHERE f.business_on <= ou.today + coalesce(g.shelf_life_days, 30)), 0) AS shelf
    FROM q JOIN core.ingredient g ON g.tenant_id = q.tenant_id AND g.id = q.ingredient_id
    JOIN fuse f ON f.ingredient_id = q.ingredient_id JOIN ou ON ou.id = f.outlet_id AND f.business_on > ou.today),
dish AS (
  SELECT rv.item_id, rv.yield_qty_milli, rl.ingredient_id, rl.qty_milli, rl.unit, rl.waste_pct_bp
    FROM core.recipe_version rv JOIN core.recipe_line rl ON rl.tenant_id = rv.tenant_id AND rl.recipe_version_id = rv.id
   WHERE rv.variant_id IS NULL AND rv.valid_from <= current_date AND (rv.valid_to IS NULL OR rv.valid_to > current_date)
     AND rv.item_id IN (SELECT r2.item_id FROM core.recipe_version r2 JOIN core.recipe_line l2 ON l2.tenant_id = r2.tenant_id AND l2.recipe_version_id = r2.id
                         WHERE l2.ingredient_id = (SELECT ingredient_id FROM q) AND r2.variant_id IS NULL
                           AND r2.valid_from <= current_date AND (r2.valid_to IS NULL OR r2.valid_to > current_date))),
costed AS (
  SELECT dish.item_id,
         sum(dish.qty_milli * (10000 + dish.waste_pct_bp)
             * CASE WHEN dish.ingredient_id = q.ingredient_id
                    THEN q.unit_price_minor * CASE WHEN dish.unit = q.unit THEN 1 ELSE cq.f END
                    ELSE lc.per1000 / 1000.0 * CASE WHEN dish.unit = lc.unit THEN 1 ELSE cl.f END END)
           / (10000.0 * min(dish.yield_qty_milli)) AS unit_cost,
         count(*) FILTER (WHERE dish.ingredient_id <> q.ingredient_id AND lc.per1000 IS NULL) AS unpriced
    FROM dish CROSS JOIN q
    LEFT JOIN conv cq ON cq.from_unit = dish.unit AND cq.to_unit = q.unit
    LEFT JOIN LATERAL (
      SELECT m.unit, m.unit_cost_per_1000_minor AS per1000 FROM core.stock_movement m
       WHERE m.ingredient_id = dish.ingredient_id AND m.kind = 'receipt' AND m.unit_cost_per_1000_minor IS NOT NULL
         AND m.outlet_id IN (SELECT id FROM ou)
       ORDER BY m.at DESC, m.id DESC LIMIT 1) lc ON true
    LEFT JOIN conv cl ON cl.from_unit = dish.unit AND cl.to_unit = lc.unit
   GROUP BY dish.item_id),
sold AS (
  SELECT ol.item_id,
         sum(round(ol.qty_milli * ol.unit_price_minor / 1000.0) - ol.line_discount_minor - CASE WHEN pk.inclusive THEN ol.tax_minor ELSE 0 END)
           * 1000.0 / nullif(sum(ol.qty_milli), 0) AS unit_net
    FROM core."order" o JOIN core.order_line ol ON ol.tenant_id = o.tenant_id AND ol.order_id = o.id CROSS JOIN pk
   WHERE o.status = 'completed' AND o.business_date > current_date - 28 AND ol.item_id IN (SELECT item_id FROM costed)
     AND o.outlet_id IN (SELECT id FROM ou)
   GROUP BY ol.item_id),
pol AS (
  SELECT b.margin_floor_bp, b.min_payment_days FROM core.business_policy b
   WHERE b.valid_from <= current_date AND (b.valid_to IS NULL OR b.valid_to > current_date)
     AND (b.outlet_id IS NULL OR b.outlet_id IN (SELECT id FROM ou))
   ORDER BY b.outlet_id IS NULL, b.valid_from DESC, b.id LIMIT 1),
mon AS (SELECT date_trunc('month', (SELECT min(today) FROM ou))::date AS m)
SELECT round(q.unit_price_minor * q.qty_milli / 1000.0)::bigint AS quote_total_minor, q.payment_days::bigint AS quote_payment_days,
       ((SELECT sum(bu.amount_minor) FROM core.budget bu, mon
          WHERE bu.category = 'purchases' AND bu.period_month = mon.m AND (bu.outlet_id IS NULL OR bu.outlet_id IN (SELECT id FROM ou)))
        - (SELECT coalesce(sum(po.total_minor), 0) FROM core.purchase_order po, mon
            WHERE po.status IN ('committed', 'received') AND po.outlet_ids && ARRAY(SELECT id FROM ou)
              AND date_trunc('month', po.created_at)::date = mon.m))::bigint AS budget_left_minor,
       (SELECT coalesce(sum(greatest(pl.qty_milli - coalesce((SELECT sum(g.qty_milli) FROM core.grn_line g
                                     JOIN core.goods_received gr ON gr.tenant_id = g.tenant_id AND gr.id = g.goods_received_id
                                    WHERE g.tenant_id = pl.tenant_id AND g.po_line_id = pl.id), 0), 0)), 0)
          FROM core.purchase_order po JOIN core.po_line pl ON pl.tenant_id = po.tenant_id AND pl.po_id = po.id
         WHERE po.status = 'committed' AND pl.ingredient_id = q.ingredient_id AND po.outlet_ids && ARRAY(SELECT id FROM ou))::bigint AS open_commit_qty_milli,
       round((SELECT need FROM use))::bigint AS need_qty_milli, round((SELECT shelf FROM use))::bigint AS use_in_shelf_life_qty_milli,
       (SELECT min(round((s.unit_net - c.unit_cost) * 10000 / nullif(s.unit_net, 0)))
          FROM costed c JOIN sold s ON s.item_id = c.item_id WHERE c.unpriced = 0)::bigint AS margin_at_quote_bp,
       (SELECT margin_floor_bp FROM pol)::bigint AS margin_floor_bp, (SELECT min_payment_days FROM pol)::bigint AS min_payment_days
  FROM q$q$,
    '{"type": "object", "required": ["quote_id"], "additionalProperties": false,
      "properties": {"quote_id": {"type": "string", "format": "uuid"}}}',
    jsonb_build_array(
      '{"name": "quote_total_minor", "type": "integer", "numeric_source": ["intel.supplier_quote.unit_price_minor", "intel.supplier_quote.qty_milli"]}'::jsonb,
      '{"name": "quote_payment_days", "type": "integer", "numeric_source": "intel.supplier_quote.payment_days"}'::jsonb,
      '{"name": "budget_left_minor", "type": "integer", "numeric_source": ["core.budget.amount_minor", "core.purchase_order.total_minor"]}'::jsonb,
      '{"name": "open_commit_qty_milli", "type": "integer", "numeric_source": ["core.po_line.qty_milli", "core.grn_line.qty_milli"]}'::jsonb,
      jsonb_build_object('name', 'need_qty_milli', 'type', 'integer', 'numeric_source', fuse_src),
      jsonb_build_object('name', 'use_in_shelf_life_qty_milli', 'type', 'integer', 'numeric_source', fuse_src || '["core.ingredient.shelf_life_days"]'),
      '{"name": "margin_at_quote_bp", "type": "integer", "numeric_source": ["core.recipe_line.qty_milli", "core.recipe_line.waste_pct_bp", "core.recipe_version.yield_qty_milli",
        "core.stock_movement.unit_cost_per_1000_minor", "intel.supplier_quote.unit_price_minor", "core.order_line.qty_milli", "core.order_line.unit_price_minor",
        "core.order_line.line_discount_minor", "core.order_line.tax_minor"]}'::jsonb,
      '{"name": "margin_floor_bp", "type": "integer", "numeric_source": "core.business_policy.margin_floor_bp"}'::jsonb,
      '{"name": "min_payment_days", "type": "integer", "numeric_source": "core.business_policy.min_payment_days"}'::jsonb),
    'manager');
END $$;

-- On-hand vs reorder levels (02-schema §7) in the pack's columns: inventory.below_reorder is the 0005 v1 (header).

-- Waste per ingredient in one week (business dates :week_start … +6, every waste movement), valued at the outlet's
-- last receipt cost on or before the waste, against the median of the 8 weeks before (weeks without waste count as 0);
-- excess = waste − median (≥ 0). Rows for ingredients with waste this week.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'inventory.waste_week', 1,
  $q$WITH w AS (
  SELECT m.ingredient_id, (:week_start::date - d.d + 6) / 7 AS wk,
         -m.qty_milli * (SELECT r.unit_cost_per_1000_minor FROM core.stock_movement r
                          JOIN core.outlet ro ON ro.tenant_id = r.tenant_id AND ro.id = r.outlet_id
                         WHERE r.outlet_id = m.outlet_id AND r.ingredient_id = m.ingredient_id AND r.kind = 'receipt'
                           AND r.unit_cost_per_1000_minor IS NOT NULL AND ((r.at AT TIME ZONE ro.tz) - ro.business_day_cutoff)::date <= d.d
                         ORDER BY r.at DESC, r.id DESC LIMIT 1) / 1000000.0 AS value
    FROM core.stock_movement m
    JOIN core.outlet ou ON ou.tenant_id = m.tenant_id AND ou.id = m.outlet_id
    CROSS JOIN LATERAL (SELECT ((m.at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date AS d) d
   WHERE m.kind = 'waste' AND (:outlet_id::uuid IS NULL OR m.outlet_id = :outlet_id::uuid)
     AND d.d >= :week_start::date - 56 AND d.d < :week_start::date + 7),
g AS (
  SELECT i.ingredient_id, n.wk, coalesce(sum(w.value), 0) AS value
    FROM (SELECT DISTINCT ingredient_id FROM w WHERE wk = 0) i CROSS JOIN generate_series(0, 8) n(wk)
    LEFT JOIN w ON w.ingredient_id = i.ingredient_id AND w.wk = n.wk
   GROUP BY i.ingredient_id, n.wk),
s AS (
  SELECT g.ingredient_id, round(sum(g.value) FILTER (WHERE g.wk = 0)) AS waste,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY g.value) FILTER (WHERE g.wk BETWEEN 1 AND 8)) AS median
    FROM g GROUP BY g.ingredient_id)
SELECT s.ingredient_id, s.waste::bigint AS waste_minor, s.median::bigint AS median_minor, greatest(s.waste - s.median, 0)::bigint AS excess_minor
  FROM s
 ORDER BY s.ingredient_id$q$,
  '{"type": "object", "required": ["outlet_id", "week_start"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "week_start": {"type": "string", "format": "date"}}}',
  '[{"name": "ingredient_id", "type": "uuid"},
    {"name": "waste_minor", "type": "integer", "numeric_source": ["core.stock_movement.qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]},
    {"name": "median_minor", "type": "integer", "numeric_source": ["core.stock_movement.qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]},
    {"name": "excess_minor", "type": "integer", "numeric_source": ["core.stock_movement.qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]}]',
  'manager');

-- One stock count (read through its count: the lines have no outlet of their own): per ingredient the expected and
-- counted quantities, the loss (expected − counted, when short) valued at the last receipt cost on or before the count
-- (the batch's own receipt for a batch line), and the counted value; the Σ row (ingredient NULL) sums both values.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'inventory.shrinkage', 1,
  $q$WITH l AS (
  SELECT sl.ingredient_id, sl.expected_qty_milli, sl.counted_qty_milli,
         coalesce((SELECT r.unit_cost_per_1000_minor FROM core.stock_movement r
                    WHERE r.tenant_id = sl.tenant_id AND sl.batch_id IS NOT NULL AND r.batch_id = sl.batch_id AND r.kind = 'receipt'
                      AND r.unit_cost_per_1000_minor IS NOT NULL AND r.at <= c.counted_at
                    ORDER BY r.at DESC, r.id DESC LIMIT 1),
                  (SELECT r.unit_cost_per_1000_minor FROM core.stock_movement r
                    WHERE r.outlet_id = c.outlet_id AND r.ingredient_id = sl.ingredient_id AND r.kind = 'receipt'
                      AND r.unit_cost_per_1000_minor IS NOT NULL AND r.at <= c.counted_at
                    ORDER BY r.at DESC, r.id DESC LIMIT 1)) AS per1000
    FROM core.stock_count c
    JOIN core.stock_count_line sl ON sl.tenant_id = c.tenant_id AND sl.stock_count_id = c.id
   WHERE c.id = :count_id::uuid),
i AS (
  SELECT l.ingredient_id, sum(l.expected_qty_milli) AS expected, sum(l.counted_qty_milli) AS counted,
         sum(greatest(l.expected_qty_milli - l.counted_qty_milli, 0) * l.per1000 / 1000000.0) AS loss,
         sum(l.counted_qty_milli * l.per1000 / 1000000.0) AS counted_value
    FROM l GROUP BY l.ingredient_id)
SELECT * FROM (
  SELECT i.ingredient_id, i.expected::bigint AS expected_qty_milli, i.counted::bigint AS counted_qty_milli,
         round(i.loss)::bigint AS loss_minor, round(i.counted_value)::bigint AS counted_value_minor
    FROM i ORDER BY i.ingredient_id) r
UNION ALL
SELECT NULL, NULL, NULL, round(sum(i.loss))::bigint, round(sum(i.counted_value))::bigint FROM i HAVING count(*) > 0$q$,
  '{"type": "object", "required": ["count_id"], "additionalProperties": false,
    "properties": {"count_id": {"type": "string", "format": "uuid"}}}',
  '[{"name": "ingredient_id", "type": "uuid"},
    {"name": "expected_qty_milli", "type": "integer", "numeric_source": "core.stock_count_line.expected_qty_milli"},
    {"name": "counted_qty_milli", "type": "integer", "numeric_source": "core.stock_count_line.counted_qty_milli"},
    {"name": "loss_minor", "type": "integer", "numeric_source": ["core.stock_count_line.expected_qty_milli", "core.stock_count_line.counted_qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]},
    {"name": "counted_value_minor", "type": "integer", "numeric_source": ["core.stock_count_line.counted_qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]}]',
  'manager');

-- Ingredients with stock on hand in scope and no sale consumption in the last :days days; value at the last receipt cost
-- (per outlet). last_sold_at = the last sale consumption ever (NULL = never).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'inventory.dead_stock', 1,
  $q$WITH oh AS (
  SELECT m.outlet_id, m.ingredient_id, sum(m.qty_milli) AS qty,
         max(m.at) FILTER (WHERE m.kind = 'sale_consumption') AS last_sold,
         (SELECT r.unit_cost_per_1000_minor FROM core.stock_movement r
           WHERE r.outlet_id = m.outlet_id AND r.ingredient_id = m.ingredient_id AND r.kind = 'receipt' AND r.unit_cost_per_1000_minor IS NOT NULL
           ORDER BY r.at DESC, r.id DESC LIMIT 1) AS per1000
    FROM core.stock_movement m
   WHERE :outlet_id::uuid IS NULL OR m.outlet_id = :outlet_id::uuid
   GROUP BY m.outlet_id, m.ingredient_id)
SELECT oh.ingredient_id, sum(oh.qty)::bigint AS on_hand_qty_milli, round(sum(oh.qty * oh.per1000 / 1000000.0))::bigint AS value_minor,
       max(oh.last_sold) AS last_sold_at
  FROM oh
 WHERE oh.qty > 0
 GROUP BY oh.ingredient_id
HAVING max(oh.last_sold) IS NULL OR max(oh.last_sold) < now() - make_interval(days => :days::int)
 ORDER BY oh.ingredient_id$q$,
  '{"type": "object", "required": ["outlet_id", "days"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "days": {"type": "integer", "minimum": 1, "maximum": 730}}}',
  '[{"name": "ingredient_id", "type": "uuid"},
    {"name": "on_hand_qty_milli", "type": "integer", "numeric_source": "core.stock_movement.qty_milli"},
    {"name": "value_minor", "type": "integer", "numeric_source": ["core.stock_movement.qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]},
    {"name": "last_sold_at", "type": "timestamptz"}]',
  'manager');

-- Tenant-level (supplier prices and invoices carry no outlet). Price observations per supplier and ingredient in the
-- 180 days to :as_of: supplier price rows and the lines of every invoice that is not void, each normalised to the
-- ingredient's base unit. baseline = the lowest 8-week rolling median (each observation's median over the 56 days to
-- it); latest = the last observation; observations = how many are above 1.05 × baseline (the crept ones);
-- creep_impact = Σ over invoice lines above 1.05 × baseline of (price − baseline) × qty.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'purchasing.price_creep', 1,
  $q$WITH conv (from_unit, to_unit, f) AS (VALUES ('kg', 'g', 1000::numeric), ('g', 'kg', 0.001), ('l', 'ml', 1000), ('ml', 'l', 0.001)),
o AS (
  SELECT s.supplier_id, s.ingredient_id, s.observed_at::date AS on_date, s.observed_at AS at, s.id,
         s.unit_price_minor / CASE WHEN s.unit = g.base_unit THEN 1 ELSE cv.f END AS price, NULL::bigint AS qty_base
    FROM core.supplier_price s JOIN core.ingredient g ON g.tenant_id = s.tenant_id AND g.id = s.ingredient_id
    LEFT JOIN conv cv ON cv.from_unit = s.unit AND cv.to_unit = g.base_unit
   WHERE s.observed_at::date <= :as_of::date AND s.observed_at::date > :as_of::date - 180
  UNION ALL
  SELECT i.supplier_id, l.ingredient_id, i.invoice_date, i.invoice_date::timestamptz, l.id,
         l.unit_price_minor / CASE WHEN l.unit = g.base_unit THEN 1 ELSE cv.f END,
         round(l.qty_milli * CASE WHEN l.unit = g.base_unit THEN 1 ELSE cv.f END)::bigint
    FROM core.supplier_invoice i
    JOIN core.supplier_invoice_line l ON l.tenant_id = i.tenant_id AND l.supplier_invoice_id = i.id
    JOIN core.ingredient g ON g.tenant_id = l.tenant_id AND g.id = l.ingredient_id
    LEFT JOIN conv cv ON cv.from_unit = l.unit AND cv.to_unit = g.base_unit
   WHERE i.status <> 'void' AND i.invoice_date <= :as_of::date AND i.invoice_date > :as_of::date - 180),
r AS (
  SELECT o.*, (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x.price) FROM o x
                WHERE x.supplier_id = o.supplier_id AND x.ingredient_id = o.ingredient_id
                  AND x.on_date > o.on_date - 56 AND x.on_date <= o.on_date) AS rolling
    FROM o WHERE o.price IS NOT NULL),
b AS (
  SELECT r.supplier_id, r.ingredient_id, min(r.rolling) AS baseline,
         (array_agg(r.price ORDER BY r.at DESC, r.id DESC))[1] AS latest
    FROM r GROUP BY r.supplier_id, r.ingredient_id)
SELECT b.supplier_id, b.ingredient_id, round(b.baseline)::bigint AS baseline_minor, round(b.latest)::bigint AS latest_minor,
       round((b.latest - b.baseline) * 10000 / nullif(b.baseline, 0))::bigint AS creep_bp,
       (SELECT count(*) FROM r WHERE r.supplier_id = b.supplier_id AND r.ingredient_id = b.ingredient_id AND r.price > 1.05 * b.baseline)::bigint AS observations,
       round((SELECT coalesce(sum((r.price - b.baseline) * r.qty_base / 1000.0), 0) FROM r
               WHERE r.supplier_id = b.supplier_id AND r.ingredient_id = b.ingredient_id AND r.qty_base IS NOT NULL
                 AND r.price > 1.05 * b.baseline))::bigint AS creep_impact_minor
  FROM b
 ORDER BY b.supplier_id, b.ingredient_id$q$,
  '{"type": "object", "required": ["as_of"], "additionalProperties": false,
    "properties": {"as_of": {"type": "string", "format": "date"}}}',
  '[{"name": "supplier_id", "type": "uuid"},
    {"name": "ingredient_id", "type": "uuid"},
    {"name": "baseline_minor", "type": "integer", "numeric_source": ["core.supplier_price.unit_price_minor", "core.supplier_invoice_line.unit_price_minor"]},
    {"name": "latest_minor", "type": "integer", "numeric_source": ["core.supplier_price.unit_price_minor", "core.supplier_invoice_line.unit_price_minor"]},
    {"name": "creep_bp", "type": "integer", "numeric_source": ["core.supplier_price.unit_price_minor", "core.supplier_invoice_line.unit_price_minor"]},
    {"name": "observations", "type": "integer", "numeric_source": ["count:core.supplier_price", "count:core.supplier_invoice_line"]},
    {"name": "creep_impact_minor", "type": "integer", "numeric_source": ["core.supplier_price.unit_price_minor", "core.supplier_invoice_line.unit_price_minor", "core.supplier_invoice_line.qty_milli"]}]',
  'manager');

-- One supplier invoice against its PO lines and what was received for them (GRN lines read through their goods
-- received, so a scoped minter counts only receipts in scope; no GRN line at all = received NULL, judged as invoiced).
-- overbilled = what was billed − what should have been: min(invoiced, received) qty at min(invoice, PO) price (≥ 0).
-- The Σ row (line_id NULL) sums it. Quantities in the invoice line's unit (PO and GRN lines in the same unit).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'purchasing.invoice_vs_po', 1,
  $q$WITH l AS (
  SELECT l.id, l.line_no, pl.unit_price_minor AS po_price, l.unit_price_minor AS price, l.qty_milli,
         (SELECT sum(g.qty_milli) FROM core.grn_line g
            JOIN core.goods_received gr ON gr.tenant_id = g.tenant_id AND gr.id = g.goods_received_id
           WHERE g.tenant_id = l.tenant_id AND g.po_line_id = l.po_line_id) AS received
    FROM core.supplier_invoice i
    JOIN core.supplier_invoice_line l ON l.tenant_id = i.tenant_id AND l.supplier_invoice_id = i.id
    LEFT JOIN core.po_line pl ON pl.tenant_id = l.tenant_id AND pl.id = l.po_line_id
   WHERE i.id = :supplier_invoice_id::uuid),
x AS (
  SELECT l.*, greatest(round((l.qty_milli * l.price
                              - least(l.qty_milli, coalesce(l.received, l.qty_milli)) * least(l.price, coalesce(l.po_price, l.price))) / 1000.0), 0) AS over
    FROM l)
SELECT * FROM (
  SELECT x.id AS line_id, x.po_price::bigint AS po_price_minor, x.price::bigint AS invoice_price_minor, x.qty_milli::bigint AS invoice_qty_milli,
         x.received::bigint AS received_qty_milli, x.over::bigint AS overbilled_minor
    FROM x ORDER BY x.line_no) r
UNION ALL
SELECT NULL, NULL, NULL, NULL, NULL, sum(x.over)::bigint FROM x HAVING count(*) > 0$q$,
  '{"type": "object", "required": ["supplier_invoice_id"], "additionalProperties": false,
    "properties": {"supplier_invoice_id": {"type": "string", "format": "uuid"}}}',
  '[{"name": "line_id", "type": "uuid"},
    {"name": "po_price_minor", "type": "integer", "numeric_source": "core.po_line.unit_price_minor"},
    {"name": "invoice_price_minor", "type": "integer", "numeric_source": "core.supplier_invoice_line.unit_price_minor"},
    {"name": "invoice_qty_milli", "type": "integer", "numeric_source": "core.supplier_invoice_line.qty_milli"},
    {"name": "received_qty_milli", "type": "integer", "numeric_source": "core.grn_line.qty_milli"},
    {"name": "overbilled_minor", "type": "integer", "numeric_source": ["core.supplier_invoice_line.unit_price_minor", "core.supplier_invoice_line.qty_milli", "core.po_line.unit_price_minor", "core.grn_line.qty_milli"]}]',
  'manager');

-- Other invoices of the same supplier with the same total whose numbers are equal once non-alphanumerics are stripped
-- (case-insensitive), not void. days_apart = |invoice dates|.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'purchasing.invoice_duplicates', 1,
  $q$SELECT t.id AS twin_invoice_id, t.total_minor::bigint AS total_minor, abs(t.invoice_date - s.invoice_date)::bigint AS days_apart
  FROM core.supplier_invoice s
  JOIN core.supplier_invoice t ON t.tenant_id = s.tenant_id AND t.supplier_id = s.supplier_id AND t.id <> s.id
   AND t.total_minor = s.total_minor AND t.status <> 'void'
   AND lower(regexp_replace(t.invoice_no, '[^A-Za-z0-9]', '', 'g')) = lower(regexp_replace(s.invoice_no, '[^A-Za-z0-9]', '', 'g'))
 WHERE s.id = :supplier_invoice_id::uuid
 ORDER BY t.invoice_date, t.id$q$,
  '{"type": "object", "required": ["supplier_invoice_id"], "additionalProperties": false,
    "properties": {"supplier_invoice_id": {"type": "string", "format": "uuid"}}}',
  '[{"name": "twin_invoice_id", "type": "uuid"},
    {"name": "total_minor", "type": "integer", "numeric_source": "core.supplier_invoice.total_minor"},
    {"name": "days_apart", "type": "integer", "numeric_source": "core.supplier_invoice.invoice_date"}]',
  'manager');

-- The quotes of one negotiation (simulated suppliers, R22), read through their run (intel.run's outlet-scope policy).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'purchasing.quote_compare', 1,
  $q$SELECT q.id AS quote_id, q.supplier_id, q.round::bigint AS round, q.unit_price_minor::bigint AS unit_price_minor,
       q.qty_milli::bigint AS qty_milli, q.min_order_qty_milli::bigint AS min_order_qty_milli, q.payment_days::bigint AS payment_days
  FROM intel.supplier_quote q
  JOIN intel.run r ON r.tenant_id = q.tenant_id AND r.id = q.run_id
 WHERE q.run_id = :negotiation_run_id::uuid
 ORDER BY q.round, q.supplier_id, q.created_at, q.id$q$,
  '{"type": "object", "required": ["negotiation_run_id"], "additionalProperties": false,
    "properties": {"negotiation_run_id": {"type": "string", "format": "uuid"}}}',
  '[{"name": "quote_id", "type": "uuid"},
    {"name": "supplier_id", "type": "uuid"},
    {"name": "round", "type": "integer", "numeric_source": "intel.supplier_quote.round"},
    {"name": "unit_price_minor", "type": "integer", "numeric_source": "intel.supplier_quote.unit_price_minor"},
    {"name": "qty_milli", "type": "integer", "numeric_source": "intel.supplier_quote.qty_milli"},
    {"name": "min_order_qty_milli", "type": "integer", "numeric_source": "intel.supplier_quote.min_order_qty_milli"},
    {"name": "payment_days", "type": "integer", "numeric_source": "intel.supplier_quote.payment_days"}]',
  'manager');

------------------------------------------------------------------------------------------------------------
-- 6. T1 — forecast templates (packs/forecast.md §3; the Forecast service's inputs and outputs), min_role manager
------------------------------------------------------------------------------------------------------------
-- Daily units of one item (completed orders, by business date) for every day of the window, and whether the outlets in
-- scope were all closed that day (outlet calendar: a date override replaces that weekday's weekly rows; weekday 0 =
-- Sunday; a day with no calendar row is open).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'forecast.sales_history', 1,
  $q$WITH days AS (
  SELECT d::date AS d FROM generate_series(:from::date, :to::date, interval '1 day') d),
s AS (
  SELECT o.business_date AS d, sum(ol.qty_milli) AS q
    FROM core."order" o JOIN core.order_line ol ON ol.tenant_id = o.tenant_id AND ol.order_id = o.id
   WHERE o.status = 'completed' AND ol.item_id = :item_id::uuid AND o.business_date BETWEEN :from::date AND :to::date
     AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)
   GROUP BY o.business_date),
ou AS (
  SELECT o.id FROM core.outlet o
   WHERE (:outlet_id::uuid IS NULL OR o.id = :outlet_id::uuid)
     AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
          OR o.id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[]))),
cl AS (
  SELECT days.d, bool_and(coalesce(
           (SELECT bool_and(c.closed) FROM core.outlet_calendar c WHERE c.outlet_id = ou.id AND c.kind = 'override' AND c.on_date = days.d),
           (SELECT bool_and(c.closed) FROM core.outlet_calendar c WHERE c.outlet_id = ou.id AND c.kind = 'weekly' AND c.weekday = extract(dow FROM days.d)),
           false)) AS closed
    FROM days CROSS JOIN ou GROUP BY days.d)
SELECT days.d AS business_on, coalesce(s.q, 0)::bigint AS qty_milli, coalesce(cl.closed, false) AS closed
  FROM days LEFT JOIN s ON s.d = days.d LEFT JOIN cl ON cl.d = days.d
 ORDER BY days.d$q$,
  '{"type": "object", "required": ["outlet_id", "item_id", "from", "to"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "item_id": {"type": "string", "format": "uuid"},
                   "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
  '[{"name": "business_on", "type": "date"},
    {"name": "qty_milli", "type": "integer", "numeric_source": "core.order_line.qty_milli"},
    {"name": "closed", "type": "boolean"}]',
  'manager');

-- Share of units by weekday (0 = Sunday, of the business date) and :slot_minutes slot (outlet-local time the order was
-- placed) over the last :weeks weeks before today, within each weekday (each weekday's shares sum to 10,000 ± rounding).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'forecast.slot_profile', 1,
  $q$WITH u AS (
  SELECT extract(dow FROM o.business_date)::int AS weekday,
         to_char(date_bin(make_interval(mins => :slot_minutes::int), o.created_at AT TIME ZONE ou.tz, timestamp '2001-01-01'), 'HH24:MI') AS slot,
         ol.qty_milli
    FROM core."order" o
    JOIN core.order_line ol ON ol.tenant_id = o.tenant_id AND ol.order_id = o.id
    JOIN core.outlet ou ON ou.tenant_id = o.tenant_id AND ou.id = o.outlet_id
   WHERE o.status = 'completed' AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)
     AND o.business_date < ((now() AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date
     AND o.business_date >= ((now() AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date - 7 * :weeks::int),
g AS (SELECT u.weekday, u.slot, sum(u.qty_milli) AS q FROM u GROUP BY u.weekday, u.slot)
SELECT g.weekday::bigint AS weekday, g.slot AS slot_start, round(g.q * 10000.0 / sum(g.q) OVER (PARTITION BY g.weekday))::bigint AS share_bp
  FROM g
 ORDER BY g.weekday, g.slot$q$,
  '{"type": "object", "required": ["outlet_id", "weeks", "slot_minutes"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "weeks": {"type": "integer", "minimum": 1, "maximum": 26},
                   "slot_minutes": {"type": "integer", "enum": [15, 30, 60]}}}',
  '[{"name": "weekday", "type": "integer", "numeric_source": "core.order.business_date"},
    {"name": "slot_start", "type": "text"},
    {"name": "share_bp", "type": "integer", "numeric_source": "core.order_line.qty_milli"}]',
  'manager');

-- The served forecast (forecast.get): the latest run with points in the window and scope, that run's own method only.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'forecast.points', 1,
  $q$WITH fr AS (
  SELECT r.id, r.method FROM intel.forecast_run r
   WHERE EXISTS (SELECT 1 FROM intel.forecast_point p WHERE p.tenant_id = r.tenant_id AND p.forecast_run_id = r.id
                    AND p.business_on BETWEEN :from::date AND :to::date AND (:outlet_id::uuid IS NULL OR p.outlet_id = :outlet_id::uuid))
   ORDER BY r.created_at DESC, r.id DESC LIMIT 1)
SELECT p.item_id, p.business_on, to_char(p.slot_start, 'HH24:MI') AS slot_start, p.qty_milli::bigint AS qty_milli,
       p.lo_qty_milli::bigint AS lo_qty_milli, p.hi_qty_milli::bigint AS hi_qty_milli, p.method
  FROM fr JOIN intel.forecast_point p ON p.forecast_run_id = fr.id AND p.method = fr.method
 WHERE p.business_on BETWEEN :from::date AND :to::date AND (:outlet_id::uuid IS NULL OR p.outlet_id = :outlet_id::uuid)
   AND (:item_id::uuid IS NULL OR p.item_id = :item_id::uuid)
 ORDER BY p.business_on, p.item_id NULLS LAST, p.slot_start NULLS FIRST, p.outlet_id$q$,
  '{"type": "object", "required": ["outlet_id", "from", "to", "item_id"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "from": {"type": "string", "format": "date"},
                   "to": {"type": "string", "format": "date"}, "item_id": {"type": ["string", "null"], "format": "uuid"}}}',
  '[{"name": "item_id", "type": "uuid"},
    {"name": "business_on", "type": "date"},
    {"name": "slot_start", "type": "text"},
    {"name": "qty_milli", "type": "integer", "numeric_source": "intel.forecast_point.qty_milli"},
    {"name": "lo_qty_milli", "type": "integer", "numeric_source": "intel.forecast_point.lo_qty_milli"},
    {"name": "hi_qty_milli", "type": "integer", "numeric_source": "intel.forecast_point.hi_qty_milli"},
    {"name": "method", "type": "text"}]',
  'manager');

-- Live accuracy per method over the window, never the run's own wape/bias (intel-written): for each outlet, item and
-- day, each method's point from the latest run trained before that day, against the units sold (completed orders).
-- wape = Σ|ŷ − y| ÷ Σy, bias = Σ(ŷ − y) ÷ Σy (bp). over_forecast_cost = Σ max(ŷ − y, 0) × the item's recipe cost
-- (lines at the last receipt cost, else the last supplier price, in the line's unit); under_forecast_sales =
-- Σ max(y − ŷ, 0) × the item's counter price at the outlet on that day.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'forecast.accuracy', 1,
  $q$WITH conv (from_unit, to_unit, f) AS (VALUES ('kg', 'g', 1000::numeric), ('g', 'kg', 0.001), ('l', 'ml', 1000), ('ml', 'l', 0.001)),
p AS (
  SELECT DISTINCT ON (p.outlet_id, p.item_id, p.business_on, p.method) p.outlet_id, p.item_id, p.business_on, p.method, p.qty_milli
    FROM intel.forecast_point p JOIN intel.forecast_run r ON r.tenant_id = p.tenant_id AND r.id = p.forecast_run_id
   WHERE p.business_on BETWEEN :from::date AND :to::date AND p.slot_start IS NULL AND p.item_id IS NOT NULL
     AND r.trained_through < p.business_on AND (:outlet_id::uuid IS NULL OR p.outlet_id = :outlet_id::uuid)
   ORDER BY p.outlet_id, p.item_id, p.business_on, p.method, r.trained_through DESC, r.created_at DESC, r.id DESC),
y AS (
  SELECT o.outlet_id, ol.item_id, o.business_date AS d, sum(ol.qty_milli) AS q
    FROM core."order" o JOIN core.order_line ol ON ol.tenant_id = o.tenant_id AND ol.order_id = o.id
   WHERE o.status = 'completed' AND o.business_date BETWEEN :from::date AND :to::date
     AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)
   GROUP BY o.outlet_id, ol.item_id, o.business_date),
cost AS (
  SELECT rv.item_id,
         sum(rl.qty_milli * (10000 + rl.waste_pct_bp)
             * coalesce(lc.per1000 / 1000.0 * CASE WHEN rl.unit = lc.unit THEN 1 ELSE cl.f END, sp.unit_price_minor::numeric))
           / (10000.0 * min(rv.yield_qty_milli)) AS unit_cost
    FROM core.recipe_version rv
    JOIN core.recipe_line rl ON rl.tenant_id = rv.tenant_id AND rl.recipe_version_id = rv.id
    LEFT JOIN LATERAL (SELECT m.unit, m.unit_cost_per_1000_minor AS per1000 FROM core.stock_movement m
                        WHERE m.ingredient_id = rl.ingredient_id AND m.kind = 'receipt' AND m.unit_cost_per_1000_minor IS NOT NULL
                          AND (:outlet_id::uuid IS NULL OR m.outlet_id = :outlet_id::uuid)
                        ORDER BY m.at DESC, m.id DESC LIMIT 1) lc ON true
    LEFT JOIN conv cl ON cl.from_unit = rl.unit AND cl.to_unit = lc.unit
    LEFT JOIN LATERAL (SELECT s.unit_price_minor FROM core.supplier_price s
                        WHERE s.ingredient_id = rl.ingredient_id AND s.unit = rl.unit ORDER BY s.observed_at DESC, s.id DESC LIMIT 1) sp ON true
   WHERE rv.variant_id IS NULL AND rv.valid_from <= :to::date AND (rv.valid_to IS NULL OR rv.valid_to > :to::date)
   GROUP BY rv.item_id),
j AS (
  SELECT p.method, p.business_on, p.qty_milli AS f, coalesce(y.q, 0) AS a, c.unit_cost,
         (SELECT pr.amount_minor FROM core.price pr
           WHERE pr.item_id = p.item_id AND pr.outlet_id = p.outlet_id AND pr.channel_kind = 'counter' AND pr.variant_id IS NULL
             AND pr.valid_from <= p.business_on AND (pr.valid_to IS NULL OR pr.valid_to > p.business_on)
           ORDER BY pr.valid_from DESC, pr.id LIMIT 1) AS price
    FROM p LEFT JOIN y ON y.outlet_id = p.outlet_id AND y.item_id = p.item_id AND y.d = p.business_on
    LEFT JOIN cost c ON c.item_id = p.item_id)
SELECT j.method, sum(j.a)::bigint AS actual_qty_milli, sum(j.f)::bigint AS forecast_qty_milli,
       round(sum(abs(j.f - j.a)) * 10000.0 / nullif(sum(j.a), 0))::bigint AS wape_bp,
       round(sum(j.f - j.a) * 10000.0 / nullif(sum(j.a), 0))::bigint AS bias_bp,
       count(DISTINCT j.business_on)::bigint AS days,
       round(sum(greatest(j.f - j.a, 0) * j.unit_cost / 1000.0))::bigint AS over_forecast_cost_minor,
       round(sum(greatest(j.a - j.f, 0) * j.price / 1000.0))::bigint AS under_forecast_sales_minor
  FROM j
 GROUP BY j.method
 ORDER BY j.method$q$,
  '{"type": "object", "required": ["outlet_id", "from", "to"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"},
                   "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
  '[{"name": "method", "type": "text"},
    {"name": "actual_qty_milli", "type": "integer", "numeric_source": "core.order_line.qty_milli"},
    {"name": "forecast_qty_milli", "type": "integer", "numeric_source": "intel.forecast_point.qty_milli"},
    {"name": "wape_bp", "type": "integer", "numeric_source": ["intel.forecast_point.qty_milli", "core.order_line.qty_milli"]},
    {"name": "bias_bp", "type": "integer", "numeric_source": ["intel.forecast_point.qty_milli", "core.order_line.qty_milli"]},
    {"name": "days", "type": "integer", "numeric_source": "count:intel.forecast_point"},
    {"name": "over_forecast_cost_minor", "type": "integer", "numeric_source": ["intel.forecast_point.qty_milli", "core.order_line.qty_milli", "core.recipe_line.qty_milli",
       "core.recipe_line.waste_pct_bp", "core.recipe_version.yield_qty_milli", "core.stock_movement.unit_cost_per_1000_minor", "core.supplier_price.unit_price_minor"]},
    {"name": "under_forecast_sales_minor", "type": "integer", "numeric_source": ["intel.forecast_point.qty_milli", "core.order_line.qty_milli", "core.price.amount_minor"]}]',
  'manager');

-- Per outlet in scope with points: the latest run that has points for it, its trained_through and that run's point count.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'forecast.freshness', 1,
  $q$SELECT DISTINCT ON (p.outlet_id) p.outlet_id, r.trained_through,
       (SELECT count(*) FROM intel.forecast_point x WHERE x.tenant_id = r.tenant_id AND x.forecast_run_id = r.id AND x.outlet_id = p.outlet_id)::bigint AS points
  FROM intel.forecast_point p JOIN intel.forecast_run r ON r.tenant_id = p.tenant_id AND r.id = p.forecast_run_id
 ORDER BY p.outlet_id, r.created_at DESC, r.id DESC$q$,
  '{"type": "object", "properties": {}, "additionalProperties": false}',
  '[{"name": "outlet_id", "type": "uuid"},
    {"name": "trained_through", "type": "date"},
    {"name": "points", "type": "integer", "numeric_source": "count:intel.forecast_point"}]',
  'manager');

------------------------------------------------------------------------------------------------------------
-- 7. T1 — people templates (packs/people.md §3), min_role manager (payroll_lines: advisor)
------------------------------------------------------------------------------------------------------------
-- Formulas follow core-api's people module (overtime.ts, payroll.ts): minutes are rostered (scheduled shifts) or
-- attended (closed attendance), dated by the outlet-local date of the shift start / clock-in, ISO weeks 'IYYY-"W"IW';
-- hourly rate = wage_rate_minor (hourly) | monthly_salary_minor × 60 / contract_min_per_month (monthly).
DO $$
DECLARE
  rate constant text := $r$CASE WHEN s.pay_basis = 'hourly' THEN s.wage_rate_minor::numeric
                     ELSE s.monthly_salary_minor::numeric * 60 / s.contract_min_per_month END$r$;
  rate_src constant jsonb := '["core.staff.wage_rate_minor", "core.staff.monthly_salary_minor", "core.staff.contract_min_per_month"]';
BEGIN
  -- Per business day and :slot_minutes slot (outlet-local): attended and rostered minutes overlapping the slot, completed
  -- orders placed in it, the forecast units for it (slot-level points of the latest run, its own method), and the
  -- minutes the demand needed: orders × the median over the 8 weeks before (same weekday and slot, slots with orders)
  -- of attended minutes per order. excess_cost = (attended − needed, ≥ 0) × the attending staff's minute-weighted rate.
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
    'people.labour_vs_demand', 1,
    $q$WITH sl AS (SELECT make_interval(mins => :slot_minutes::int) AS w),
iv AS (
  SELECT 'a' AS k, t.outlet_id, t.clock_in_at AT TIME ZONE ou.tz AS s, t.clock_out_at AT TIME ZONE ou.tz AS e, $q$ || rate || $q$ AS rate, ou.business_day_cutoff AS cut
    FROM core.attendance t JOIN core.staff s ON s.tenant_id = t.tenant_id AND s.id = t.staff_id
    JOIN core.outlet ou ON ou.tenant_id = t.tenant_id AND ou.id = t.outlet_id
   WHERE t.clock_out_at IS NOT NULL AND (:outlet_id::uuid IS NULL OR t.outlet_id = :outlet_id::uuid)
     AND (t.clock_in_at AT TIME ZONE ou.tz)::date BETWEEN :from::date - 56 AND :to::date + 1
  UNION ALL
  SELECT 'r', r.outlet_id, r.starts_at AT TIME ZONE ou.tz, r.ends_at AT TIME ZONE ou.tz, NULL, ou.business_day_cutoff
    FROM core.roster_shift r JOIN core.outlet ou ON ou.tenant_id = r.tenant_id AND ou.id = r.outlet_id
   WHERE r.status = 'scheduled' AND (:outlet_id::uuid IS NULL OR r.outlet_id = :outlet_id::uuid)
     AND (r.starts_at AT TIME ZONE ou.tz)::date BETWEEN :from::date - 56 AND :to::date + 1),
pieces AS (
  SELECT iv.k, (b.b - iv.cut)::date AS d, to_char(b.b, 'HH24:MI') AS slot, iv.rate,
         extract(epoch FROM least(iv.e, b.b + sl.w) - greatest(iv.s, b.b)) / 60 AS mins
    FROM iv CROSS JOIN sl
    CROSS JOIN LATERAL generate_series(date_bin(sl.w, iv.s, timestamp '2001-01-01'), iv.e - interval '1 microsecond', sl.w) b(b)),
lab AS (
  SELECT p.d, p.slot, sum(p.mins) FILTER (WHERE p.k = 'a') AS att, sum(p.mins) FILTER (WHERE p.k = 'r') AS ros,
         sum(p.mins * p.rate) FILTER (WHERE p.k = 'a') / nullif(sum(p.mins) FILTER (WHERE p.k = 'a'), 0) AS rate
    FROM pieces p GROUP BY p.d, p.slot),
dem AS (
  SELECT o.business_date AS d, to_char(date_bin(sl.w, o.created_at AT TIME ZONE ou.tz, timestamp '2001-01-01'), 'HH24:MI') AS slot, count(*) AS n
    FROM core."order" o JOIN core.outlet ou ON ou.tenant_id = o.tenant_id AND ou.id = o.outlet_id CROSS JOIN sl
   WHERE o.status = 'completed' AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)
     AND o.business_date BETWEEN :from::date - 56 AND :to::date
   GROUP BY 1, 2),
fc AS (
  SELECT p.business_on AS d, to_char(p.slot_start, 'HH24:MI') AS slot, sum(p.qty_milli) / 1000.0 AS units
    FROM intel.forecast_point p
    JOIN (SELECT r.id, r.method FROM intel.forecast_run r
           WHERE EXISTS (SELECT 1 FROM intel.forecast_point x WHERE x.tenant_id = r.tenant_id AND x.forecast_run_id = r.id AND x.slot_start IS NOT NULL)
           ORDER BY r.created_at DESC, r.id DESC LIMIT 1) fr ON fr.id = p.forecast_run_id AND fr.method = p.method
   WHERE p.slot_start IS NOT NULL AND p.business_on BETWEEN :from::date AND :to::date AND (:outlet_id::uuid IS NULL OR p.outlet_id = :outlet_id::uuid)
   GROUP BY 1, 2),
allk AS (
  SELECT d, slot FROM lab UNION SELECT d, slot FROM dem),
h AS (
  SELECT k.d, k.slot, coalesce(lab.att, 0) AS att, coalesce(lab.ros, 0) AS ros, coalesce(dem.n, 0) AS n, lab.rate
    FROM allk k LEFT JOIN lab ON lab.d = k.d AND lab.slot = k.slot LEFT JOIN dem ON dem.d = k.d AND dem.slot = k.slot),
x AS (
  SELECT h.*,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY b.att / b.n) FROM h b
           WHERE b.slot = h.slot AND b.n > 0 AND b.d BETWEEN h.d - 56 AND h.d - 7 AND extract(dow FROM b.d) = extract(dow FROM h.d)) AS norm
    FROM h WHERE h.d BETWEEN :from::date AND :to::date)
SELECT x.d AS business_on, x.slot AS slot_start, round(x.att)::bigint AS attended_min, round(x.ros)::bigint AS rostered_min,
       x.n::bigint AS orders, round(fc.units)::bigint AS forecast_orders, round(x.n * x.norm)::bigint AS needed_min,
       CASE WHEN x.norm IS NOT NULL THEN round(greatest(x.att - x.n * x.norm, 0) * x.rate / 60) END::bigint AS excess_cost_minor
  FROM x LEFT JOIN fc ON fc.d = x.d AND fc.slot = x.slot
 ORDER BY x.d, x.slot$q$,
    '{"type": "object", "required": ["outlet_id", "from", "to", "slot_minutes"], "additionalProperties": false,
      "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "from": {"type": "string", "format": "date"},
                     "to": {"type": "string", "format": "date"}, "slot_minutes": {"type": "integer", "enum": [15, 30, 60]}}}',
    jsonb_build_array(
      '{"name": "business_on", "type": "date"}'::jsonb,
      '{"name": "slot_start", "type": "text"}'::jsonb,
      '{"name": "attended_min", "type": "integer", "numeric_source": ["core.attendance.clock_in_at", "core.attendance.clock_out_at"]}'::jsonb,
      '{"name": "rostered_min", "type": "integer", "numeric_source": ["core.roster_shift.starts_at", "core.roster_shift.ends_at"]}'::jsonb,
      '{"name": "orders", "type": "integer", "numeric_source": "count:core.order"}'::jsonb,
      '{"name": "forecast_orders", "type": "integer", "numeric_source": "intel.forecast_point.qty_milli"}'::jsonb,
      '{"name": "needed_min", "type": "integer", "numeric_source": ["count:core.order", "core.attendance.clock_in_at", "core.attendance.clock_out_at"]}'::jsonb,
      jsonb_build_object('name', 'excess_cost_minor', 'type', 'integer', 'numeric_source',
        '["count:core.order", "core.attendance.clock_in_at", "core.attendance.clock_out_at"]'::jsonb || rate_src)),
    'manager');

  -- Attended beyond rostered per staff and ISO week (core-api overtimeRows, with outlet_id nullable).
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
    'people.overtime_drift', 1,
    $q$WITH r AS (
  SELECT s.staff_id, to_char((s.starts_at AT TIME ZONE o.tz)::date, 'IYYY-"W"IW') AS wk, sum(extract(epoch FROM s.ends_at - s.starts_at) / 60)::bigint AS m
    FROM core.roster_shift s JOIN core.outlet o ON o.tenant_id = s.tenant_id AND o.id = s.outlet_id
   WHERE s.status = 'scheduled' AND (:outlet_id::uuid IS NULL OR s.outlet_id = :outlet_id::uuid)
     AND (s.starts_at AT TIME ZONE o.tz)::date BETWEEN :from::date AND :to::date
   GROUP BY 1, 2),
a AS (
  SELECT t.staff_id, to_char((t.clock_in_at AT TIME ZONE o.tz)::date, 'IYYY-"W"IW') AS wk, sum(extract(epoch FROM t.clock_out_at - t.clock_in_at) / 60)::bigint AS m
    FROM core.attendance t JOIN core.outlet o ON o.tenant_id = t.tenant_id AND o.id = t.outlet_id
   WHERE t.clock_out_at IS NOT NULL AND (:outlet_id::uuid IS NULL OR t.outlet_id = :outlet_id::uuid)
     AND (t.clock_in_at AT TIME ZONE o.tz)::date BETWEEN :from::date AND :to::date
   GROUP BY 1, 2)
SELECT a.staff_id, a.wk AS iso_week, coalesce(r.m, 0) AS rostered_min, a.m AS attended_min,
       greatest(a.m - coalesce(r.m, 0), 0) AS extra_min,
       round(greatest(a.m - coalesce(r.m, 0), 0) * $q$ || rate || $q$ * s.ot_multiplier_bp / 600000)::bigint AS extra_cost_minor
  FROM a LEFT JOIN r ON r.staff_id = a.staff_id AND r.wk = a.wk
  JOIN core.staff s ON s.id = a.staff_id
 ORDER BY a.wk, a.staff_id$q$,
    '{"type": "object", "required": ["outlet_id", "from", "to"], "additionalProperties": false,
      "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"},
                     "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
    jsonb_build_array(
      '{"name": "staff_id", "type": "uuid"}'::jsonb,
      '{"name": "iso_week", "type": "text"}'::jsonb,
      '{"name": "rostered_min", "type": "integer", "numeric_source": ["core.roster_shift.starts_at", "core.roster_shift.ends_at"]}'::jsonb,
      '{"name": "attended_min", "type": "integer", "numeric_source": ["core.attendance.clock_in_at", "core.attendance.clock_out_at"]}'::jsonb,
      '{"name": "extra_min", "type": "integer", "numeric_source": ["core.roster_shift.starts_at", "core.roster_shift.ends_at", "core.attendance.clock_in_at", "core.attendance.clock_out_at"]}'::jsonb,
      jsonb_build_object('name', 'extra_cost_minor', 'type', 'integer', 'numeric_source',
        '["core.roster_shift.starts_at", "core.roster_shift.ends_at", "core.attendance.clock_in_at", "core.attendance.clock_out_at", "core.staff.ot_multiplier_bp"]'::jsonb || rate_src)),
    'manager');

  -- Labour cost (attended minutes × hourly rate) ÷ net sales (completed orders' lines, net of discounts and of tax where
  -- prices include it) per ISO week of the business date; target = the labour target policy in force (outlet first);
  -- excess = labour − target × sales (≥ 0).
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
    'people.labour_pct', 1,
    $q$WITH pk AS (
  SELECT (cp.doc -> 'tax' ->> 'price_display') = 'inclusive' AS inclusive
    FROM core.tenant t JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
   WHERE cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')),
l AS (
  SELECT to_char((t.clock_in_at AT TIME ZONE o.tz)::date, 'IYYY-"W"IW') AS wk,
         sum(extract(epoch FROM t.clock_out_at - t.clock_in_at) / 60 * $q$ || rate || $q$ / 60) AS labour
    FROM core.attendance t JOIN core.staff s ON s.tenant_id = t.tenant_id AND s.id = t.staff_id
    JOIN core.outlet o ON o.tenant_id = t.tenant_id AND o.id = t.outlet_id
   WHERE t.clock_out_at IS NOT NULL AND (:outlet_id::uuid IS NULL OR t.outlet_id = :outlet_id::uuid)
     AND (t.clock_in_at AT TIME ZONE o.tz)::date BETWEEN :from::date AND :to::date
   GROUP BY 1),
n AS (
  SELECT to_char(o.business_date, 'IYYY-"W"IW') AS wk,
         sum(round(ol.qty_milli * ol.unit_price_minor / 1000.0) - ol.line_discount_minor - CASE WHEN pk.inclusive THEN ol.tax_minor ELSE 0 END) AS sales
    FROM core."order" o JOIN core.order_line ol ON ol.tenant_id = o.tenant_id AND ol.order_id = o.id CROSS JOIN pk
   WHERE o.status = 'completed' AND o.business_date BETWEEN :from::date AND :to::date
     AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)
   GROUP BY 1),
tg AS (
  SELECT b.labour_target_bp FROM core.business_policy b
   WHERE b.labour_target_bp IS NOT NULL AND b.valid_from <= :to::date AND (b.valid_to IS NULL OR b.valid_to > :to::date)
     AND (b.outlet_id IS NULL OR b.outlet_id = :outlet_id::uuid)
   ORDER BY b.outlet_id IS NULL, b.valid_from DESC, b.id LIMIT 1)
SELECT k.wk AS iso_week, round(coalesce(l.labour, 0))::bigint AS labour_minor, coalesce(n.sales, 0)::bigint AS net_sales_minor,
       round(coalesce(l.labour, 0) * 10000 / nullif(n.sales, 0))::bigint AS labour_bp, (SELECT labour_target_bp FROM tg)::bigint AS target_bp,
       greatest(round(coalesce(l.labour, 0) - (SELECT labour_target_bp FROM tg) * coalesce(n.sales, 0) / 10000.0), 0)::bigint AS excess_labour_minor
  FROM (SELECT wk FROM l UNION SELECT wk FROM n) k LEFT JOIN l ON l.wk = k.wk LEFT JOIN n ON n.wk = k.wk
 ORDER BY k.wk$q$,
    '{"type": "object", "required": ["outlet_id", "from", "to"], "additionalProperties": false,
      "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"},
                     "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
    jsonb_build_array(
      '{"name": "iso_week", "type": "text"}'::jsonb,
      jsonb_build_object('name', 'labour_minor', 'type', 'integer', 'numeric_source', '["core.attendance.clock_in_at", "core.attendance.clock_out_at"]'::jsonb || rate_src),
      '{"name": "net_sales_minor", "type": "integer", "numeric_source": ["core.order_line.qty_milli", "core.order_line.unit_price_minor", "core.order_line.line_discount_minor", "core.order_line.tax_minor"]}'::jsonb,
      jsonb_build_object('name', 'labour_bp', 'type', 'integer', 'numeric_source', '["core.attendance.clock_in_at", "core.attendance.clock_out_at", "core.order_line.qty_milli",
        "core.order_line.unit_price_minor", "core.order_line.line_discount_minor", "core.order_line.tax_minor"]'::jsonb || rate_src),
      '{"name": "target_bp", "type": "integer", "numeric_source": "core.business_policy.labour_target_bp"}'::jsonb,
      jsonb_build_object('name', 'excess_labour_minor', 'type', 'integer', 'numeric_source', '["core.attendance.clock_in_at", "core.attendance.clock_out_at", "core.order_line.qty_milli",
        "core.order_line.unit_price_minor", "core.order_line.line_discount_minor", "core.order_line.tax_minor", "core.business_policy.labour_target_bp"]'::jsonb || rate_src)),
    'manager');

  -- Rostered shifts (scheduled, outlet-local start date in the window) and how many have a closed attendance row linked
  -- to them; coverage = floor(attended × 10,000 ÷ rostered) (core-api coverage()).
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
    'people.attendance_coverage', 1,
    $q$SELECT count(*)::bigint AS rostered_shifts,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM core.attendance a WHERE a.tenant_id = s.tenant_id AND a.roster_shift_id = s.id
                                                                       AND a.clock_out_at IS NOT NULL))::bigint AS attended_shifts,
       (count(*) FILTER (WHERE EXISTS (SELECT 1 FROM core.attendance a WHERE a.tenant_id = s.tenant_id AND a.roster_shift_id = s.id
                                                                        AND a.clock_out_at IS NOT NULL)) * 10000 / nullif(count(*), 0))::bigint AS coverage_bp
  FROM core.roster_shift s JOIN core.outlet o ON o.tenant_id = s.tenant_id AND o.id = s.outlet_id
 WHERE s.status = 'scheduled' AND (:outlet_id::uuid IS NULL OR s.outlet_id = :outlet_id::uuid)
   AND (s.starts_at AT TIME ZONE o.tz)::date BETWEEN :from::date AND :to::date$q$,
    '{"type": "object", "required": ["outlet_id", "from", "to"], "additionalProperties": false,
      "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"},
                     "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
    '[{"name": "rostered_shifts", "type": "integer", "numeric_source": "count:core.roster_shift"},
      {"name": "attended_shifts", "type": "integer", "numeric_source": ["count:core.roster_shift", "count:core.attendance"]},
      {"name": "coverage_bp", "type": "integer", "numeric_source": ["count:core.roster_shift", "count:core.attendance"]}]',
    'manager');

  -- Outstanding advances per staff member (read through the staff row: advances carry no outlet): given − recovered,
  -- a recovery booked on a payroll later voided does not count (core-api outstandingAdvance); days since the oldest
  -- advance given, to the outlet's business date today. Rows only where something is outstanding.
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
    'people.advances_open', 1,
    $q$SELECT s.id AS staff_id,
       sum(CASE a.kind WHEN 'given' THEN a.amount_minor ELSE -a.amount_minor END)::bigint AS outstanding_minor,
       (((now() AT TIME ZONE o.tz) - o.business_day_cutoff)::date - min(a.on_date) FILTER (WHERE a.kind = 'given'))::bigint AS days_since_given
  FROM core.staff s
  JOIN core.outlet o ON o.tenant_id = s.tenant_id AND o.id = s.outlet_id
  JOIN core.advance a ON a.tenant_id = s.tenant_id AND a.staff_id = s.id
 WHERE (:outlet_id::uuid IS NULL OR s.outlet_id = :outlet_id::uuid)
   AND NOT EXISTS (SELECT 1 FROM core.payroll_draft d WHERE d.tenant_id = a.tenant_id AND d.id = a.payroll_draft_id AND d.status = 'void')
 GROUP BY s.id, o.tz, o.business_day_cutoff
HAVING sum(CASE a.kind WHEN 'given' THEN a.amount_minor ELSE -a.amount_minor END) > 0
 ORDER BY s.id$q$,
    '{"type": "object", "required": ["outlet_id"], "additionalProperties": false,
      "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}}}',
    '[{"name": "staff_id", "type": "uuid"},
      {"name": "outstanding_minor", "type": "integer", "numeric_source": "core.advance.amount_minor"},
      {"name": "days_since_given", "type": "integer", "numeric_source": "core.advance.on_date"}]',
    'manager');

  -- (IN) A month's pay per staff member as core-api previewPayroll proposes it: hours of the ISO weeks whose Sunday falls
  -- in the month; hourly base = round(base minutes × rate ÷ 60) (attended less overtime), monthly base = the salary;
  -- overtime = Σ weekly extra cost for weeks with a roster; tips = Σ tip-pool shares of pools ending in the month;
  -- advance recovery = recoveries dated in the month (not on a voided payroll); net = base + overtime + tips − recovery.
  -- Staff employed in the month; an hourly member with no attendance in those weeks has no line. Pay is finance:
  -- min_role advisor (payroll drafts are owner-only commands).
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
    'people.payroll_lines', 1,
    $q$WITH m AS (
  SELECT :period_month::date AS s, (:period_month::date + interval '1 month - 1 day')::date AS e),
wk AS (
  SELECT m.s + (7 - extract(isodow FROM m.s)::int) % 7 - 6 AS f, m.e - extract(isodow FROM m.e)::int % 7 AS t FROM m),
r AS (
  SELECT x.staff_id, to_char((x.starts_at AT TIME ZONE o.tz)::date, 'IYYY-"W"IW') AS w, sum(extract(epoch FROM x.ends_at - x.starts_at) / 60)::bigint AS m
    FROM core.roster_shift x JOIN core.outlet o ON o.tenant_id = x.tenant_id AND o.id = x.outlet_id CROSS JOIN wk
   WHERE x.status = 'scheduled' AND (:outlet_id::uuid IS NULL OR x.outlet_id = :outlet_id::uuid)
     AND (x.starts_at AT TIME ZONE o.tz)::date BETWEEN wk.f AND wk.t
   GROUP BY 1, 2),
a AS (
  SELECT x.staff_id, to_char((x.clock_in_at AT TIME ZONE o.tz)::date, 'IYYY-"W"IW') AS w, sum(extract(epoch FROM x.clock_out_at - x.clock_in_at) / 60)::bigint AS m
    FROM core.attendance x JOIN core.outlet o ON o.tenant_id = x.tenant_id AND o.id = x.outlet_id CROSS JOIN wk
   WHERE x.clock_out_at IS NOT NULL AND (:outlet_id::uuid IS NULL OR x.outlet_id = :outlet_id::uuid)
     AND (x.clock_in_at AT TIME ZONE o.tz)::date BETWEEN wk.f AND wk.t
   GROUP BY 1, 2),
ot AS (
  SELECT a.staff_id, a.m AS att, coalesce(r.m, 0) AS ros, greatest(a.m - coalesce(r.m, 0), 0) AS extra,
         round(greatest(a.m - coalesce(r.m, 0), 0) * $q$ || rate || $q$ * s.ot_multiplier_bp / 600000) AS extra_cost
    FROM a LEFT JOIN r ON r.staff_id = a.staff_id AND r.w = a.w JOIN core.staff s ON s.id = a.staff_id),
st AS (
  SELECT s.* FROM core.staff s, m
   WHERE (:outlet_id::uuid IS NULL OR s.outlet_id = :outlet_id::uuid) AND s.joined_on <= m.e AND (s.left_on IS NULL OR s.left_on >= m.s)),
p AS (
  SELECT st.id AS staff_id,
         CASE WHEN st.pay_basis = 'hourly'
              THEN round((SELECT coalesce(sum(ot.att - CASE WHEN ot.ros > 0 THEN ot.extra ELSE 0 END), 0) FROM ot WHERE ot.staff_id = st.id)
                         * st.wage_rate_minor / 60.0)
              ELSE st.monthly_salary_minor END AS base,
         (SELECT coalesce(sum(ot.extra_cost) FILTER (WHERE ot.ros > 0), 0) FROM ot WHERE ot.staff_id = st.id) AS overtime,
         (SELECT coalesce(sum(sh.amount_minor), 0) FROM core.tip_pool tp
            JOIN core.tip_pool_share sh ON sh.tenant_id = tp.tenant_id AND sh.tip_pool_id = tp.id, m
           WHERE sh.staff_id = st.id AND tp.outlet_id = st.outlet_id AND tp.period_to BETWEEN m.s AND m.e) AS tips,
         (SELECT coalesce(sum(ad.amount_minor), 0) FROM core.advance ad, m
           WHERE ad.staff_id = st.id AND ad.kind = 'recovered' AND ad.on_date BETWEEN m.s AND m.e
             AND NOT EXISTS (SELECT 1 FROM core.payroll_draft d WHERE d.tenant_id = ad.tenant_id AND d.id = ad.payroll_draft_id AND d.status = 'void')) AS recovery
    FROM st
   WHERE st.pay_basis = 'monthly' OR EXISTS (SELECT 1 FROM ot WHERE ot.staff_id = st.id))
SELECT p.staff_id, p.base::bigint AS base_minor, p.overtime::bigint AS overtime_minor, p.recovery::bigint AS advance_recovery_minor,
       p.tips::bigint AS tips_minor, (p.base + p.overtime + p.tips - p.recovery)::bigint AS net_minor
  FROM p
 ORDER BY p.staff_id$q$,
    '{"type": "object", "required": ["outlet_id", "period_month"], "additionalProperties": false,
      "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "period_month": {"type": "string", "format": "date"}}}',
    jsonb_build_array(
      '{"name": "staff_id", "type": "uuid"}'::jsonb,
      jsonb_build_object('name', 'base_minor', 'type', 'integer', 'numeric_source', '["core.attendance.clock_in_at", "core.attendance.clock_out_at"]'::jsonb || rate_src),
      jsonb_build_object('name', 'overtime_minor', 'type', 'integer', 'numeric_source',
        '["core.attendance.clock_in_at", "core.attendance.clock_out_at", "core.roster_shift.starts_at", "core.roster_shift.ends_at", "core.staff.ot_multiplier_bp"]'::jsonb || rate_src),
      '{"name": "advance_recovery_minor", "type": "integer", "numeric_source": "core.advance.amount_minor"}'::jsonb,
      '{"name": "tips_minor", "type": "integer", "numeric_source": "core.tip_pool_share.amount_minor"}'::jsonb,
      jsonb_build_object('name', 'net_minor', 'type', 'integer', 'numeric_source',
        '["core.attendance.clock_in_at", "core.attendance.clock_out_at", "core.roster_shift.starts_at", "core.roster_shift.ends_at", "core.staff.ot_multiplier_bp",
          "core.advance.amount_minor", "core.tip_pool_share.amount_minor"]'::jsonb || rate_src)),
    'advisor');
END $$;

------------------------------------------------------------------------------------------------------------
-- 8. T1 — customers and growth templates (packs/customers-growth.md §3), min_role manager
------------------------------------------------------------------------------------------------------------
-- Coupon uses carry no outlet: they are read through their order (outlet-scoped), so a scoped minter sees only the uses
-- of its outlets' orders. Coupons are tenant-level.
-- Per coupon, uses in the window (the order's business date): count and discount; cap evasion = uses beyond the
-- coupon's per-customer cap by one phone number (digits only) across all the customer records that share it.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'customers.coupon_leakage', 1,
  $q$WITH u AS (
  SELECT cu.coupon_id, cu.discount_minor, regexp_replace(c.phone, '\D', '', 'g') AS ph,
         row_number() OVER (PARTITION BY cu.coupon_id, regexp_replace(c.phone, '\D', '', 'g') ORDER BY cu.at, cu.id) AS n
    FROM core.coupon_use cu
    JOIN core."order" o ON o.tenant_id = cu.tenant_id AND o.id = cu.order_id
    LEFT JOIN core.customer c ON c.tenant_id = cu.tenant_id AND c.id = cu.customer_id
   WHERE o.business_date BETWEEN :from::date AND :to::date)
SELECT u.coupon_id, count(*)::bigint AS uses, sum(u.discount_minor)::bigint AS discount_minor,
       count(*) FILTER (WHERE u.ph IS NOT NULL AND u.n > k.per_customer_cap)::bigint AS cap_evasion_uses,
       coalesce(sum(u.discount_minor) FILTER (WHERE u.ph IS NOT NULL AND u.n > k.per_customer_cap), 0)::bigint AS cap_evasion_minor
  FROM u JOIN core.coupon k ON k.id = u.coupon_id
 GROUP BY u.coupon_id
 ORDER BY u.coupon_id$q$,
  '{"type": "object", "required": ["from", "to"], "additionalProperties": false,
    "properties": {"from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
  '[{"name": "coupon_id", "type": "uuid"},
    {"name": "uses", "type": "integer", "numeric_source": "count:core.coupon_use"},
    {"name": "discount_minor", "type": "integer", "numeric_source": "core.coupon_use.discount_minor"},
    {"name": "cap_evasion_uses", "type": "integer", "numeric_source": ["count:core.coupon_use", "core.coupon.per_customer_cap"]},
    {"name": "cap_evasion_minor", "type": "integer", "numeric_source": ["core.coupon_use.discount_minor", "core.coupon.per_customer_cap"]}]',
  'manager');

-- Anonymous uses (no customer) in one week (business dates :week_start … +6) per coupon and the member who applied it;
-- cash_uses = those orders with a cash tender; outlet_median_uses = the median of uses per member that week.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'customers.staff_coupon_use', 1,
  $q$WITH u AS (
  SELECT cu.coupon_id, cu.applied_by AS member_id, cu.discount_minor,
         EXISTS (SELECT 1 FROM core.tender t WHERE t.tenant_id = o.tenant_id AND t.order_id = o.id AND t.method = 'cash') AS cash
    FROM core.coupon_use cu JOIN core."order" o ON o.tenant_id = cu.tenant_id AND o.id = cu.order_id
   WHERE cu.customer_id IS NULL AND o.business_date >= :week_start::date AND o.business_date < :week_start::date + 7
     AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)),
g AS (
  SELECT u.coupon_id, u.member_id, count(*) AS uses, count(*) FILTER (WHERE u.cash) AS cash_uses, sum(u.discount_minor) AS discount
    FROM u GROUP BY u.coupon_id, u.member_id)
SELECT g.coupon_id, g.member_id, g.uses::bigint AS uses, g.cash_uses::bigint AS cash_uses, g.discount::bigint AS discount_minor,
       round((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x.n) FROM (SELECT count(*) AS n FROM u GROUP BY u.member_id) x))::bigint AS outlet_median_uses
  FROM g
 ORDER BY g.coupon_id, g.member_id$q$,
  '{"type": "object", "required": ["outlet_id", "week_start"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "week_start": {"type": "string", "format": "date"}}}',
  '[{"name": "coupon_id", "type": "uuid"},
    {"name": "member_id", "type": "uuid"},
    {"name": "uses", "type": "integer", "numeric_source": "count:core.coupon_use"},
    {"name": "cash_uses", "type": "integer", "numeric_source": ["count:core.coupon_use", "count:core.tender"]},
    {"name": "discount_minor", "type": "integer", "numeric_source": "core.coupon_use.discount_minor"},
    {"name": "outlet_median_uses", "type": "integer", "numeric_source": "count:core.coupon_use"}]',
  'manager');

-- One coupon's uses per day over the 28 days to :to (the order's business date), against the median day of those 28
-- (days without uses count as 0): first_time_uses = uses on a customer's first completed or open order;
-- excess_discount = the day's discount − the median day's discount (≥ 0); in_campaign_window = a campaign of this coupon
-- (not cancelled) had a send window covering the day. Rows for days with uses.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'customers.coupon_daily', 1,
  $q$WITH days AS (SELECT d::date AS d FROM generate_series(:to::date - 27, :to::date, interval '1 day') d),
u AS (
  SELECT o.business_date AS d, cu.discount_minor,
         cu.customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM core."order" p WHERE p.tenant_id = o.tenant_id AND p.customer_id = cu.customer_id
                                                      AND p.status NOT IN ('cancelled', 'rejected') AND (p.created_at, p.id) < (o.created_at, o.id)) AS first_time
    FROM core.coupon_use cu JOIN core."order" o ON o.tenant_id = cu.tenant_id AND o.id = cu.order_id
   WHERE cu.coupon_id = :coupon_id::uuid AND o.business_date BETWEEN :to::date - 27 AND :to::date),
g AS (
  SELECT days.d, count(u.d) AS uses, count(u.d) FILTER (WHERE u.first_time) AS first_time, coalesce(sum(u.discount_minor), 0) AS discount
    FROM days LEFT JOIN u ON u.d = days.d GROUP BY days.d),
med AS (
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY g.uses) AS uses, percentile_cont(0.5) WITHIN GROUP (ORDER BY g.discount) AS discount FROM g)
SELECT g.d AS used_on, g.uses::bigint AS uses, round(med.uses)::bigint AS median_uses, g.first_time::bigint AS first_time_uses,
       g.discount::bigint AS discount_minor, greatest(round(g.discount - med.discount), 0)::bigint AS excess_discount_minor,
       EXISTS (SELECT 1 FROM core.campaign cp JOIN core.outlet ou ON ou.tenant_id = cp.tenant_id
                WHERE cp.coupon_id = :coupon_id::uuid AND cp.status <> 'cancelled' AND cp.window_from IS NOT NULL
                  AND ou.id = ANY (CASE WHEN cardinality(cp.outlet_ids) = 0 THEN ARRAY[ou.id] ELSE cp.outlet_ids END)
                  AND g.d BETWEEN ((cp.window_from AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date
                              AND ((coalesce(cp.window_to, cp.window_from) AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date) AS in_campaign_window
  FROM g CROSS JOIN med
 WHERE g.uses > 0
 ORDER BY g.d$q$,
  '{"type": "object", "required": ["coupon_id", "to"], "additionalProperties": false,
    "properties": {"coupon_id": {"type": "string", "format": "uuid"}, "to": {"type": "string", "format": "date"}}}',
  '[{"name": "used_on", "type": "date"},
    {"name": "uses", "type": "integer", "numeric_source": "count:core.coupon_use"},
    {"name": "median_uses", "type": "integer", "numeric_source": "count:core.coupon_use"},
    {"name": "first_time_uses", "type": "integer", "numeric_source": ["count:core.coupon_use", "count:core.order"]},
    {"name": "discount_minor", "type": "integer", "numeric_source": "core.coupon_use.discount_minor"},
    {"name": "excess_discount_minor", "type": "integer", "numeric_source": "core.coupon_use.discount_minor"},
    {"name": "in_campaign_window", "type": "boolean"}]',
  'manager');

-- Customers with ≥ 2 completed orders in the 90 days to :as_of (business dates; outlet_id NULL = every outlet in scope):
-- orders, the median gap between consecutive order days, days since the last, monthly spend = 90-day order totals ÷ 3.
-- segment (INFERENCE, pack gives no rule): 'at_risk' = ≥ 3 orders and silent longer than max(2 × median gap, 14 days);
-- 'regular' = ≥ 3 orders otherwise; else 'occasional'. The last row is the Σ row (customer NULL): at_risk_count,
-- regular_count and the at-risk customers' monthly spend.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'customers.churn_segments', 1,
  $q$WITH o AS (
  SELECT o.customer_id, o.business_date AS d, o.total_minor
    FROM core."order" o
   WHERE o.status = 'completed' AND o.customer_id IS NOT NULL
     AND o.business_date > :as_of::date - 90 AND o.business_date <= :as_of::date
     AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)),
gaps AS (
  SELECT x.customer_id, x.d - lag(x.d) OVER (PARTITION BY x.customer_id ORDER BY x.d) AS gap
    FROM (SELECT DISTINCT customer_id, d FROM o) x),
c AS (
  SELECT o.customer_id, count(*) AS n, max(o.d) AS last_d, sum(o.total_minor) AS spend,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY g.gap) FROM gaps g WHERE g.customer_id = o.customer_id AND g.gap IS NOT NULL) AS gap
    FROM o GROUP BY o.customer_id HAVING count(*) >= 2),
s AS (
  SELECT c.*, :as_of::date - c.last_d AS since,
         CASE WHEN c.n >= 3 AND :as_of::date - c.last_d > greatest(2 * c.gap, 14) THEN 'at_risk'
              WHEN c.n >= 3 THEN 'regular' ELSE 'occasional' END AS segment
    FROM c)
SELECT * FROM (
  SELECT s.customer_id, s.n::bigint AS orders_90d, round(s.gap)::bigint AS median_gap_days, s.since::bigint AS days_since_last,
         round(s.spend / 3.0)::bigint AS monthly_spend_minor, s.segment,
         NULL::bigint AS at_risk_count, NULL::bigint AS regular_count, NULL::bigint AS at_risk_spend_minor
    FROM s ORDER BY s.segment, s.customer_id) r
UNION ALL
SELECT NULL, NULL, NULL, NULL, NULL, NULL,
       (SELECT count(*) FROM s WHERE s.segment = 'at_risk')::bigint, (SELECT count(*) FROM s WHERE s.segment = 'regular')::bigint,
       (SELECT coalesce(sum(round(s.spend / 3.0)), 0) FROM s WHERE s.segment = 'at_risk')::bigint$q$,
  '{"type": "object", "required": ["outlet_id", "as_of"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "as_of": {"type": "string", "format": "date"}}}',
  '[{"name": "customer_id", "type": "uuid"},
    {"name": "orders_90d", "type": "integer", "numeric_source": "count:core.order"},
    {"name": "median_gap_days", "type": "integer", "numeric_source": "core.order.business_date"},
    {"name": "days_since_last", "type": "integer", "numeric_source": "core.order.business_date"},
    {"name": "monthly_spend_minor", "type": "integer", "numeric_source": "core.order.total_minor"},
    {"name": "segment", "type": "text"},
    {"name": "at_risk_count", "type": "integer", "numeric_source": ["count:core.order", "core.order.business_date"]},
    {"name": "regular_count", "type": "integer", "numeric_source": ["count:core.order", "core.order.business_date"]},
    {"name": "at_risk_spend_minor", "type": "integer", "numeric_source": ["core.order.total_minor", "core.order.business_date"]}]',
  'manager');

-- Reviews per ISO week of the outlet-local review date in the window: count, mean rating × 100, the mean over the 8 weeks
-- before that week; kitchen tickets late that week (ready after due, the order's business week) and their change against
-- the 8-week weekly mean (bp).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'customers.review_trend', 1,
  $q$WITH rv AS (
  SELECT date_trunc('week', ((r.reviewed_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date)::date AS wk, r.rating
    FROM core.review r JOIN core.outlet ou ON ou.tenant_id = r.tenant_id AND ou.id = r.outlet_id
   WHERE (:outlet_id::uuid IS NULL OR r.outlet_id = :outlet_id::uuid)
     AND ((r.reviewed_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date BETWEEN :from::date - 63 AND :to::date),
lt AS (
  SELECT date_trunc('week', o.business_date)::date AS wk, count(*) AS n
    FROM core.kitchen_ticket k JOIN core."order" o ON o.tenant_id = k.tenant_id AND o.id = k.order_id
   WHERE k.ready_at > k.due_at AND (:outlet_id::uuid IS NULL OR k.outlet_id = :outlet_id::uuid)
     AND o.business_date BETWEEN :from::date - 63 AND :to::date
   GROUP BY 1),
w AS (
  SELECT DISTINCT rv.wk FROM rv WHERE rv.wk >= date_trunc('week', :from::date)::date)
SELECT to_char(w.wk, 'IYYY-"W"IW') AS iso_week, (SELECT count(*) FROM rv WHERE rv.wk = w.wk)::bigint AS reviews,
       round((SELECT avg(rv.rating) FROM rv WHERE rv.wk = w.wk) * 100)::bigint AS avg_rating_x100,
       round((SELECT avg(rv.rating) FROM rv WHERE rv.wk >= w.wk - 56 AND rv.wk < w.wk) * 100)::bigint AS mean_8w_x100,
       coalesce((SELECT lt.n FROM lt WHERE lt.wk = w.wk), 0)::bigint AS late_tickets,
       round((coalesce((SELECT lt.n FROM lt WHERE lt.wk = w.wk), 0) - (SELECT coalesce(sum(lt.n), 0) / 8.0 FROM lt WHERE lt.wk >= w.wk - 56 AND lt.wk < w.wk))
             * 10000 / nullif((SELECT coalesce(sum(lt.n), 0) / 8.0 FROM lt WHERE lt.wk >= w.wk - 56 AND lt.wk < w.wk), 0))::bigint AS late_change_bp
  FROM w
 ORDER BY w.wk$q$,
  '{"type": "object", "required": ["outlet_id", "from", "to"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"},
                   "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
  '[{"name": "iso_week", "type": "text"},
    {"name": "reviews", "type": "integer", "numeric_source": "count:core.review"},
    {"name": "avg_rating_x100", "type": "integer", "numeric_source": "core.review.rating"},
    {"name": "mean_8w_x100", "type": "integer", "numeric_source": "core.review.rating"},
    {"name": "late_tickets", "type": "integer", "numeric_source": ["count:core.kitchen_ticket", "core.kitchen_ticket.ready_at", "core.kitchen_ticket.due_at"]},
    {"name": "late_change_bp", "type": "integer", "numeric_source": ["count:core.kitchen_ticket", "core.kitchen_ticket.ready_at", "core.kitchen_ticket.due_at"]}]',
  'manager');

-- The customers a segment snapshot names (its rows' customer_id cells; a snapshot the minter could not open — wider
-- outlet scope — names none) and how many of them may receive offers: not erased, email or SMS consent given.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'customers.consented_audience', 1,
  $q$WITH ids AS (
  SELECT DISTINCT (r ->> 'customer_id')::uuid AS id
    FROM evidence.snapshot s CROSS JOIN LATERAL jsonb_array_elements(s.rows) r
   WHERE s.id = :segment_snapshot_id::uuid AND r ->> 'customer_id' IS NOT NULL
     AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
          OR (NOT '*' = ANY (s.outlet_scope)
              AND s.outlet_scope::uuid[] <@ (SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
SELECT count(*)::bigint AS audience,
       count(*) FILTER (WHERE c.erased_at IS NULL AND (coalesce((c.consent ->> 'email')::boolean, false) OR coalesce((c.consent ->> 'sms')::boolean, false)))::bigint AS consented
  FROM ids JOIN core.customer c ON c.id = ids.id$q$,
  '{"type": "object", "required": ["segment_snapshot_id"], "additionalProperties": false,
    "properties": {"segment_snapshot_id": {"type": "string", "format": "uuid"}}}',
  '[{"name": "audience", "type": "integer", "numeric_source": "count:core.customer"},
    {"name": "consented", "type": "integer", "numeric_source": ["count:core.customer", "core.customer.consent"]}]',
  'manager');

-- A coupon's current terms.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'customers.coupon_current', 1,
  $q$SELECT k.value_minor::bigint AS value_minor, k.value_bp::bigint AS value_bp, k.per_customer_cap::bigint AS per_customer_cap,
       k.global_cap::bigint AS global_cap, k.min_spend_minor::bigint AS min_spend_minor
  FROM core.coupon k
 WHERE k.id = :coupon_id::uuid$q$,
  '{"type": "object", "required": ["coupon_id"], "additionalProperties": false,
    "properties": {"coupon_id": {"type": "string", "format": "uuid"}}}',
  '[{"name": "value_minor", "type": "integer", "numeric_source": "core.coupon.value_minor"},
    {"name": "value_bp", "type": "integer", "numeric_source": "core.coupon.value_bp"},
    {"name": "per_customer_cap", "type": "integer", "numeric_source": "core.coupon.per_customer_cap"},
    {"name": "global_cap", "type": "integer", "numeric_source": "core.coupon.global_cap"},
    {"name": "min_spend_minor", "type": "integer", "numeric_source": "core.coupon.min_spend_minor"}]',
  'manager');

------------------------------------------------------------------------------------------------------------
-- 9. T1 — compliance and assets templates (packs/compliance-assets.md §3), min_role manager
------------------------------------------------------------------------------------------------------------
-- core.outlet is tenant-visible: templates that list outlets narrow it to the minter's outlets themselves (as 0019's
-- finance.tender_vs_bank does).
-- Per outlet in scope and required kind (the country pack's licence_kinds, a param — R21): the licence in force on
-- :as_of (active, the outlet's own or a tenant-wide one, the latest expiry first); days_left = valid_to − as_of
-- (NULL when it does not expire); missing = none in force.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'compliance.licence_calendar', 1,
  $q$SELECT ou.id AS outlet_id, k.kind, l.id AS licence_id, l.valid_to, (l.valid_to - :as_of::date)::bigint AS days_left, l.id IS NULL AS missing
  FROM core.outlet ou
 CROSS JOIN unnest(:required_kinds::text[]) k(kind)
  LEFT JOIN LATERAL (
    SELECT x.id, x.valid_to FROM core.licence x
     WHERE x.kind = k.kind AND x.status = 'active' AND (x.outlet_id = ou.id OR x.outlet_id IS NULL)
       AND x.valid_from <= :as_of::date AND (x.valid_to IS NULL OR x.valid_to >= :as_of::date)
     ORDER BY x.valid_to DESC NULLS FIRST, x.id LIMIT 1) l ON true
 WHERE (SELECT current_setting('app.outlet_ids', true)) = '{*}'
    OR ou.id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])
 ORDER BY ou.id, k.kind$q$,
  '{"type": "object", "required": ["as_of", "required_kinds"], "additionalProperties": false,
    "properties": {"as_of": {"type": "string", "format": "date"},
                   "required_kinds": {"type": "array", "items": {"type": "string", "pattern": "^[a-z][a-z0-9_]*$"}, "minItems": 1, "maxItems": 20}}}',
  '[{"name": "outlet_id", "type": "uuid"},
    {"name": "kind", "type": "text"},
    {"name": "licence_id", "type": "uuid"},
    {"name": "valid_to", "type": "date"},
    {"name": "days_left", "type": "integer", "numeric_source": "core.licence.valid_to"},
    {"name": "missing", "type": "boolean"}]',
  'manager');

-- Per active checklist (outlet NULL = run at every outlet in scope): runs expected by its frequency over the window
-- (days, ISO weeks or months touched, × outlets) and periods with a run; the last row (checklist NULL) is the temperature
-- log: asset-days expected (active assets with a safe range, every day of the window) and asset-days with a reading.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'compliance.log_coverage', 1,
  $q$WITH days AS (SELECT d::date AS d FROM generate_series(:from::date, :to::date, interval '1 day') d),
ou AS (
  SELECT o.id, o.tz, o.business_day_cutoff FROM core.outlet o
   WHERE (:outlet_id::uuid IS NULL OR o.id = :outlet_id::uuid)
     AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
          OR o.id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[]))),
cp AS (
  SELECT c.id AS checklist_id, ou.id AS outlet_id,
         CASE c.frequency WHEN 'daily' THEN days.d WHEN 'weekly' THEN date_trunc('week', days.d)::date ELSE date_trunc('month', days.d)::date END AS p,
         c.frequency
    FROM core.checklist c JOIN ou ON c.outlet_id = ou.id OR c.outlet_id IS NULL CROSS JOIN days
   WHERE c.active),
ck AS (
  SELECT cp.checklist_id, count(DISTINCT (cp.outlet_id, cp.p)) AS expected,
         count(DISTINCT (cp.outlet_id, cp.p)) FILTER (WHERE EXISTS (
           SELECT 1 FROM core.checklist_run r WHERE r.checklist_id = cp.checklist_id AND r.outlet_id = cp.outlet_id
              AND r.business_date BETWEEN :from::date AND :to::date
              AND CASE cp.frequency WHEN 'daily' THEN r.business_date WHEN 'weekly' THEN date_trunc('week', r.business_date)::date
                                     ELSE date_trunc('month', r.business_date)::date END = cp.p)) AS done
    FROM cp GROUP BY cp.checklist_id),
tl AS (
  SELECT count(*) AS expected,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM core.temp_log t WHERE t.asset_id = a.id
                                          AND ((t.read_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date = days.d)) AS logged
    FROM core.asset a JOIN ou ON ou.id = a.outlet_id CROSS JOIN days
   WHERE a.active AND a.safe_min_milli_c IS NOT NULL AND (a.installed_on IS NULL OR a.installed_on <= days.d))
SELECT * FROM (
  SELECT ck.checklist_id, ck.expected::bigint AS expected_runs, ck.done::bigint AS done_runs,
         (ck.done * 10000 / nullif(ck.expected, 0))::bigint AS coverage_bp, NULL::bigint AS temp_expected, NULL::bigint AS temp_logged
    FROM ck ORDER BY ck.checklist_id) r
UNION ALL
SELECT NULL, NULL, NULL, (tl.logged * 10000 / nullif(tl.expected, 0))::bigint, tl.expected::bigint, tl.logged::bigint FROM tl$q$,
  '{"type": "object", "required": ["outlet_id", "from", "to"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"},
                   "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
  '[{"name": "checklist_id", "type": "uuid"},
    {"name": "expected_runs", "type": "integer", "numeric_source": "core.checklist.frequency"},
    {"name": "done_runs", "type": "integer", "numeric_source": "count:core.checklist_run"},
    {"name": "coverage_bp", "type": "integer", "numeric_source": ["count:core.checklist_run", "core.checklist.frequency", "count:core.temp_log", "count:core.asset"]},
    {"name": "temp_expected", "type": "integer", "numeric_source": "count:core.asset"},
    {"name": "temp_logged", "type": "integer", "numeric_source": "count:core.temp_log"}]',
  'manager');

-- Per asset and outlet-local day with readings in the window: readings, those outside the asset's safe range, the
-- highest reading; temp_waste = the outlet's temperature waste (reason 'temperature') that day, valued at the last
-- receipt cost, shown on asset-days with an excursion (an outlet's waste is not split between its assets).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'compliance.temp_excursions', 1,
  $q$WITH r AS (
  SELECT a.id AS asset_id, a.outlet_id, ((t.read_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date AS d,
         count(*) AS readings,
         count(*) FILTER (WHERE t.reading_milli_c < a.safe_min_milli_c OR t.reading_milli_c > a.safe_max_milli_c) AS bad,
         max(t.reading_milli_c) AS hi
    FROM core.temp_log t
    JOIN core.asset a ON a.tenant_id = t.tenant_id AND a.id = t.asset_id
    JOIN core.outlet ou ON ou.tenant_id = t.tenant_id AND ou.id = t.outlet_id
   WHERE (:outlet_id::uuid IS NULL OR t.outlet_id = :outlet_id::uuid)
     AND ((t.read_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date BETWEEN :from::date AND :to::date
   GROUP BY a.id, a.outlet_id, 3)
SELECT r.asset_id, r.d AS logged_on, r.readings::bigint AS readings, r.bad::bigint AS out_of_range, r.hi::bigint AS max_milli_c,
       CASE WHEN r.bad > 0 THEN round(coalesce((
         SELECT sum(-m.qty_milli * (SELECT x.unit_cost_per_1000_minor FROM core.stock_movement x
                                     WHERE x.outlet_id = m.outlet_id AND x.ingredient_id = m.ingredient_id AND x.kind = 'receipt'
                                       AND x.unit_cost_per_1000_minor IS NOT NULL AND x.at <= m.at
                                     ORDER BY x.at DESC, x.id DESC LIMIT 1) / 1000000.0)
           FROM core.stock_movement m
           JOIN core.waste_log w ON w.tenant_id = m.tenant_id AND w.id = m.ref_id AND m.ref_type = 'core.waste_log'
           JOIN core.outlet ou ON ou.tenant_id = m.tenant_id AND ou.id = m.outlet_id
          WHERE m.kind = 'waste' AND w.reason = 'temperature' AND m.outlet_id = r.outlet_id
            AND ((m.at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date = r.d), 0)) ELSE 0 END::bigint AS temp_waste_minor
  FROM r
 ORDER BY r.d, r.asset_id$q$,
  '{"type": "object", "required": ["outlet_id", "from", "to"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"},
                   "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
  '[{"name": "asset_id", "type": "uuid"},
    {"name": "logged_on", "type": "date"},
    {"name": "readings", "type": "integer", "numeric_source": "count:core.temp_log"},
    {"name": "out_of_range", "type": "integer", "numeric_source": ["count:core.temp_log", "core.temp_log.reading_milli_c", "core.asset.safe_min_milli_c", "core.asset.safe_max_milli_c"]},
    {"name": "max_milli_c", "type": "integer", "numeric_source": "core.temp_log.reading_milli_c"},
    {"name": "temp_waste_minor", "type": "integer", "numeric_source": ["core.stock_movement.qty_milli", "core.stock_movement.unit_cost_per_1000_minor"]}]',
  'manager');

-- Per asset in scope (AMCs and maintenance read through their asset): breakdown repairs done in the window and billed
-- outside a contract (no amc_id) while an AMC of the asset was valid; AMCs of the asset overlapping each other and the
-- window — overlap days of each pair, priced at the earlier contract's daily cost (cost × days ÷ 365); amc_waste = both;
-- days a scheduled preventive job is overdue on :to (the oldest); the cost of the last preventive job done.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'compliance.asset_costs', 1,
  $q$WITH a AS (
  SELECT a.id FROM core.asset a WHERE :outlet_id::uuid IS NULL OR a.outlet_id = :outlet_id::uuid),
rep AS (
  SELECT m.asset_id, sum(m.cost_minor) AS v FROM core.maintenance m
   WHERE m.asset_id IN (SELECT id FROM a) AND m.kind = 'breakdown' AND m.status = 'done' AND m.amc_id IS NULL
     AND m.done_on BETWEEN :from::date AND :to::date AND m.cost_minor IS NOT NULL
     AND EXISTS (SELECT 1 FROM core.amc c WHERE c.asset_id = m.asset_id AND m.done_on BETWEEN c.valid_from AND c.valid_to)
   GROUP BY m.asset_id),
ov AS (
  SELECT x.asset_id, sum(least(x.valid_to, y.valid_to) - greatest(x.valid_from, y.valid_from)) AS days,
         sum((least(x.valid_to, y.valid_to) - greatest(x.valid_from, y.valid_from)) * x.cost_minor / 365.0) AS v
    FROM core.amc x JOIN core.amc y ON y.tenant_id = x.tenant_id AND y.asset_id = x.asset_id AND (y.valid_from, y.id) > (x.valid_from, x.id)
   WHERE x.asset_id IN (SELECT id FROM a) AND least(x.valid_to, y.valid_to) > greatest(x.valid_from, y.valid_from)
     AND greatest(x.valid_from, y.valid_from) <= :to::date AND least(x.valid_to, y.valid_to) >= :from::date
   GROUP BY x.asset_id)
SELECT a.id AS asset_id, coalesce(rep.v, 0)::bigint AS repairs_under_amc_minor, coalesce(ov.days, 0)::bigint AS amc_overlap_days,
       round(coalesce(ov.v, 0))::bigint AS amc_overlap_minor, (coalesce(rep.v, 0) + round(coalesce(ov.v, 0)))::bigint AS amc_waste_minor,
       (SELECT greatest(:to::date - min(m.due_on), 0) FROM core.maintenance m
         WHERE m.asset_id = a.id AND m.kind = 'preventive' AND m.status = 'scheduled' AND m.due_on < :to::date)::bigint AS preventive_overdue_days,
       (SELECT m.cost_minor FROM core.maintenance m
         WHERE m.asset_id = a.id AND m.kind = 'preventive' AND m.status = 'done' AND m.cost_minor IS NOT NULL AND m.done_on <= :to::date
         ORDER BY m.done_on DESC, m.id DESC LIMIT 1)::bigint AS last_preventive_cost_minor
  FROM a LEFT JOIN rep ON rep.asset_id = a.id LEFT JOIN ov ON ov.asset_id = a.id
 ORDER BY a.id$q$,
  '{"type": "object", "required": ["outlet_id", "from", "to"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"},
                   "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
  '[{"name": "asset_id", "type": "uuid"},
    {"name": "repairs_under_amc_minor", "type": "integer", "numeric_source": "core.maintenance.cost_minor"},
    {"name": "amc_overlap_days", "type": "integer", "numeric_source": ["core.amc.valid_from", "core.amc.valid_to"]},
    {"name": "amc_overlap_minor", "type": "integer", "numeric_source": ["core.amc.valid_from", "core.amc.valid_to", "core.amc.cost_minor"]},
    {"name": "amc_waste_minor", "type": "integer", "numeric_source": ["core.maintenance.cost_minor", "core.amc.valid_from", "core.amc.valid_to", "core.amc.cost_minor"]},
    {"name": "preventive_overdue_days", "type": "integer", "numeric_source": "core.maintenance.due_on"},
    {"name": "last_preventive_cost_minor", "type": "integer", "numeric_source": "core.maintenance.cost_minor"}]',
  'manager');

-- Utility expense per completed order for each of the last :months months (to the current month, outlet-local; the
-- outlet's own expenses, plus tenant-wide ones when outlet_id is NULL), against the median of the 3 months before;
-- energy_excess = (per order − median) × orders (≥ 0).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'compliance.energy_per_order', 1,
  $q$WITH cur AS (
  SELECT date_trunc('month', min(((now() AT TIME ZONE o.tz) - o.business_day_cutoff)::date))::date AS m FROM core.outlet o),
ms AS (
  SELECT (cur.m - make_interval(months => k))::date AS m FROM cur, generate_series(0, :months::int + 2) k),
x AS (
  SELECT ms.m,
         (SELECT coalesce(sum(e.amount_minor), 0) FROM core.expense e
           WHERE e.category = 'utilities' AND date_trunc('month', e.incurred_on)::date = ms.m
             AND (CASE WHEN :outlet_id::uuid IS NULL THEN true ELSE e.outlet_id = :outlet_id::uuid END)) AS util,
         (SELECT count(*) FROM core."order" o
           WHERE o.status = 'completed' AND date_trunc('month', o.business_date)::date = ms.m
             AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)) AS n
    FROM ms),
y AS (
  SELECT x.*, x.util::numeric / nullif(x.n, 0) AS per,
         (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY p.util::numeric / p.n) FROM x p
           WHERE p.m < x.m AND p.m >= (x.m - interval '3 months')::date AND p.n > 0) AS med
    FROM x)
SELECT y.m AS month_on, y.util::bigint AS utility_minor, y.n::bigint AS orders, round(y.per)::bigint AS per_order_minor,
       round(y.med)::bigint AS median_per_order_minor, greatest(round((y.per - y.med) * y.n), 0)::bigint AS energy_excess_minor
  FROM y, cur
 WHERE y.m > (cur.m - make_interval(months => :months::int))::date
 ORDER BY y.m$q$,
  '{"type": "object", "required": ["outlet_id", "months"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "months": {"type": "integer", "minimum": 1, "maximum": 24}}}',
  '[{"name": "month_on", "type": "date"},
    {"name": "utility_minor", "type": "integer", "numeric_source": "core.expense.amount_minor"},
    {"name": "orders", "type": "integer", "numeric_source": "count:core.order"},
    {"name": "per_order_minor", "type": "integer", "numeric_source": ["core.expense.amount_minor", "count:core.order"]},
    {"name": "median_per_order_minor", "type": "integer", "numeric_source": ["core.expense.amount_minor", "count:core.order"]},
    {"name": "energy_excess_minor", "type": "integer", "numeric_source": ["core.expense.amount_minor", "count:core.order"]}]',
  'manager');

------------------------------------------------------------------------------------------------------------
-- 10. T1 — market and strategy templates (packs/market-strategy.md §3), min_role manager (viability: advisor)
------------------------------------------------------------------------------------------------------------
-- A day's demand is its completed orders by business date (history bills carry no promised time). Signal days are the
-- market signals at the outlet or tenant-wide (outlet NULL); "normal" days are days with orders and no signal of any kind.
-- Uplift of a signal kind (and label) at one outlet over the last :lookback_days days before today: per label, its
-- signal days with orders, their mean orders, the baseline = the mean orders of normal days on the same weekday as each
-- signal day, uplift = (mean − baseline) ÷ baseline (bp). outlet_id NULL = every outlet in scope, pooled.
DO $$
DECLARE
  days constant text := $d$ou AS (
  SELECT o.id, ((now() AT TIME ZONE o.tz) - o.business_day_cutoff)::date AS today FROM core.outlet o
   WHERE (:outlet_id::uuid IS NULL OR o.id = :outlet_id::uuid)
     AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
          OR o.id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[]))),
dd AS (
  SELECT o.outlet_id, o.business_date AS d, count(*) AS n, sum(o.total_minor) AS sales
    FROM core."order" o JOIN ou ON ou.id = o.outlet_id
   WHERE o.status = 'completed' AND o.business_date < ou.today
   GROUP BY o.outlet_id, o.business_date),
sig AS (
  SELECT DISTINCT ou.id AS outlet_id, s.on_date, s.kind, s.label, s.value_milli
    FROM core.market_signal s JOIN ou ON s.outlet_id = ou.id OR s.outlet_id IS NULL
   WHERE s.kind <> 'competitor_price'),
normal AS (
  SELECT dd.* FROM dd WHERE NOT EXISTS (SELECT 1 FROM sig WHERE sig.outlet_id = dd.outlet_id AND sig.on_date = dd.d))$d$;
BEGIN
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
    'market.signal_uplift', 1,
    'WITH ' || days || $q$,
past AS (
  SELECT sig.label, dd.outlet_id, dd.d, dd.n,
         (SELECT avg(nm.n) FROM normal nm WHERE nm.outlet_id = dd.outlet_id AND extract(dow FROM nm.d) = extract(dow FROM dd.d)) AS base
    FROM (SELECT DISTINCT outlet_id, on_date, label FROM sig WHERE sig.kind = :kind::text AND (:label::text IS NULL OR sig.label = :label::text)) sig
    JOIN dd ON dd.outlet_id = sig.outlet_id AND dd.d = sig.on_date
    JOIN ou ON ou.id = dd.outlet_id
   WHERE dd.d >= ou.today - :lookback_days::int)
SELECT p.label, count(*)::bigint AS occurrences, round(avg(p.n))::bigint AS signal_day_orders, round(avg(p.base))::bigint AS baseline_orders,
       round((avg(p.n) - avg(p.base)) * 10000 / nullif(avg(p.base), 0))::bigint AS uplift_bp
  FROM past p
 GROUP BY p.label
 ORDER BY p.label$q$,
    '{"type": "object", "required": ["outlet_id", "kind", "label", "lookback_days"], "additionalProperties": false,
      "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"},
                     "kind": {"type": "string", "enum": ["weather", "festival", "holiday", "local_event", "other"]},
                     "label": {"type": ["string", "null"]}, "lookback_days": {"type": "integer", "minimum": 7, "maximum": 730}}}',
    '[{"name": "label", "type": "text"},
      {"name": "occurrences", "type": "integer", "numeric_source": "count:core.market_signal"},
      {"name": "signal_day_orders", "type": "integer", "numeric_source": "count:core.order"},
      {"name": "baseline_orders", "type": "integer", "numeric_source": "count:core.order"},
      {"name": "uplift_bp", "type": "integer", "numeric_source": ["count:core.order", "count:core.market_signal"]}]',
    'manager');

  -- Signals from today to :days days ahead, with their (kind, label)'s past effect at the same outlets (as signal_uplift,
  -- over all history before today); the forecast units of the day (the latest run, its own method, whole-day points);
  -- baseline = the mean orders and order totals of normal days on the signal day's weekday; expected extra sales =
  -- baseline sales × uplift (rounded, both integers first; negative = fewer sales).
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
    'market.upcoming', 1,
    'WITH ' || days || $q$,
up AS (
  SELECT sig.outlet_id, sig.on_date, sig.kind, sig.label, sig.value_milli FROM sig JOIN ou ON ou.id = sig.outlet_id
   WHERE sig.on_date BETWEEN ou.today AND ou.today + :days::int),
hist AS (
  SELECT k.kind, k.label, count(*) AS occ,
         round((avg(dd.n) - avg((SELECT avg(nm.n) FROM normal nm WHERE nm.outlet_id = dd.outlet_id AND extract(dow FROM nm.d) = extract(dow FROM dd.d))))
               * 10000 / nullif(avg((SELECT avg(nm.n) FROM normal nm WHERE nm.outlet_id = dd.outlet_id AND extract(dow FROM nm.d) = extract(dow FROM dd.d))), 0)) AS uplift
    FROM (SELECT DISTINCT kind, label FROM up) k
    JOIN (SELECT DISTINCT outlet_id, on_date, kind, label FROM sig) s ON s.kind = k.kind AND s.label = k.label
    JOIN dd ON dd.outlet_id = s.outlet_id AND dd.d = s.on_date
   GROUP BY k.kind, k.label),
fc AS (
  SELECT p.outlet_id, p.business_on, sum(p.qty_milli) / 1000.0 AS units
    FROM intel.forecast_point p
    JOIN (SELECT r.id, r.method FROM intel.forecast_run r
           WHERE EXISTS (SELECT 1 FROM intel.forecast_point x WHERE x.tenant_id = r.tenant_id AND x.forecast_run_id = r.id)
           ORDER BY r.created_at DESC, r.id DESC LIMIT 1) fr ON fr.id = p.forecast_run_id AND fr.method = p.method
   WHERE p.slot_start IS NULL
   GROUP BY p.outlet_id, p.business_on),
x AS (
  SELECT up.*, hist.uplift, hist.occ,
         round((SELECT avg(nm.n) FROM normal nm WHERE nm.outlet_id = up.outlet_id AND extract(dow FROM nm.d) = extract(dow FROM up.on_date))) AS base_n,
         round((SELECT avg(nm.sales) FROM normal nm WHERE nm.outlet_id = up.outlet_id AND extract(dow FROM nm.d) = extract(dow FROM up.on_date))) AS base_s,
         (SELECT fc.units FROM fc WHERE fc.outlet_id = up.outlet_id AND fc.business_on = up.on_date) AS units
    FROM up LEFT JOIN hist ON hist.kind = up.kind AND hist.label = up.label)
SELECT x.on_date, x.kind, x.label, x.value_milli::bigint AS value_milli, x.uplift::bigint AS hist_uplift_bp, coalesce(x.occ, 0)::bigint AS occurrences,
       round(x.units)::bigint AS forecast_orders, x.base_n::bigint AS baseline_orders, x.base_s::bigint AS baseline_sales_minor,
       round(x.base_s * x.uplift / 10000.0)::bigint AS expected_extra_sales_minor
  FROM x
 ORDER BY x.on_date, x.kind, x.label, x.outlet_id$q$,
    '{"type": "object", "required": ["outlet_id", "days"], "additionalProperties": false,
      "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "days": {"type": "integer", "minimum": 0, "maximum": 60}}}',
    '[{"name": "on_date", "type": "date"},
      {"name": "kind", "type": "text"},
      {"name": "label", "type": "text"},
      {"name": "value_milli", "type": "integer", "numeric_source": "core.market_signal.value_milli"},
      {"name": "hist_uplift_bp", "type": "integer", "numeric_source": ["count:core.order", "count:core.market_signal"]},
      {"name": "occurrences", "type": "integer", "numeric_source": "count:core.market_signal"},
      {"name": "forecast_orders", "type": "integer", "numeric_source": "intel.forecast_point.qty_milli"},
      {"name": "baseline_orders", "type": "integer", "numeric_source": "count:core.order"},
      {"name": "baseline_sales_minor", "type": "integer", "numeric_source": "core.order.total_minor"},
      {"name": "expected_extra_sales_minor", "type": "integer", "numeric_source": ["core.order.total_minor", "count:core.order", "count:core.market_signal"]}]',
    'manager');
END $$;

-- Items with competitor price observations (market signals of kind competitor_price) in the last :days days at the
-- outlet or tenant-wide: our counter price now (the highest in scope), the competitor's median, observations, the gap
-- (bp of theirs); units sold in the last 30 days, their rank among all items sold, the change against the 30 days
-- before (bp); exposure = (ours − theirs) × monthly units.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'market.competitor_gap', 1,
  $q$WITH ou AS (
  SELECT o.id, ((now() AT TIME ZONE o.tz) - o.business_day_cutoff)::date AS today FROM core.outlet o
   WHERE (:outlet_id::uuid IS NULL OR o.id = :outlet_id::uuid)
     AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
          OR o.id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[]))),
td AS (SELECT min(today) AS today FROM ou),
cp AS (
  SELECT s.item_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY s.value_minor) AS price, count(*) AS n
    FROM core.market_signal s, td
   WHERE s.kind = 'competitor_price' AND (s.outlet_id IS NULL OR s.outlet_id IN (SELECT id FROM ou))
     AND s.on_date > td.today - :days::int AND s.on_date <= td.today
   GROUP BY s.item_id),
pr AS (
  SELECT p.item_id, max(p.amount_minor) AS price FROM core.price p, td
   WHERE p.outlet_id IN (SELECT id FROM ou) AND p.channel_kind = 'counter' AND p.variant_id IS NULL
     AND p.valid_from <= td.today AND (p.valid_to IS NULL OR p.valid_to > td.today)
   GROUP BY p.item_id),
u AS (
  SELECT ol.item_id, sum(ol.qty_milli) FILTER (WHERE o.business_date > td.today - 30) AS now_q,
         sum(ol.qty_milli) FILTER (WHERE o.business_date <= td.today - 30) AS prev_q
    FROM core."order" o JOIN core.order_line ol ON ol.tenant_id = o.tenant_id AND ol.order_id = o.id, td
   WHERE o.status = 'completed' AND o.outlet_id IN (SELECT id FROM ou) AND o.business_date > td.today - 60 AND o.business_date <= td.today
   GROUP BY ol.item_id),
r AS (SELECT u.*, rank() OVER (ORDER BY coalesce(u.now_q, 0) DESC) AS rk FROM u)
SELECT cp.item_id, pr.price::bigint AS our_price_minor, round(cp.price)::bigint AS competitor_price_minor, cp.n::bigint AS observations,
       round((pr.price - cp.price) * 10000 / nullif(cp.price, 0))::bigint AS gap_bp,
       round(coalesce(r.now_q, 0) / 1000.0)::bigint AS monthly_units, r.rk::bigint AS units_rank,
       round((coalesce(r.now_q, 0) - r.prev_q) * 10000.0 / nullif(r.prev_q, 0))::bigint AS units_change_bp,
       round((pr.price - cp.price) * coalesce(r.now_q, 0) / 1000.0)::bigint AS gap_exposure_minor
  FROM cp LEFT JOIN pr ON pr.item_id = cp.item_id LEFT JOIN r ON r.item_id = cp.item_id
 ORDER BY cp.item_id$q$,
  '{"type": "object", "required": ["outlet_id", "days"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "days": {"type": "integer", "minimum": 1, "maximum": 365}}}',
  '[{"name": "item_id", "type": "uuid"},
    {"name": "our_price_minor", "type": "integer", "numeric_source": "core.price.amount_minor"},
    {"name": "competitor_price_minor", "type": "integer", "numeric_source": "core.market_signal.value_minor"},
    {"name": "observations", "type": "integer", "numeric_source": "count:core.market_signal"},
    {"name": "gap_bp", "type": "integer", "numeric_source": ["core.price.amount_minor", "core.market_signal.value_minor"]},
    {"name": "monthly_units", "type": "integer", "numeric_source": "core.order_line.qty_milli"},
    {"name": "units_rank", "type": "integer", "numeric_source": "core.order_line.qty_milli"},
    {"name": "units_change_bp", "type": "integer", "numeric_source": "core.order_line.qty_milli"},
    {"name": "gap_exposure_minor", "type": "integer", "numeric_source": ["core.price.amount_minor", "core.market_signal.value_minor", "core.order_line.qty_milli"]}]',
  'manager');

-- One viability case (tenant-level) against its comparable outlet's closed months: comparable margin = (income −
-- expense) ÷ income over the months closed for that outlet (or tenant-wide), from the postings of its journal entries.
-- breakeven = rent ÷ (avg ticket × margin) ÷ 30 days, rounded up; payback = capex ÷ (expected daily orders × 30 × avg
-- ticket × margin − rent), rounded up; NULL when it never pays back. Ledger margins are finance: min_role advisor.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'market.viability', 1,
  $q$WITH v AS (
  SELECT * FROM core.viability_case WHERE id = :viability_case_id::uuid),
cm AS (
  SELECT DISTINCT pc.period_month FROM core.period_close pc, v
   WHERE v.comparable_outlet_id IS NOT NULL AND (pc.outlet_id = v.comparable_outlet_id OR pc.outlet_id IS NULL)),
pl AS (
  SELECT -sum(p.amount_minor) FILTER (WHERE a.type = 'income') AS income, -sum(p.amount_minor) FILTER (WHERE a.type IN ('income', 'expense')) AS margin
    FROM core.journal_entry je
    JOIN core.posting p ON p.tenant_id = je.tenant_id AND p.journal_entry_id = je.id
    JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id, v
   WHERE je.outlet_id = v.comparable_outlet_id AND date_trunc('month', je.entry_date)::date IN (SELECT period_month FROM cm)),
m AS (SELECT pl.margin * 10000.0 / nullif(pl.income, 0) AS bp FROM pl)
SELECT v.rent_minor::bigint AS rent_minor, v.capex_minor::bigint AS capex_minor, v.avg_ticket_minor::bigint AS avg_ticket_minor,
       v.expected_daily_orders::bigint AS expected_daily_orders, round(m.bp)::bigint AS comparable_margin_bp,
       (SELECT count(*) FROM cm)::bigint AS closed_months,
       ceil(v.rent_minor / nullif(v.avg_ticket_minor * m.bp / 10000.0, 0) / 30)::bigint AS breakeven_daily_orders,
       CASE WHEN v.expected_daily_orders * 30 * v.avg_ticket_minor * m.bp / 10000.0 - v.rent_minor > 0
            THEN ceil(v.capex_minor / (v.expected_daily_orders * 30 * v.avg_ticket_minor * m.bp / 10000.0 - v.rent_minor)) END::bigint AS payback_months
  FROM v CROSS JOIN m$q$,
  '{"type": "object", "required": ["viability_case_id"], "additionalProperties": false,
    "properties": {"viability_case_id": {"type": "string", "format": "uuid"}}}',
  '[{"name": "rent_minor", "type": "integer", "numeric_source": "core.viability_case.rent_minor"},
    {"name": "capex_minor", "type": "integer", "numeric_source": "core.viability_case.capex_minor"},
    {"name": "avg_ticket_minor", "type": "integer", "numeric_source": "core.viability_case.avg_ticket_minor"},
    {"name": "expected_daily_orders", "type": "integer", "numeric_source": "core.viability_case.expected_daily_orders"},
    {"name": "comparable_margin_bp", "type": "integer", "numeric_source": "core.posting.amount_minor"},
    {"name": "closed_months", "type": "integer", "numeric_source": "count:core.period_close"},
    {"name": "breakeven_daily_orders", "type": "integer", "numeric_source": ["core.viability_case.rent_minor", "core.viability_case.avg_ticket_minor", "core.posting.amount_minor"]},
    {"name": "payback_months", "type": "integer", "numeric_source": ["core.viability_case.capex_minor", "core.viability_case.rent_minor", "core.viability_case.avg_ticket_minor",
       "core.viability_case.expected_daily_orders", "core.posting.amount_minor"]}]',
  'advisor');

-- One goal's pace (its outlet, or every outlet in scope when the goal is tenant-wide): actual = completed orders or their
-- net sales (lines net of discounts and of tax where prices include it) from period_from to today (capped at due_on);
-- elapsed = share of the goal's days gone (bp, ≤ 10,000); pace = (actual ÷ target) ÷ elapsed (bp); projected miss =
-- target − actual ÷ elapsed (positive = short; minor units when the metric is net_sales).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'market.goal_progress', 1,
  $q$WITH g AS (
  SELECT g.*, least(((now() AT TIME ZONE coalesce(ou.tz, t.home_tz, 'UTC')) - coalesce(ou.business_day_cutoff, time '00:00'))::date, g.due_on) AS today
    FROM core.goal g JOIN core.tenant t ON t.tenant_id = g.tenant_id
    LEFT JOIN core.outlet ou ON ou.tenant_id = g.tenant_id AND ou.id = g.outlet_id
   WHERE g.id = :goal_id::uuid),
pk AS (
  SELECT (cp.doc -> 'tax' ->> 'price_display') = 'inclusive' AS inclusive
    FROM core.tenant t JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
   WHERE cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')),
a AS (
  SELECT CASE WHEN g.metric = 'orders'
              THEN (SELECT count(*) FROM core."order" o
                     WHERE o.status = 'completed' AND o.business_date BETWEEN g.period_from AND g.today AND (g.outlet_id IS NULL OR o.outlet_id = g.outlet_id))
              ELSE (SELECT coalesce(sum(round(ol.qty_milli * ol.unit_price_minor / 1000.0) - ol.line_discount_minor - CASE WHEN pk.inclusive THEN ol.tax_minor ELSE 0 END), 0)
                      FROM core."order" o JOIN core.order_line ol ON ol.tenant_id = o.tenant_id AND ol.order_id = o.id CROSS JOIN pk
                     WHERE o.status = 'completed' AND o.business_date BETWEEN g.period_from AND g.today AND (g.outlet_id IS NULL OR o.outlet_id = g.outlet_id)) END AS actual,
         least(greatest((g.today - g.period_from + 1) * 10000.0 / (g.due_on - g.period_from + 1), 0), 10000) AS elapsed
    FROM g)
SELECT g.target_value::bigint AS target_value, a.actual::bigint AS actual_value, round(a.elapsed)::bigint AS elapsed_bp,
       round(a.actual * 10000.0 / g.target_value * 10000 / nullif(a.elapsed, 0))::bigint AS pace_bp,
       round(g.target_value - a.actual * 10000.0 / nullif(a.elapsed, 0))::bigint AS projected_miss_value
  FROM g CROSS JOIN a$q$,
  '{"type": "object", "required": ["goal_id"], "additionalProperties": false,
    "properties": {"goal_id": {"type": "string", "format": "uuid"}}}',
  '[{"name": "target_value", "type": "integer", "numeric_source": "core.goal.target_value"},
    {"name": "actual_value", "type": "integer", "numeric_source": ["count:core.order", "core.order_line.qty_milli", "core.order_line.unit_price_minor", "core.order_line.line_discount_minor", "core.order_line.tax_minor"]},
    {"name": "elapsed_bp", "type": "integer", "numeric_source": ["core.goal.period_from", "core.goal.due_on"]},
    {"name": "pace_bp", "type": "integer", "numeric_source": ["core.goal.target_value", "core.goal.period_from", "core.goal.due_on", "count:core.order",
       "core.order_line.qty_milli", "core.order_line.unit_price_minor", "core.order_line.line_discount_minor", "core.order_line.tax_minor"]},
    {"name": "projected_miss_value", "type": "integer", "numeric_source": ["core.goal.target_value", "core.goal.period_from", "core.goal.due_on", "count:core.order",
       "core.order_line.qty_milli", "core.order_line.unit_price_minor", "core.order_line.line_discount_minor", "core.order_line.tax_minor"]}]',
  'manager');

-- The basis for a proposed goal over the last :months complete months (before the current month, outlet-local):
-- last month's value and the best month's, of completed orders or their net sales (as goal_progress).
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'market.goal_baseline', 1,
  $q$WITH cur AS (
  SELECT date_trunc('month', min(((now() AT TIME ZONE o.tz) - o.business_day_cutoff)::date))::date AS m FROM core.outlet o),
pk AS (
  SELECT (cp.doc -> 'tax' ->> 'price_display') = 'inclusive' AS inclusive
    FROM core.tenant t JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
   WHERE cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')),
ms AS (SELECT (cur.m - make_interval(months => k))::date AS m FROM cur, generate_series(1, :months::int) k),
v AS (
  SELECT ms.m,
         CASE WHEN :metric::text = 'orders'
              THEN (SELECT count(*) FROM core."order" o
                     WHERE o.status = 'completed' AND date_trunc('month', o.business_date)::date = ms.m
                       AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid))
              ELSE (SELECT coalesce(sum(round(ol.qty_milli * ol.unit_price_minor / 1000.0) - ol.line_discount_minor - CASE WHEN pk.inclusive THEN ol.tax_minor ELSE 0 END), 0)
                      FROM core."order" o JOIN core.order_line ol ON ol.tenant_id = o.tenant_id AND ol.order_id = o.id CROSS JOIN pk
                     WHERE o.status = 'completed' AND date_trunc('month', o.business_date)::date = ms.m
                       AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)) END AS value
    FROM ms)
SELECT (SELECT v.value FROM v, cur WHERE v.m = (cur.m - interval '1 month')::date)::bigint AS last_month_value,
       (SELECT max(v.value) FROM v)::bigint AS best_month_value$q$,
  '{"type": "object", "required": ["outlet_id", "metric", "months"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "metric": {"type": "string", "enum": ["net_sales", "orders"]},
                   "months": {"type": "integer", "minimum": 1, "maximum": 24}}}',
  '[{"name": "last_month_value", "type": "integer", "numeric_source": ["count:core.order", "core.order_line.qty_milli", "core.order_line.unit_price_minor", "core.order_line.line_discount_minor", "core.order_line.tax_minor"]},
    {"name": "best_month_value", "type": "integer", "numeric_source": ["count:core.order", "core.order_line.qty_milli", "core.order_line.unit_price_minor", "core.order_line.line_discount_minor", "core.order_line.tax_minor"]}]',
  'manager');

------------------------------------------------------------------------------------------------------------
-- 11. Post-conditions (positive: each reads back as written)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  -- H1: the three CHECKs, exactly (every 0018 kind plus the two new ones).
  SELECT string_agg(v.t || '.' || v.c, ', ') INTO bad
    FROM (VALUES
      ('core.document', 'document_kind_check',
       $d$CHECK ((kind = ANY (ARRAY['supplier_invoice'::text, 'payout_statement'::text, 'bank_statement'::text, 'pos_export'::text, 'tally_export'::text, 'aggregator_orders'::text, 'market_signal'::text, 'menu'::text, 'price_list'::text, 'chat_export'::text, 'agreement'::text, 'licence'::text, 'other'::text, 'pos_bills'::text, 'waste_log'::text, 'shift_log'::text, 'stock_count'::text])))$d$),
      ('core.import_format', 'import_format_kind_check',
       $d$CHECK ((kind = ANY (ARRAY['payout_statement'::text, 'bank_statement'::text, 'pos_export'::text, 'tally_export'::text, 'aggregator_orders'::text, 'supplier_invoice'::text, 'market_signal'::text, 'menu'::text, 'price_list'::text, 'reviews'::text, 'pos_bills'::text, 'waste_log'::text, 'shift_log'::text, 'stock_count'::text])))$d$),
      ('core.import_run', 'import_run_kind_check',
       $d$CHECK ((kind = ANY (ARRAY['payout_statement'::text, 'bank_statement'::text, 'pos_export'::text, 'tally_export'::text, 'aggregator_orders'::text, 'supplier_invoice'::text, 'market_signal'::text, 'menu'::text, 'price_list'::text, 'reviews'::text, 'pos_bills'::text, 'waste_log'::text, 'shift_log'::text, 'stock_count'::text])))$d$)
    ) v(t, c, def)
   WHERE (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = v.t::regclass AND conname = v.c AND contype = 'c' AND convalidated)
         IS DISTINCT FROM v.def;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0021: kind CHECKs not as written: %', bad; END IF;

  -- H2: the binding, exactly (0008, 0011 review, 0015 A7, 0018, 0021), still draft-only, still no derived table.
  IF (SELECT array_agg(t ORDER BY t) FROM core.command_authority, unnest(target_tables) t WHERE command_type = 'imports.run.commit.v1')
       IS DISTINCT FROM ARRAY['core.bank_line', 'core.expense', 'core.order', 'core.order_line', 'core.refund', 'core.review',
                              'core.settlement', 'core.settlement_line', 'core.shift', 'core.stock_count', 'core.stock_count_line',
                              'core.supplier_invoice', 'core.supplier_invoice_line', 'core.tender', 'core.void', 'core.waste_log']
     OR NOT (SELECT draft_only FROM core.command_authority WHERE command_type = 'imports.run.commit.v1') THEN
    RAISE EXCEPTION '0021: imports.run.commit.v1 binding not as written: %',
      (SELECT array_agg(t ORDER BY t) FROM core.command_authority, unnest(target_tables) t WHERE command_type = 'imports.run.commit.v1');
  END IF;
  IF (SELECT array_agg(table_name || ':' || outlet_kind ORDER BY table_name) FROM core.book_scope
       WHERE table_name IN ('core.shift', 'core.stock_count', 'core.stock_count_line'))
     IS DISTINCT FROM ARRAY['core.shift:column', 'core.stock_count:column', 'core.stock_count_line:parent'] THEN
    RAISE EXCEPTION '0021: book_scope of the newly bound tables is not what the binding relies on';
  END IF;

  -- H3: the one count_adjust row, with its state.
  IF (SELECT array_agg(source_table || '>' || target_table || ':' || source_state) FROM core.derivation_rule WHERE rule_id = 'inventory.count_adjust')
     IS DISTINCT FROM ARRAY[$s$core.stock_count>core.stock_movement:s.status = 'submitted'$s$] THEN
    RAISE EXCEPTION '0021: inventory.count_adjust not as written';
  END IF;

  -- T1: exactly these 44 templates (version 1) at their min_role; inventory.below_reorder is still only its 0005 v1.
  SELECT string_agg(coalesce(t.id, v.id), ', ') INTO bad
    FROM (VALUES
      ('kitchen.ticket_times', 'manager'), ('kitchen.ticket_drift', 'manager'), ('kitchen.remakes_overprep', 'manager'),
      ('kitchen.prep_need', 'manager'), ('kitchen.ticket_coverage', 'manager'),
      ('inventory.shortfall', 'manager'), ('inventory.waste_week', 'manager'), ('inventory.expiry_risk', 'manager'),
      ('inventory.shrinkage', 'manager'), ('inventory.dead_stock', 'manager'), ('purchasing.price_creep', 'manager'),
      ('purchasing.invoice_vs_po', 'manager'), ('purchasing.invoice_duplicates', 'manager'), ('purchasing.quote_compare', 'manager'),
      ('purchasing.deal_inputs', 'manager'),
      ('forecast.sales_history', 'manager'), ('forecast.slot_profile', 'manager'), ('forecast.points', 'manager'),
      ('forecast.accuracy', 'manager'), ('forecast.freshness', 'manager'),
      ('people.labour_vs_demand', 'manager'), ('people.overtime_drift', 'manager'), ('people.labour_pct', 'manager'),
      ('people.attendance_coverage', 'manager'), ('people.advances_open', 'manager'), ('people.payroll_lines', 'advisor'),
      ('customers.coupon_leakage', 'manager'), ('customers.staff_coupon_use', 'manager'), ('customers.coupon_daily', 'manager'),
      ('customers.churn_segments', 'manager'), ('customers.review_trend', 'manager'), ('customers.consented_audience', 'manager'),
      ('customers.coupon_current', 'manager'),
      ('compliance.licence_calendar', 'manager'), ('compliance.log_coverage', 'manager'), ('compliance.temp_excursions', 'manager'),
      ('compliance.asset_costs', 'manager'), ('compliance.energy_per_order', 'manager'),
      ('market.signal_uplift', 'manager'), ('market.upcoming', 'manager'), ('market.competitor_gap', 'manager'),
      ('market.viability', 'advisor'), ('market.goal_progress', 'manager'), ('market.goal_baseline', 'manager')) v(id, min_role)
    FULL JOIN (SELECT * FROM evidence.snapshot_template
                WHERE id ~ '^(kitchen|purchasing|forecast|people|customers|compliance|market)\.'
                   OR (id ~ '^inventory\.' AND id <> 'inventory.below_reorder')) t ON t.id = v.id
   WHERE t.id IS NULL OR v.id IS NULL OR t.min_role <> v.min_role OR t.version <> 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0021: templates not as written: %', bad; END IF;
  IF (SELECT array_agg(version) FROM evidence.snapshot_template WHERE id = 'inventory.below_reorder') IS DISTINCT FROM ARRAY[1] THEN
    RAISE EXCEPTION '0021: inventory.below_reorder is not the single 0005 version';
  END IF;

  PERFORM munim_meta.assert_catalog('0021');
END $$;
