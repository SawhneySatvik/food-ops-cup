-- 0023_mc1e_template_versions — W3 migrator lane M-C1e (m-1), fix forward over 0001–0022. Runs as munim_migrator.
-- Additive only: version 2 of nine templates the specialist pack lanes asked for (orchestrator, 11 Oct), and one command
-- authority row (D1). No table, column, function, policy or grant changes; v1 rows are untouched. core-api mints the
-- LATEST version of a template, so every new snapshot of these nine is a version-2 snapshot from now on (the callers to
-- update are in db/README.md).
-- Items:
--   F1  finance.settlement_vs_orders v2 (b-44): one Σ row per settlement (settlement_line_id NULL), FIRST, then the lines.
--       The Σ row sums the lines that COUNT under the pack's line rule (packs/finance.md §4: short_minor ≥ max(₹1, 0.5% of
--       expected_net_minor), thresholds from the tenant's active pack, detectors.finance.short_payout line_short_minor_gte
--       / line_short_bp_gte — core-api reconcileSettlement's rule exactly), so the impact a finding shows is the sum of the
--       lines a dispute claims (§6), never netted down by overpaid lines or padded by rounding-level ones. Every Σ column
--       sums those same lines (Σ short = Σ expected − Σ net on the row). A settlement with no counting line still has its
--       Σ row (zeros). Expected net now starts from the matched order's TOTAL (pack §2 "order total − contracted
--       commission − tax withheld − refunds", and core-api's reconcileSettlement); an unmatched line falls back to the
--       statement's gross (v1 used the gross for every line — identical wherever the statement's gross is the order
--       total, as in every worldgen world). New columns, appended: settlement_id, channel_id.
--   F2  finance.missing_payouts v2 (b-44): one Σ row per channel (order_id NULL), FIRST; its days_unsettled is the OLDEST
--       unsettled order's age (DECISIONS 11 Oct W3.2: the trigger is the oldest order, the impact every unsettled order of
--       the channel). New column, appended: channel_id. No channel with an unsettled order → no row (v1 always printed a
--       zero Σ row).
--   F3  finance.tender_vs_bank v2 (b-44): one Σ row per ISO week (business_on NULL), FIRST, over that week's GAP DAYS: days
--       the bank statement reaches (a credit for the method on or after the day, up to :to — a day after the statement's
--       last credit is unknown, never a gap) whose gap ≥ the active pack's detectors.finance.tender_gap gap_minor_gte.
--       Σ tendered / credited / gap / voids / void_minor over those days; gap_days = their count; shift_member_id only when
--       every gap day's member is the same one; outlet_median_voids = the per-day median × gap_days, so the pack §4
--       critical clause "voids ≥ 2 × outlet_median_voids" compares like with like on the Σ row (a week's voids against
--       the median day's voids over as many days; b-44's request compared a week's sum with one day's median). Day rows
--       are v1's. New columns, appended: week_start (Σ rows; NULL on day rows), gap_days (Σ rows; NULL on day rows).
--   F4  finance.gst_check v2 (b-44's gst_mismatch detector): a nullable outlet_id param (NULL = every outlet in scope, the
--       v1 rows exactly), narrowing both the orders and the journal entries. Columns unchanged.
--   C1  customers.coupon_current v2 (b-46, the catalogue.coupon.set.v1 draft needs them): + code, kind, valid_from,
--       valid_to (timestamptz), outlet_ids (TEXT: the coupon's outlet list as a JSON array of uuids, '[]' = every outlet —
--       contracts ColumnType has no array type; core-api renders the cell as this string), active, requires_customer.
--   L1  compliance.licence_calendar v2 (DECISIONS 11 Oct W3.2: expired is not missing): + status ('in_force' | 'expired'
--       | 'missing') and manager_member_id. 'expired' = none in force on :as_of, and the kind's latest non-superseded
--       licence started on or before :as_of and either ran out (active, valid_to < as_of) or was marked lapsed; the row
--       then names that licence (licence_id, valid_to) with days_left = valid_to − as_of capped at 0 (negative once run
--       out; 0 for a lapsed licence whose date has not come — it has no days left). `missing` is now true only for
--       status 'missing' (none ever, or only superseded / not yet started): a BREAKING change for the licence_expiring
--       detector, which read an expired licence as missing (it now fires on days_left ≤ 30 instead).
--   L2  compliance.log_coverage v2: + manager_member_id (the goals.task.create.v1 assignee, pack §6). A checklist row's
--       outlet is :outlet_id, else the checklist's own; the temperature row's is :outlet_id; no outlet → NULL.
--       Manager rule (L1, L2): the outlet's manager is an ACTIVE member with an ACTIVE 'manager' membership listing the
--       outlet (an empty list is no outlet for a manager, 0020 coverage rule); several → the one whose membership lists
--       the FEWEST outlets (the outlet's own manager before an area manager), then the lowest member id. None → NULL (the
--       mapping falls back, e.g. to the approver; a worldgen world has a manager only at restaurant_group's South).
--       Only outlets in the minter's scope get a manager (an outlet outside it gets no row at all).
--   P1  people.overtime_drift v2 (b-48): one Σ row per staff member (iso_week NULL), FIRST — Σ of that member's weekly
--       rows in the window (pack §5 impact "4-week Σ row": the window is the caller's, 4 ISO weeks for the detector);
--       extra_cost_minor Σ = Σ of the rounded weekly costs shown. Week rows are v1's.
--   K1  kitchen.ticket_times v2 (b-45 prep_time_gap): one row per station and item over the whole window (slot_start
--       NULL), FIRST, then v1's per-slot rows. Pack §4 judges prep_time_gap per item and station (dedupe
--       <outlet>:<item>:<station>, a 14-day window, no slot), and slot p80s cannot be combined. Columns unchanged.
--   D1  Command findings.dismiss.v1 (orchestrator 11 Oct, from b-84 / T-084a lineage and dismiss): a person dismisses an
--       intel finding. core.command_log.command_type references core.command_authority, so the route fails closed until the
--       row exists. Its only write is intel.finding.status (operational; munim_core's existing 0012 column grant), so
--       target_tables is '{}' exactly as the other operational-only commands (drafts.approve.v1, drafts.reject.v1,
--       catalogue.availability.set.v1): the guard's own-command branch admits no book table under it (MB008 / MB001).
--       Roles owner, manager, judge; scope outlet. No core.decision.reason_code (the reject code stays in the audit entry).
-- Not changed here (reported): (a) IN aggregator settlement lines read OVERPAID by the order's tax: the template subtracts
-- the order's tax for operator-collects channels (pack §2, Sec 9(5); core-domain postOrder books the receivable net of
-- it and postSettlement clears gross − tax_withheld; core-api reconcileSettlement uses the same formula), while worldgen's
-- statements report gross = the order total with tax_withheld 0. The statements are wrong (worldgen lane). (b) Kitchen
-- late refunds: kitchen.ticket_drift reads reason_code 'late' (packs/kitchen.md §2, K1); worldgen writes 'late_delivery'.
-- No refund-reason vocabulary exists in migrations or contracts (a free slug); the pack is the only source. Not db.
-- New SQLSTATEs: none.

------------------------------------------------------------------------------------------------------------
-- 0. Nothing to overwrite: none of the nine has a version 2 yet, and each v1 is the shape this file extends.
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(id || ' v' || version, ', ') INTO bad FROM evidence.snapshot_template
   WHERE id IN ('finance.settlement_vs_orders', 'finance.missing_payouts', 'finance.tender_vs_bank', 'finance.gst_check',
                'customers.coupon_current', 'compliance.licence_calendar', 'compliance.log_coverage', 'people.overtime_drift',
                'kitchen.ticket_times')
     AND version <> 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0023: a later version already exists: %', bad; END IF;
  SELECT string_agg(v.id, ', ') INTO bad
    FROM (VALUES ('finance.settlement_vs_orders', 'settlement_line_id,matched_order_id,order_total_minor,commission_minor,net_minor,expected_commission_minor,refund_minor,expected_net_minor,short_minor'),
                 ('finance.missing_payouts', 'order_id,order_total_minor,expected_net_minor,days_unsettled'),
                 ('finance.tender_vs_bank', 'business_on,tendered_minor,credited_minor,gap_minor,voids,void_minor,outlet_median_voids,shift_member_id'),
                 ('finance.gst_check', 'outlet_id,order_tax_minor,posted_tax_minor,diff_minor'),
                 ('customers.coupon_current', 'value_minor,value_bp,per_customer_cap,global_cap,min_spend_minor'),
                 ('compliance.licence_calendar', 'outlet_id,kind,licence_id,valid_to,days_left,missing'),
                 ('compliance.log_coverage', 'checklist_id,expected_runs,done_runs,coverage_bp,temp_expected,temp_logged'),
                 ('people.overtime_drift', 'staff_id,iso_week,rostered_min,attended_min,extra_min,extra_cost_minor'),
                 ('kitchen.ticket_times', 'station,item_id,slot_start,tickets,p50_sec,p80_sec,late_tickets,configured_prep_sec')) v(id, cols)
    LEFT JOIN evidence.snapshot_template t ON t.id = v.id AND t.version = 1
   WHERE t.id IS NULL
      OR (SELECT string_agg(c ->> 'name', ',' ORDER BY k) FROM jsonb_array_elements(t.columns) WITH ORDINALITY e(c, k))
         IS DISTINCT FROM v.cols;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0023: version 1 is not the shape this file extends: %', bad; END IF;
END $$;

------------------------------------------------------------------------------------------------------------
-- 1. F1 — finance.settlement_vs_orders v2: a Σ row per settlement over the lines that count, first
------------------------------------------------------------------------------------------------------------
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
SELECT 'finance.settlement_vs_orders', 2,
  $q$WITH op AS (
  -- Aggregator channels whose operator collects the order's tax (pack aggregators, tax_treatment operator_collects_excluded).
  SELECT 'aggregator:' || (a ->> 'code') AS kind
    FROM core.tenant t
    JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
    CROSS JOIN LATERAL jsonb_array_elements(cp.doc -> 'aggregators') a
   WHERE a ->> 'tax_treatment' = 'operator_collects_excluded'
     AND cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')),
th AS (
  -- The pack's line rule (packs/finance.md §4): a line counts when short ≥ max(line_short_minor_gte, ⌈expected × line_short_bp_gte ÷ 10000⌉).
  SELECT (cp.doc #>> '{detectors,finance.short_payout,thresholds,line_short_minor_gte}')::bigint AS line_minor,
         (cp.doc #>> '{detectors,finance.short_payout,thresholds,line_short_bp_gte}')::bigint AS line_bp
    FROM core.tenant t
    JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
   WHERE cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')),
l AS (
  -- expected net = the order's total (the statement's gross for an unmatched line) − contracted commission on the gross −
  -- tax withheld (the order's own tax where the operator collects it, the statement's figure otherwise, pack §2) − refunds
  -- we recorded on that order; short = expected − paid.
  SELECT st.id AS settlement_id, st.channel_id, sl.id AS settlement_line_id, sl.matched_order_id, o.total_minor AS order_total,
         sl.commission_minor, sl.net_minor,
         round(sl.gross_minor * ct.commission_bp / 10000.0) AS expected_commission,
         coalesce((SELECT sum(r.amount_minor) FROM core.refund r WHERE r.tenant_id = sl.tenant_id AND r.order_id = sl.matched_order_id), 0) AS refund,
         coalesce(o.total_minor, sl.gross_minor) - round(sl.gross_minor * ct.commission_bp / 10000.0)
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
     AND (:outlet_id::uuid IS NULL OR st.outlet_id = :outlet_id::uuid)),
q AS (
  SELECT l.*, l.expected_net - l.net_minor AS short,
         coalesce(l.expected_net - l.net_minor > 0
                  AND l.expected_net - l.net_minor >= greatest(th.line_minor, ceil(l.expected_net * th.line_bp / 10000.0)), false) AS counts
    FROM l LEFT JOIN th ON true)
SELECT settlement_line_id, matched_order_id, order_total_minor, commission_minor, net_minor, expected_commission_minor,
       refund_minor, expected_net_minor, short_minor, settlement_id, channel_id
  FROM (-- The Σ row of each settlement (settlement_line_id NULL): its counting lines summed.
        SELECT 0 AS k, max(q.period_to) AS period_to, q.settlement_id, q.channel_id, NULL::uuid AS settlement_line_id,
               NULL::uuid AS matched_order_id,
               coalesce(sum(q.order_total) FILTER (WHERE q.counts), 0)::bigint AS order_total_minor,
               coalesce(sum(q.commission_minor) FILTER (WHERE q.counts), 0)::bigint AS commission_minor,
               coalesce(sum(q.net_minor) FILTER (WHERE q.counts), 0)::bigint AS net_minor,
               coalesce(sum(q.expected_commission) FILTER (WHERE q.counts), 0)::bigint AS expected_commission_minor,
               coalesce(sum(q.refund) FILTER (WHERE q.counts), 0)::bigint AS refund_minor,
               coalesce(sum(q.expected_net) FILTER (WHERE q.counts), 0)::bigint AS expected_net_minor,
               coalesce(sum(q.short) FILTER (WHERE q.counts), 0)::bigint AS short_minor
          FROM q GROUP BY q.settlement_id, q.channel_id
        UNION ALL
        SELECT 1, q.period_to, q.settlement_id, q.channel_id, q.settlement_line_id, q.matched_order_id, q.order_total::bigint,
               q.commission_minor::bigint, q.net_minor::bigint, q.expected_commission::bigint, q.refund::bigint,
               q.expected_net::bigint, q.short::bigint
          FROM q) z
 ORDER BY z.k, z.period_to, z.settlement_id, z.settlement_line_id$q$,
  params_schema,
  '[{"name": "settlement_line_id", "type": "uuid"},
    {"name": "matched_order_id", "type": "uuid"},
    {"name": "order_total_minor", "type": "integer", "numeric_source": "core.order.total_minor"},
    {"name": "commission_minor", "type": "integer", "numeric_source": "core.settlement_line.commission_minor"},
    {"name": "net_minor", "type": "integer", "numeric_source": "core.settlement_line.net_minor"},
    {"name": "expected_commission_minor", "type": "integer", "numeric_source": ["core.settlement_line.gross_minor", "core.channel_terms.commission_bp"]},
    {"name": "refund_minor", "type": "integer", "numeric_source": "core.refund.amount_minor"},
    {"name": "expected_net_minor", "type": "integer", "numeric_source": ["core.order.total_minor", "core.settlement_line.gross_minor", "core.channel_terms.commission_bp", "core.order.tax_minor", "core.settlement_line.tax_withheld_minor", "core.refund.amount_minor"]},
    {"name": "short_minor", "type": "integer", "numeric_source": ["core.order.total_minor", "core.settlement_line.gross_minor", "core.channel_terms.commission_bp", "core.order.tax_minor", "core.settlement_line.tax_withheld_minor", "core.refund.amount_minor", "core.settlement_line.net_minor"]},
    {"name": "settlement_id", "type": "uuid"},
    {"name": "channel_id", "type": "uuid"}]',
  min_role
  FROM evidence.snapshot_template WHERE id = 'finance.settlement_vs_orders' AND version = 1;

------------------------------------------------------------------------------------------------------------
-- 2. F2 — finance.missing_payouts v2: a Σ row per channel (oldest order's age), first
------------------------------------------------------------------------------------------------------------
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
SELECT 'finance.missing_payouts', 2,
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
  -- Never on a payout line (matched, or by the channel's own order reference).
  SELECT d.id, d.channel_id, d.total_minor, (:as_of::date - d.completed_on) AS days_unsettled,
         d.total_minor - round(d.total_minor * coalesce(ct.commission_bp, 0) / 10000.0)
           - CASE WHEN d.kind IN (SELECT kind FROM op) THEN d.tax_minor ELSE 0 END AS expected_net
    FROM done d
    LEFT JOIN core.channel_terms ct ON ct.channel_id = d.channel_id
     AND d.completed_on >= ct.valid_from AND (ct.valid_to IS NULL OR d.completed_on < ct.valid_to)
   WHERE NOT EXISTS (SELECT 1 FROM core.settlement_line sl JOIN core.settlement st ON st.tenant_id = sl.tenant_id AND st.id = sl.settlement_id
                      WHERE st.channel_id = d.channel_id
                        AND (sl.matched_order_id = d.id OR (d.external_ref IS NOT NULL AND sl.external_order_ref = d.external_ref))))
SELECT order_id, order_total_minor, expected_net_minor, days_unsettled, channel_id
  FROM (-- The Σ row of each channel (order_id NULL); its days_unsettled is the oldest order's.
        SELECT 0 AS k, m.channel_id, NULL::uuid AS order_id, sum(m.total_minor)::bigint AS order_total_minor,
               sum(m.expected_net)::bigint AS expected_net_minor, max(m.days_unsettled)::bigint AS days_unsettled
          FROM m GROUP BY m.channel_id
        UNION ALL
        SELECT 1, m.channel_id, m.id, m.total_minor::bigint, m.expected_net::bigint, m.days_unsettled::bigint FROM m) z
 ORDER BY z.k, z.channel_id, z.days_unsettled DESC, z.order_id$q$,
  params_schema,
  '[{"name": "order_id", "type": "uuid"},
    {"name": "order_total_minor", "type": "integer", "numeric_source": "core.order.total_minor"},
    {"name": "expected_net_minor", "type": "integer", "numeric_source": ["core.order.total_minor", "core.channel_terms.commission_bp", "core.order.tax_minor"]},
    {"name": "days_unsettled", "type": "integer", "numeric_source": ["core.order_event.at", "core.order.business_date"]},
    {"name": "channel_id", "type": "uuid"}]',
  min_role
  FROM evidence.snapshot_template WHERE id = 'finance.missing_payouts' AND version = 1;

------------------------------------------------------------------------------------------------------------
-- 3. F3 — finance.tender_vs_bank v2: a Σ row per ISO week over its gap days, first
------------------------------------------------------------------------------------------------------------
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
SELECT 'finance.tender_vs_bank', 2,
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
bl AS (
  -- Bank credits for the method up to :to: lines of the outlets, or tenant-wide lines paid to an outlet's own UPI VPA.
  SELECT b.value_date, b.amount_minor FROM core.bank_line b
   WHERE b.amount_minor > 0 AND b.method = :method::text AND b.value_date <= :to::date
     AND (b.outlet_id IN (SELECT id FROM ou) OR (b.outlet_id IS NULL AND b.payee_vpa IN (SELECT upi_vpa FROM ou)))),
bk AS (SELECT value_date AS d, sum(amount_minor) AS credited FROM bl WHERE value_date >= :from::date GROUP BY value_date),
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
days AS (SELECT d FROM tb UNION SELECT d FROM bk),
dr AS (
  SELECT days.d AS business_on, coalesce(tb.tendered, 0)::bigint AS tendered_minor, coalesce(bk.credited, 0)::bigint AS credited_minor,
         (coalesce(tb.tendered, 0) - coalesce(bk.credited, 0))::bigint AS gap_minor,
         coalesce(v.voids, 0)::bigint AS voids, coalesce(v.void_minor, 0)::bigint AS void_minor,
         (SELECT m FROM med) AS outlet_median_voids, sm.opened_by AS shift_member_id
    FROM days
    LEFT JOIN tb ON tb.d = days.d
    LEFT JOIN bk ON bk.d = days.d
    LEFT JOIN v ON v.d = days.d
    LEFT JOIN sm ON sm.d = days.d),
gd AS (
  -- Gap days: the statement reaches the day (a credit on or after it, up to :to) and the gap is at least the pack's
  -- detectors.finance.tender_gap gap_minor_gte. A day after the statement's last credit is unknown, never a gap.
  SELECT dr.* FROM dr
   WHERE dr.business_on <= (SELECT max(bl.value_date) FROM bl)
     AND dr.gap_minor >= (SELECT (cp.doc #>> '{detectors,finance.tender_gap,thresholds,gap_minor_gte}')::bigint
                            FROM core.tenant tn JOIN platform.country_pack cp ON cp.code = tn.country_code AND cp.status = 'active'
                           WHERE cp.version = (SELECT max(x.version) FROM platform.country_pack x WHERE x.code = tn.country_code AND x.status = 'active')))
SELECT business_on, tendered_minor, credited_minor, gap_minor, voids, void_minor, outlet_median_voids, shift_member_id, week_start, gap_days
  FROM (-- The Σ row of each ISO week with a gap day (business_on NULL): its gap days summed; the median day's voids × gap_days;
        -- the shift member only when every gap day's member is the same one.
        SELECT 0 AS k, NULL::date AS business_on, date_trunc('week', gd.business_on)::date AS week_start,
               sum(gd.tendered_minor)::bigint AS tendered_minor, sum(gd.credited_minor)::bigint AS credited_minor,
               sum(gd.gap_minor)::bigint AS gap_minor, sum(gd.voids)::bigint AS voids, sum(gd.void_minor)::bigint AS void_minor,
               (max(gd.outlet_median_voids) * count(*))::bigint AS outlet_median_voids,
               CASE WHEN count(gd.shift_member_id) = count(*) AND count(DISTINCT gd.shift_member_id) = 1
                    THEN min(gd.shift_member_id::text)::uuid END AS shift_member_id,
               count(*)::bigint AS gap_days
          FROM gd GROUP BY 3
        UNION ALL
        SELECT 1, dr.business_on, NULL::date, dr.tendered_minor, dr.credited_minor, dr.gap_minor, dr.voids, dr.void_minor,
               dr.outlet_median_voids, dr.shift_member_id, NULL::bigint
          FROM dr) z
 ORDER BY z.k, z.week_start, z.business_on$q$,
  params_schema,
  '[{"name": "business_on", "type": "date"},
    {"name": "tendered_minor", "type": "integer", "numeric_source": "core.tender.amount_minor"},
    {"name": "credited_minor", "type": "integer", "numeric_source": "core.bank_line.amount_minor"},
    {"name": "gap_minor", "type": "integer", "numeric_source": ["core.tender.amount_minor", "core.bank_line.amount_minor"]},
    {"name": "voids", "type": "integer", "numeric_source": "count:core.void"},
    {"name": "void_minor", "type": "integer", "numeric_source": "core.void.amount_minor"},
    {"name": "outlet_median_voids", "type": "integer", "numeric_source": ["count:core.void", "core.tender.amount_minor", "core.bank_line.amount_minor"]},
    {"name": "shift_member_id", "type": "uuid"},
    {"name": "week_start", "type": "date"},
    {"name": "gap_days", "type": "integer", "numeric_source": ["core.tender.amount_minor", "core.bank_line.amount_minor"]}]',
  min_role
  FROM evidence.snapshot_template WHERE id = 'finance.tender_vs_bank' AND version = 1;

------------------------------------------------------------------------------------------------------------
-- 4. F4 — finance.gst_check v2: an optional outlet_id
------------------------------------------------------------------------------------------------------------
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
SELECT 'finance.gst_check', 2,
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
     AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)
   GROUP BY o.outlet_id),
pt AS (
  SELECT je.outlet_id, (-sum(p.amount_minor))::bigint AS posted_tax_minor
    FROM core.journal_entry je
    JOIN core.posting p ON p.tenant_id = je.tenant_id AND p.journal_entry_id = je.id
    JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id
   WHERE je.posting_rule = 'finance.post_order' AND a.code IN ('2100')
     AND je.entry_date >= :period_month::date AND je.entry_date < (:period_month::date + interval '1 month')
     AND (:outlet_id::uuid IS NULL OR je.outlet_id = :outlet_id::uuid)
   GROUP BY je.outlet_id)
SELECT coalesce(ot.outlet_id, pt.outlet_id) AS outlet_id, coalesce(ot.order_tax_minor, 0) AS order_tax_minor,
       coalesce(pt.posted_tax_minor, 0) AS posted_tax_minor, coalesce(pt.posted_tax_minor, 0) - coalesce(ot.order_tax_minor, 0) AS diff_minor
  FROM ot FULL JOIN pt ON pt.outlet_id = ot.outlet_id
 ORDER BY 1$q$,
  '{"type": "object", "required": ["period_month", "outlet_id"], "additionalProperties": false,
    "properties": {"period_month": {"type": "string", "format": "date"}, "outlet_id": {"type": ["string", "null"], "format": "uuid"}}}',
  columns, min_role
  FROM evidence.snapshot_template WHERE id = 'finance.gst_check' AND version = 1;

