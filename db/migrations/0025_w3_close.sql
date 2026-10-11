-- 0025_w3_close — W3 close (migrator lane m-1), fix forward over 0001–0024. Runs as munim_migrator.
-- Additive only: one template version, one trigger, one column grant. No table, no data rewritten.
-- Items:
--   E1  intel.investigation_cost_estimate v2 (review R-D 4). v1 charged the per-step cost per remaining checklist ITEM, but a
--       step judges every evaluable item in one L1 call (core-api investigations/step.ts), so the cost unit is the STEP. v1
--       also INNER-joined the spend, so a linked step whose run recorded no spend (template narration, a recorded model at 0)
--       dropped out of the denominator and inflated the average. v2:
--         per_step_minor  = round(Σ spend of the runs linked to steps of same-playbook investigations ÷ the number of those
--                           linked steps), half away from zero, per spend currency. "Linked" = run_id IS NOT NULL (a step
--                           with no run made no model call it could be charged for). The denominator is counted in its own
--                           CTE, independent of currency: a step with no spend row, or with spend only in another currency,
--                           counts as 0 in that currency's numerator and 1 in its denominator (the spend is LEFT-joined; the
--                           NULL-currency group it yields is dropped, never used as a denominator).
--         remaining_steps = expected remaining steps, from the investigation's own state:
--                             open / waiting → max(0, least(max_steps − steps_done, checklist items not frozen));
--                             any terminal status → 0 (no further step can run, 0020 MB004).
--                           INFERENCE: max_steps − steps_done is the hard bound (core stops at max_steps); the not-frozen
--                           count caps it because a step that freezes nothing new ends the run (waiting / no_driver_found /
--                           exhausted, core-domain nextStatus) in the common case — it is an estimate, labelled so.
--         estimate_minor  = per_step_minor × remaining_steps (the two shown cells multiply to the third).
--       Columns: v1's, with remaining_steps inserted after remaining_items (kept: core reads only estimate_minor and currency).
--       Params and min_role = v1's. Rows: one per currency with spend in the history; 0 rows when no linked step exists or
--       none has spend (no currency to state a figure in → the preview reads "cannot verify", as without history). v1 stays.
--   N1  core.investigation AFTER INSERT OR UPDATE → core.notify_ids('munim_inbox') (b-89a). Payload '<tenant_id>:<id>' (ids
--       only), delivered at commit. core-api's explicit notifyInbox sends the identical payload on the same channel in the
--       same transaction, which Postgres delivers once; core-worker's munim_svc UPDATEs (Auto) now notify too.
--   G1  GRANT SELECT (id) ON intel.intel_spend TO munim_platform (b-92: keyset paging of a tenant's spend rows by (at, id)).
--       Still no run, role, provider, model or token column. NOT granted: SELECT on core.ai_budget_cap — it is a tenant book,
--       the operator console (platform-admin A5) does not show the owner's cap, and reading it would need USAGE on schema core
--       plus a new operator RLS path. Both are asserted below.
--   Not here: a business-policy command row. 0007's 'tenancy.policy.set.v1' (owner, judge; tenant; core.business_policy)
--   is the authority fx-core's command uses (orchestrator, W3 close).
-- New SQLSTATEs: none.

------------------------------------------------------------------------------------------------------------
-- 0. Pre-checks: what this file builds on is the shape it builds on.
------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT array_agg(version ORDER BY version) FROM evidence.snapshot_template WHERE id = 'intel.investigation_cost_estimate')
     IS DISTINCT FROM ARRAY[1] THEN
    RAISE EXCEPTION '0025: intel.investigation_cost_estimate is not exactly version 1';
  END IF;
  IF (SELECT p.prorettype FROM pg_proc p WHERE p.oid = to_regprocedure('core.notify_ids()')) IS DISTINCT FROM 'trigger'::regtype THEN
    RAISE EXCEPTION '0025: core.notify_ids() is not the 0003 trigger function';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'core.investigation'::regclass AND NOT t.tgisinternal
               AND t.tgfoid = 'core.notify_ids()'::regprocedure) THEN
    RAISE EXCEPTION '0025: core.investigation already has a notify_ids trigger';
  END IF;
END $$;

------------------------------------------------------------------------------------------------------------
-- 1. E1 — intel.investigation_cost_estimate v2 (per remaining step)
------------------------------------------------------------------------------------------------------------
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
SELECT 'intel.investigation_cost_estimate', 2,
  $q$WITH inv AS (
  SELECT i.playbook_id, i.checklist, i.status, i.max_steps, i.steps_done FROM core.investigation i WHERE i.id = :investigation_id::uuid),
