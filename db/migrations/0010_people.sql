-- 0010_people — people (02-schema §2.8, packs/people.md): staff, rosters and shifts, attendance, payroll
-- drafts (pack scope), advances, tip pools, training, hiring. All books (R29: rosters/payroll/advances/tips;
-- personal records). Runs as munim_migrator. RLS predicates: see the header of 0003. Outlet-scoped per
-- 02-schema §0: roster_shift, attendance.
--
-- Payroll scope (R21, packs/people.md): a payroll draft is refused unless the tenant's country pack has
-- payroll_scope = 'drafts' (IN today; AU is 'roster_only') — MB013 out_of_pack_scope. Read from
-- platform.country_pack at write time, never hard-coded by country (project rule 7).

-- Labour cost = attended minutes × wage_rate_minor (per hour); monthly staff carry a salary and the contract
-- minutes it covers, and core derives their hourly rate from those (packs/people.md §2).
CREATE TABLE core.staff (
  tenant_id              uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id                     uuid        NOT NULL,
  member_id              uuid,
  outlet_id              uuid        NOT NULL,
  name                   text        NOT NULL CHECK (name <> ''),
  phone                  text        CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  role_key               text        NOT NULL CHECK (role_key ~ '^[a-z][a-z0-9_]*$'),
  pay_basis              text        NOT NULL CHECK (pay_basis IN ('hourly', 'monthly')),
  wage_rate_minor        bigint      CHECK (wage_rate_minor >= 0),
  monthly_salary_minor   bigint      CHECK (monthly_salary_minor >= 0),
  contract_min_per_month integer     CHECK (contract_min_per_month > 0),
  ot_multiplier_bp       integer     NOT NULL CHECK (ot_multiplier_bp BETWEEN 10000 AND 40000),
  currency               char(3)     NOT NULL,
  joined_on              date        NOT NULL,
  left_on                date,
  active                 boolean     NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  origin                 jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, member_id),
  FOREIGN KEY (tenant_id, member_id) REFERENCES core.member (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  CHECK ((pay_basis = 'hourly') = (wage_rate_minor IS NOT NULL)),
  CHECK ((pay_basis = 'monthly') = (monthly_salary_minor IS NOT NULL AND contract_min_per_month IS NOT NULL)),
  CHECK (left_on IS NULL OR left_on >= joined_on)
);

-- A week's roster for one outlet (week_start = Monday). At most one active roster per outlet-week.
CREATE TABLE core.roster (
  tenant_id  uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id         uuid        NOT NULL,
  outlet_id  uuid        NOT NULL,
  week_start date        NOT NULL CHECK (extract(isodow FROM week_start) = 1),
  status     text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  draft_id   uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  origin     jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, draft_id) REFERENCES core.draft (tenant_id, id)
);
CREATE UNIQUE INDEX roster_one_active_per_week ON core.roster (tenant_id, outlet_id, week_start) WHERE status = 'active';

-- A person cannot be rostered on two overlapping shifts (any outlet).
CREATE TABLE core.roster_shift (
  tenant_id  uuid        NOT NULL,
  id         uuid        NOT NULL,
  roster_id  uuid        NOT NULL,
  outlet_id  uuid        NOT NULL,
  staff_id   uuid        NOT NULL,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  role_key   text        NOT NULL CHECK (role_key ~ '^[a-z][a-z0-9_]*$'),
  status     text        NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  origin     jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id, roster_id) REFERENCES core.roster (tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES core.staff (tenant_id, id),
  CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '24 hours'),
  CONSTRAINT roster_shift_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, staff_id WITH =, (tstzrange(starts_at, ends_at, '[)')) WITH &&) WHERE (status = 'scheduled')
);

-- Clock-in/out. clock_out_at stays NULL while the shift is open.
CREATE TABLE core.attendance (
  tenant_id       uuid        NOT NULL,
  id              uuid        NOT NULL,
  outlet_id       uuid        NOT NULL,
  staff_id        uuid        NOT NULL,
  roster_shift_id uuid,
  clock_in_at     timestamptz NOT NULL,
  clock_out_at    timestamptz,
  source          text        NOT NULL CHECK (source IN ('device', 'manual')),
  recorded_by     uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  origin          jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES core.staff (tenant_id, id),
  FOREIGN KEY (tenant_id, roster_shift_id) REFERENCES core.roster_shift (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES core.member (tenant_id, id),
  CHECK (clock_out_at IS NULL OR (clock_out_at > clock_in_at AND clock_out_at <= clock_in_at + interval '24 hours'))
);

-- The approved payroll computation for one outlet-month (IN only, pack scope); payment happens elsewhere.
CREATE TABLE core.payroll_draft (
  tenant_id    uuid        NOT NULL REFERENCES core.tenant (tenant_id),
  id           uuid        NOT NULL,
  outlet_id    uuid        NOT NULL,
  period_month date        NOT NULL CHECK (extract(day FROM period_month) = 1),
  status       text        NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'paid_externally', 'void')),
  currency     char(3)     NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  origin       jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id)
);
CREATE UNIQUE INDEX payroll_draft_one_per_month ON core.payroll_draft (tenant_id, outlet_id, period_month) WHERE status <> 'void';

