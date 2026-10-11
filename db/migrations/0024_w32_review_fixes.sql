-- 0024_w32_review_fixes — W3.2 review fixes (migrator lane m-1), fix forward over 0001–0023. Runs as munim_migrator.
-- Additive only: one unique index, two CHECKs (one new, one widened), one CHECK widened on intel.chunk, two nullable
-- columns + an FK + an index + a trigger on intel.supplier_quote, one template version. No grant changes; no data rewritten.
-- Items:
--   S1  core.stock_count UNIQUE (tenant_id, outlet_id, counted_at) — R-A F2: two concurrent approvals of the same count
--       (select-then-insert) could both insert. The second now fails 23505. The migration refuses to apply while a
--       duplicate exists (it counts them; it never rewrites a count). No shift EXCLUDE: core serialises shift overlap with
--       a per-tenant+outlet advisory lock (R-A F2, orchestrator). counted_at defaults to now() (the transaction's start),
--       so two counts at one outlet in ONE transaction now collide: give each its own counted_at.
--   S2  core.supplier CHECK supplier_a2a_simulated_only (a2a_card_url IS NULL OR kind = 'simulated') — R-C F4: an RFQ
--       could be sent to a real supplier, because a2a_card_url was allowed on kind 'real' (member-updatable). kind has no
--       UPDATE grant, so the pairing holds for the row's life. Refuses to apply while a real supplier carries a card URL.
--   Q1  Quote provenance — R-C F3 ruling: the supplier's reply is kept as untrusted text, and each extracted field points
--       at the span it was read from.
--       (a) intel.chunk's source CHECK is WIDENED (0012: exactly one of document_id / message_id) to also admit a run-held
--           chunk: no document, no message, run_id set — the text a run received that is neither (a simulated supplier's
--           reply; R22: not books). Every existing row still passes; nothing else about chunks changes (tenant-only RLS,
--           munim_svc INSERT, intel_ro.chunk_search lists it like any chunk — untrusted text, tainting as search results do).
--       (b) intel.supplier_quote + source_chunk_id uuid NULL (FK → intel.chunk) + spans jsonb NULL, both or neither
--           (CHECK supplier_quote_spans_with_chunk). Grants unchanged: munim_svc's table-wide INSERT covers both columns
--           (core's /internal/intel/v1 quotes:batch path); munim_core / munim_svc SELECT.
--       (c) Trigger intel.supplier_quote_spans_match (BEFORE INSERT OR UPDATE; MB012, as intel.claim_quote_matches): the
--           chunk must be visible and belong to the quote's own run; spans is an object whose keys are numeric quote fields
--           (unit_price_minor, qty_milli, min_order_qty_milli, payment_days); each value [start, end] — integers, 0-based,
--           end-exclusive CHARACTER (code point) offsets, 0 ≤ start < end ≤ length(text); every numeric field that is SET
--           (≠ 0: all four are NOT NULL, and intel's ground() emits no span for a zero) has a span — qty_milli is always > 0,
--           so a sourced quote always spans its quantity. The span's text is NOT re-parsed here (one tokenizer, intel's;
--           R-C F2 shows how a second one drifts). Error text carries ids and the four fixed field names only — never a
--           spans key before it is validated (it is intel-supplied). MB012 maps to 422 claim_quote_mismatch in core-api.
--   R1  intel.run trigger CHECK widened with 'ingest' (an ingestion run can be minted; R-C / i-2). 'auto_step' (0020) stays.
--       actor is unchanged: an ingest run's actor is the uploading member's id (or 'watcher:<pack>' for a worker-started
--       ingestion) — both already pass the 0003 actor CHECK.
--   F5  finance.settlement_vs_orders v3 — R-A F5: aligned with core-api reconcileSettlement (modules/finance/settle.ts):
--       (1) the order is INNER-joined: an unmatched line (matched_order_id NULL, or an order the minter cannot see) has no
--           detail row and never counts toward a Σ row (core never opens a short_payout break for it). v2 fell back to the
--           statement's gross, so an unmatched line short by ≥ the threshold counted.
--       (2) a missing pack threshold takes core's default: line_short_minor_gte ?? 1, line_short_bp_gte ?? 0 (v2: a NULL
--           threshold made every line not count). A tenant with no active pack row reads both defaults.
--       The Σ rows are v2's set exactly: one per settlement in the window with ≥ 1 order line, matched or not, FIRST; a
--       settlement whose order lines are all unmatched keeps its Σ row, all zeros (0023's promise). Columns, params and
--       min_role are v2's, copied (INSERT … SELECT). Unchanged from v2: no channel terms for the period → no line counts
--       (core: no break); the operator-collects tax rule (pack aggregators, = core-domain channelTreatment).
-- New SQLSTATEs: none (MB012 reused, see Q1).

------------------------------------------------------------------------------------------------------------
-- 0. Pre-checks: no row violates what this file adds, and each object it widens is the shape it widens.
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM (SELECT 1 FROM core.stock_count GROUP BY tenant_id, outlet_id, counted_at HAVING count(*) > 1) d;
  IF n > 0 THEN
    RAISE EXCEPTION '0024: % (tenant, outlet, counted_at) groups of core.stock_count hold more than one count — resolve them first (no rewrite here)', n;
  END IF;
  SELECT count(*) INTO n FROM core.supplier WHERE a2a_card_url IS NOT NULL AND kind <> 'simulated';
  IF n > 0 THEN
    RAISE EXCEPTION '0024: % non-simulated suppliers carry an a2a_card_url — clear it first (R-C F4; no rewrite here)', n;
  END IF;
  IF (SELECT count(*) FROM pg_constraint c WHERE c.conrelid = 'intel.chunk'::regclass AND c.conname = 'chunk_check'
         AND pg_get_constraintdef(c.oid) = 'CHECK ((num_nonnulls(document_id, message_id) = 1))') <> 1 THEN
    RAISE EXCEPTION '0024: intel.chunk chunk_check is not the 0012 CHECK 0024 widens';
  END IF;
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'intel.run'::regclass AND c.conname = 'run_trigger_check')
     IS DISTINCT FROM $d$CHECK ((trigger = ANY (ARRAY['event'::text, 'watch_sweep'::text, 'ask'::text, 'brief'::text, 'auto_step'::text])))$d$ THEN
    RAISE EXCEPTION '0024: intel.run run_trigger_check is not the 0020 CHECK 0024 widens';
  END IF;
  IF (SELECT array_agg(version ORDER BY version) FROM evidence.snapshot_template WHERE id = 'finance.settlement_vs_orders')
     IS DISTINCT FROM ARRAY[1, 2] THEN
    RAISE EXCEPTION '0024: finance.settlement_vs_orders is not exactly versions 1 and 2';
  END IF;
  IF to_regclass('core.stock_count_outlet_counted_at_key') IS NOT NULL OR to_regclass('intel.supplier_quote_source_chunk_id_fk_idx') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'intel.supplier_quote'::regclass AND attname IN ('source_chunk_id', 'spans') AND NOT attisdropped) THEN
    RAISE EXCEPTION '0024: an object this file creates already exists';
  END IF;
