-- 0020_mc23_threads_policy_investigations — W3 merged migrator lane M-C23 (BOARD W3 consolidation: M-C3 + M-C2 + the
-- F11 Auto standing grant), migrator lane m-1, fix forward over 0001–0019. Runs as munim_migrator. Additive only. Items:
--   T1  core.ai_thread / core.ai_thread_turn (F9; operational). Not core.conversation / core.message (0009), which hold
--       ingested, untrusted chats. A turn is written once (no UPDATE grant): its `tainted` flag can never be laundered.
--       Turns are gapless per thread (MB014). The thread's rolling summary may cite only answered, untainted turns of
--       that thread (B1: a tainted turn's prose never enters the summary, even after it ages out of the window).
--   P1  core.ai_policy (per-role investigation-mode ceiling) and core.ai_budget_cap (the tenant's monthly AI cap) — F10,
--       F11 O-2. BOOKS (R29 lists budgets): written only by the owner's own commands ai_policy.ceiling.set.v1 /
--       ai_policy.cap.set.v1 (scope tenant, owner only; never intel, never munim_svc). Tenant-level book_scope rows.
--       No rows are backfilled: T-090 seeds them (onboarding) under those commands; absent row = the code default.
--   I1  core.investigation / core.investigation_step (ADR-014 §7.2, F10; operational). Steps are gapless (MB014), only
--       while the investigation is open or waiting and within max_steps (MB004), and carry who triggered them:
--       member (the signed-in member, munim_core), plan (the member who approved the plan, munim_core), auto (core-worker,
--       munim_svc, under a live standing grant). mode = auto needs an approved plan (CHECK). munim_svc may UPDATE exactly
--       (status, checklist, steps_done, stop_reason, updated_at) of an investigation and INSERT steps (§14 C9). A step's
--       run / summary answer are linked once after narration (ADR §7.2 step 5); `tainted` never goes back to false.
--   G1  F11 / O-1: core.investigation_grant — the standing grant a member gives by choosing Auto. A table, not columns on
--       core.investigation: a revoke followed by a new grant keeps both records, every Auto run and step names the grant
--       that authorised it (FK), and munim_svc's UPDATE list on core.investigation stays the five M-C2 columns. One live
--       grant per investigation (partial unique index). Created only by that member in their own request (= the
--       investigation's creator, scope = the investigation's scope, covered by their membership now); revoked once
--       (revoked_at/revoked_by NULL → value, by the signed-in member). Liveness is enforced by refusal, at every step:
--       an Auto step and an `auto_step` run need the grant unrevoked, the investigation mode auto and open/waiting, the
--       member and membership active, and the member's CURRENT membership covering the grant's scope (a narrowed or
--       removed membership refuses — F11 "cancelled when access changes"; review M7). Revoking therefore stops Auto by
--       construction; moving the investigation out of `auto` (or cancelling it) is core's (T-089b).
--   G2  intel.run.trigger gains 'auto_step' (CHECK widened, additive) with intel.run.grant_id (set exactly for auto_step);
--       actor = the grantor's member id (the 0003 actor CHECK already admits a uuid). An auto_step run is refused unless
--       its grant is live as above and the run's outlet scope lies inside the grant's.
--   V1  intel_ro.investigation_current (owner munim_view_owner; ids, text and jsonb only — no numeric column).
--   T2  Templates: intel.agent_track_record (per specialist: proposed, approved, edited, rejected, stale, abstained —
--       core.draft / core.decision counts and intel.trace_event abstain counts only, never confidence_bp, R40 C5),
--       intel.ai_budget_left (owner cap, operator limit, effective cap = the lower of the two (F11 O-2), spent, left),
--       intel.investigation_cost_estimate ("estimate (computed)": per-step spend history × remaining checklist items).
-- New SQLSTATE: MB015 investigation_refused (the investigation, step, standing-grant or auto_step run rules above).
-- Reused: MB014 sequence_gap (turn/step numbers), MB004 illegal_transition (terminal investigation, set-once links).

------------------------------------------------------------------------------------------------------------
-- 1. T1 — specialist threads (F9)
------------------------------------------------------------------------------------------------------------
-- specialist / addressed_to: the eight ids of ledger R45 F8 (packages/contracts/src/intel/specialists.ts); NULL = the
-- main conversation (the Manager). outlet_scope: the creator's scope when the thread opened, in intel.run's form.
CREATE TABLE core.ai_thread (
  tenant_id    uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id           uuid        NOT NULL,
  specialist   text        CHECK (specialist IN ('catalogue', 'kitchen', 'inventory_purchasing', 'finance', 'people',
                                                 'customers', 'compliance', 'market')),
  created_by   uuid        NOT NULL,
  outlet_scope text[]      NOT NULL CHECK (outlet_scope = '{*}' OR (cardinality(outlet_scope) >= 1
                             AND array_to_string(outlet_scope, ',') ~ '^[0-9a-f-]{36}(,[0-9a-f-]{36})*$')),
  -- The rolling cited summary (T-088a): ≤ 8 segments, each an object naming the turn it came from (`turn_no`).
  summary      jsonb       NOT NULL DEFAULT '[]' CONSTRAINT ai_thread_summary_shape CHECK (
                             jsonb_typeof(summary) = 'array' AND jsonb_array_length(summary) <= 8
                             AND NOT jsonb_path_exists(summary, '$[*] ? (!exists(@.turn_no ? (@.type() == "number" && @ >= 1 && @ == @.floor())))')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES core.member (tenant_id, id)
);

CREATE TABLE core.ai_thread_turn (
  tenant_id    uuid        NOT NULL,
  thread_id    uuid        NOT NULL,
  turn_no      integer     NOT NULL CHECK (turn_no >= 1),
  id           uuid        NOT NULL,
  member_id    uuid        NOT NULL,
  answer_id    uuid,
  addressed_to text        CHECK (addressed_to IN ('catalogue', 'kitchen', 'inventory_purchasing', 'finance', 'people',
                                                   'customers', 'compliance', 'market')),
  tainted      boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, thread_id, turn_no),
  CONSTRAINT ai_thread_turn_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT ai_thread_turn_answer_unique UNIQUE (tenant_id, answer_id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES core.ai_thread (tenant_id, id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES core.member (tenant_id, id),
  FOREIGN KEY (tenant_id, answer_id) REFERENCES intel.answer (tenant_id, id)
);

------------------------------------------------------------------------------------------------------------
-- 2. P1 — AI policy (F10 "who", F11 O-2): books
------------------------------------------------------------------------------------------------------------
-- The highest investigation mode a role may pick. Defaults (no row) are core-domain's (T-090: owner auto, manager
-- plan, staff step from F10; advisor step and judge plan are INFERENCE, O-3).
CREATE TABLE core.ai_policy (
  tenant_id    uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id           uuid        NOT NULL,
  role         text        NOT NULL CHECK (role IN ('owner', 'manager', 'staff', 'advisor', 'judge')),
  mode_ceiling text        NOT NULL CHECK (mode_ceiling IN ('step', 'plan', 'auto')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  origin       jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT ai_policy_one_per_role UNIQUE (tenant_id, role)
);

-- The tenant's monthly AI spend cap. The effective cap is the lower of this and the operator's
-- platform.llm_budget.limit_minor for the month (F11 O-2) — compared only in the same currency (intel.ai_budget_left).
-- "Never above the operator limit" is core's refusal (T-090, 422 cap_above_platform_budget): the limit is per month
-- and operator-mutable, so the database does not freeze the comparison. Currency = the tenant's base currency (R30).
CREATE TABLE core.ai_budget_cap (
  tenant_id         uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                uuid        NOT NULL,
  monthly_cap_minor bigint      NOT NULL CHECK (monthly_cap_minor >= 0),
  currency          char(3)     NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  origin            jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT ai_budget_cap_one_per_tenant UNIQUE (tenant_id)
);

INSERT INTO core.command_authority (command_type, allowed_roles, scope, target_tables) VALUES
  ('ai_policy.ceiling.set.v1', ARRAY['owner'], 'tenant', ARRAY['core.ai_policy']),
  ('ai_policy.cap.set.v1',     ARRAY['owner'], 'tenant', ARRAY['core.ai_budget_cap']);

-- Tenant-level records: the command's tenant scope ('{*}') alone decides (0014 F1).
INSERT INTO core.book_scope (table_name, outlet_kind) VALUES ('core.ai_policy', 'none'), ('core.ai_budget_cap', 'none');

------------------------------------------------------------------------------------------------------------
-- 3. I1 — investigations (ADR-014 §7.2, F10): operational
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.investigation (
  tenant_id        uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id               uuid        NOT NULL,
  playbook_id      text        NOT NULL CHECK (playbook_id ~ '^[a-z][a-z0-9_]*$'),
  params           jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object'),
  outlet_scope     text[]      NOT NULL CHECK (outlet_scope = '{*}' OR (cardinality(outlet_scope) >= 1
                                 AND array_to_string(outlet_scope, ',') ~ '^[0-9a-f-]{36}(,[0-9a-f-]{36})*$')),
  created_by       uuid        NOT NULL,
  mode             text        NOT NULL DEFAULT 'step' CHECK (mode IN ('step', 'plan', 'auto')),
  status           text        NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'waiting', 'done', 'no_driver_found', 'cannot_verify', 'cancelled', 'exhausted')),
  -- [{item_id, status ∈ {pending, supported, refuted, cannot_verify}, frozen bool, snapshot_ids[]}] (§7.2)
  checklist        jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(checklist) = 'array'),
  steps_done       integer     NOT NULL DEFAULT 0 CHECK (steps_done >= 0),
  max_steps        integer     NOT NULL DEFAULT 10 CHECK (max_steps BETWEEN 1 AND 10),
  plan_approved_by uuid,
  plan_approved_at timestamptz,
  -- Why a Plan/Auto run stopped (F10); NULL while it runs.
  stop_reason      text        CHECK (stop_reason IN ('draft', 'abstain', 'budget', 'scope', 'waiting')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES core.member (tenant_id, id),
  FOREIGN KEY (tenant_id, plan_approved_by) REFERENCES core.member (tenant_id, id),
  CHECK (steps_done <= max_steps),
  CONSTRAINT investigation_plan_approval_pair CHECK ((plan_approved_by IS NULL) = (plan_approved_at IS NULL)),
  CONSTRAINT investigation_auto_needs_plan CHECK (mode <> 'auto' OR plan_approved_by IS NOT NULL)
);

------------------------------------------------------------------------------------------------------------
-- 4. G1 — the standing grant behind Auto (F11 O-1)
------------------------------------------------------------------------------------------------------------
CREATE TABLE core.investigation_grant (
  tenant_id        uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id               uuid        NOT NULL,
  investigation_id uuid        NOT NULL,
  member_id        uuid        NOT NULL,
  outlet_scope     text[]      NOT NULL CHECK (outlet_scope = '{*}' OR (cardinality(outlet_scope) >= 1
                                 AND array_to_string(outlet_scope, ',') ~ '^[0-9a-f-]{36}(,[0-9a-f-]{36})*$')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz,
  revoked_by       uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, investigation_id) REFERENCES core.investigation (tenant_id, id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES core.member (tenant_id, id),
  FOREIGN KEY (tenant_id, revoked_by) REFERENCES core.member (tenant_id, id),
  CONSTRAINT investigation_grant_revoke_pair CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TABLE core.investigation_step (
  tenant_id         uuid        NOT NULL,
  investigation_id  uuid        NOT NULL,
  step_no           integer     NOT NULL CHECK (step_no >= 1),
  member_id         uuid        NOT NULL,
  triggered_by      text        NOT NULL CHECK (triggered_by IN ('member', 'plan', 'auto')),
  grant_id          uuid,
  run_id            uuid,
  started_at        timestamptz NOT NULL DEFAULT now(),
  item_updates      jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(item_updates) = 'array'),
  summary_answer_id uuid,
  tainted           boolean     NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, investigation_id, step_no),
  FOREIGN KEY (tenant_id, investigation_id) REFERENCES core.investigation (tenant_id, id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES core.member (tenant_id, id),
  FOREIGN KEY (tenant_id, grant_id) REFERENCES core.investigation_grant (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES intel.run (tenant_id, id),
  FOREIGN KEY (tenant_id, summary_answer_id) REFERENCES intel.answer (tenant_id, id),
  CONSTRAINT investigation_step_grant_iff_auto CHECK ((triggered_by = 'auto') = (grant_id IS NOT NULL))
);

------------------------------------------------------------------------------------------------------------
-- 5. G2 — intel.run: the auto_step trigger kind (additive CHECK widening) and its grant
------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'intel.run'::regclass AND c.conname = 'run_trigger_check')
     IS DISTINCT FROM $d$CHECK ((trigger = ANY (ARRAY['event'::text, 'watch_sweep'::text, 'ask'::text, 'brief'::text])))$d$ THEN
    RAISE EXCEPTION '0020: intel.run run_trigger_check is not the 0003 CHECK 0020 widens';
  END IF;
END $$;
ALTER TABLE intel.run DROP CONSTRAINT run_trigger_check;
ALTER TABLE intel.run ADD CONSTRAINT run_trigger_check CHECK (trigger IN ('event', 'watch_sweep', 'ask', 'brief', 'auto_step'));
ALTER TABLE intel.run ADD COLUMN grant_id uuid;
ALTER TABLE intel.run
  ADD CONSTRAINT run_grant_fk FOREIGN KEY (tenant_id, grant_id) REFERENCES core.investigation_grant (tenant_id, id),
  ADD CONSTRAINT run_grant_iff_auto_step CHECK ((trigger = 'auto_step') = (grant_id IS NOT NULL));

------------------------------------------------------------------------------------------------------------
-- 6. Functions (trigger functions only: no EXECUTE grant, nothing callable by a runtime role)
------------------------------------------------------------------------------------------------------------
-- Turns: gapless per thread under a per-thread transaction lock. turn_no NULL → the next number (two concurrent asks
-- both land, consecutively); a supplied number must be the next one (MB014).
CREATE FUNCTION core.ai_thread_turn_number() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE last_no integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('core.ai_thread_turn:' || NEW.tenant_id::text || ':' || NEW.thread_id::text, 0));
  SELECT max(t.turn_no) INTO last_no FROM core.ai_thread_turn t WHERE t.tenant_id = NEW.tenant_id AND t.thread_id = NEW.thread_id;
  IF NEW.turn_no IS NULL THEN
    NEW.turn_no := coalesce(last_no, 0) + 1;
  ELSIF NEW.turn_no <> coalesce(last_no, 0) + 1 THEN
    RAISE EXCEPTION 'sequence_gap: turn % for thread % (expected %)', NEW.turn_no, NEW.thread_id, coalesce(last_no, 0) + 1
      USING ERRCODE = 'MB014';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.ai_thread_turn_number() FROM PUBLIC;

-- The summary cites only answered, untainted turns of this very thread (B1). Turns are insert-once, so a cited turn
-- can never become tainted afterwards.
CREATE FUNCTION core.ai_thread_summary_untainted() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.summary) s
              WHERE NOT EXISTS (SELECT 1 FROM core.ai_thread_turn t
                                 WHERE t.tenant_id = NEW.tenant_id AND t.thread_id = NEW.id
                                   AND t.turn_no = (s ->> 'turn_no')::integer
                                   AND t.answer_id IS NOT NULL AND NOT t.tainted)) THEN
    RAISE EXCEPTION 'thread_summary_refused: thread % summary cites a turn that is missing, unanswered or tainted', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.ai_thread_summary_untainted() FROM PUBLIC;