CREATE TABLE core.payroll_draft_line (
  tenant_id              uuid    NOT NULL,
  id                     uuid    NOT NULL,
  payroll_draft_id       uuid    NOT NULL,
  staff_id               uuid    NOT NULL,
  base_minor             bigint  NOT NULL CHECK (base_minor >= 0),
  overtime_minor         bigint  NOT NULL CHECK (overtime_minor >= 0),
  tips_minor             bigint  NOT NULL CHECK (tips_minor >= 0),
  advance_recovery_minor bigint  NOT NULL CHECK (advance_recovery_minor >= 0),
  net_minor              bigint  NOT NULL,
  currency               char(3) NOT NULL,
  origin                 jsonb   NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, payroll_draft_id, staff_id),
  FOREIGN KEY (tenant_id, payroll_draft_id) REFERENCES core.payroll_draft (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES core.staff (tenant_id, id),
  CHECK (net_minor = base_minor + overtime_minor + tips_minor - advance_recovery_minor)
);

-- Append-only entries; outstanding = Σ given − Σ recovered (packs/people.md §2).
CREATE TABLE core.advance (
  tenant_id        uuid        NOT NULL,
  id               uuid        NOT NULL,
  staff_id         uuid        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('given', 'recovered')),
  amount_minor     bigint      NOT NULL CHECK (amount_minor > 0),
  currency         char(3)     NOT NULL,
  on_date          date        NOT NULL,
  payroll_draft_id uuid,
  note             text,
  recorded_by      uuid        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  origin           jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES core.staff (tenant_id, id),
  FOREIGN KEY (tenant_id, payroll_draft_id) REFERENCES core.payroll_draft (tenant_id, id),
  FOREIGN KEY (tenant_id, recorded_by) REFERENCES core.member (tenant_id, id),
  CHECK (payroll_draft_id IS NULL OR kind = 'recovered')
);

-- A pool of tips for an outlet and period, and each person's share of it.
CREATE TABLE core.tip_pool (
  tenant_id    uuid        NOT NULL,
  id           uuid        NOT NULL,
  outlet_id    uuid        NOT NULL,
  period_from  date        NOT NULL,
  period_to    date        NOT NULL,
  basis        text        NOT NULL CHECK (basis IN ('equal', 'hours', 'manual')),
  total_minor  bigint      NOT NULL CHECK (total_minor >= 0),
  currency     char(3)     NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  origin       jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id),
  CHECK (period_to >= period_from)
);

CREATE TABLE core.tip_pool_share (
  tenant_id    uuid    NOT NULL,
  id           uuid    NOT NULL,
  tip_pool_id  uuid    NOT NULL,
  staff_id     uuid    NOT NULL,
  amount_minor bigint  NOT NULL CHECK (amount_minor >= 0),
  currency     char(3) NOT NULL,
  origin       jsonb   NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, tip_pool_id, staff_id),
  FOREIGN KEY (tenant_id, tip_pool_id) REFERENCES core.tip_pool (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES core.staff (tenant_id, id)
);

CREATE TABLE core.training_record (
  tenant_id    uuid        NOT NULL,
  id           uuid        NOT NULL,
  staff_id     uuid        NOT NULL,
  course_key   text        NOT NULL CHECK (course_key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$'),
  completed_on date        NOT NULL,
  valid_to     date,
  document_id  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  origin       jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, staff_id) REFERENCES core.staff (tenant_id, id),
  FOREIGN KEY (tenant_id, document_id) REFERENCES core.document (tenant_id, id),
  CHECK (valid_to IS NULL OR valid_to >= completed_on)
);

