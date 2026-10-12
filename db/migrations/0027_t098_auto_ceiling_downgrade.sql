-- 0027_t098_auto_ceiling_downgrade — T-098 (ledger R45 F10: a lowered ceiling downgrades a running Auto investigation to
-- Plan), migrator lane fx-98, fix forward over 0001–0026. Runs as munim_migrator. One CHECK widened, one CHECK and two
-- triggers added (A1 is a tightening no core-api flow uses; orchestrator ruling, T-098 fix cycle 1). No row is written or
-- rewritten; no privilege changes.
-- Items:
--   C1  core.investigation.stop_reason gains 'ceiling' (0020's inline CHECK investigation_stop_reason_check, dropped and
--       re-added under the same name with the one new value).
--   C2  A ceiling stop IS the downgrade: when an UPDATE sets stop_reason to 'ceiling' on an `auto` row and does not itself
--       touch mode, the BEFORE UPDATE trigger ceiling_downgrade sets mode = 'plan' in the same row write. core-worker
--       (munim_svc, auto.ts) therefore downgrades with `SET stop_reason = 'ceiling'` alone. Why a trigger and not
--       GRANT UPDATE (mode) TO munim_svc: 0020 pins munim_svc's UPDATE list on core.investigation to five columns (its
--       header G1 and post-conditions), and with no UPDATE on mode munim_svc cannot write any mode at all — plan → auto,
--       step → auto, auto → step are refused by privilege (42501), not by trigger logic. The only mode change open to
--       munim_svc is this derived auto → plan. A BEFORE trigger's write to NEW is not a column-privilege check (only the
--       statement's SET list is), which the 0027 gate proves on embedded Postgres.
--       Backed by CHECK investigation_ceiling_not_auto (stop_reason 'ceiling' never on an `auto` row): if the trigger is
--       dropped or disabled, the svc stop fails closed (23514) instead of leaving a "ceiling" row running as Auto, and no
--       role can put a downgraded row back to `auto` while its stop reason stands. A later step clears stop_reason (step.ts)
--       and the row stays `plan` (A1).
--   A1  Auto is entered only with the plan approval: an UPDATE that moves mode INTO `auto` must, in the same row write, set
--       plan_approved_by from NULL (trigger auto_entry; MB004 illegal_transition otherwise). That is exactly core-api's
--       approveAuto (`SET plan_approved_by = <the signed-in member>, mode = 'auto'`); 0020 investigation_rules then checks the
--       approver is the signed-in member and stamps plan_approved_at. It fires after auto_entry (trigger name order), so the
--       condition reads plan_approved_by, not plan_approved_at. A plan is approved once (0020), so an investigation that left
--       Auto (downgraded, or moved to plan/step by munim_core) never re-enters it, and its unrevoked standing grant can never
--       authorise a step again. INSERT is untouched (0020 investigation_auto_needs_plan already requires the approval).
--   G   The standing grant (0020 G1) is NOT revoked here: munim_svc holds no UPDATE on core.investigation_grant and
--       grant_rules admits a revoke only by the signed-in member (revoked_by = app.member_id). The downgraded row's grant
--       stays revoked_at NULL but is inert: an auto step (step_rules) and an auto_step run (run_auto_step_grant) both
--       require the investigation's mode to be `auto` (0027 gate: both MB015 after the downgrade).
-- Book guard: core.investigation is munim:operational (0020), so no command/decision path and no derivation rule applies.
-- New SQLSTATEs: none (23514 from the CHECKs).