-- Investigations: created by the signed-in member; a plan is approved once, by the signed-in member (stamped now());
-- a terminal status never changes (MB004).
CREATE FUNCTION core.investigation_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE me text := nullif(current_setting('app.member_id', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by::text IS DISTINCT FROM me THEN
      RAISE EXCEPTION 'investigation_refused: an investigation is created by the signed-in member' USING ERRCODE = 'MB015';
    END IF;
  ELSIF OLD.status IN ('done', 'no_driver_found', 'cannot_verify', 'cancelled', 'exhausted') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'illegal_transition: investigation % is %', OLD.id, OLD.status USING ERRCODE = 'MB004';
  END IF;
  IF NEW.plan_approved_by IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.plan_approved_by END) THEN
    IF TG_OP = 'UPDATE' AND OLD.plan_approved_by IS NOT NULL OR NEW.plan_approved_by::text IS DISTINCT FROM me THEN
      RAISE EXCEPTION 'investigation_refused: a plan is approved once, by the signed-in member' USING ERRCODE = 'MB015';
    END IF;
    NEW.plan_approved_at := now();
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.investigation_rules() FROM PUBLIC;

-- The standing grant (F11): given by the investigation's creator in their own request, for exactly the investigation's
-- scope, which their membership covers now; revoked once, by the signed-in member.
-- Coverage (as core-domain outletScopeOf): an empty membership outlet list is every outlet for owner/advisor/judge and
-- no outlet for anyone else; '{*}' needs every outlet.
CREATE FUNCTION core.investigation_grant_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  me    text := nullif(current_setting('app.member_id', true), '');
  inv   core.investigation;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR NEW.revoked_by::text IS DISTINCT FROM me THEN
      RAISE EXCEPTION 'investigation_refused: a standing grant is revoked once, by the signed-in member' USING ERRCODE = 'MB015';
    END IF;
    NEW.revoked_at := greatest(now(), OLD.created_at);
    RETURN NEW;
  END IF;
  SELECT * INTO inv FROM core.investigation i WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.investigation_id;
  IF NEW.member_id::text IS DISTINCT FROM me OR inv.id IS NULL OR inv.created_by <> NEW.member_id
     OR NEW.outlet_scope IS DISTINCT FROM inv.outlet_scope OR NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM core.member m JOIN core.membership ms ON ms.tenant_id = m.tenant_id AND ms.member_id = m.id
                     WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.member_id AND m.active AND ms.active
                       AND CASE WHEN cardinality(ms.outlet_ids) = 0 THEN ms.role IN ('owner', 'advisor', 'judge')
                                WHEN NEW.outlet_scope = '{*}' THEN false
                                ELSE NEW.outlet_scope::uuid[] <@ ms.outlet_ids END) THEN
    RAISE EXCEPTION 'investigation_refused: a standing grant is the investigation creator''s own, for its scope, inside their membership'
      USING ERRCODE = 'MB015';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.investigation_grant_rules() FROM PUBLIC;

