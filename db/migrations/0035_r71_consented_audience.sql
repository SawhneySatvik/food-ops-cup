-- 0035_r71_consented_audience — R71 (founder, 16 Oct 2026: what "Send me offers" consents to). Migrator lane, fix forward over
-- 0001–0034. Runs as munim_migrator. Additive: version 2 of one evidence template. No table, column, index, policy, trigger,
-- function, grant, command type or derivation rule is changed, and version 1 is not touched.
-- Why: customers.consented_audience v1 counts a customer as consented only on `consent.email` or `consent.sms`. A customer's own
-- grant — the storefront's "Send me offers" box and customers.consent.set.v1 (core-api consentHandler) — is stored as
-- {marketing, at}, so every business outside the demo seed counted 0 and a campaign draft was refused (no_marketing_consent).
-- Items:
--   C1  Version 2 counts, among the segment's customers who are not erased, those with email consent or SMS consent, where
--       (R71) email = consent.email if it is set, else consent.marketing, else no; sms = consent.sms if it is set, else no.
--       `marketing` is consent for email only: it never stands in for sms, and a channel's own flag always wins over it (a
--       withdrawn email — staff write email false — stays withdrawn). A flag that is not a JSON boolean counts as not set (it
--       cannot raise, and a string such as "yes" is not consent); core-api's customer reads (consentFlags) follow the same rule.
--       Same params, columns and min_role as v1; the SQL is v1's with the `consented` expression replaced (the anchor must occur
--       exactly once, else this file refuses), so the segment ids and the minter-scope clause are v1's, byte for byte.
--       v1 has no per-channel column (only `audience` and `consented`), so there is no other column to keep in step.
-- New SQLSTATEs: none.

------------------------------------------------------------------------------------------------------------
-- 0. Pre-checks: what this file builds on is the shape it builds on.
------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT max(version) FROM evidence.snapshot_template WHERE id = 'customers.consented_audience') IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION '0035: customers.consented_audience is not at version 1';
  END IF;
END $$;

------------------------------------------------------------------------------------------------------------
-- 1. C1 — version 2
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  old_expr constant text := $a$count(*) FILTER (WHERE c.erased_at IS NULL AND (coalesce((c.consent ->> 'email')::boolean, false) OR coalesce((c.consent ->> 'sms')::boolean, false)))::bigint AS consented$a$;
  new_expr constant text := $a$count(*) FILTER (
         WHERE c.erased_at IS NULL
           AND (coalesce(CASE WHEN jsonb_typeof(c.consent -> 'email') = 'boolean' THEN (c.consent ->> 'email')::boolean END,
                         CASE WHEN jsonb_typeof(c.consent -> 'marketing') = 'boolean' THEN (c.consent ->> 'marketing')::boolean END,
                         false)
                OR coalesce(CASE WHEN jsonb_typeof(c.consent -> 'sms') = 'boolean' THEN (c.consent ->> 'sms')::boolean END, false)))::bigint AS consented$a$;
  prev evidence.snapshot_template;
BEGIN
  SELECT * INTO prev FROM evidence.snapshot_template WHERE id = 'customers.consented_audience' AND version = 1;
  IF (length(prev.sql) - length(replace(prev.sql, old_expr, ''))) / length(old_expr) <> 1 THEN
    RAISE EXCEPTION '0035: customers.consented_audience v1 consented expression does not occur exactly once';
  END IF;
  INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
  VALUES (prev.id, 2, replace(prev.sql, old_expr, new_expr), prev.params_schema, prev.columns, prev.min_role);
END $$;

------------------------------------------------------------------------------------------------------------
-- 2. Post-conditions (read back what Postgres holds)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  -- C1's expressions, typed again: the read-back compares the stored SQL with them, not with what block 1 computed.
  old_expr constant text := $a$count(*) FILTER (WHERE c.erased_at IS NULL AND (coalesce((c.consent ->> 'email')::boolean, false) OR coalesce((c.consent ->> 'sms')::boolean, false)))::bigint AS consented$a$;
  new_expr constant text := $a$count(*) FILTER (
         WHERE c.erased_at IS NULL
           AND (coalesce(CASE WHEN jsonb_typeof(c.consent -> 'email') = 'boolean' THEN (c.consent ->> 'email')::boolean END,
                         CASE WHEN jsonb_typeof(c.consent -> 'marketing') = 'boolean' THEN (c.consent ->> 'marketing')::boolean END,
                         false)
                OR coalesce(CASE WHEN jsonb_typeof(c.consent -> 'sms') = 'boolean' THEN (c.consent ->> 'sms')::boolean END, false)))::bigint AS consented$a$;
  bad text;
BEGIN
  SELECT string_agg(x, ', ') INTO bad FROM (
    -- C1: v1 is still there and v2 is the latest.
    SELECT 'version' AS x
     WHERE (SELECT array_agg(version ORDER BY version) FROM evidence.snapshot_template WHERE id = 'customers.consented_audience')
           IS DISTINCT FROM ARRAY[1, 2]
    UNION ALL
    -- C1: v1's params, columns and role.
    SELECT 'shape' FROM evidence.snapshot_template n JOIN evidence.snapshot_template o ON o.id = n.id AND o.version = 1
     WHERE n.id = 'customers.consented_audience' AND n.version = 2
       AND (n.params_schema IS DISTINCT FROM o.params_schema OR n.columns IS DISTINCT FROM o.columns OR n.min_role IS DISTINCT FROM o.min_role)
    UNION ALL
    -- C1: v1's SQL with the consented expression replaced by R71's, and nothing else changed.
    SELECT 'sql' FROM evidence.snapshot_template n JOIN evidence.snapshot_template o ON o.id = n.id AND o.version = 1
     WHERE n.id = 'customers.consented_audience' AND n.version = 2
       AND (position(new_expr IN n.sql) = 0 OR n.sql IS DISTINCT FROM replace(o.sql, old_expr, new_expr))) y;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0035: customers.consented_audience v2 not as written: %', bad; END IF;

  PERFORM munim_meta.assert_catalog('0035');
END $$;