CREATE TABLE core.hiring_candidate (
  tenant_id  uuid        NOT NULL,
  id         uuid        NOT NULL,
  outlet_id  uuid        NOT NULL,
  name       text        NOT NULL CHECK (name <> ''),
  phone      text        CHECK (phone ~ '^\+[1-9][0-9]{6,14}$'),
  email      text,
  role_key   text        NOT NULL CHECK (role_key ~ '^[a-z][a-z0-9_]*$'),
  stage      text        NOT NULL DEFAULT 'applied'
               CHECK (stage IN ('applied', 'interviewed', 'offered', 'hired', 'rejected', 'withdrawn')),
  source     text,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  origin     jsonb       NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES core.outlet (tenant_id, id)
);

------------------------------------------------------------------------------------------------------------
-- Functions and triggers
------------------------------------------------------------------------------------------------------------
-- Pack scope: payroll drafts only where the tenant's active pack says payroll_scope = 'drafts'.
CREATE FUNCTION core.payroll_pack_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE scope text;
BEGIN
  SELECT p.doc ->> 'payroll_scope' INTO scope
    FROM core.tenant t JOIN platform.country_pack p ON p.code = t.country_code AND p.status = 'active'
   WHERE t.tenant_id = NEW.tenant_id
   ORDER BY p.version DESC LIMIT 1;
  IF scope IS DISTINCT FROM 'drafts' THEN
    RAISE EXCEPTION 'out_of_pack_scope: payroll is not prepared under this country pack (payroll_scope = %)',
      coalesce(scope, 'unknown') USING ERRCODE = 'MB013';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.payroll_pack_scope() FROM PUBLIC;

CREATE TRIGGER pack_scope BEFORE INSERT ON core.payroll_draft FOR EACH ROW EXECUTE FUNCTION core.payroll_pack_scope();

CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.staff              FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.roster             FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.roster_shift       FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.attendance         FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.payroll_draft      FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.payroll_draft_line FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.advance            FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.tip_pool           FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.tip_pool_share     FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.training_record    FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.hiring_candidate   FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();

CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.staff              FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.payroll_draft      FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.payroll_draft_line FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.advance            FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.tip_pool           FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');
CREATE TRIGGER currency_check BEFORE INSERT OR UPDATE ON core.tip_pool_share     FOR EACH ROW EXECUTE FUNCTION core.assert_tenant_currency('currency');

------------------------------------------------------------------------------------------------------------
-- RLS: tenant policy, outlet policy on roster_shift and attendance (02-schema §0)
------------------------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff', 'roster', 'payroll_draft', 'payroll_draft_line', 'advance', 'tip_pool',
                           'tip_pool_share', 'training_record', 'hiring_candidate'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON core.%I
      USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))
      WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))$p$, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['roster_shift', 'attendance'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_outlet_isolation ON core.%I
      USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
             AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
                  OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))
      WITH CHECK (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
             AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
                  OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))$p$, t);
  END LOOP;
END $$;

COMMENT ON TABLE core.staff              IS 'munim:book';
COMMENT ON TABLE core.roster             IS 'munim:book';
COMMENT ON TABLE core.roster_shift       IS 'munim:book';
COMMENT ON TABLE core.attendance         IS 'munim:book';
COMMENT ON TABLE core.payroll_draft      IS 'munim:book';
COMMENT ON TABLE core.payroll_draft_line IS 'munim:book';
COMMENT ON TABLE core.advance            IS 'munim:book';
COMMENT ON TABLE core.tip_pool           IS 'munim:book';
COMMENT ON TABLE core.tip_pool_share     IS 'munim:book';
COMMENT ON TABLE core.training_record    IS 'munim:book';
COMMENT ON TABLE core.hiring_candidate   IS 'munim:book';

------------------------------------------------------------------------------------------------------------
-- Grants. Advances, payroll lines and tip shares are append-only.
------------------------------------------------------------------------------------------------------------
REVOKE ALL ON core.staff, core.roster, core.roster_shift, core.attendance, core.payroll_draft, core.payroll_draft_line,
  core.advance, core.tip_pool, core.tip_pool_share, core.training_record, core.hiring_candidate FROM PUBLIC;
GRANT SELECT ON core.staff, core.roster, core.roster_shift, core.attendance, core.payroll_draft, core.payroll_draft_line,
  core.advance, core.tip_pool, core.tip_pool_share, core.training_record, core.hiring_candidate TO munim_core, munim_svc;
GRANT INSERT ON core.staff, core.roster, core.roster_shift, core.attendance, core.payroll_draft, core.payroll_draft_line,
  core.advance, core.tip_pool, core.tip_pool_share, core.training_record, core.hiring_candidate TO munim_core;