-- Steps. INSERT: gapless (MB014; step_no NULL → next), only while the investigation is open/waiting and within
-- max_steps (MB004), and the trigger is who it says it is (MB015):
--   member — munim_core, member_id = the signed-in member;
--   plan   — munim_core, member_id = the signed-in member = the plan's approver, mode plan or auto;
--   auto   — munim_svc (core-worker), mode auto, the step's grant is this investigation's live grant, given by member_id,
--            whose member and membership are active and whose CURRENT membership covers the grant's scope.
-- UPDATE (and an INSERT carrying links): run_id and summary_answer_id are set once; tainted never goes back to false
-- (MB004); an auto step's run is an auto_step run of the same grant, any other step's run is not an auto_step run.
CREATE FUNCTION core.investigation_step_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  me      text := nullif(current_setting('app.member_id', true), '');
  last_no integer;
  inv     core.investigation;
  ok      boolean;
  r_trig  text;
  r_grant uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('core.investigation_step:' || NEW.tenant_id::text || ':' || NEW.investigation_id::text, 0));
    SELECT max(s.step_no) INTO last_no FROM core.investigation_step s
     WHERE s.tenant_id = NEW.tenant_id AND s.investigation_id = NEW.investigation_id;
    IF NEW.step_no IS NULL THEN
      NEW.step_no := coalesce(last_no, 0) + 1;
    ELSIF NEW.step_no <> coalesce(last_no, 0) + 1 THEN
      RAISE EXCEPTION 'sequence_gap: step % for investigation % (expected %)', NEW.step_no, NEW.investigation_id, coalesce(last_no, 0) + 1
        USING ERRCODE = 'MB014';
    END IF;
    SELECT * INTO inv FROM core.investigation i WHERE i.tenant_id = NEW.tenant_id AND i.id = NEW.investigation_id;
    IF inv.id IS NULL THEN
      RAISE EXCEPTION 'investigation_refused: investigation % is not visible here', NEW.investigation_id USING ERRCODE = 'MB015';
    END IF;
    IF inv.status NOT IN ('open', 'waiting') OR NEW.step_no > inv.max_steps THEN
      RAISE EXCEPTION 'illegal_transition: no step % on investigation % (status %, max %)', NEW.step_no, inv.id, inv.status, inv.max_steps
        USING ERRCODE = 'MB004';
    END IF;
    ok := CASE NEW.triggered_by
      WHEN 'member' THEN current_user = 'munim_core' AND NEW.member_id::text = me
      WHEN 'plan' THEN current_user = 'munim_core' AND NEW.member_id::text = me AND NEW.member_id = inv.plan_approved_by
                       AND inv.mode IN ('plan', 'auto')
      ELSE current_user = 'munim_svc' AND inv.mode = 'auto'
           AND EXISTS (SELECT 1 FROM core.investigation_grant g
                         JOIN core.member m ON m.tenant_id = g.tenant_id AND m.id = g.member_id
                         JOIN core.membership ms ON ms.tenant_id = g.tenant_id AND ms.member_id = g.member_id
                        WHERE g.tenant_id = NEW.tenant_id AND g.id = NEW.grant_id AND g.investigation_id = NEW.investigation_id
                          AND g.member_id = NEW.member_id AND g.revoked_at IS NULL AND m.active AND ms.active
                          AND CASE WHEN cardinality(ms.outlet_ids) = 0 THEN ms.role IN ('owner', 'advisor', 'judge')
                                   WHEN g.outlet_scope = '{*}' THEN false
                                   ELSE g.outlet_scope::uuid[] <@ ms.outlet_ids END) END;
    IF NOT coalesce(ok, false) THEN
      RAISE EXCEPTION 'investigation_refused: a % step needs %', NEW.triggered_by,
        CASE NEW.triggered_by WHEN 'member' THEN 'the signed-in member' WHEN 'plan' THEN 'the plan''s approver, signed in'
          ELSE 'core-worker under a live standing grant whose member''s current membership covers its scope' END
        USING ERRCODE = 'MB015';
    END IF;
  ELSE
    IF (OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id)
       OR (OLD.summary_answer_id IS NOT NULL AND NEW.summary_answer_id IS DISTINCT FROM OLD.summary_answer_id)
       OR (OLD.tainted AND NOT NEW.tainted) THEN
      RAISE EXCEPTION 'illegal_transition: a step''s run and summary are linked once and its taint is never cleared'
        USING ERRCODE = 'MB004';
    END IF;
  END IF;
  IF NEW.run_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.run_id IS DISTINCT FROM OLD.run_id) THEN
    SELECT r.trigger, r.grant_id INTO r_trig, r_grant FROM intel.run r WHERE r.tenant_id = NEW.tenant_id AND r.id = NEW.run_id;
    IF r_trig IS NULL OR (NEW.triggered_by = 'auto') <> (r_trig = 'auto_step')
       OR (NEW.triggered_by = 'auto' AND r_grant IS DISTINCT FROM NEW.grant_id) THEN
      RAISE EXCEPTION 'investigation_refused: an auto step''s run is an auto_step run of its grant, and only an auto step''s'
        USING ERRCODE = 'MB015';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.investigation_step_rules() FROM PUBLIC;

