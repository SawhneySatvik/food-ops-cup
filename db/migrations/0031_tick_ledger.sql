-- 0031_tick_ledger — T-117 (R56 G-2; plan 06 row T-117; lane B2 report §7): an idempotent tick. Migrator lane, fix forward over 0001–0030.
-- Runs as munim_migrator. Additive: one new operational table and its grants. No existing table, column, index, policy, trigger,
-- function, grant, command type or derivation rule is changed; no row is written.
-- Items:
--   T1  core.tick_claim (job, slot_at): which core-worker job has run for which aligned tick slot. The tick route (a scheduler
--       calling HTTP instead of a long-running worker) claims each job with INSERT … ON CONFLICT DO NOTHING just before it
--       starts; a retried or repeated call for the same slot finds the claim and skips that job, so the tenant brief is not posted
--       twice. A claim is committed on its own (not in the tick's lock transaction, which never commits), so a tick killed mid-job
--       keeps its claims: at most once per (job, slot). finished_at and outcome are set together when the job ends; a claim with
--       neither is a job that started and never reported (its process died), and it is not re-run for that slot.
--       Service state for every tenant at once (one claim covers every tenant the job visits), so no tenant_id and no RLS: like
--       core.command_authority and the other tenant-less operational tables, access is by grant alone. `munim:operational`
--       (R29): not a book; it holds job names and times, never a figure shown to anyone.
--   G   munim_svc (core-worker's role, no book grants): SELECT, INSERT, and UPDATE of (finished_at, outcome) only. No other role
--       holds any privilege; nobody may DELETE or TRUNCATE (a claim is never released).
-- New SQLSTATEs: none (23505 from the key, 23514 from the CHECKs, 42501 from the grants).

------------------------------------------------------------------------------------------------------------
-- 0. Pre-checks: what this file builds on is the shape it builds on.
------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('core.tick_claim') IS NOT NULL THEN RAISE EXCEPTION '0031: core.tick_claim already exists'; END IF;
END $$;

------------------------------------------------------------------------------------------------------------
-- 1. T1 — the table
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.tick_claim (
  job         text        NOT NULL CONSTRAINT tick_claim_job_check CHECK (job ~ '^[a-z][a-z0-9-]{0,62}$'),
  slot_at     timestamptz NOT NULL,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome     text CONSTRAINT tick_claim_outcome_check CHECK (outcome IN ('ok', 'failed', 'aborted')),
  CONSTRAINT tick_claim_pkey PRIMARY KEY (job, slot_at),
  CONSTRAINT tick_claim_finished_check CHECK ((finished_at IS NULL) = (outcome IS NULL))
);
COMMENT ON TABLE core.tick_claim IS 'munim:operational';

------------------------------------------------------------------------------------------------------------
-- 2. G — revoke, then grant
------------------------------------------------------------------------------------------------------------
REVOKE ALL ON core.tick_claim FROM PUBLIC, munim_core, munim_svc, munim_platform, munim_intel_ro, munim_crosstenant, munim_view_owner;
GRANT SELECT, INSERT ON core.tick_claim TO munim_svc;
GRANT UPDATE (finished_at, outcome) ON core.tick_claim TO munim_svc;

------------------------------------------------------------------------------------------------------------
-- 3. Post-conditions (read back what Postgres holds; never trust IF NOT EXISTS)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(x, ', ') INTO bad FROM (
    -- T1: the columns, as written.
    SELECT 'columns' AS x WHERE (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ':notnull' ELSE '' END
                                                   || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), 'nodefault'), ',' ORDER BY a.attnum)
                                   FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                                  WHERE a.attrelid = 'core.tick_claim'::regclass AND a.attnum > 0 AND NOT a.attisdropped)
      IS DISTINCT FROM 'job:text:notnull:nodefault,slot_at:timestamp with time zone:notnull:nodefault,claimed_at:timestamp with time zone:notnull:now(),'
                    || 'finished_at:timestamp with time zone:nodefault,outcome:text:nodefault'
    UNION ALL
    -- The key: a primary key on exactly (job, slot_at), backed by a unique index on those two columns in that order.
    SELECT 'key' WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_index i ON i.indexrelid = c.conindid
                                    WHERE c.conrelid = 'core.tick_claim'::regclass AND c.contype = 'p' AND i.indisunique AND i.indisprimary
                                      AND i.indkey::text = (SELECT string_agg(a.attnum::text, ' ' ORDER BY k.o) FROM unnest(ARRAY['job', 'slot_at']) WITH ORDINALITY k(n, o)
                                                              JOIN pg_attribute a ON a.attrelid = 'core.tick_claim'::regclass AND a.attname = k.n)
                                      AND i.indpred IS NULL AND i.indexprs IS NULL)
       OR (SELECT count(*) FROM pg_index WHERE indrelid = 'core.tick_claim'::regclass) <> 1
    UNION ALL
    -- The CHECKs, as written.
    SELECT 'checks' WHERE (SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), ' | ' ORDER BY conname) FROM pg_constraint
                            WHERE conrelid = 'core.tick_claim'::regclass AND contype = 'c')
      IS DISTINCT FROM 'tick_claim_finished_check=CHECK (((finished_at IS NULL) = (outcome IS NULL)))'
                    || ' | tick_claim_job_check=CHECK ((job ~ ''^[a-z][a-z0-9-]{0,62}$''::text))'
                    || ' | tick_claim_outcome_check=CHECK ((outcome = ANY (ARRAY[''ok''::text, ''failed''::text, ''aborted''::text])))'
    UNION ALL
    -- No other constraint (no foreign key: nothing here points at a tenant; 'n' is Postgres 18's NOT NULL entry) and no trigger.
    SELECT 'extra' WHERE EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'core.tick_claim'::regclass AND contype NOT IN ('p', 'c', 'n'))
       OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'core.tick_claim'::regclass)
    UNION ALL
    -- Tagged operational; owned by the migrator; no tenant_id (so the forced-RLS rule does not apply) and RLS off.
    SELECT 'table' FROM pg_class c WHERE c.oid = 'core.tick_claim'::regclass
       AND (obj_description(c.oid, 'pg_class') IS DISTINCT FROM 'munim:operational' OR c.relowner <> 'munim_migrator'::regrole
            OR c.relrowsecurity OR c.relkind <> 'r'
            OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped))
    UNION ALL
    -- G: the table ACL holds the owner and munim_svc only, munim_svc exactly SELECT + INSERT (no table-level UPDATE).
    SELECT 'acl' WHERE (SELECT string_agg(x.grantee::regrole::text || ':' || x.privilege_type, ',' ORDER BY x.grantee::regrole::text, x.privilege_type)
                          FROM pg_class c, aclexplode(c.relacl) x
                         WHERE c.oid = 'core.tick_claim'::regclass AND x.grantee <> c.relowner)
      IS DISTINCT FROM 'munim_svc:INSERT,munim_svc:SELECT'
    UNION ALL
    -- G: column grants are munim_svc's UPDATE of finished_at and outcome, nothing else.
    SELECT 'column-acl' WHERE (SELECT string_agg(a.attname || ':' || x.grantee::regrole::text || ':' || x.privilege_type, ',' ORDER BY a.attname)
                                 FROM pg_attribute a, aclexplode(a.attacl) x
                                WHERE a.attrelid = 'core.tick_claim'::regclass AND a.attnum > 0 AND a.attacl IS NOT NULL)
      IS DISTINCT FROM 'finished_at:munim_svc:UPDATE,outcome:munim_svc:UPDATE'
    UNION ALL
    -- G, read through the privilege functions: no other runtime role reads or writes; nobody DELETEs or TRUNCATEs.
    SELECT 'others:' || r FROM unnest(ARRAY['munim_core', 'munim_platform', 'munim_intel_ro', 'munim_crosstenant', 'munim_view_owner']) r
     WHERE has_table_privilege(r, 'core.tick_claim', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR has_any_column_privilege(r, 'core.tick_claim', 'SELECT,INSERT,UPDATE,REFERENCES')
    UNION ALL
    SELECT 'svc' WHERE NOT has_table_privilege('munim_svc', 'core.tick_claim', 'SELECT,INSERT')
       OR has_table_privilege('munim_svc', 'core.tick_claim', 'UPDATE') OR has_table_privilege('munim_svc', 'core.tick_claim', 'DELETE')
       OR has_table_privilege('munim_svc', 'core.tick_claim', 'TRUNCATE')
       OR NOT has_column_privilege('munim_svc', 'core.tick_claim', 'finished_at', 'UPDATE') OR NOT has_column_privilege('munim_svc', 'core.tick_claim', 'outcome', 'UPDATE')
       OR has_column_privilege('munim_svc', 'core.tick_claim', 'job', 'UPDATE') OR has_column_privilege('munim_svc', 'core.tick_claim', 'slot_at', 'UPDATE')
       OR has_column_privilege('munim_svc', 'core.tick_claim', 'claimed_at', 'UPDATE')
    UNION ALL
    -- No row (this file writes none).
    SELECT 'rows' WHERE EXISTS (SELECT 1 FROM core.tick_claim)) y;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0031: tick ledger not as written: %', bad; END IF;

  PERFORM munim_meta.assert_catalog('0031');
END $$;
