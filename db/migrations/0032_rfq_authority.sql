-- 0032_rfq_authority — T-127 (lane C T-114 report §0.1): the command authority of a person's request for quotes. Migrator lane, fix
-- forward over 0001–0031. Runs as munim_migrator. Additive: one core.command_authority row. No table, column, index, policy, trigger,
-- function, grant or derivation rule is changed.
-- Items:
--   A1  purchasing.rfq.request.v1 (POST /v1/rfq-requests, T-114): a person asks the simulated suppliers to quote one ingredient for
--       the outlets they choose. core.command_log.command_type references core.command_authority, and core-api judges every chosen
--       outlet against this row, so until it exists every request is refused. Roles owner, manager, judge and scope outlet: the
--       row of purchasing.po.create.v1 (0003), whose draft the negotiation may end in. It writes no book table (the command's own
--       writes are command_log and audit_log; an RFQ to simulated suppliers is not books, R22), so target_tables is '{}' exactly as
--       the other operational-only commands (findings.dismiss.v1, drafts.approve.v1): the guard's own-command branch admits no
--       book table under it (MB008). Not draft-only, no role cap, no outlet column, no amount cap, no customer table. This is the
--       stand-in T-114's tests inserted, now the migration's row.
-- New SQLSTATEs: none.

------------------------------------------------------------------------------------------------------------
-- 0. Pre-checks: what this file builds on is the shape it builds on.
------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM core.command_authority WHERE command_type = 'purchasing.rfq.request.v1') THEN
    RAISE EXCEPTION '0032: purchasing.rfq.request.v1 already has a command_authority row';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.command_authority
                  WHERE command_type = 'purchasing.po.create.v1' AND allowed_roles = ARRAY['owner', 'manager', 'judge'] AND scope = 'outlet') THEN
    RAISE EXCEPTION '0032: purchasing.po.create.v1 is not the owner/manager/judge outlet row this one mirrors';
  END IF;
END $$;

------------------------------------------------------------------------------------------------------------
-- 1. A1 — purchasing.rfq.request.v1: writes no book table
------------------------------------------------------------------------------------------------------------
INSERT INTO core.command_authority (command_type, allowed_roles, scope, target_tables)
VALUES ('purchasing.rfq.request.v1', ARRAY['owner', 'manager', 'judge'], 'outlet', '{}');

------------------------------------------------------------------------------------------------------------
-- 2. Post-conditions (read back what Postgres holds)
------------------------------------------------------------------------------------------------------------
DO $$
BEGIN
  -- A1: the row exactly as the operational-only commands carry theirs: no book table, no customer table, own commands allowed,
  -- no role cap, no outlet column, no amount cap.
  IF NOT EXISTS (SELECT 1 FROM core.command_authority
                  WHERE command_type = 'purchasing.rfq.request.v1' AND allowed_roles = ARRAY['owner', 'manager', 'judge'] AND scope = 'outlet'
                    AND target_tables = '{}' AND customer_target_tables = '{}' AND NOT draft_only AND role_caps = '{}'
                    AND outlet_column IS NULL AND max_amount_minor IS NULL) THEN
    RAISE EXCEPTION '0032: purchasing.rfq.request.v1 is not the operational-only command written here';
  END IF;

  PERFORM munim_meta.assert_catalog('0032');
END $$;