END $$;

------------------------------------------------------------------------------------------------------------
-- 1. S1 — one count per outlet per instant
------------------------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX stock_count_outlet_counted_at_key ON core.stock_count (tenant_id, outlet_id, counted_at);

------------------------------------------------------------------------------------------------------------
-- 2. S2 — only a simulated supplier has an A2A endpoint
------------------------------------------------------------------------------------------------------------
ALTER TABLE core.supplier ADD CONSTRAINT supplier_a2a_simulated_only CHECK (a2a_card_url IS NULL OR kind = 'simulated');

------------------------------------------------------------------------------------------------------------
-- 3. Q1 — a quote's fields point into the supplier's reply
------------------------------------------------------------------------------------------------------------
ALTER TABLE intel.chunk DROP CONSTRAINT chunk_check;
ALTER TABLE intel.chunk ADD CONSTRAINT chunk_source_check
  CHECK (num_nonnulls(document_id, message_id) = 1 OR (document_id IS NULL AND message_id IS NULL AND run_id IS NOT NULL));

ALTER TABLE intel.supplier_quote ADD COLUMN source_chunk_id uuid;
ALTER TABLE intel.supplier_quote ADD COLUMN spans jsonb;
ALTER TABLE intel.supplier_quote
  ADD CONSTRAINT supplier_quote_source_chunk_fk FOREIGN KEY (tenant_id, source_chunk_id) REFERENCES intel.chunk (tenant_id, id),
  ADD CONSTRAINT supplier_quote_spans_with_chunk CHECK ((source_chunk_id IS NULL) = (spans IS NULL));
