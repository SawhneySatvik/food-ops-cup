-- 0033_forecast_per_outlet — T-127 (lane C T-114 report §0 "a one-outlet RFQ resets the other outlet's forecast"). Migrator lane,
-- fix forward over 0001–0032. Runs as munim_migrator. Additive: one new version of six evidence templates. No table, column, index,
-- policy, trigger, function, grant, command type or derivation rule is changed, and no earlier version is touched.
-- Why: these six read "the latest forecast run with a point the minter can see" — one run for the whole read. A run's points cover
-- only the outlets it was made for: the negotiation (POST /v1/rfq-requests → intel /negotiate) forecasts exactly the outlets the
-- person chose, under a run scoped to them (T-114; mint refuses any other outlet, so the run cannot forecast the rest). After a
-- one-outlet RFQ that run is the newest, and every all-outlet read then found no forecast for the other outlets: their need read 0
-- until the next run covering them.
-- Items:
--   F1  The new version picks the latest run per outlet: for each outlet, the newest run with a point at that outlet the minter can
--       see (forecast_point is outlet-scoped under RLS, so an outlet outside the minter's scope has none), then reads only that
--       run's points at that outlet, in that run's own method as before. With one outlet named, or every run covering every outlet,
--       it returns what the previous version returns. Same params, columns and min_role as the previous version; the SQL is the
--       previous version's with the pick replaced (each anchor must occur exactly once, else this file refuses):
--         kitchen.prep_need v1 → v2       (the latest run with a point on :business_date, per outlet)
--         forecast.points v1 → v2         (the latest run with a point in the window, per outlet)
--         inventory.shortfall v2 → v3,    inventory.expiry_risk v2 → v3,    purchasing.deal_inputs v3 → v4   (the shared `fuse` CTE)
--         market.upcoming v2 → v3         (the `fc` forecast CTE)
--       Not changed: people.labour_vs_demand takes the latest run with SLOT points, which no negotiation posts; forecast.accuracy
--       and forecast.freshness already pick per outlet (DISTINCT ON).
-- New SQLSTATEs: none.

------------------------------------------------------------------------------------------------------------
-- 0. Pre-checks: what this file builds on is the shape it builds on.
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(t.id || ' latest v' || t.v, ', ') INTO bad
    FROM (SELECT id, max(version) v FROM evidence.snapshot_template
           WHERE id IN ('kitchen.prep_need', 'forecast.points', 'inventory.shortfall', 'inventory.expiry_risk', 'purchasing.deal_inputs',
                        'market.upcoming')
           GROUP BY id) t
    FULL JOIN (VALUES ('kitchen.prep_need', 1), ('forecast.points', 1), ('inventory.shortfall', 2), ('inventory.expiry_risk', 2),
                      ('purchasing.deal_inputs', 3), ('market.upcoming', 2)) w(id, v) ON w.id = t.id
   WHERE t.v IS DISTINCT FROM w.v;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0033: the templates are not at the versions this file extends: %', bad; END IF;
END $$;

------------------------------------------------------------------------------------------------------------
-- 1. F1 — the new versions
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  -- The pick per outlet, in each template's own words (`p` or `x` for the point, as the previous version names it).
  fuse_old constant text := $a$  SELECT r.id, r.method FROM intel.forecast_run r
   WHERE EXISTS (SELECT 1 FROM intel.forecast_point p WHERE p.tenant_id = r.tenant_id AND p.forecast_run_id = r.id)
   ORDER BY r.created_at DESC, r.id DESC LIMIT 1),
fuse AS ($a$;
  fuse_new constant text := $a$  SELECT o.id AS outlet_id, lr.id, lr.method FROM core.outlet o
   CROSS JOIN LATERAL (SELECT r.id, r.method FROM intel.forecast_run r
                        WHERE EXISTS (SELECT 1 FROM intel.forecast_point p WHERE p.tenant_id = r.tenant_id AND p.forecast_run_id = r.id
                                         AND p.outlet_id = o.id)
                        ORDER BY r.created_at DESC, r.id DESC LIMIT 1) lr),
