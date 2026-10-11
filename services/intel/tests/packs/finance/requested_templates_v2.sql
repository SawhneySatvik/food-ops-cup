-- T-047 (b-44) REQUEST TO THE MIGRATOR, not a migration. Three finance template versions the finance detectors read
-- (packs/finance.md §4, §5, §6). tests/packs/finance installs them into its throwaway embedded Postgres, as the cluster
-- superuser, only while the database has no version 2 of the same id; once the migrator lands its own v2 the tests read
-- that one instead. Params are unchanged from version 1 (the generated read tools keep their schemas); only the rows grow.
-- Why each is needed (the detector interface fires on ONE row, and a dispute needs a channel id from that row):
--   finance.settlement_vs_orders v2  one Σ row per settlement (settlement_id, channel_id), first — §4 threshold and dedupe
--                                    are per settlement, and the §6 dispute names its channel.
--   finance.missing_payouts v2       one Σ row per channel (channel_id), first, whose days_unsettled is the OLDEST order's
--                                    age — §4 "days_unsettled > 10" becomes a test on the Σ row.
--   finance.tender_vs_bank v2        one Σ row per ISO week of the window (week_start, gap_days), first: the week's gap days
--                                    (gap ≥ the pack's detectors.finance.tender_gap gap_minor_gte, on days the bank statement
--                                    reaches) — §4 "≥ ₹500 on ≥ 3 of 7 days" and its critical clause become tests on it.
-- Σ rows come FIRST: runTemplate caps a snapshot at 500 rows, and v1's Σ row is last, so a busy month would lose it.

INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'finance.settlement_vs_orders', 2,
  $q$WITH op AS (
  -- Aggregator channels whose operator collects the order's tax (pack aggregators, tax_treatment operator_collects_excluded).
  SELECT 'aggregator:' || (a ->> 'code') AS kind
    FROM core.tenant t
    JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
    CROSS JOIN LATERAL jsonb_array_elements(cp.doc -> 'aggregators') a
   WHERE a ->> 'tax_treatment' = 'operator_collects_excluded'
     AND cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')),
l AS (
  -- As version 1: expected net = gross − contracted commission − tax withheld − refunds we recorded; short = expected − paid.
  SELECT st.id AS settlement_id, st.channel_id, sl.id AS settlement_line_id, sl.matched_order_id, o.total_minor AS order_total,
         sl.commission_minor, sl.net_minor,
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
SELECT settlement_id, channel_id, settlement_line_id, matched_order_id, order_total_minor, commission_minor, net_minor,
       expected_commission_minor, refund_minor, expected_net_minor, short_minor
  FROM (-- One Σ row per settlement (settlement_line_id null), every amount summed.
        SELECT 0 AS k, max(l.period_to) AS period_to, l.settlement_id, l.channel_id, NULL::uuid AS settlement_line_id,
               NULL::uuid AS matched_order_id, coalesce(sum(l.order_total), 0)::bigint AS order_total_minor,
               sum(l.commission_minor)::bigint AS commission_minor, sum(l.net_minor)::bigint AS net_minor,
               coalesce(sum(l.expected_commission), 0)::bigint AS expected_commission_minor, sum(l.refund)::bigint AS refund_minor,
               coalesce(sum(l.expected_net), 0)::bigint AS expected_net_minor, coalesce(sum(l.expected_net - l.net_minor), 0)::bigint AS short_minor
          FROM l GROUP BY l.settlement_id, l.channel_id
        UNION ALL
        SELECT 1, l.period_to, l.settlement_id, l.channel_id, l.settlement_line_id, l.matched_order_id, l.order_total::bigint,
               l.commission_minor::bigint, l.net_minor::bigint, l.expected_commission::bigint, l.refund::bigint,
               l.expected_net::bigint, (l.expected_net - l.net_minor)::bigint
          FROM l) z
 ORDER BY z.k, z.period_to, z.settlement_id, z.settlement_line_id$q$,
  '{"type": "object", "required": ["channel_id", "from", "to", "outlet_id"], "additionalProperties": false,
    "properties": {"channel_id": {"type": ["string", "null"], "format": "uuid"}, "from": {"type": "string", "format": "date"},
                   "to": {"type": "string", "format": "date"}, "outlet_id": {"type": ["string", "null"], "format": "uuid"}}}',
  '[{"name": "settlement_id", "type": "uuid"},
    {"name": "channel_id", "type": "uuid"},
    {"name": "settlement_line_id", "type": "uuid"},
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
  'finance.missing_payouts', 2,
  $q$WITH op AS (
  SELECT 'aggregator:' || (a ->> 'code') AS kind
    FROM core.tenant t
    JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
    CROSS JOIN LATERAL jsonb_array_elements(cp.doc -> 'aggregators') a
   WHERE a ->> 'tax_treatment' = 'operator_collects_excluded'
     AND cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')),
done AS (
  -- As version 1: completed aggregator orders and the business day they completed on.
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
  SELECT d.id, d.channel_id, d.total_minor, (:as_of::date - d.completed_on) AS days_unsettled,
         d.total_minor - round(d.total_minor * coalesce(ct.commission_bp, 0) / 10000.0)
           - CASE WHEN d.kind IN (SELECT kind FROM op) THEN d.tax_minor ELSE 0 END AS expected_net
    FROM done d
    LEFT JOIN core.channel_terms ct ON ct.channel_id = d.channel_id
     AND d.completed_on >= ct.valid_from AND (ct.valid_to IS NULL OR d.completed_on < ct.valid_to)
   WHERE NOT EXISTS (SELECT 1 FROM core.settlement_line sl JOIN core.settlement st ON st.tenant_id = sl.tenant_id AND st.id = sl.settlement_id
                      WHERE st.channel_id = d.channel_id
                        AND (sl.matched_order_id = d.id OR (d.external_ref IS NOT NULL AND sl.external_order_ref = d.external_ref))))
SELECT channel_id, order_id, order_total_minor, expected_net_minor, days_unsettled
  FROM (-- One Σ row per channel (order_id null); its days_unsettled is the oldest order's.
        SELECT 0 AS k, m.channel_id, NULL::uuid AS order_id, sum(m.total_minor)::bigint AS order_total_minor,
               sum(m.expected_net)::bigint AS expected_net_minor, max(m.days_unsettled)::bigint AS days_unsettled
          FROM m GROUP BY m.channel_id
        UNION ALL
        SELECT 1, m.channel_id, m.id, m.total_minor::bigint, m.expected_net::bigint, m.days_unsettled::bigint FROM m) z
 ORDER BY z.k, z.channel_id, z.days_unsettled DESC, z.order_id$q$,
  '{"type": "object", "required": ["channel_id", "as_of", "outlet_id"], "additionalProperties": false,
    "properties": {"channel_id": {"type": ["string", "null"], "format": "uuid"}, "as_of": {"type": "string", "format": "date"},
                   "outlet_id": {"type": ["string", "null"], "format": "uuid"}}}',
  '[{"name": "channel_id", "type": "uuid"},
    {"name": "order_id", "type": "uuid"},
    {"name": "order_total_minor", "type": "integer", "numeric_source": "core.order.total_minor"},
    {"name": "expected_net_minor", "type": "integer", "numeric_source": ["core.order.total_minor", "core.channel_terms.commission_bp", "core.order.tax_minor"]},
    {"name": "days_unsettled", "type": "integer", "numeric_source": ["core.order_event.at", "core.order.business_date"]}]',
  'advisor');

INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'finance.tender_vs_bank', 2,
  $q$WITH ou AS (
  -- As version 1: outlets in the minter's scope (core.outlet itself is tenant-visible), narrowed by :outlet_id.
  SELECT o.id, o.tz, o.business_day_cutoff, o.upi_vpa FROM core.outlet o
   WHERE (:outlet_id::uuid IS NULL OR o.id = :outlet_id::uuid)
     AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
          OR o.id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[]))),