------------------------------------------------------------------------------------------------------------
-- 5. C1 — customers.coupon_current v2: the coupon's identity, scope and validity beside its terms
------------------------------------------------------------------------------------------------------------
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
SELECT 'customers.coupon_current', 2,
  $q$SELECT k.value_minor::bigint AS value_minor, k.value_bp::bigint AS value_bp, k.per_customer_cap::bigint AS per_customer_cap,
       k.global_cap::bigint AS global_cap, k.min_spend_minor::bigint AS min_spend_minor,
       k.code, k.kind, k.valid_from, k.valid_to, to_jsonb(k.outlet_ids)::text AS outlet_ids, k.active, k.requires_customer
  FROM core.coupon k
 WHERE k.id = :coupon_id::uuid$q$,
  params_schema,
  columns || '[{"name": "code", "type": "text"}, {"name": "kind", "type": "text"}, {"name": "valid_from", "type": "timestamptz"},
               {"name": "valid_to", "type": "timestamptz"}, {"name": "outlet_ids", "type": "text"}, {"name": "active", "type": "boolean"},
               {"name": "requires_customer", "type": "boolean"}]',
  min_role
  FROM evidence.snapshot_template WHERE id = 'customers.coupon_current' AND version = 1;

------------------------------------------------------------------------------------------------------------
-- 6. L1 — compliance.licence_calendar v2: expired apart from missing, and the outlet's manager
------------------------------------------------------------------------------------------------------------
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
SELECT 'compliance.licence_calendar', 2,
  $q$SELECT ou.id AS outlet_id, k.kind, coalesce(l.id, x.id) AS licence_id, coalesce(l.valid_to, x.valid_to) AS valid_to,
       CASE WHEN l.id IS NOT NULL THEN l.valid_to - :as_of::date
            WHEN x.id IS NOT NULL THEN least(x.valid_to - :as_of::date, 0) END::bigint AS days_left,
       l.id IS NULL AND x.id IS NULL AS missing,
       CASE WHEN l.id IS NOT NULL THEN 'in_force' WHEN x.id IS NOT NULL THEN 'expired' ELSE 'missing' END AS status,
       (SELECT ms.member_id FROM core.membership ms
          JOIN core.member mb ON mb.tenant_id = ms.tenant_id AND mb.id = ms.member_id AND mb.active
         WHERE ms.tenant_id = ou.tenant_id AND ms.role = 'manager' AND ms.active AND ou.id = ANY (ms.outlet_ids)
         ORDER BY cardinality(ms.outlet_ids), ms.member_id LIMIT 1) AS manager_member_id
  FROM core.outlet ou
 CROSS JOIN unnest(:required_kinds::text[]) k(kind)
  -- In force on :as_of (v1): active, the outlet's own or a tenant-wide one, the latest expiry first.
  LEFT JOIN LATERAL (
    SELECT y.id, y.valid_to FROM core.licence y
     WHERE y.kind = k.kind AND y.status = 'active' AND (y.outlet_id = ou.id OR y.outlet_id IS NULL)
       AND y.valid_from <= :as_of::date AND (y.valid_to IS NULL OR y.valid_to >= :as_of::date)
     ORDER BY y.valid_to DESC NULLS FIRST, y.id LIMIT 1) l ON true
  -- Else expired: the latest non-superseded one that had started and ran out (active, valid_to < as_of) or lapsed.
  LEFT JOIN LATERAL (
    SELECT y.id, y.valid_to FROM core.licence y
     WHERE l.id IS NULL AND y.kind = k.kind AND (y.outlet_id = ou.id OR y.outlet_id IS NULL) AND y.valid_from <= :as_of::date
       AND ((y.status = 'active' AND y.valid_to < :as_of::date) OR y.status = 'lapsed')
     ORDER BY y.valid_to DESC NULLS FIRST, y.id LIMIT 1) x ON true
 WHERE (SELECT current_setting('app.outlet_ids', true)) = '{*}'
    OR ou.id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])
 ORDER BY ou.id, k.kind$q$,
  params_schema,
  columns || '[{"name": "status", "type": "text"}, {"name": "manager_member_id", "type": "uuid"}]',
  min_role
  FROM evidence.snapshot_template WHERE id = 'compliance.licence_calendar' AND version = 1;