linked AS (
  SELECT st.tenant_id, st.run_id
    FROM core.investigation i
    JOIN core.investigation_step st ON st.tenant_id = i.tenant_id AND st.investigation_id = i.id
   WHERE i.playbook_id = (SELECT inv.playbook_id FROM inv) AND st.run_id IS NOT NULL),
n AS (
  SELECT count(*) AS steps FROM linked),
spend AS (
  SELECT s.currency, coalesce(sum(s.amount_minor), 0) AS spent
    FROM linked l
    LEFT JOIN intel.intel_spend s ON s.tenant_id = l.tenant_id AND s.run_id = l.run_id
   GROUP BY s.currency),
rem AS (
  SELECT count(*) FILTER (WHERE NOT coalesce((x ->> 'frozen')::boolean, false)) AS items
    FROM inv CROSS JOIN LATERAL jsonb_array_elements(inv.checklist) x),
fut AS (
  SELECT CASE WHEN inv.status IN ('open', 'waiting') THEN greatest(least(inv.max_steps - inv.steps_done, rem.items), 0) ELSE 0 END AS steps
    FROM inv CROSS JOIN rem)
SELECT sp.currency, round(sp.spent::numeric / n.steps)::bigint AS per_step_minor, n.steps::bigint AS steps_in_history,
       rem.items::bigint AS remaining_items, fut.steps::bigint AS remaining_steps,
       (round(sp.spent::numeric / n.steps) * fut.steps)::bigint AS estimate_minor,
       'estimate (computed)'::text AS label
  FROM spend sp CROSS JOIN n CROSS JOIN rem CROSS JOIN fut
 WHERE sp.currency IS NOT NULL
 ORDER BY sp.currency$q$,
  v1.params_schema,
  '[{"name": "currency", "type": "text"},
    {"name": "per_step_minor", "type": "integer", "numeric_source": ["intel.intel_spend.amount_minor", "count:core.investigation_step"]},
    {"name": "steps_in_history", "type": "integer", "numeric_source": "count:core.investigation_step"},
    {"name": "remaining_items", "type": "integer", "numeric_source": "core.investigation.checklist"},
    {"name": "remaining_steps", "type": "integer", "numeric_source": ["core.investigation.max_steps", "core.investigation.steps_done", "core.investigation.checklist"]},
    {"name": "estimate_minor", "type": "integer", "numeric_source": ["intel.intel_spend.amount_minor", "count:core.investigation_step",
                                                                     "core.investigation.max_steps", "core.investigation.steps_done", "core.investigation.checklist"]},
    {"name": "label", "type": "text"}]',
  v1.min_role
  FROM evidence.snapshot_template v1
 WHERE v1.id = 'intel.investigation_cost_estimate' AND v1.version = 1;

------------------------------------------------------------------------------------------------------------
-- 2. N1 — investigations wake inbox streams (ids only)
------------------------------------------------------------------------------------------------------------
CREATE TRIGGER notify_inbox AFTER INSERT OR UPDATE ON core.investigation FOR EACH ROW EXECUTE FUNCTION core.notify_ids('munim_inbox');

------------------------------------------------------------------------------------------------------------
-- 3. G1 — the operator pages a tenant's spend rows by (at, id)
------------------------------------------------------------------------------------------------------------
GRANT SELECT (id) ON intel.intel_spend TO munim_platform;