-- An auto_step run (core-worker's run token for an Auto step) needs, at insert: its grant unrevoked; actor = the
-- grantor; the investigation in mode auto and open/waiting; the grantor's member and membership active and their
-- CURRENT membership covering the grant's scope; the run's scope inside the grant's. Every other trigger kind: untouched.
CREATE FUNCTION intel.run_auto_step_grant() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  g_member uuid;
  g_scope  text[];
BEGIN
  IF NEW.trigger IS DISTINCT FROM 'auto_step' THEN
    RETURN NEW;
  END IF;
  SELECT g.member_id, g.outlet_scope INTO g_member, g_scope
    FROM core.investigation_grant g
    JOIN core.investigation i ON i.tenant_id = g.tenant_id AND i.id = g.investigation_id
   WHERE g.tenant_id = NEW.tenant_id AND g.id = NEW.grant_id AND g.revoked_at IS NULL
     AND i.mode = 'auto' AND i.status IN ('open', 'waiting');
  IF g_member IS NULL OR g_member::text <> NEW.actor
     OR NOT (CASE WHEN g_scope = '{*}' THEN true
                  WHEN NEW.outlet_scope = '{*}' THEN false
                  ELSE NEW.outlet_scope::uuid[] <@ g_scope::uuid[] END)
     OR NOT EXISTS (SELECT 1 FROM core.member m JOIN core.membership ms ON ms.tenant_id = m.tenant_id AND ms.member_id = m.id
                     WHERE m.tenant_id = NEW.tenant_id AND m.id = g_member AND m.active AND ms.active
                       AND CASE WHEN cardinality(ms.outlet_ids) = 0 THEN ms.role IN ('owner', 'advisor', 'judge')
                                WHEN g_scope = '{*}' THEN false
                                ELSE g_scope::uuid[] <@ ms.outlet_ids END) THEN
    RAISE EXCEPTION 'investigation_refused: an auto_step run needs a live standing grant of its actor covering its scope'
      USING ERRCODE = 'MB015';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION intel.run_auto_step_grant() FROM PUBLIC;

------------------------------------------------------------------------------------------------------------
-- 7. Triggers
------------------------------------------------------------------------------------------------------------
-- Books: the guard first (name order); currency and updated_at after it.
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.ai_policy     FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.ai_budget_cap FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.ai_budget_cap FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.ai_policy     FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.ai_budget_cap FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();

CREATE TRIGGER turn_number BEFORE INSERT ON core.ai_thread_turn FOR EACH ROW EXECUTE FUNCTION core.ai_thread_turn_number();
CREATE TRIGGER summary_untainted BEFORE INSERT OR UPDATE ON core.ai_thread FOR EACH ROW EXECUTE FUNCTION core.ai_thread_summary_untainted();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.ai_thread FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();

CREATE TRIGGER investigation_rules BEFORE INSERT OR UPDATE ON core.investigation FOR EACH ROW EXECUTE FUNCTION core.investigation_rules();
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON core.investigation FOR EACH ROW EXECUTE FUNCTION core.touch_updated_at();
CREATE TRIGGER grant_rules BEFORE INSERT OR UPDATE ON core.investigation_grant FOR EACH ROW EXECUTE FUNCTION core.investigation_grant_rules();
CREATE TRIGGER step_rules BEFORE INSERT OR UPDATE ON core.investigation_step FOR EACH ROW EXECUTE FUNCTION core.investigation_step_rules();
CREATE TRIGGER auto_step_grant BEFORE INSERT ON intel.run FOR EACH ROW EXECUTE FUNCTION intel.run_auto_step_grant();

------------------------------------------------------------------------------------------------------------
-- 8. RLS: enable + force; one permissive policy (forms of 0003/0014/0019) + the restrictive customer_scope and
--    guest_scope (deny form, 0014) on each new tenant table
------------------------------------------------------------------------------------------------------------
-- Threads, investigations and grants: intel.run's scope rule (0014 #37) — visible when the caller's outlet scope covers
-- the row's (review M7: viewer scope ⊇ investigation scope, else 404); a '{*}' row only to an all-outlet owner /
-- advisor / judge or a service context. Turns and steps: exactly when their parent is (0019 O2), new rows too.
DO $$
DECLARE
  t      text;
  tenant constant text := $c$tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)$c$;
  scope  constant text := $c$tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
         AND CASE WHEN outlet_scope = '{*}'
                  THEN (SELECT current_setting('app.outlet_ids', true)) = '{*}'
                       AND (SELECT coalesce(nullif(current_setting('app.role', true), ''), 'service')) IN ('service', 'owner', 'advisor', 'judge')
                  ELSE (SELECT current_setting('app.outlet_ids', true)) = '{*}'
                       OR outlet_scope::uuid[] <@ (SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[] END$c$;
  via    text;
  r      record;
BEGIN
  FOREACH t IN ARRAY ARRAY['core.ai_thread', 'core.ai_thread_turn', 'core.ai_policy', 'core.ai_budget_cap', 'core.investigation',
                           'core.investigation_grant', 'core.investigation_step'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY customer_scope ON %s AS RESTRICTIVE FOR ALL
      USING (((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'customer'))
      WITH CHECK (((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'customer'))$p$, t);
    EXECUTE format($p$CREATE POLICY guest_scope ON %s AS RESTRICTIVE FOR ALL
      USING (((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'guest'))
      WITH CHECK (((SELECT current_setting('app.role', true)) IS DISTINCT FROM 'guest'))$p$, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['core.ai_policy', 'core.ai_budget_cap'] LOOP
    EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (%s) WITH CHECK (%s)', t, tenant, tenant);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['core.ai_thread', 'core.investigation', 'core.investigation_grant'] LOOP
    EXECUTE format('CREATE POLICY tenant_run_scope ON %s USING (%s) WITH CHECK (%s)', t, scope, scope);
  END LOOP;
  FOR r IN SELECT * FROM (VALUES ('ai_thread_turn', 'ai_thread', 'thread_id'),
                                 ('investigation_step', 'investigation', 'investigation_id')) v(child, parent, fk) LOOP
    via := format('%s AND EXISTS (SELECT 1 FROM core.%I x WHERE x.tenant_id = %I.tenant_id AND x.id = %I.%I)', tenant, r.parent, r.child, r.child, r.fk);
    EXECUTE format('CREATE POLICY tenant_via_parent ON core.%I USING (%s) WITH CHECK (%s)', r.child, via, via);
  END LOOP;
END $$;

------------------------------------------------------------------------------------------------------------
-- 9. Tags (R29)
------------------------------------------------------------------------------------------------------------
COMMENT ON TABLE core.ai_thread           IS 'munim:operational';
COMMENT ON TABLE core.ai_thread_turn      IS 'munim:operational';
COMMENT ON TABLE core.ai_policy           IS 'munim:book';
COMMENT ON TABLE core.ai_budget_cap       IS 'munim:book';
COMMENT ON TABLE core.investigation       IS 'munim:operational';
COMMENT ON TABLE core.investigation_step  IS 'munim:operational';
COMMENT ON TABLE core.investigation_grant IS 'munim:operational';

------------------------------------------------------------------------------------------------------------
-- 10. Grants: revoke-then-grant per table. No DELETE/TRUNCATE; UPDATE is column-pinned. munim_svc: SELECT on all
--     seven (run-frame, core-worker), INSERT on investigation_step only, UPDATE on exactly the five investigation
--     columns and the step links — never a book table, never a grant, a thread or a turn.
------------------------------------------------------------------------------------------------------------
REVOKE ALL ON core.ai_thread, core.ai_thread_turn, core.ai_policy, core.ai_budget_cap, core.investigation,
  core.investigation_grant, core.investigation_step FROM PUBLIC;

GRANT SELECT, INSERT ON core.ai_thread TO munim_core;
GRANT UPDATE (summary, updated_at) ON core.ai_thread TO munim_core;
GRANT SELECT ON core.ai_thread TO munim_svc;

-- Insert-once: no UPDATE for anyone (a turn's taint cannot be cleared, its answer cannot be swapped).
GRANT SELECT, INSERT ON core.ai_thread_turn TO munim_core;
GRANT SELECT ON core.ai_thread_turn TO munim_svc;

GRANT SELECT, INSERT ON core.ai_policy TO munim_core;
GRANT UPDATE (mode_ceiling, updated_at) ON core.ai_policy TO munim_core;
GRANT SELECT ON core.ai_policy TO munim_svc;

GRANT SELECT, INSERT ON core.ai_budget_cap TO munim_core;
GRANT UPDATE (monthly_cap_minor, updated_at) ON core.ai_budget_cap TO munim_core;
GRANT SELECT ON core.ai_budget_cap TO munim_svc;

GRANT SELECT, INSERT ON core.investigation TO munim_core;
GRANT UPDATE (status, checklist, steps_done, stop_reason, mode, plan_approved_by, plan_approved_at, updated_at)
  ON core.investigation TO munim_core;
GRANT SELECT ON core.investigation TO munim_svc;
GRANT UPDATE (status, checklist, steps_done, stop_reason, updated_at) ON core.investigation TO munim_svc;

GRANT SELECT, INSERT ON core.investigation_grant TO munim_core;
GRANT UPDATE (revoked_at, revoked_by) ON core.investigation_grant TO munim_core;
GRANT SELECT ON core.investigation_grant TO munim_svc;

GRANT SELECT, INSERT ON core.investigation_step TO munim_core, munim_svc;
GRANT UPDATE (run_id, summary_answer_id, tainted) ON core.investigation_step TO munim_core, munim_svc;

------------------------------------------------------------------------------------------------------------
-- 11. Indexes (every tenant-led FK covered; gotcha 1: asserted from pg_index below)
------------------------------------------------------------------------------------------------------------
CREATE INDEX ai_thread_created_by_fk_idx ON core.ai_thread (tenant_id, created_by);
CREATE INDEX ai_thread_specialist_idx ON core.ai_thread (tenant_id, specialist, updated_at);
CREATE INDEX ai_thread_turn_member_id_fk_idx ON core.ai_thread_turn (tenant_id, member_id);
CREATE INDEX investigation_created_by_fk_idx ON core.investigation (tenant_id, created_by);
CREATE INDEX investigation_plan_approved_by_fk_idx ON core.investigation (tenant_id, plan_approved_by);
-- core-worker's resume scan (T-089b): open Auto investigations of a tenant.
CREATE INDEX investigation_open_auto_idx ON core.investigation (tenant_id, mode, status) WHERE status IN ('open', 'waiting');
CREATE INDEX investigation_grant_investigation_id_fk_idx ON core.investigation_grant (tenant_id, investigation_id);
CREATE UNIQUE INDEX investigation_grant_one_live ON core.investigation_grant (tenant_id, investigation_id) WHERE revoked_at IS NULL;
CREATE INDEX investigation_grant_member_id_fk_idx ON core.investigation_grant (tenant_id, member_id);
CREATE INDEX investigation_grant_revoked_by_fk_idx ON core.investigation_grant (tenant_id, revoked_by);
CREATE INDEX investigation_step_member_id_fk_idx ON core.investigation_step (tenant_id, member_id);
CREATE INDEX investigation_step_grant_id_fk_idx ON core.investigation_step (tenant_id, grant_id);
CREATE INDEX investigation_step_run_id_fk_idx ON core.investigation_step (tenant_id, run_id);
CREATE INDEX investigation_step_summary_answer_id_fk_idx ON core.investigation_step (tenant_id, summary_answer_id);
CREATE INDEX run_grant_id_fk_idx ON intel.run (tenant_id, grant_id);

------------------------------------------------------------------------------------------------------------
-- 12. V1 — intel_ro.investigation_current (owner munim_view_owner; RLS of core.investigation applies as that owner)
------------------------------------------------------------------------------------------------------------
CREATE VIEW intel_ro.investigation_current AS
  SELECT i.id, i.playbook_id, i.params, i.mode, i.status, i.stop_reason, i.checklist, i.updated_at
    FROM core.investigation i;
GRANT SELECT (tenant_id, id, playbook_id, params, outlet_scope, mode, status, stop_reason, checklist, updated_at)
  ON core.investigation TO munim_view_owner;
REVOKE ALL ON intel_ro.investigation_current FROM PUBLIC;
GRANT SELECT ON intel_ro.investigation_current TO munim_intel_ro;
GRANT CREATE ON SCHEMA intel_ro TO munim_view_owner;
ALTER VIEW intel_ro.investigation_current OWNER TO munim_view_owner;
REVOKE CREATE ON SCHEMA intel_ro FROM munim_view_owner;

------------------------------------------------------------------------------------------------------------
-- 13. T2 — templates (run under the minter's RLS; tenant and outlet scope come from the minter, R40 C4)
------------------------------------------------------------------------------------------------------------
-- Per specialist (F8 ids): drafts it proposed (core.draft.source = 'intel:<id>', any status), the decisions on them
-- (approved / edited / rejected), its stale drafts, and its abstains (intel.trace_event kind 'abstain', actor
-- 'specialist:<id>'). Rows only for specialists with at least one count; `specialist` NULL = all of them.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'intel.agent_track_record', 1,
  $q$WITH sp (specialist) AS (VALUES ('catalogue'), ('kitchen'), ('inventory_purchasing'), ('finance'), ('people'),
                                  ('customers'), ('compliance'), ('market')),
d AS (
  SELECT substr(r.source, 7) AS specialist, count(*) AS proposed,
         count(*) FILTER (WHERE dc.verdict = 'approved') AS approved,
         count(*) FILTER (WHERE dc.verdict = 'edited') AS edited,
         count(*) FILTER (WHERE dc.verdict = 'rejected') AS rejected,
         count(*) FILTER (WHERE r.status = 'stale') AS stale
    FROM core.draft r
    LEFT JOIN core.decision dc ON dc.tenant_id = r.tenant_id AND dc.draft_id = r.id
   WHERE r.source LIKE 'intel:%'
   GROUP BY 1),
a AS (
  SELECT substr(t.actor, 12) AS specialist, count(*) AS abstained
    FROM intel.trace_event t
   WHERE t.kind = 'abstain' AND t.actor LIKE 'specialist:%'
   GROUP BY 1)
SELECT sp.specialist, coalesce(d.proposed, 0)::bigint AS proposed, coalesce(d.approved, 0)::bigint AS approved,
       coalesce(d.edited, 0)::bigint AS edited, coalesce(d.rejected, 0)::bigint AS rejected, coalesce(d.stale, 0)::bigint AS stale,
       coalesce(a.abstained, 0)::bigint AS abstained
  FROM sp
  LEFT JOIN d ON d.specialist = sp.specialist
  LEFT JOIN a ON a.specialist = sp.specialist
 WHERE (d.specialist IS NOT NULL OR a.specialist IS NOT NULL)
   AND (:specialist::text IS NULL OR sp.specialist = :specialist::text)
 ORDER BY sp.specialist$q$,
  '{"type": "object", "required": ["specialist"], "additionalProperties": false,
    "properties": {"specialist": {"anyOf": [{"type": "string", "enum": ["catalogue", "kitchen", "inventory_purchasing", "finance",
                                  "people", "customers", "compliance", "market"]}, {"type": "null"}]}}}',
  '[{"name": "specialist", "type": "text"},
    {"name": "proposed", "type": "integer", "numeric_source": "count:core.draft"},
    {"name": "approved", "type": "integer", "numeric_source": "count:core.decision"},
    {"name": "edited", "type": "integer", "numeric_source": "count:core.decision"},
    {"name": "rejected", "type": "integer", "numeric_source": "count:core.decision"},
    {"name": "stale", "type": "integer", "numeric_source": "count:core.draft"},
    {"name": "abstained", "type": "integer", "numeric_source": "count:intel.trace_event"}]',
  'manager');

-- The month's AI budget (F11 O-2): the operator's limit for the month and its spend (platform.llm_budget_spent, UTC
-- month, the budget's currency), the owner's cap when it is in that currency, effective = the lower of the two,
-- left = effective − spent (negative when overspent). 0 rows when the operator set no budget for the month.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'intel.ai_budget_left', 1,
  $q$SELECT b.month, b.currency, c.monthly_cap_minor AS owner_cap_minor, b.limit_minor AS operator_limit_minor,
       least(b.limit_minor, coalesce(c.monthly_cap_minor, b.limit_minor)) AS effective_cap_minor, b.spent_minor,
       least(b.limit_minor, coalesce(c.monthly_cap_minor, b.limit_minor)) - b.spent_minor AS left_minor
  FROM platform.llm_budget_spent b
  LEFT JOIN core.ai_budget_cap c ON c.tenant_id = b.tenant_id AND c.currency = b.currency
 WHERE b.month = :month::date$q$,
  '{"type": "object", "required": ["month"], "additionalProperties": false,
    "properties": {"month": {"type": "string", "format": "date"}}}',
  '[{"name": "month", "type": "date"},
    {"name": "currency", "type": "text"},
    {"name": "owner_cap_minor", "type": "integer", "numeric_source": "core.ai_budget_cap.monthly_cap_minor"},
    {"name": "operator_limit_minor", "type": "integer", "numeric_source": "platform.llm_budget.limit_minor"},
    {"name": "effective_cap_minor", "type": "integer", "numeric_source": ["core.ai_budget_cap.monthly_cap_minor", "platform.llm_budget.limit_minor"]},
    {"name": "spent_minor", "type": "integer", "numeric_source": "intel.intel_spend.amount_minor"},
    {"name": "left_minor", "type": "integer", "numeric_source": ["core.ai_budget_cap.monthly_cap_minor", "platform.llm_budget.limit_minor", "intel.intel_spend.amount_minor"]}]',
  'manager');

-- Plan preview cost (F10, T-089a), labelled "estimate (computed)": per-step spend = round(Σ spend of the runs linked to
-- steps of investigations on the same playbook ÷ the number of those steps), half away from zero, per spend currency;
-- × this investigation's remaining (not frozen) checklist items. 0 rows without step-spend history.
INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES (
  'intel.investigation_cost_estimate', 1,
  $q$WITH inv AS (
  SELECT i.playbook_id, i.checklist FROM core.investigation i WHERE i.id = :investigation_id::uuid),
hist AS (
  SELECT s.currency, sum(s.amount_minor) AS spent, count(DISTINCT (st.investigation_id, st.step_no)) AS steps
    FROM core.investigation i
    JOIN core.investigation_step st ON st.tenant_id = i.tenant_id AND st.investigation_id = i.id
    JOIN intel.intel_spend s ON s.tenant_id = st.tenant_id AND s.run_id = st.run_id
   WHERE i.playbook_id = (SELECT inv.playbook_id FROM inv)
   GROUP BY s.currency),
rem AS (
  SELECT count(*) FILTER (WHERE NOT coalesce((x ->> 'frozen')::boolean, false)) AS items
    FROM inv CROSS JOIN LATERAL jsonb_array_elements(inv.checklist) x)
SELECT h.currency, round(h.spent::numeric / h.steps)::bigint AS per_step_minor, h.steps::bigint AS steps_in_history,
       rem.items::bigint AS remaining_items, (round(h.spent::numeric / h.steps) * rem.items)::bigint AS estimate_minor,
       'estimate (computed)'::text AS label
  FROM hist h CROSS JOIN rem
 ORDER BY h.currency$q$,
  '{"type": "object", "required": ["investigation_id"], "additionalProperties": false,
    "properties": {"investigation_id": {"type": "string", "format": "uuid"}}}',
  '[{"name": "currency", "type": "text"},
    {"name": "per_step_minor", "type": "integer", "numeric_source": ["intel.intel_spend.amount_minor", "count:core.investigation_step"]},
    {"name": "steps_in_history", "type": "integer", "numeric_source": "count:core.investigation_step"},
    {"name": "remaining_items", "type": "integer", "numeric_source": "core.investigation.checklist"},
    {"name": "estimate_minor", "type": "integer", "numeric_source": ["intel.intel_spend.amount_minor", "count:core.investigation_step", "core.investigation.checklist"]},
    {"name": "label", "type": "text"}]',
  'manager');