------------------------------------------------------------------------------------------------------------
-- 7. L2 — compliance.log_coverage v2: the manager of the row's outlet
------------------------------------------------------------------------------------------------------------
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
SELECT 'compliance.log_coverage', 2,
  $q$WITH days AS (SELECT d::date AS d FROM generate_series(:from::date, :to::date, interval '1 day') d),
ou AS (
  SELECT o.id, o.tz, o.business_day_cutoff FROM core.outlet o
   WHERE (:outlet_id::uuid IS NULL OR o.id = :outlet_id::uuid)
     AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
          OR o.id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[]))),
mg AS (
  -- Each in-scope outlet's manager (header: active member and membership, fewest outlets, then the lowest member id).
  SELECT DISTINCT ON (ou.id) ou.id AS outlet_id, ms.member_id
    FROM ou
    JOIN core.membership ms ON ms.role = 'manager' AND ms.active AND ou.id = ANY (ms.outlet_ids)
    JOIN core.member mb ON mb.tenant_id = ms.tenant_id AND mb.id = ms.member_id AND mb.active
   ORDER BY ou.id, cardinality(ms.outlet_ids), ms.member_id),
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
         (ck.done * 10000 / nullif(ck.expected, 0))::bigint AS coverage_bp, NULL::bigint AS temp_expected, NULL::bigint AS temp_logged,
         (SELECT mg.member_id FROM mg WHERE mg.outlet_id = coalesce(:outlet_id::uuid, c.outlet_id)) AS manager_member_id
    FROM ck JOIN core.checklist c ON c.id = ck.checklist_id ORDER BY ck.checklist_id) r