CREATE INDEX supplier_quote_source_chunk_id_fk_idx ON intel.supplier_quote (tenant_id, source_chunk_id);

-- MB012: every span lies inside the run's own chunk, and every set numeric field has one. Reads the chunk under the
-- caller's RLS: an invisible chunk (other tenant, no context) refuses.
CREATE FUNCTION intel.supplier_quote_spans_match() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  src text;
  src_run uuid;
  k text;
  v jsonb;
  f text;
BEGIN
  IF NEW.source_chunk_id IS NULL THEN RETURN NEW; END IF;
  SELECT c.text, c.run_id INTO src, src_run FROM intel.chunk c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.source_chunk_id;
  IF src IS NULL OR src_run IS DISTINCT FROM NEW.run_id THEN
    RAISE EXCEPTION 'quote_span_mismatch: supplier quote % source chunk % is not a chunk of its run %', NEW.id, NEW.source_chunk_id, NEW.run_id
      USING ERRCODE = 'MB012';
  END IF;
  IF jsonb_typeof(NEW.spans) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'quote_span_mismatch: supplier quote % spans is not an object', NEW.id USING ERRCODE = 'MB012';
  END IF;
  FOR k, v IN SELECT e.key, e.value FROM jsonb_each(NEW.spans) e LOOP
    IF k NOT IN ('unit_price_minor', 'qty_milli', 'min_order_qty_milli', 'payment_days') THEN
      RAISE EXCEPTION 'quote_span_mismatch: supplier quote % spans a field that is not a numeric quote field', NEW.id USING ERRCODE = 'MB012';
    END IF;
    IF jsonb_typeof(v) IS DISTINCT FROM 'array' OR jsonb_array_length(v) <> 2
       OR jsonb_typeof(v -> 0) IS DISTINCT FROM 'number' OR jsonb_typeof(v -> 1) IS DISTINCT FROM 'number'
       OR (v ->> 0) !~ '^[0-9]{1,9}$' OR (v ->> 1) !~ '^[0-9]{1,9}$'
       OR (v ->> 0)::integer >= (v ->> 1)::integer OR (v ->> 1)::integer > length(src) THEN
      RAISE EXCEPTION 'quote_span_mismatch: supplier quote % % span is not inside its source chunk', NEW.id, k USING ERRCODE = 'MB012';
    END IF;
  END LOOP;
  f := CASE WHEN NEW.unit_price_minor <> 0 AND NOT NEW.spans ? 'unit_price_minor' THEN 'unit_price_minor'
            WHEN NEW.qty_milli <> 0 AND NOT NEW.spans ? 'qty_milli' THEN 'qty_milli'
            WHEN NEW.min_order_qty_milli <> 0 AND NOT NEW.spans ? 'min_order_qty_milli' THEN 'min_order_qty_milli'
            WHEN NEW.payment_days <> 0 AND NOT NEW.spans ? 'payment_days' THEN 'payment_days' END;
  IF f IS NOT NULL THEN
    RAISE EXCEPTION 'quote_span_mismatch: supplier quote % % is set but has no span', NEW.id, f USING ERRCODE = 'MB012';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION intel.supplier_quote_spans_match() FROM PUBLIC;
CREATE TRIGGER spans_match BEFORE INSERT OR UPDATE ON intel.supplier_quote FOR EACH ROW EXECUTE FUNCTION intel.supplier_quote_spans_match();