------------------------------------------------------------------------------------------------------------
-- 4. Post-conditions (read back what Postgres holds)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  -- E1: v2 is the latest; v1's params and role, v1's columns with remaining_steps after remaining_items; the shape of the fix.
  SELECT string_agg(x, ', ') INTO bad FROM (
    SELECT 'latest' AS x WHERE (SELECT max(version) FROM evidence.snapshot_template WHERE id = 'intel.investigation_cost_estimate') <> 2
    UNION ALL
    SELECT 'shape' FROM evidence.snapshot_template t2 JOIN evidence.snapshot_template t1 ON t1.id = t2.id AND t1.version = 1
     WHERE t2.id = 'intel.investigation_cost_estimate' AND t2.version = 2
       AND (t2.params_schema IS DISTINCT FROM t1.params_schema OR t2.min_role IS DISTINCT FROM t1.min_role
            OR (SELECT string_agg(c ->> 'name', ',' ORDER BY k) FROM jsonb_array_elements(t2.columns) WITH ORDINALITY e(c, k))
               IS DISTINCT FROM 'currency,per_step_minor,steps_in_history,remaining_items,remaining_steps,estimate_minor,label'
            OR (SELECT string_agg(c ->> 'name', ',' ORDER BY k) FROM jsonb_array_elements(t1.columns) WITH ORDINALITY e(c, k))
               IS DISTINCT FROM 'currency,per_step_minor,steps_in_history,remaining_items,estimate_minor,label')
    UNION ALL
    SELECT 'sql' FROM evidence.snapshot_template t WHERE t.id = 'intel.investigation_cost_estimate' AND t.version = 2
       AND (position('LEFT JOIN intel.intel_spend s ON s.tenant_id = l.tenant_id AND s.run_id = l.run_id' IN t.sql) = 0
            OR position('SELECT count(*) AS steps FROM linked' IN t.sql) = 0
            OR position('st.run_id IS NOT NULL' IN t.sql) = 0
            OR position('WHERE sp.currency IS NOT NULL' IN t.sql) = 0
            OR position($s$WHEN inv.status IN ('open', 'waiting') THEN greatest(least(inv.max_steps - inv.steps_done, rem.items), 0) ELSE 0$s$ IN t.sql) = 0
            OR position('round(sp.spent::numeric / n.steps) * fut.steps' IN t.sql) = 0
            OR t.sql ~* '(now\(|current_date|current_timestamp|localtimestamp|clock_timestamp|transaction_timestamp|statement_timestamp)')) y;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0025: intel.investigation_cost_estimate v2 not as written: %', bad; END IF;

  -- N1: AFTER INSERT OR UPDATE, row-level, enabled, core.notify_ids() with exactly the argument 'munim_inbox'.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'core.investigation'::regclass AND t.tgname = 'notify_inbox'
                    AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgfoid = 'core.notify_ids()'::regprocedure
                    AND t.tgtype = (1 | 4 | 16) AND t.tgnargs = 1 AND t.tgargs = convert_to('munim_inbox', 'UTF8') || '\x00'::bytea)
     OR has_function_privilege('public', 'core.notify_ids()', 'EXECUTE') THEN
    RAISE EXCEPTION '0025: trigger core.investigation notify_inbox not as written';
  END IF;

  -- G1, both directions: id and the four 0012 columns; never run, role, provider, model or tokens; never a write; and no
  -- operator read of the tenant's AI cap (a book) or of schema core.
  IF NOT has_column_privilege('munim_platform', 'intel.intel_spend', 'id', 'SELECT')
     OR NOT has_column_privilege('munim_platform', 'intel.intel_spend', 'tenant_id', 'SELECT')
     OR NOT has_column_privilege('munim_platform', 'intel.intel_spend', 'amount_minor', 'SELECT')
     OR NOT has_column_privilege('munim_platform', 'intel.intel_spend', 'currency', 'SELECT')
     OR NOT has_column_privilege('munim_platform', 'intel.intel_spend', 'at', 'SELECT')
     OR has_column_privilege('munim_platform', 'intel.intel_spend', 'run_id', 'SELECT')
     OR has_column_privilege('munim_platform', 'intel.intel_spend', 'role', 'SELECT')
     OR has_column_privilege('munim_platform', 'intel.intel_spend', 'provider', 'SELECT')
     OR has_column_privilege('munim_platform', 'intel.intel_spend', 'model_id', 'SELECT')
     OR has_column_privilege('munim_platform', 'intel.intel_spend', 'input_tokens', 'SELECT')
     OR has_column_privilege('munim_platform', 'intel.intel_spend', 'output_tokens', 'SELECT')
     OR has_table_privilege('munim_platform', 'intel.intel_spend', 'SELECT')
     OR has_table_privilege('munim_platform', 'intel.intel_spend', 'INSERT, UPDATE, DELETE')
     OR has_table_privilege('munim_platform', 'core.ai_budget_cap', 'SELECT, INSERT, UPDATE, DELETE')
     OR has_schema_privilege('munim_platform', 'core', 'USAGE') THEN
    RAISE EXCEPTION '0025: munim_platform privileges on intel.intel_spend / core.ai_budget_cap not as written';
  END IF;

  PERFORM munim_meta.assert_catalog('0025');
END $$;