UNION ALL
SELECT NULL, NULL, NULL, (tl.logged * 10000 / nullif(tl.expected, 0))::bigint, tl.expected::bigint, tl.logged::bigint,
       (SELECT mg.member_id FROM mg WHERE mg.outlet_id = :outlet_id::uuid)
  FROM tl$q$,
  params_schema,
  columns || '[{"name": "manager_member_id", "type": "uuid"}]',
  min_role
  FROM evidence.snapshot_template WHERE id = 'compliance.log_coverage' AND version = 1;

------------------------------------------------------------------------------------------------------------
-- 8. P1 — people.overtime_drift v2: a Σ row per staff member over the window, first
------------------------------------------------------------------------------------------------------------
-- The rate is 0021's (core-api people overtimeRows): hourly wage, or the monthly salary over contracted minutes × 60.
DO $$
DECLARE
  rate constant text := $r$CASE WHEN s.pay_basis = 'hourly' THEN s.wage_rate_minor::numeric
                     ELSE s.monthly_salary_minor::numeric * 60 / s.contract_min_per_month END$r$;
BEGIN
  IF position(rate IN (SELECT sql FROM evidence.snapshot_template WHERE id = 'people.overtime_drift' AND version = 1)) = 0 THEN
    RAISE EXCEPTION '0023: people.overtime_drift v1 does not use the 0021 rate this version repeats';
  END IF;
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
  SELECT 'people.overtime_drift', 2,
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
   GROUP BY 1, 2),