------------------------------------------------------------------------------------------------------------
-- 4. R1 — an ingestion run
------------------------------------------------------------------------------------------------------------
ALTER TABLE intel.run DROP CONSTRAINT run_trigger_check;
ALTER TABLE intel.run ADD CONSTRAINT run_trigger_check CHECK (trigger IN ('event', 'watch_sweep', 'ask', 'brief', 'auto_step', 'ingest'));

------------------------------------------------------------------------------------------------------------
-- 5. F5 — finance.settlement_vs_orders v3: reconcileSettlement's lines and thresholds
------------------------------------------------------------------------------------------------------------
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
SELECT 'finance.settlement_vs_orders', 3,
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
s AS (
  -- The settlements in the window with at least one order line: one Σ row each.
  SELECT st.tenant_id, st.id AS settlement_id, st.channel_id, st.period_to
    FROM core.settlement st
   WHERE st.period_to BETWEEN :from::date AND :to::date
     AND (:channel_id::uuid IS NULL OR st.channel_id = :channel_id::uuid)
     AND (:outlet_id::uuid IS NULL OR st.outlet_id = :outlet_id::uuid)
     AND EXISTS (SELECT 1 FROM core.settlement_line x WHERE x.tenant_id = st.tenant_id AND x.settlement_id = st.id AND x.line_kind = 'order')),