t AS (
  SELECT ((t.at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date AS d, t.amount_minor, t.shift_id
    FROM core.tender t JOIN ou ON ou.id = t.outlet_id
   WHERE t.method = :method::text),
tb AS (SELECT d, sum(amount_minor) AS tendered FROM t WHERE d BETWEEN :from::date AND :to::date GROUP BY d),
bl AS (
  -- The method's bank credits for the outlets: their own lines, or tenant-wide lines paid to an outlet's UPI VPA.
  SELECT b.value_date, b.amount_minor FROM core.bank_line b
   WHERE b.amount_minor > 0 AND b.method = :method::text AND b.value_date <= :to::date
     AND (b.outlet_id IN (SELECT id FROM ou) OR (b.outlet_id IS NULL AND b.payee_vpa IN (SELECT upi_vpa FROM ou)))),
bk AS (SELECT value_date AS d, sum(amount_minor) AS credited FROM bl WHERE value_date >= :from::date GROUP BY value_date),
v AS (
  SELECT ((x.at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date AS d, count(*) AS voids, sum(x.amount_minor) AS void_minor
    FROM core.void x JOIN ou ON ou.id = x.outlet_id
   GROUP BY 1),
med AS (
  SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY coalesce(v.voids, 0)))::bigint AS m
    FROM tb LEFT JOIN v ON v.d = tb.d),
sm AS (
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
  -- Gap days: the statement reaches the day (a later or same-day credit exists) and the gap is at least the pack's
  -- detectors.finance.tender_gap gap_minor_gte. A day after the statement's last credit is unknown, never a gap.
  SELECT dr.* FROM dr
   WHERE dr.business_on <= (SELECT max(value_date) FROM bl)
     AND dr.gap_minor >= (SELECT (cp.doc #>> '{detectors,finance.tender_gap,thresholds,gap_minor_gte}')::bigint
                            FROM core.tenant tn JOIN platform.country_pack cp ON cp.code = tn.country_code AND cp.status = 'active'
                           WHERE cp.version = (SELECT max(x.version) FROM platform.country_pack x WHERE x.code = tn.country_code AND x.status = 'active')))
SELECT business_on, week_start, tendered_minor, credited_minor, gap_minor, voids, void_minor, outlet_median_voids, shift_member_id, gap_days
  FROM (-- One Σ row per ISO week with a gap day (business_on null): Σ over its gap days; the shift member only when every
        -- gap day's member is the same one.
        SELECT 0 AS k, NULL::date AS business_on, date_trunc('week', gd.business_on)::date AS week_start,
               sum(gd.tendered_minor)::bigint AS tendered_minor, sum(gd.credited_minor)::bigint AS credited_minor,
               sum(gd.gap_minor)::bigint AS gap_minor, sum(gd.voids)::bigint AS voids, sum(gd.void_minor)::bigint AS void_minor,
               max(gd.outlet_median_voids) AS outlet_median_voids,
               CASE WHEN count(gd.shift_member_id) = count(*) AND count(DISTINCT gd.shift_member_id) = 1
                    THEN min(gd.shift_member_id::text)::uuid END AS shift_member_id,
               count(*)::bigint AS gap_days
          FROM gd GROUP BY 3
        UNION ALL
        SELECT 1, dr.business_on, NULL::date, dr.tendered_minor, dr.credited_minor, dr.gap_minor, dr.voids, dr.void_minor,
               dr.outlet_median_voids, dr.shift_member_id, NULL::bigint
          FROM dr) z
 ORDER BY z.k, z.week_start, z.business_on$q$,
  '{"type": "object", "required": ["outlet_id", "method", "from", "to"], "additionalProperties": false,
    "properties": {"outlet_id": {"type": ["string", "null"], "format": "uuid"}, "method": {"type": "string", "enum": ["cash", "card", "upi"]},
                   "from": {"type": "string", "format": "date"}, "to": {"type": "string", "format": "date"}}}',
  '[{"name": "business_on", "type": "date"},
    {"name": "week_start", "type": "date"},
    {"name": "tendered_minor", "type": "integer", "numeric_source": "core.tender.amount_minor"},
    {"name": "credited_minor", "type": "integer", "numeric_source": "core.bank_line.amount_minor"},
    {"name": "gap_minor", "type": "integer", "numeric_source": ["core.tender.amount_minor", "core.bank_line.amount_minor"]},
    {"name": "voids", "type": "integer", "numeric_source": "count:core.void"},
    {"name": "void_minor", "type": "integer", "numeric_source": "core.void.amount_minor"},
    {"name": "outlet_median_voids", "type": "integer", "numeric_source": "count:core.void"},
    {"name": "shift_member_id", "type": "uuid"},
    {"name": "gap_days", "type": "integer", "numeric_source": ["core.tender.amount_minor", "core.bank_line.amount_minor"]}]',
  'advisor')