w AS (
  -- v1's rows: attended beyond rostered per staff and ISO week, costed at the overtime multiplier.
  SELECT a.staff_id, a.wk AS iso_week, coalesce(r.m, 0) AS rostered_min, a.m AS attended_min,
         greatest(a.m - coalesce(r.m, 0), 0) AS extra_min,
         round(greatest(a.m - coalesce(r.m, 0), 0) * $q$ || rate || $q$ * s.ot_multiplier_bp / 600000)::bigint AS extra_cost_minor
    FROM a LEFT JOIN r ON r.staff_id = a.staff_id AND r.wk = a.wk
    JOIN core.staff s ON s.id = a.staff_id)
SELECT staff_id, iso_week, rostered_min, attended_min, extra_min, extra_cost_minor
  FROM (-- The Σ row of each staff member (iso_week NULL): their week rows summed.
        SELECT 0 AS k, w.staff_id, NULL::text AS iso_week, sum(w.rostered_min)::bigint AS rostered_min, sum(w.attended_min)::bigint AS attended_min,
               sum(w.extra_min)::bigint AS extra_min, sum(w.extra_cost_minor)::bigint AS extra_cost_minor
          FROM w GROUP BY w.staff_id
        UNION ALL
        SELECT 1, w.staff_id, w.iso_week, w.rostered_min, w.attended_min, w.extra_min, w.extra_cost_minor FROM w) z
 ORDER BY z.k, z.iso_week, z.staff_id$q$,
    params_schema, columns, min_role
    FROM evidence.snapshot_template WHERE id = 'people.overtime_drift' AND version = 1;