fuse AS ($a$;
  join_old constant text := $a$FROM fr JOIN intel.forecast_point p ON p.forecast_run_id = fr.id AND p.method = fr.method$a$;
  join_new constant text := $a$FROM fr JOIN intel.forecast_point p ON p.forecast_run_id = fr.id AND p.method = fr.method AND p.outlet_id = fr.outlet_id$a$;
  prep_old constant text := $a$  SELECT r.id, r.method FROM intel.forecast_run r
   WHERE EXISTS (SELECT 1 FROM intel.forecast_point p WHERE p.forecast_run_id = r.id AND p.business_on = :business_date::date
                    AND (:outlet_id::uuid IS NULL OR p.outlet_id = :outlet_id::uuid))
   ORDER BY r.created_at DESC, r.id DESC LIMIT 1),$a$;
  prep_new constant text := $a$  SELECT o.id AS outlet_id, lr.id, lr.method FROM core.outlet o
   CROSS JOIN LATERAL (SELECT r.id, r.method FROM intel.forecast_run r
                        WHERE EXISTS (SELECT 1 FROM intel.forecast_point p WHERE p.forecast_run_id = r.id AND p.business_on = :business_date::date
                                         AND p.outlet_id = o.id)
                        ORDER BY r.created_at DESC, r.id DESC LIMIT 1) lr
   WHERE :outlet_id::uuid IS NULL OR o.id = :outlet_id::uuid),$a$;
  prepj_old constant text := $a$JOIN fr ON fr.id = p.forecast_run_id AND fr.method = p.method$a$;
  prepj_new constant text := $a$JOIN fr ON fr.id = p.forecast_run_id AND fr.method = p.method AND fr.outlet_id = p.outlet_id$a$;
  pts_old constant text := $a$  SELECT r.id, r.method FROM intel.forecast_run r
   WHERE EXISTS (SELECT 1 FROM intel.forecast_point p WHERE p.tenant_id = r.tenant_id AND p.forecast_run_id = r.id
                    AND p.business_on BETWEEN :from::date AND :to::date AND (:outlet_id::uuid IS NULL OR p.outlet_id = :outlet_id::uuid))
   ORDER BY r.created_at DESC, r.id DESC LIMIT 1)$a$;
  pts_new constant text := $a$  SELECT o.id AS outlet_id, lr.id, lr.method FROM core.outlet o
   CROSS JOIN LATERAL (SELECT r.id, r.method FROM intel.forecast_run r
                        WHERE EXISTS (SELECT 1 FROM intel.forecast_point p WHERE p.tenant_id = r.tenant_id AND p.forecast_run_id = r.id
                                         AND p.business_on BETWEEN :from::date AND :to::date AND p.outlet_id = o.id)
                        ORDER BY r.created_at DESC, r.id DESC LIMIT 1) lr
   WHERE :outlet_id::uuid IS NULL OR o.id = :outlet_id::uuid)$a$;
  up_old constant text := $a$    JOIN (SELECT r.id, r.method FROM intel.forecast_run r
           WHERE EXISTS (SELECT 1 FROM intel.forecast_point x WHERE x.tenant_id = r.tenant_id AND x.forecast_run_id = r.id)
           ORDER BY r.created_at DESC, r.id DESC LIMIT 1) fr ON fr.id = p.forecast_run_id AND fr.method = p.method$a$;
  up_new constant text := $a$    JOIN (SELECT o.id AS outlet_id, lr.id, lr.method FROM core.outlet o
           CROSS JOIN LATERAL (SELECT r.id, r.method FROM intel.forecast_run r
                                WHERE EXISTS (SELECT 1 FROM intel.forecast_point x WHERE x.tenant_id = r.tenant_id AND x.forecast_run_id = r.id
                                                 AND x.outlet_id = o.id)
                                ORDER BY r.created_at DESC, r.id DESC LIMIT 1) lr) fr
      ON fr.id = p.forecast_run_id AND fr.method = p.method AND fr.outlet_id = p.outlet_id$a$;
  r     record;
  prev  evidence.snapshot_template;
  q     text;
  i     integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('kitchen.prep_need',      ARRAY[[prep_old, prep_new], [prepj_old, prepj_new]]),
      ('forecast.points',        ARRAY[[pts_old, pts_new], [join_old, join_new]]),
      ('inventory.shortfall',    ARRAY[[fuse_old, fuse_new], [join_old, join_new]]),
      ('inventory.expiry_risk',  ARRAY[[fuse_old, fuse_new], [join_old, join_new]]),
      ('purchasing.deal_inputs', ARRAY[[fuse_old, fuse_new], [join_old, join_new]]),
      ('market.upcoming',        ARRAY[[up_old, up_new]])) AS x (id, edits)
  LOOP
    SELECT * INTO prev FROM evidence.snapshot_template t
     WHERE t.id = r.id AND t.version = (SELECT max(version) FROM evidence.snapshot_template WHERE id = r.id);
    q := prev.sql;
    FOR i IN 1 .. array_length(r.edits, 1) LOOP
      IF (length(q) - length(replace(q, r.edits[i][1], ''))) / length(r.edits[i][1]) <> 1 THEN
        RAISE EXCEPTION '0033: % v% anchor % does not occur exactly once', r.id, prev.version, i;
      END IF;
      q := replace(q, r.edits[i][1], r.edits[i][2]);
    END LOOP;
    INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
    VALUES (r.id, prev.version + 1, q, prev.params_schema, prev.columns, prev.min_role);
  END LOOP;