l AS (
  -- Matched order lines only (reconcileSettlement's JOIN): expected net = the order's total − contracted commission on the
  -- gross − tax withheld (the order's own tax where the operator collects it, the statement's figure otherwise, pack §2) −
  -- refunds we recorded on that order; short = expected − paid.
  SELECT s.settlement_id, s.channel_id, s.period_to, sl.id AS settlement_line_id, sl.matched_order_id, o.total_minor AS order_total,
         sl.commission_minor, sl.net_minor,
         round(sl.gross_minor * ct.commission_bp / 10000.0) AS expected_commission,
         rf.refund,
         o.total_minor - round(sl.gross_minor * ct.commission_bp / 10000.0)
           - CASE WHEN ch.kind IN (SELECT kind FROM op) THEN o.tax_minor ELSE sl.tax_withheld_minor END
           - rf.refund AS expected_net
    FROM s
    JOIN core.settlement_line sl ON sl.tenant_id = s.tenant_id AND sl.settlement_id = s.settlement_id AND sl.line_kind = 'order'
    JOIN core."order" o ON o.tenant_id = sl.tenant_id AND o.id = sl.matched_order_id
    JOIN core.channel ch ON ch.tenant_id = s.tenant_id AND ch.id = s.channel_id
    LEFT JOIN core.channel_terms ct ON ct.tenant_id = s.tenant_id AND ct.channel_id = s.channel_id
     AND s.period_to >= ct.valid_from AND (ct.valid_to IS NULL OR s.period_to < ct.valid_to)
    CROSS JOIN LATERAL (SELECT coalesce(sum(r.amount_minor), 0) AS refund FROM core.refund r WHERE r.tenant_id = o.tenant_id AND r.order_id = o.id) rf),
q AS (
  -- core's defaults where the pack names no threshold: line_short_minor_gte ?? 1, line_short_bp_gte ?? 0.
  SELECT l.*, l.expected_net - l.net_minor AS short,
         coalesce(l.expected_net - l.net_minor > 0
                  AND l.expected_net - l.net_minor >= greatest(coalesce(th.line_minor, 1), ceil(l.expected_net * coalesce(th.line_bp, 0) / 10000.0)), false) AS counts
    FROM l LEFT JOIN th ON true)
SELECT settlement_line_id, matched_order_id, order_total_minor, commission_minor, net_minor, expected_commission_minor,
       refund_minor, expected_net_minor, short_minor, settlement_id, channel_id
  FROM (-- The Σ row of each settlement (settlement_line_id NULL): its counting lines summed (zeros when none counts).
        SELECT 0 AS k, s.period_to, s.settlement_id, s.channel_id, NULL::uuid AS settlement_line_id,
               NULL::uuid AS matched_order_id,
               coalesce(sum(q.order_total) FILTER (WHERE q.counts), 0)::bigint AS order_total_minor,
               coalesce(sum(q.commission_minor) FILTER (WHERE q.counts), 0)::bigint AS commission_minor,
               coalesce(sum(q.net_minor) FILTER (WHERE q.counts), 0)::bigint AS net_minor,
               coalesce(sum(q.expected_commission) FILTER (WHERE q.counts), 0)::bigint AS expected_commission_minor,
               coalesce(sum(q.refund) FILTER (WHERE q.counts), 0)::bigint AS refund_minor,
               coalesce(sum(q.expected_net) FILTER (WHERE q.counts), 0)::bigint AS expected_net_minor,
               coalesce(sum(q.short) FILTER (WHERE q.counts), 0)::bigint AS short_minor
          FROM s LEFT JOIN q ON q.settlement_id = s.settlement_id
         GROUP BY s.settlement_id, s.channel_id, s.period_to
        UNION ALL
        SELECT 1, q.period_to, q.settlement_id, q.channel_id, q.settlement_line_id, q.matched_order_id, q.order_total::bigint,
               q.commission_minor::bigint, q.net_minor::bigint, q.expected_commission::bigint, q.refund::bigint,
               q.expected_net::bigint, q.short::bigint
          FROM q) z
 ORDER BY z.k, z.period_to, z.settlement_id, z.settlement_line_id$q$,
  params_schema, columns, min_role
  FROM evidence.snapshot_template WHERE id = 'finance.settlement_vs_orders' AND version = 2;

------------------------------------------------------------------------------------------------------------
-- 6. Post-conditions (read back what was written; IF NOT EXISTS is never trusted — gotcha 1)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  -- Indexes: name, uniqueness, exact column order, no predicate, valid.
  SELECT string_agg(v.name, ', ') INTO bad
    FROM (VALUES ('core.stock_count', 'stock_count_outlet_counted_at_key', 'tenant_id,outlet_id,counted_at', true),
                 ('intel.supplier_quote', 'supplier_quote_source_chunk_id_fk_idx', 'tenant_id,source_chunk_id', false)) v(tbl, name, cols, uniq)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = v.tbl::regclass AND ic.relname = v.name AND i.indisunique = v.uniq AND i.indisvalid AND i.indpred IS NULL
        AND i.indexprs IS NULL
        AND (SELECT string_agg(a.attname, ',' ORDER BY k.n) FROM unnest(i.indkey) WITH ORDINALITY k(attnum, n)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) = v.cols);
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0024: indexes not as written: %', bad; END IF;

  -- CHECKs and the FK, as written.
  SELECT string_agg(v.tbl || '.' || v.name, ', ') INTO bad
    FROM (VALUES ('core.supplier', 'supplier_a2a_simulated_only', $d$CHECK (((a2a_card_url IS NULL) OR (kind = 'simulated'::text)))$d$),
                 ('intel.chunk', 'chunk_source_check',
                  $d$CHECK (((num_nonnulls(document_id, message_id) = 1) OR ((document_id IS NULL) AND (message_id IS NULL) AND (run_id IS NOT NULL))))$d$),
                 ('intel.supplier_quote', 'supplier_quote_spans_with_chunk', $d$CHECK (((source_chunk_id IS NULL) = (spans IS NULL)))$d$),
                 ('intel.supplier_quote', 'supplier_quote_source_chunk_fk',
                  $d$FOREIGN KEY (tenant_id, source_chunk_id) REFERENCES intel.chunk(tenant_id, id)$d$),
                 ('intel.run', 'run_trigger_check',
                  $d$CHECK ((trigger = ANY (ARRAY['event'::text, 'watch_sweep'::text, 'ask'::text, 'brief'::text, 'auto_step'::text, 'ingest'::text])))$d$),
                 ('intel.run', 'run_grant_iff_auto_step', $d$CHECK (((trigger = 'auto_step'::text) = (grant_id IS NOT NULL)))$d$)) v(tbl, name, def)
   WHERE (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = v.tbl::regclass AND c.conname = v.name) IS DISTINCT FROM v.def;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0024: constraints not as written: %', bad; END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'intel.chunk'::regclass AND conname = 'chunk_check') THEN
    RAISE EXCEPTION '0024: the narrow intel.chunk CHECK is still there';
  END IF;

  -- The new columns: nullable, typed as written; grants unchanged (munim_svc inserts them, munim_core and intel do not).
  IF (SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' || attnotnull, ',' ORDER BY attname)
        FROM pg_attribute WHERE attrelid = 'intel.supplier_quote'::regclass AND attname IN ('source_chunk_id', 'spans') AND NOT attisdropped)
     IS DISTINCT FROM 'source_chunk_id:uuid:false,spans:jsonb:false'
     OR NOT has_column_privilege('munim_svc', 'intel.supplier_quote', 'source_chunk_id', 'INSERT')
     OR NOT has_column_privilege('munim_svc', 'intel.supplier_quote', 'spans', 'INSERT')
     OR has_table_privilege('munim_svc', 'intel.supplier_quote', 'UPDATE, DELETE')
     OR has_table_privilege('munim_core', 'intel.supplier_quote', 'INSERT, UPDATE, DELETE')
     OR has_table_privilege('munim_intel_ro', 'intel.supplier_quote', 'INSERT, UPDATE, DELETE')
     OR NOT has_column_privilege('munim_core', 'intel.supplier_quote', 'spans', 'SELECT') THEN
    RAISE EXCEPTION '0024: intel.supplier_quote columns or grants not as written';
  END IF;

  -- The trigger: enabled, BEFORE INSERT OR UPDATE, row-level, on the function written here; the function not PUBLIC.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'intel.supplier_quote'::regclass AND t.tgname = 'spans_match' AND NOT t.tgisinternal
                    AND t.tgenabled = 'O' AND t.tgfoid = 'intel.supplier_quote_spans_match()'::regprocedure AND t.tgtype = (1 | 2 | 4 | 16))
     OR has_function_privilege('public', 'intel.supplier_quote_spans_match()', 'EXECUTE') THEN
    RAISE EXCEPTION '0024: trigger intel.supplier_quote spans_match not as written';
  END IF;

  -- v3: the latest; v2's columns, params and role exactly; the inner join, core's defaults, Σ first; no wall clock.
  SELECT string_agg(x, ', ') INTO bad FROM (
    SELECT 'latest' AS x WHERE (SELECT max(version) FROM evidence.snapshot_template WHERE id = 'finance.settlement_vs_orders') <> 3
    UNION ALL
    SELECT 'shape' FROM evidence.snapshot_template t3 JOIN evidence.snapshot_template t2 ON t2.id = t3.id AND t2.version = 2
     WHERE t3.id = 'finance.settlement_vs_orders' AND t3.version = 3
       AND (t3.columns IS DISTINCT FROM t2.columns OR t3.params_schema IS DISTINCT FROM t2.params_schema OR t3.min_role IS DISTINCT FROM t2.min_role)
    UNION ALL
    SELECT 'sql' FROM evidence.snapshot_template t WHERE t.id = 'finance.settlement_vs_orders' AND t.version = 3
       AND (position('JOIN core."order" o ON o.tenant_id = sl.tenant_id AND o.id = sl.matched_order_id' IN t.sql) = 0
            OR t.sql ~ 'LEFT JOIN core\."order"'
            OR position('coalesce(th.line_minor, 1)' IN t.sql) = 0 OR position('coalesce(th.line_bp, 0)' IN t.sql) = 0
            OR position('{detectors,finance.short_payout,thresholds,line_short_minor_gte}' IN t.sql) = 0
            OR position('{detectors,finance.short_payout,thresholds,line_short_bp_gte}' IN t.sql) = 0
            OR position('SELECT 0 AS k' IN t.sql) = 0 OR t.sql !~ 'ORDER BY [a-z]+\.k, '
            OR t.sql ~* '(now\(|current_date|current_timestamp|localtimestamp|clock_timestamp|transaction_timestamp|statement_timestamp)')) y;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0024: finance.settlement_vs_orders v3 not as written: %', bad; END IF;

  PERFORM munim_meta.assert_catalog('0024');
END $$;