END $$;

------------------------------------------------------------------------------------------------------------
-- 9. K1 — kitchen.ticket_times v2: a row per station and item over the window (slot_start NULL), first
------------------------------------------------------------------------------------------------------------
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
SELECT 'kitchen.ticket_times', 2,
  $q$WITH t AS (
  -- v1: a ticket's time is ready_at − accepted_at; its slot the 30-minute slot of accepted_at, outlet-local; its day its order's.
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
   ORDER BY k.id, ol.item_id),
g AS (
  -- Station and item over the whole window (slot NULL), then per slot.
  SELECT 0 AS k, t.station, t.item_id, NULL::text AS slot_start, count(*)::bigint AS tickets,
         percentile_disc(0.5) WITHIN GROUP (ORDER BY t.sec)::bigint AS p50_sec,
         percentile_disc(0.8) WITHIN GROUP (ORDER BY t.sec)::bigint AS p80_sec,
         count(*) FILTER (WHERE t.late)::bigint AS late_tickets
    FROM t GROUP BY t.station, t.item_id
  UNION ALL
  SELECT 1, t.station, t.item_id, t.slot, count(*)::bigint,
         percentile_disc(0.5) WITHIN GROUP (ORDER BY t.sec)::bigint,
         percentile_disc(0.8) WITHIN GROUP (ORDER BY t.sec)::bigint,
         count(*) FILTER (WHERE t.late)::bigint
    FROM t GROUP BY t.station, t.item_id, t.slot)