END $$;

------------------------------------------------------------------------------------------------------------
-- 2. Post-conditions (read back what Postgres holds)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(x, ', ') INTO bad FROM (
    -- F1: each new version is the latest, one above the version it extends, with that version's params, columns and role.
    SELECT 'version:' || w.id AS x
      FROM (VALUES ('kitchen.prep_need', 2), ('forecast.points', 2), ('inventory.shortfall', 3), ('inventory.expiry_risk', 3),
                   ('purchasing.deal_inputs', 4), ('market.upcoming', 3)) w(id, v)
      LEFT JOIN evidence.snapshot_template n ON n.id = w.id AND n.version = w.v
      LEFT JOIN evidence.snapshot_template o ON o.id = w.id AND o.version = w.v - 1
     WHERE n.id IS NULL OR o.id IS NULL
        OR (SELECT max(version) FROM evidence.snapshot_template WHERE id = w.id) <> w.v
        OR n.params_schema IS DISTINCT FROM o.params_schema OR n.columns IS DISTINCT FROM o.columns OR n.min_role IS DISTINCT FROM o.min_role
        -- the pick is per outlet, and it is the only change: the new SQL has the per-outlet pick and joins on its outlet
        OR position('CROSS JOIN LATERAL (SELECT r.id, r.method FROM intel.forecast_run r' IN n.sql) = 0
        OR position('LIMIT 1) lr' IN n.sql) = 0
        OR n.sql !~ 'outlet_id = (fr\.outlet_id|p\.outlet_id)'
        OR length(n.sql) <= length(o.sql)
    UNION ALL
    -- Every latest template that reads intel.forecast_run picks per outlet (a LATERAL per outlet, or DISTINCT ON over the
    -- outlet) or reads slot points only; the hand list of the slot readers and the DISTINCT ON readers.
    SELECT 'reader:' || t.id
      FROM evidence.snapshot_template t
     WHERE t.version = (SELECT max(x.version) FROM evidence.snapshot_template x WHERE x.id = t.id)
       AND position('intel.forecast_run r' IN t.sql) > 0
       AND position('CROSS JOIN LATERAL (SELECT r.id, r.method FROM intel.forecast_run r' IN t.sql) = 0
       AND t.id NOT IN ('forecast.accuracy', 'forecast.freshness', 'people.labour_vs_demand')
    UNION ALL
    -- No new version reads the wall clock beyond the version it extends.
    SELECT 'clock:' || n.id
      FROM evidence.snapshot_template n JOIN evidence.snapshot_template o ON o.id = n.id AND o.version = n.version - 1
     WHERE (n.id, n.version) IN (('kitchen.prep_need', 2), ('forecast.points', 2), ('inventory.shortfall', 3), ('inventory.expiry_risk', 3),
                                 ('purchasing.deal_inputs', 4), ('market.upcoming', 3))
       AND (SELECT count(*) FROM regexp_matches(n.sql, '(now\(|current_date|current_timestamp|localtimestamp|clock_timestamp)', 'gi'))
           <> (SELECT count(*) FROM regexp_matches(o.sql, '(now\(|current_date|current_timestamp|localtimestamp|clock_timestamp)', 'gi'))) y;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0033: template versions not as written: %', bad; END IF;

  PERFORM munim_meta.assert_catalog('0033');
END $$;