GRANT UPDATE (outlet_id, name, phone, role_key, pay_basis, wage_rate_minor, monthly_salary_minor, contract_min_per_month,
  ot_multiplier_bp, left_on, active) ON core.staff TO munim_core;
GRANT UPDATE (status) ON core.roster TO munim_core;
GRANT UPDATE (starts_at, ends_at, role_key, status) ON core.roster_shift TO munim_core;
GRANT UPDATE (clock_out_at) ON core.attendance TO munim_core;
GRANT UPDATE (status) ON core.payroll_draft TO munim_core;
GRANT UPDATE (stage, note) ON core.hiring_candidate TO munim_core;

------------------------------------------------------------------------------------------------------------
-- Indexes
------------------------------------------------------------------------------------------------------------
CREATE INDEX staff_outlet_id_fk_idx ON core.staff (tenant_id, outlet_id);
CREATE INDEX roster_draft_id_fk_idx ON core.roster (tenant_id, draft_id);
CREATE INDEX roster_shift_outlet_id_roster_id_fk_idx ON core.roster_shift (tenant_id, outlet_id, roster_id);
CREATE INDEX roster_shift_staff_id_fk_idx ON core.roster_shift (tenant_id, staff_id, starts_at);
CREATE INDEX attendance_outlet_id_fk_idx ON core.attendance (tenant_id, outlet_id, clock_in_at);
CREATE INDEX attendance_staff_id_fk_idx ON core.attendance (tenant_id, staff_id);
CREATE INDEX attendance_roster_shift_id_fk_idx ON core.attendance (tenant_id, roster_shift_id);
CREATE INDEX attendance_recorded_by_fk_idx ON core.attendance (tenant_id, recorded_by);
CREATE INDEX payroll_draft_outlet_id_fk_idx ON core.payroll_draft (tenant_id, outlet_id);
CREATE INDEX payroll_draft_line_staff_id_fk_idx ON core.payroll_draft_line (tenant_id, staff_id);
CREATE INDEX advance_staff_id_fk_idx ON core.advance (tenant_id, staff_id);
CREATE INDEX advance_payroll_draft_id_fk_idx ON core.advance (tenant_id, payroll_draft_id);
CREATE INDEX advance_recorded_by_fk_idx ON core.advance (tenant_id, recorded_by);
CREATE INDEX tip_pool_outlet_id_fk_idx ON core.tip_pool (tenant_id, outlet_id);
CREATE INDEX tip_pool_share_staff_id_fk_idx ON core.tip_pool_share (tenant_id, staff_id);
CREATE INDEX training_record_staff_id_fk_idx ON core.training_record (tenant_id, staff_id);
CREATE INDEX training_record_document_id_fk_idx ON core.training_record (tenant_id, document_id);
CREATE INDEX hiring_candidate_outlet_id_fk_idx ON core.hiring_candidate (tenant_id, outlet_id);

------------------------------------------------------------------------------------------------------------
-- Command authority with table bindings (draft types from packs/people.md §6; member commands INFERENCE)
------------------------------------------------------------------------------------------------------------
INSERT INTO core.command_authority (command_type, allowed_roles, scope, target_tables) VALUES
  ('people.staff.upsert.v1',         ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.staff']),
  ('people.roster.create.v1',        ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.roster', 'core.roster_shift']),
  ('people.roster.update.v1',        ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.roster', 'core.roster_shift']),
  ('people.attendance.record.v1',    ARRAY['owner', 'manager', 'staff', 'judge'], 'outlet', ARRAY['core.attendance']),
  ('people.payroll_draft.create.v1', ARRAY['owner', 'judge'],                     'outlet',
                                     ARRAY['core.payroll_draft', 'core.payroll_draft_line', 'core.advance']),
  ('people.advance.record.v1',       ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.advance']),
  ('people.tip_pool.record.v1',      ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.tip_pool', 'core.tip_pool_share']),
  ('people.training.record.v1',      ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.training_record']),
  ('people.candidate.upsert.v1',     ARRAY['owner', 'manager', 'judge'],          'outlet', ARRAY['core.hiring_candidate']);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'roster_shift_no_overlap' AND contype = 'x'
                    AND conrelid = 'core.roster_shift'::regclass) THEN
    RAISE EXCEPTION '0010: roster_shift_no_overlap missing';
  END IF;
  PERFORM munim_meta.assert_catalog('0010');
END $$;