------------------------------------------------------------------------------------------------------------
-- 0. Pre-checks: what this file builds on is the shape it builds on.
------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
       WHERE c.conrelid = 'core.investigation'::regclass AND c.conname = 'investigation_stop_reason_check')
     IS DISTINCT FROM $d$CHECK ((stop_reason = ANY (ARRAY['draft'::text, 'abstain'::text, 'budget'::text, 'scope'::text, 'waiting'::text])))$d$ THEN
    RAISE EXCEPTION '0027: core.investigation investigation_stop_reason_check is not the 0020 CHECK 0027 widens';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'core.investigation'::regclass AND conname = 'investigation_ceiling_not_auto')
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'core.investigation'::regclass AND tgname = 'ceiling_downgrade')
     OR to_regprocedure('core.investigation_ceiling_downgrade()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'core.investigation'::regclass AND tgname = 'auto_entry')
     OR to_regprocedure('core.investigation_auto_entry()') IS NOT NULL THEN
    RAISE EXCEPTION '0027: core.investigation already has a ceiling CHECK, or an auto_entry / ceiling_downgrade trigger or function';
  END IF;
  IF has_column_privilege('munim_svc', 'core.investigation', 'mode', 'UPDATE') THEN
    RAISE EXCEPTION '0027: munim_svc already holds UPDATE on core.investigation.mode';
  END IF;
END $$;

------------------------------------------------------------------------------------------------------------
-- 1. C1 — stop_reason 'ceiling'
------------------------------------------------------------------------------------------------------------
ALTER TABLE core.investigation DROP CONSTRAINT investigation_stop_reason_check;
ALTER TABLE core.investigation ADD CONSTRAINT investigation_stop_reason_check
  CHECK (stop_reason IN ('draft', 'abstain', 'budget', 'scope', 'waiting', 'ceiling'));

------------------------------------------------------------------------------------------------------------
-- 2. C2 — a ceiling stop downgrades Auto to Plan
------------------------------------------------------------------------------------------------------------
ALTER TABLE core.investigation ADD CONSTRAINT investigation_ceiling_not_auto
  CHECK (stop_reason IS DISTINCT FROM 'ceiling' OR mode <> 'auto');

-- Trigger function only: no EXECUTE grant, nothing callable by a runtime role (gotcha 21). SECURITY INVOKER.
CREATE FUNCTION core.investigation_ceiling_downgrade() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.stop_reason = 'ceiling' AND OLD.stop_reason IS DISTINCT FROM 'ceiling' AND OLD.mode = 'auto' AND NEW.mode = 'auto' THEN
    NEW.mode := 'plan';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.investigation_ceiling_downgrade() FROM PUBLIC;

CREATE TRIGGER ceiling_downgrade BEFORE UPDATE ON core.investigation FOR EACH ROW EXECUTE FUNCTION core.investigation_ceiling_downgrade();

------------------------------------------------------------------------------------------------------------
-- 3. A1 — Auto only with the plan approval
------------------------------------------------------------------------------------------------------------
CREATE FUNCTION core.investigation_auto_entry() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.mode = 'auto' AND OLD.mode IS DISTINCT FROM 'auto'
     AND NOT (OLD.plan_approved_by IS NULL AND NEW.plan_approved_by IS NOT NULL) THEN
    RAISE EXCEPTION 'illegal_transition: investigation % enters auto only in the update that approves its plan', OLD.id
      USING ERRCODE = 'MB004';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.investigation_auto_entry() FROM PUBLIC;

CREATE TRIGGER auto_entry BEFORE UPDATE ON core.investigation FOR EACH ROW EXECUTE FUNCTION core.investigation_auto_entry();

------------------------------------------------------------------------------------------------------------
-- 4. Post-conditions (read back what Postgres holds; never trust IF NOT EXISTS)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(x, ', ') INTO bad FROM (
    -- C1 + C2: both CHECKs, as written.
    SELECT 'checks' AS x WHERE (SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), ' | ' ORDER BY conname) FROM pg_constraint
                                 WHERE conrelid = 'core.investigation'::regclass
                                   AND conname IN ('investigation_stop_reason_check', 'investigation_ceiling_not_auto'))
      IS DISTINCT FROM $d$investigation_ceiling_not_auto=CHECK (((stop_reason IS DISTINCT FROM 'ceiling'::text) OR (mode <> 'auto'::text)))$d$
                    || $d$ | investigation_stop_reason_check=CHECK ((stop_reason = ANY (ARRAY['draft'::text, 'abstain'::text, 'budget'::text, 'scope'::text, 'waiting'::text, 'ceiling'::text])))$d$
    UNION ALL
    -- C2 + A1: the triggers — BEFORE UPDATE FOR EACH ROW (tgtype 1 row | 2 before | 16 update = 19), enabled, on their function.
    SELECT 'trigger:' || v.g FROM (VALUES ('ceiling_downgrade', 'core.investigation_ceiling_downgrade()'),
                                          ('auto_entry', 'core.investigation_auto_entry()')) v(g, f)
     WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'core.investigation'::regclass AND t.tgname = v.g
                          AND t.tgfoid = v.f::regprocedure AND t.tgenabled = 'O' AND t.tgtype = 19 AND NOT t.tgisinternal)
    UNION ALL
    -- The functions: invoker rights, pinned search_path, an explicit ACL that grants nobody but the owner (no PUBLIC EXECUTE),
    -- and each body's load-bearing line.
    SELECT 'function:' || v.f FROM (VALUES ('core.investigation_ceiling_downgrade()', 'NEW.mode := ''plan'''),
                                           ('core.investigation_auto_entry()', 'NOT (OLD.plan_approved_by IS NULL AND NEW.plan_approved_by IS NOT NULL)')) v(f, line)
      JOIN pg_proc p ON p.oid = v.f::regprocedure
     WHERE p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp'] OR p.proacl IS NULL
        OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner)
        OR position(v.line IN p.prosrc) = 0
    UNION ALL
    -- munim_svc's privileges on core.investigation are still exactly 0020's: SELECT, and UPDATE of the five columns.
    SELECT 'svc-grants' WHERE (SELECT string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) FROM pg_class c, aclexplode(c.relacl) a
                                WHERE c.oid = 'core.investigation'::regclass AND a.grantee = 'munim_svc'::regrole) IS DISTINCT FROM 'SELECT'
       OR (SELECT string_agg(at.attname, ',' ORDER BY at.attname) FROM pg_attribute at, aclexplode(at.attacl) a
            WHERE at.attrelid = 'core.investigation'::regclass AND at.attnum > 0 AND a.grantee = 'munim_svc'::regrole AND a.privilege_type = 'UPDATE')
          IS DISTINCT FROM 'checklist,status,steps_done,stop_reason,updated_at'
       OR has_column_privilege('munim_svc', 'core.investigation', 'mode', 'UPDATE')
       OR has_any_column_privilege('munim_svc', 'core.investigation_grant', 'UPDATE')
    UNION ALL
    -- No row is in the new state yet (this file writes none).
    SELECT 'rows' WHERE EXISTS (SELECT 1 FROM core.investigation WHERE stop_reason = 'ceiling')) y;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0027: core.investigation ceiling downgrade not as written: %', bad; END IF;

  PERFORM munim_meta.assert_catalog('0027');
END $$;