------------------------------------------------------------------------------------------------------------
-- 14. Post-conditions (never trust IF NOT EXISTS: read back what Postgres holds)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  -- Indexes: exact table, columns (in order), uniqueness and predicate.
  SELECT string_agg(v.name, ', ') INTO bad
    FROM (VALUES
      ('core.ai_thread', 'ai_thread_created_by_fk_idx', 'tenant_id,created_by', false, NULL),
      ('core.ai_thread', 'ai_thread_specialist_idx', 'tenant_id,specialist,updated_at', false, NULL),
      ('core.ai_thread_turn', 'ai_thread_turn_pkey', 'tenant_id,thread_id,turn_no', true, NULL),
      ('core.ai_thread_turn', 'ai_thread_turn_id_unique', 'tenant_id,id', true, NULL),
      ('core.ai_thread_turn', 'ai_thread_turn_answer_unique', 'tenant_id,answer_id', true, NULL),
      ('core.ai_thread_turn', 'ai_thread_turn_member_id_fk_idx', 'tenant_id,member_id', false, NULL),
      ('core.ai_policy', 'ai_policy_one_per_role', 'tenant_id,role', true, NULL),
      ('core.ai_budget_cap', 'ai_budget_cap_one_per_tenant', 'tenant_id', true, NULL),
      ('core.investigation', 'investigation_created_by_fk_idx', 'tenant_id,created_by', false, NULL),
      ('core.investigation', 'investigation_plan_approved_by_fk_idx', 'tenant_id,plan_approved_by', false, NULL),
      ('core.investigation', 'investigation_open_auto_idx', 'tenant_id,mode,status', false,
       $p$(status = ANY (ARRAY['open'::text, 'waiting'::text]))$p$),
      ('core.investigation_grant', 'investigation_grant_investigation_id_fk_idx', 'tenant_id,investigation_id', false, NULL),
      ('core.investigation_grant', 'investigation_grant_one_live', 'tenant_id,investigation_id', true, '(revoked_at IS NULL)'),
      ('core.investigation_grant', 'investigation_grant_member_id_fk_idx', 'tenant_id,member_id', false, NULL),
      ('core.investigation_grant', 'investigation_grant_revoked_by_fk_idx', 'tenant_id,revoked_by', false, NULL),
      ('core.investigation_step', 'investigation_step_pkey', 'tenant_id,investigation_id,step_no', true, NULL),
      ('core.investigation_step', 'investigation_step_member_id_fk_idx', 'tenant_id,member_id', false, NULL),
      ('core.investigation_step', 'investigation_step_grant_id_fk_idx', 'tenant_id,grant_id', false, NULL),
      ('core.investigation_step', 'investigation_step_run_id_fk_idx', 'tenant_id,run_id', false, NULL),
      ('core.investigation_step', 'investigation_step_summary_answer_id_fk_idx', 'tenant_id,summary_answer_id', false, NULL),
      ('intel.run', 'run_grant_id_fk_idx', 'tenant_id,grant_id', false, NULL)) v(tbl, name, cols, uniq, pred)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = v.tbl::regclass AND ic.relname = v.name AND i.indisunique = v.uniq AND i.indisvalid
        AND (SELECT string_agg(a.attname, ',' ORDER BY k.n) FROM unnest(i.indkey) WITH ORDINALITY k(attnum, n)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) = v.cols
        AND pg_get_expr(i.indpred, i.indrelid) IS NOT DISTINCT FROM v.pred);
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0020: indexes not as written: %', bad; END IF;

  -- The widened trigger CHECK and the grant pairing on intel.run, as written.
  IF (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'intel.run'::regclass AND c.conname = 'run_trigger_check')
       IS DISTINCT FROM $d$CHECK ((trigger = ANY (ARRAY['event'::text, 'watch_sweep'::text, 'ask'::text, 'brief'::text, 'auto_step'::text])))$d$
     OR (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'intel.run'::regclass AND c.conname = 'run_grant_iff_auto_step')
       IS DISTINCT FROM $d$CHECK (((trigger = 'auto_step'::text) = (grant_id IS NOT NULL)))$d$
     OR (SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c WHERE c.conrelid = 'core.investigation'::regclass AND c.conname = 'investigation_auto_needs_plan')
       IS DISTINCT FROM $d$CHECK (((mode <> 'auto'::text) OR (plan_approved_by IS NOT NULL)))$d$ THEN
    RAISE EXCEPTION '0020: CHECKs not as written';
  END IF;

  -- Policies: exactly one permissive policy per table, in its form; the two restrictive ones in the deny form.
  SELECT string_agg(v.t, ', ') INTO bad
    FROM (VALUES ('core.ai_thread', 'tenant_run_scope', '%outlet_scope = ''{*}''::text[]%'),
                 ('core.investigation', 'tenant_run_scope', '%outlet_scope = ''{*}''::text[]%'),
                 ('core.investigation_grant', 'tenant_run_scope', '%outlet_scope = ''{*}''::text[]%'),
                 ('core.ai_thread_turn', 'tenant_via_parent', '%FROM core.ai_thread x%'),
                 ('core.investigation_step', 'tenant_via_parent', '%FROM core.investigation x%'),
                 ('core.ai_policy', 'tenant_isolation', '(tenant_id = %'),
                 ('core.ai_budget_cap', 'tenant_isolation', '(tenant_id = %')) v(t, name, pat)
   WHERE (SELECT count(*) FROM pg_policy p WHERE p.polrelid = v.t::regclass AND p.polpermissive) <> 1
      OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = v.t::regclass AND p.polpermissive AND p.polname = v.name
                        AND p.polcmd = '*' AND pg_get_expr(p.polqual, p.polrelid) LIKE v.pat
                        AND pg_get_expr(p.polqual, p.polrelid) = pg_get_expr(p.polwithcheck, p.polrelid))
      OR (SELECT count(*) FROM pg_policy p WHERE p.polrelid = v.t::regclass AND NOT p.polpermissive
             AND ((p.polname = 'customer_scope' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%IS DISTINCT FROM ''customer''::text)')
               OR (p.polname = 'guest_scope' AND pg_get_expr(p.polqual, p.polrelid) LIKE '%IS DISTINCT FROM ''guest''::text)'))
             AND pg_get_expr(p.polqual, p.polrelid) = pg_get_expr(p.polwithcheck, p.polrelid)) <> 2
      OR (SELECT count(*) FROM pg_policy p WHERE p.polrelid = v.t::regclass AND NOT p.polpermissive) <> 2;
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0020: policies not as written on: %', bad; END IF;

  -- Grants, both directions.
  IF NOT has_column_privilege('munim_svc', 'core.investigation', 'status', 'UPDATE')
     OR NOT has_column_privilege('munim_svc', 'core.investigation', 'checklist', 'UPDATE')
     OR NOT has_column_privilege('munim_svc', 'core.investigation', 'steps_done', 'UPDATE')
     OR NOT has_column_privilege('munim_svc', 'core.investigation', 'stop_reason', 'UPDATE')
     OR NOT has_column_privilege('munim_svc', 'core.investigation', 'updated_at', 'UPDATE')
     OR has_column_privilege('munim_svc', 'core.investigation', 'created_by', 'UPDATE')
     OR has_column_privilege('munim_svc', 'core.investigation', 'outlet_scope', 'UPDATE')
     OR has_column_privilege('munim_svc', 'core.investigation', 'mode', 'UPDATE')
     OR has_column_privilege('munim_svc', 'core.investigation', 'plan_approved_by', 'UPDATE')
     OR has_table_privilege('munim_svc', 'core.investigation', 'INSERT')
     OR NOT has_table_privilege('munim_svc', 'core.investigation_step', 'INSERT')
     OR has_table_privilege('munim_svc', 'core.investigation_grant', 'INSERT')
     OR has_any_column_privilege('munim_svc', 'core.investigation_grant', 'UPDATE')
     OR has_table_privilege('munim_svc', 'core.ai_thread', 'INSERT') OR has_table_privilege('munim_svc', 'core.ai_thread_turn', 'INSERT')
     OR has_table_privilege('munim_svc', 'core.ai_policy', 'INSERT') OR has_any_column_privilege('munim_svc', 'core.ai_policy', 'UPDATE')
     OR has_table_privilege('munim_svc', 'core.ai_budget_cap', 'INSERT') OR has_any_column_privilege('munim_svc', 'core.ai_budget_cap', 'UPDATE')
     OR has_any_column_privilege('munim_core', 'core.ai_thread_turn', 'UPDATE') OR has_any_column_privilege('munim_svc', 'core.ai_thread_turn', 'UPDATE')
     OR NOT has_column_privilege('munim_core', 'core.investigation_grant', 'revoked_at', 'UPDATE')
     OR has_column_privilege('munim_core', 'core.investigation_grant', 'member_id', 'UPDATE')
     OR has_column_privilege('munim_core', 'core.investigation_grant', 'outlet_scope', 'UPDATE')
     OR has_column_privilege('munim_core', 'core.ai_budget_cap', 'currency', 'UPDATE')
     OR NOT has_column_privilege('munim_core', 'core.ai_policy', 'mode_ceiling', 'UPDATE')
     OR NOT has_column_privilege('munim_core', 'core.ai_budget_cap', 'monthly_cap_minor', 'UPDATE')
     OR has_table_privilege('munim_intel_ro', 'intel_ro.investigation_current', 'INSERT')
     OR NOT has_table_privilege('munim_intel_ro', 'intel_ro.investigation_current', 'SELECT') THEN
    RAISE EXCEPTION '0020: grants not as written';
  END IF;

  -- Command bindings and book scope, as written.
  IF (SELECT array_agg(command_type || ':' || array_to_string(allowed_roles, '|') || ':' || scope || ':' || array_to_string(target_tables, '|')
                       || ':' || draft_only ORDER BY command_type)
        FROM core.command_authority WHERE command_type LIKE 'ai\_policy.%')
       IS DISTINCT FROM ARRAY['ai_policy.cap.set.v1:owner:tenant:core.ai_budget_cap:false',
                              'ai_policy.ceiling.set.v1:owner:tenant:core.ai_policy:false']
     OR (SELECT count(*) FROM core.book_scope WHERE table_name IN ('core.ai_policy', 'core.ai_budget_cap') AND outlet_kind = 'none') <> 2 THEN
    RAISE EXCEPTION '0020: ai_policy commands or book scope not as written';
  END IF;

  -- The view: owner, exact columns, none numeric (R40 C5).
  IF (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = 'intel_ro.investigation_current'::regclass) <> 'munim_view_owner'
     OR (SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' ORDER BY a.attnum)
           FROM pg_attribute a WHERE a.attrelid = 'intel_ro.investigation_current'::regclass AND a.attnum > 0)
        IS DISTINCT FROM 'id:uuid,playbook_id:text,params:jsonb,mode:text,status:text,stop_reason:text,checklist:jsonb,updated_at:timestamp with time zone' THEN
    RAISE EXCEPTION '0020: intel_ro.investigation_current not as written';
  END IF;

  -- The three templates at their min_role.
  IF (SELECT array_agg(id || ':' || min_role ORDER BY id) FROM evidence.snapshot_template WHERE id LIKE 'intel.%' AND version = 1)
       IS DISTINCT FROM ARRAY['intel.agent_track_record:manager', 'intel.ai_budget_left:manager', 'intel.investigation_cost_estimate:manager'] THEN
    RAISE EXCEPTION '0020: intel templates not as written';
  END IF;

  -- The new triggers, enabled, on their tables.
  SELECT string_agg(v.t || '.' || v.g, ', ') INTO bad
    FROM (VALUES ('core.ai_policy', 'book_guard', 'core.guard_book_write()'), ('core.ai_budget_cap', 'book_guard', 'core.guard_book_write()'),
                 ('core.ai_budget_cap', 'currency_check', 'core.assert_tenant_currency()'),
                 ('core.ai_thread_turn', 'turn_number', 'core.ai_thread_turn_number()'),
                 ('core.ai_thread', 'summary_untainted', 'core.ai_thread_summary_untainted()'),
                 ('core.investigation', 'investigation_rules', 'core.investigation_rules()'),
                 ('core.investigation_grant', 'grant_rules', 'core.investigation_grant_rules()'),
                 ('core.investigation_step', 'step_rules', 'core.investigation_step_rules()'),
                 ('intel.run', 'auto_step_grant', 'intel.run_auto_step_grant()')) v(t, g, f)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = v.t::regclass AND t.tgname = v.g
                        AND t.tgfoid = v.f::regprocedure AND t.tgenabled = 'O');
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0020: triggers missing: %', bad; END IF;

  PERFORM munim_meta.assert_catalog('0020');
END $$;