SELECT g.station, g.item_id, g.slot_start, g.tickets, g.p50_sec, g.p80_sec, g.late_tickets,
       -- The prep time configured for the item at the station on :to (the largest across the outlets in scope).
       (SELECT max(p.prep_sec) FROM core.prep_time p
         WHERE p.item_id = g.item_id AND p.station = g.station AND p.outlet_id IN (SELECT DISTINCT x.outlet_id FROM t x)
           AND p.valid_from <= :to::date AND (p.valid_to IS NULL OR p.valid_to > :to::date))::bigint AS configured_prep_sec
  FROM g
 ORDER BY g.k, g.station, g.item_id, g.slot_start$q$,
  params_schema, columns, min_role
  FROM evidence.snapshot_template WHERE id = 'kitchen.ticket_times' AND version = 1;

------------------------------------------------------------------------------------------------------------
-- 10. D1 — findings.dismiss.v1: writes no book table (intel.finding.status only)
------------------------------------------------------------------------------------------------------------
INSERT INTO core.command_authority (command_type, allowed_roles, scope, target_tables)
VALUES ('findings.dismiss.v1', ARRAY['owner', 'manager', 'judge'], 'outlet', '{}');

------------------------------------------------------------------------------------------------------------
-- 11. Post-conditions (positive: each reads back as written)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  -- Exactly these nine got a version 2 here, each its latest; columns = v1's names and types + the appended ones; v1's
  -- min_role; params = v1's (gst_check: + a nullable outlet_id, required as every named param is).
  SELECT string_agg(coalesce(v.id, '?') || ' ' || coalesce(t2.id, '?'), ', ') INTO bad
    FROM (VALUES ('finance.settlement_vs_orders', '[{"name": "settlement_id", "type": "uuid"}, {"name": "channel_id", "type": "uuid"}]'::jsonb, 'advisor'),
                 ('finance.missing_payouts', '[{"name": "channel_id", "type": "uuid"}]', 'advisor'),
                 ('finance.tender_vs_bank', '[{"name": "week_start", "type": "date"}, {"name": "gap_days", "type": "integer"}]', 'advisor'),
                 ('finance.gst_check', '[]', 'advisor'),
                 ('customers.coupon_current', '[{"name": "code", "type": "text"}, {"name": "kind", "type": "text"}, {"name": "valid_from", "type": "timestamptz"}, {"name": "valid_to", "type": "timestamptz"}, {"name": "outlet_ids", "type": "text"}, {"name": "active", "type": "boolean"}, {"name": "requires_customer", "type": "boolean"}]', 'manager'),
                 ('compliance.licence_calendar', '[{"name": "status", "type": "text"}, {"name": "manager_member_id", "type": "uuid"}]', 'manager'),
                 ('compliance.log_coverage', '[{"name": "manager_member_id", "type": "uuid"}]', 'manager'),
                 ('people.overtime_drift', '[]', 'manager'),
                 ('kitchen.ticket_times', '[]', 'manager')) v(id, extra, min_role)
    FULL JOIN (SELECT * FROM evidence.snapshot_template WHERE version = 2
                 AND id IN ('finance.settlement_vs_orders', 'finance.missing_payouts', 'finance.tender_vs_bank', 'finance.gst_check',
                            'customers.coupon_current', 'compliance.licence_calendar', 'compliance.log_coverage', 'people.overtime_drift',
                            'kitchen.ticket_times')) t2 ON t2.id = v.id
    LEFT JOIN evidence.snapshot_template t1 ON t1.id = v.id AND t1.version = 1
   WHERE t2.id IS NULL OR v.id IS NULL OR t1.id IS NULL
      OR (SELECT max(x.version) FROM evidence.snapshot_template x WHERE x.id = v.id) <> 2
      OR (SELECT jsonb_agg(jsonb_build_object('name', c ->> 'name', 'type', c ->> 'type') ORDER BY k) FROM jsonb_array_elements(t2.columns) WITH ORDINALITY e(c, k))
         IS DISTINCT FROM (SELECT jsonb_agg(jsonb_build_object('name', c ->> 'name', 'type', c ->> 'type') ORDER BY k) FROM jsonb_array_elements(t1.columns) WITH ORDINALITY e(c, k)) || v.extra
      OR t2.min_role IS DISTINCT FROM t1.min_role OR t2.min_role IS DISTINCT FROM v.min_role
      OR t2.params_schema IS DISTINCT FROM CASE WHEN v.id = 'finance.gst_check'
           THEN jsonb_set(jsonb_set(t1.params_schema, '{required}', (t1.params_schema -> 'required') || '["outlet_id"]'),
                          '{properties,outlet_id}', '{"type": ["string", "null"], "format": "uuid"}')
           ELSE t1.params_schema END;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0023: version-2 templates not as written: %', bad; END IF;

  -- Σ rows first: each v2 orders its Σ / whole-window rows (k = 0) before the detail rows, so the 500-row cap cannot cut them.
  SELECT string_agg(id, ', ') INTO bad FROM evidence.snapshot_template
   WHERE version = 2 AND id IN ('finance.settlement_vs_orders', 'finance.missing_payouts', 'finance.tender_vs_bank', 'people.overtime_drift',
                                'kitchen.ticket_times')
     AND (position('SELECT 0 AS k' IN sql) = 0 OR sql !~ 'ORDER BY [a-z]+\.k, ');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0023: Σ rows not ordered first: %', bad; END IF;

  -- The pack thresholds the finance versions read are named exactly once each, by the path the packs carry.
  IF position('{detectors,finance.short_payout,thresholds,line_short_minor_gte}' IN (SELECT sql FROM evidence.snapshot_template WHERE id = 'finance.settlement_vs_orders' AND version = 2)) = 0
     OR position('{detectors,finance.short_payout,thresholds,line_short_bp_gte}' IN (SELECT sql FROM evidence.snapshot_template WHERE id = 'finance.settlement_vs_orders' AND version = 2)) = 0
     OR position('{detectors,finance.tender_gap,thresholds,gap_minor_gte}' IN (SELECT sql FROM evidence.snapshot_template WHERE id = 'finance.tender_vs_bank' AND version = 2)) = 0 THEN
    RAISE EXCEPTION '0023: the finance versions do not read the pack thresholds';
  END IF;

  -- No new version reads the wall clock (none needs as_of: each has a date window or a date param already).
  SELECT string_agg(id, ', ') INTO bad FROM evidence.snapshot_template
   WHERE version = 2 AND id IN ('finance.settlement_vs_orders', 'finance.missing_payouts', 'finance.tender_vs_bank', 'finance.gst_check',
                                'customers.coupon_current', 'compliance.licence_calendar', 'compliance.log_coverage', 'people.overtime_drift',
                                'kitchen.ticket_times')
     AND sql ~* '(now\(|current_date|current_timestamp|localtimestamp|clock_timestamp|transaction_timestamp|statement_timestamp)';
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0023: a new version reads the wall clock: %', bad; END IF;

  -- D1: the row exactly as the operational-only commands carry theirs (no book table, no customer table, own commands
  -- allowed, no cap, no outlet column); munim_core can set a finding's status and nothing else of it.
  IF NOT EXISTS (SELECT 1 FROM core.command_authority
                  WHERE command_type = 'findings.dismiss.v1' AND allowed_roles = ARRAY['owner', 'manager', 'judge'] AND scope = 'outlet'
                    AND target_tables = '{}' AND customer_target_tables = '{}' AND NOT draft_only AND role_caps = '{}'
                    AND outlet_column IS NULL AND max_amount_minor IS NULL)
     OR NOT has_column_privilege('munim_core', 'intel.finding', 'status', 'UPDATE')
     OR has_column_privilege('munim_core', 'intel.finding', 'severity', 'UPDATE')
     OR has_table_privilege('munim_core', 'intel.finding', 'INSERT, DELETE') THEN
    RAISE EXCEPTION '0023: findings.dismiss.v1 is not the operational-only command written here';
  END IF;

  PERFORM munim_meta.assert_catalog('0023');
END $$;
