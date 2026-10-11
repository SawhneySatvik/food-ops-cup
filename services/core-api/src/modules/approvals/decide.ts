// Approve / reject a draft (03-architecture §1.6, db/README "Approval transaction"; R15, R16, R26, R27).
// Everything happens in ONE munim_core transaction under the approver's own SET LOCAL identity:
//   proposed → executing (conditional, exactly one winner) → authority on the FINAL payload → based_on cells
//   re-run under the approver's scope (changed → `stale`, commit that alone, 0 executions) → core.decision →
//   app.decision_id → the module's handler via executeCommand (audit + outbox) → executed. A handler that finds core's
//   own figures moved since the draft was made (an import preview, R-A 6) throws `stale_draft`: the decision and
//   everything after it roll back, and the draft goes `stale` exactly as above (never `proposed` again).
import { commandEnvelopeOf, draftable, parseRef, snapRef } from "@munim/contracts";
import { DraftsApproveV1, DraftsRejectV1 } from "@munim/contracts/approvals";
import { evaluateAuthority, type AuthorityRow } from "@munim/core-domain/authority";
import type { Deps } from "../../lib/types.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import { contextOf } from "../../auth/resolve.ts";
import { canonicalJson, executeCommand, IdempotencyConflict, uuidv7, type Actor, type CommandContext, type CommandHandler, type OutboxRow, publishCommitted } from "../../commit/index.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { draftHandler } from "./handlers.ts";
import { checkEdit, resolvePayload, snapshotIdsOf } from "./payload.ts";
import { cellOf, type Cell, loadSnapshots, type Member, mintMemberSnapshot, runTemplate, snapIdOf } from "./snapshots.ts";

export type DecideDeps = Pick<Deps, "pools" | "publish" | "log">;

/** Publishes the committed transaction's outbox rows (T-005 publishCommitted). Without a publisher in this
 *  composition, or when delivery fails, the rows stay for the core-worker sweeper; publishing never fails the
 *  request. Called only after withContext has COMMITTED — never inside the approving transaction. */
async function afterCommit(deps: DecideDeps, m: Member, out: Outcome): Promise<Outcome> {
  if (deps.publish) {
    await publishCommitted(deps.publish, m.tenant_id, out.outbox, (ids) => deps.log(`approvals: ${ids.length} event(s) left for the sweeper`));
  }
  return out;
}

/** The stored result text, whether it is a replay, and the outbox rows to publish after the OUTER commit. */
export type Outcome = { body: string; replayed: boolean; outbox: OutboxRow[] };

const ApproveEnvelope = commandEnvelopeOf("drafts.approve.v1", DraftsApproveV1);
const RejectEnvelope = commandEnvelopeOf("drafts.reject.v1", DraftsRejectV1);

interface DraftRow {
  id: string;
  outlet_ids: string[];
  command_type: string;
  command_payload: Record<string, unknown>;
  based_on: unknown[];
  status: string;
}

async function readDraft(c: Queryable, id: string): Promise<DraftRow> {
  const r = await c.query<DraftRow>(
    `SELECT id, outlet_ids, command_type, command_payload, based_on, status FROM core.draft WHERE id = $1`, [id]);
  // RLS hides another tenant's or another outlet's draft: 404, never 403 (gotcha 16).
  if (!r.rows[0]) throw new ApiError("not_found");
  return r.rows[0];
}

const actorOf = (m: Member): Actor => ({ kind: "member", id: m.member_id, role: m.role });

/** core-domain's rule per target outlet, plus the guard's tenant rule (a `tenant` command needs '{*}'),
 *  which evaluateAuthority does not check. A capped row with no amount is denied (fail closed). */
async function authorityRow(c: Queryable, commandType: string) {
  const r = await c.query<AuthorityRow & { max_amount_minor: string | null }>(
    `SELECT command_type, allowed_roles, scope, max_amount_minor FROM core.command_authority WHERE command_type = $1`, [commandType]);
  return r.rows[0];
}

/** The role half alone — what the decision trigger (MB006) checks for the draft's command type. */
const roleAllowed = async (c: Queryable, m: Member, commandType: string) =>
  (await authorityRow(c, commandType))?.allowed_roles.includes(m.role) ?? false;

async function authorized(c: Queryable, m: Member, commandType: string, targets: readonly string[]): Promise<boolean> {
  const row = await authorityRow(c, commandType);
  if (!row) return false;
  // No target outlets = tenant-wide (a `{}` draft, or a command naming no outlet): it needs every outlet ('*'),
  // and is then judged like a tenant-scoped row (role + cap). Tenant-wide drafts are owner-level (ruling #18).
  const tenantWide = row.scope === "tenant" || targets.length === 0;
  if (tenantWide && m.outlet_ids !== "*") return false;
  const rows = [{ ...row, scope: tenantWide ? "tenant" as const : row.scope,
    max_amount_minor: row.max_amount_minor === null ? null : Number(row.max_amount_minor) }];
  const scope = m.outlet_ids === "*" ? ["*"] : m.outlet_ids;
  for (const t of tenantWide ? [null] : targets) {
    if (!evaluateAuthority({ command_type: commandType, role: m.role, outlet_scope: scope, target_outlet_id: t }, rows).allow) return false;
  }
  return true;
}

/** The outlets a command writes to, from its final payload. */
function outletTargets(payload: Record<string, unknown>): string[] {
  if (typeof payload.outlet_id === "string") return [payload.outlet_id];
  if (Array.isArray(payload.outlet_ids)) return payload.outlet_ids.filter((x): x is string => typeof x === "string");
  return [];
}

const norm = (v: Cell | undefined): string | null => (v === null || v === undefined ? null : String(v));

type Change = { ref: string; value: Cell; now_ref: string | null; now: Cell };

/** Re-runs each based_on cell's template — template, version and params taken from the cited snapshot row,
 *  not from the draft — under the approver's scope. The row is matched by its uuid/date cells (by index when
 *  it has none). Returns the changed cells, each new value cited by a snapshot minted for the approver;
 *  null when a based_on ref does not resolve for this approver. */
async function recheck(c: Queryable, m: Member, basedOn: unknown[]): Promise<Change[] | null> {
  const refs = basedOn.map((e) => (typeof e === "string" ? e : (e as { ref?: unknown } | null)?.ref));
  if (refs.some((r) => typeof r !== "string" || snapIdOf(r) === null)) return null;
  const snaps = await loadSnapshots(c, refs.map((r) => snapIdOf(r as string)!), m);
  const changed: Array<{ ref: string; value: Cell; sid: string; row: number; col: string }> = [];
  const reruns = new Map<string, Awaited<ReturnType<typeof runTemplate>>>();
  for (const ref of refs as string[]) {
    const orig = cellOf(ref, snaps);
    if (!orig) return null;
    const sid = snapIdOf(ref)!;
    const s = snaps.get(sid)!;
    const { row: at, column: col } = parseRef(ref) as { row: number; column: string };
    const origRow = s.rows[at]!;
    if (!reruns.has(sid)) reruns.set(sid, await runTemplate(c, s.template_id, s.template_version, s.params));
    const rerun = reruns.get(sid)!;
    const keys = s.columns.filter((x) => x.type === "uuid" || x.type === "date").map((x) => x.name);
    const row = keys.length
      ? rerun.rows.findIndex((r) => keys.every((k) => norm(r[k]) === norm(origRow[k])))
      : rerun.rows[at] ? at : -1;
    if (row < 0 || norm(rerun.rows[row]![col]) !== norm(orig.value)) changed.push({ ref, value: orig.value, sid, row, col });
  }
  const minted = new Map<string, string>();
  for (const ch of changed) {
    if (!minted.has(ch.sid)) {
      const s = snaps.get(ch.sid)!;
      minted.set(ch.sid, await mintMemberSnapshot(c, m, s.template_id, s.template_version, s.params, reruns.get(ch.sid)!.rows));
    }
  }
  return changed.map((ch) => ch.row < 0
    ? { ref: ch.ref, value: ch.value, now_ref: null, now: null }
    : { ref: ch.ref, value: ch.value, now_ref: snapRef(minted.get(ch.sid)!, ch.row, ch.col), now: reruns.get(ch.sid)!.rows[ch.row]![ch.col]! });
}

async function audit(c: Queryable, m: Member, draftId: string, after: Record<string, unknown>, decisionId: string | null) {
  await c.query(
    `INSERT INTO core.audit_log (tenant_id, actor, action, entity, entity_id, after, decision_id) VALUES ($1, $2, 'drafts.approve.v1', 'core.draft', $3, $4, $5)`,
    [m.tenant_id, actorOf(m), draftId, after, decisionId]);
}

/** A database refusal that will not succeed on retry (data/constraint/guard): the draft becomes `failed`.
 *  Anything else (serialisation, connection, a handler bug) rolls back to `proposed`. */
const permanent = (e: unknown) => {
  const s = (e as { code?: unknown } | null)?.code;
  return typeof s === "string" && /^(22|23|MB|42501)/.test(s);
};

async function replayIfKnown(c: Queryable, ctx: CommandContext, command: Parameters<typeof executeCommand>[1], h: CommandHandler,
  sameDecision: boolean): Promise<Outcome | null> {
  // The same lock executeCommand takes, held to commit: a concurrent request with this key waits, then replays.
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('core.command_log:' || $1 || ':' || $2, 0))`, [ctx.tenantId, command.idempotency_key]);
  const prior = await c.query(`SELECT 1 FROM core.command_log WHERE tenant_id = $1 AND idempotency_key = $2`, [ctx.tenantId, command.idempotency_key]);
  if (!prior.rows[0]) return null;
  if (!sameDecision) throw new IdempotencyConflict();
  // executeCommand compares the request hash: identical → the stored body, different → IdempotencyConflict.
  return executeCommand(ctx, command, h);
}

export async function approveDraft(deps: DecideDeps, m: Member, draftId: string, body: unknown): Promise<Outcome> {
  const { pools } = deps;
  const env = ApproveEnvelope.safeParse(body);
  if (!env.success) {
    const type = (body as { payload?: { command_type?: unknown } } | null)?.payload?.command_type;
    throw new ApiError(typeof type === "string" && !draftable(type) ? "unregistered_command_type" : "invalid_payload");
  }
  const { command_id, idempotency_key, payload: p } = env.data;
  if (p.draft_id !== draftId) throw new ApiError("invalid_payload");

  const result = await withContext(pools.core, contextOf(m), async (c): Promise<Outcome | { stale: Change[] } | { failed: true }> => {
    const draft = await readDraft(c, draftId);
    const d = draftable(draft.command_type);
    const h = draftHandler(draft.command_type);
    if (!d || !h) throw new ApiError("unregistered_command_type");
    if (p.command_type !== draft.command_type || !d.editable.safeParse(draft.command_payload).success) throw new ApiError("invalid_payload");

    // A person without authority is told so before anything is resolved (their scope may not open the cells).
    if (!(await authorized(c, m, "drafts.approve.v1", draft.outlet_ids)) || !(await roleAllowed(c, m, draft.command_type))) {
      throw new ApiError("forbidden", "authority_denied");
    }

    const edited = p.edited_payload;
    if (edited && checkEdit(edited, draft.command_payload, m.member_id)) throw new ApiError("invalid_payload");
    const final = edited ?? draft.command_payload;
    const resolved = resolvePayload(final, await loadSnapshots(c, snapshotIdsOf(final), m));
    if (!resolved.ok) throw new ApiError("cannot_verify", "unresolved_ref", { refs: resolved.unresolved });
    const cmd = d.command.safeParse(resolved.payload);
    if (!cmd.success) throw new ApiError("invalid_payload");
    const targets = outletTargets(cmd.data as Record<string, unknown>);
    if (draft.outlet_ids.length && targets.some((t) => !draft.outlet_ids.includes(t))) throw new ApiError("invalid_payload");
    // Authority on the FINAL payload (R27): its target outlets and, where the row has a cap, its amount.
    if (!(await authorized(c, m, draft.command_type, targets))) throw new ApiError("forbidden", "authority_denied");

    const command = { command_id, idempotency_key, type: draft.command_type, payload: cmd.data as Record<string, unknown> };
    const base = { tx: <T>(fn: (q: Queryable) => Promise<T>) => fn(c), tenantId: m.tenant_id, actor: actorOf(m) };
    const verdict = edited ? "edited" : "approved";
    // The inner command's hash covers neither the draft id nor the verdict, edit form or reason: a replay must
    // also match THIS draft's stored decision, or it is a different request under a reused key.
    const prior = await c.query<{ verdict: string; final_payload: unknown; reason: string | null; decided_by: string }>(
      `SELECT verdict, final_payload, reason, decided_by FROM core.decision WHERE draft_id = $1`, [draftId]);
    const dec = prior.rows[0];
    // No decision on THIS draft while the key exists = the key was used for another draft (F8): conflict.
    const sameDecision = !!dec && (dec.verdict === verdict && dec.reason === p.reason && dec.decided_by === m.member_id
      && canonicalJson(dec.final_payload) === canonicalJson(final));
    const replay = await replayIfKnown(c, base, command, h, sameDecision);
    if (replay) return replay;

    const won = await c.query(
      `UPDATE core.draft SET status = 'executing', exec_txid = txid_current() WHERE id = $1 AND status = 'proposed' RETURNING id`, [draftId]);
    if (won.rowCount !== 1) {
      // A retry after a stale or failed outcome gets that outcome again, not "already decided".
      const now = (await c.query<{ status: string }>(`SELECT status FROM core.draft WHERE id = $1`, [draftId])).rows[0]?.status;
      if (now === "stale") throw new ApiError("stale_draft", "stale_draft");
      if (now === "failed") throw new ApiError("execution_failed");
      throw new ApiError("already_decided");
    }

    const changes = await recheck(c, m, draft.based_on);
    if (changes === null) throw new ApiError("cannot_verify", "unresolved_ref");
    if (changes.length) {
      await c.query(`UPDATE core.draft SET status = 'stale' WHERE id = $1`, [draftId]);
      await audit(c, m, draftId, { status: "stale", changes: changes.map(({ ref, now_ref }) => ({ ref, now_ref })) }, null);
      return { stale: changes };
    }

    const decisionId = uuidv7();
    await c.query("SAVEPOINT draft_decide");
    await c.query(
      `INSERT INTO core.decision (tenant_id, id, draft_id, verdict, final_payload, reason, decided_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [m.tenant_id, decisionId, draftId, verdict, final, p.reason, m.member_id]);
    await c.query(`SELECT set_config('app.decision_id', $1, true)`, [decisionId]);
    const wrapped: CommandHandler = {
      type: h.type,
      async run(q, cmdEnv) {
        const out = await h.run(q, cmdEnv);
        return { ...out, audit: [...out.audit, { action: "drafts.approve.v1", entity: "core.draft", entityId: draftId, after: { status: "executed", verdict } }] };
      },
    };
    await c.query("SAVEPOINT draft_exec");
    let done: Outcome;
    try {
      // No `publish` here: it would fire before this OUTER transaction commits (afterCommit publishes).
      done = await executeCommand({ ...base, decisionId }, command, wrapped);
    } catch (e) {
      if (e instanceof ApiError && e.code === "stale_draft") {
        await c.query("ROLLBACK TO SAVEPOINT draft_decide");
        await c.query(`UPDATE core.draft SET status = 'stale' WHERE id = $1`, [draftId]);
        await audit(c, m, draftId, { status: "stale", changes: [] }, null);
        return { stale: [] };
      }
      if (!permanent(e)) throw e;
      await c.query("ROLLBACK TO SAVEPOINT draft_exec");
      // failure_reason (0014): the refusing SQLSTATE as a code, e.g. sqlstate_23p01 — never exception text.
      await c.query(`UPDATE core.draft SET status = 'failed', failure_reason = $2 WHERE id = $1`,
        [draftId, `sqlstate_${(e as { code: string }).code.toLowerCase()}`]);
      await audit(c, m, draftId, { status: "failed", sqlstate: (e as { code: string }).code }, decisionId);
      return { failed: true };
    }
    await c.query(`UPDATE core.draft SET status = 'executed' WHERE id = $1`, [draftId]);
    return done;
  });

  if ("stale" in result) throw new ApiError("stale_draft", "stale_draft", { changes: result.stale });
  if ("failed" in result) throw new ApiError("execution_failed");
  return afterCommit(deps, m, result);
}

export async function rejectDraft(deps: DecideDeps, m: Member, draftId: string, body: unknown): Promise<Outcome> {
  const { pools } = deps;
  const env = RejectEnvelope.safeParse(body);
  if (!env.success || env.data.payload.draft_id !== draftId) throw new ApiError("invalid_payload");
  const reason = env.data.payload.reason;
  // No column holds the code yet (migrator request): it rides in the audit entry, which lineage reads.
  const reasonCode = env.data.payload.reason_code;
  const out = await withContext(pools.core, contextOf(m), async (c) => {
    const draft = await readDraft(c, draftId);
    if (!(await authorized(c, m, "drafts.reject.v1", draft.outlet_ids)) || !(await roleAllowed(c, m, draft.command_type))) {
      throw new ApiError("forbidden", "authority_denied");
    }
    const decisionId = uuidv7();
    await c.query(`SELECT set_config('app.decision_id', $1, true)`, [decisionId]);
    const handler: CommandHandler = {
      type: "drafts.reject.v1",
      async run(q) {
        const r = await q.query(`UPDATE core.draft SET status = 'rejected' WHERE id = $1 AND status = 'proposed' RETURNING id`, [draftId]);
        if (r.rowCount !== 1) throw new ApiError("already_decided");
        await q.query(
          `INSERT INTO core.decision (tenant_id, id, draft_id, verdict, final_payload, reason, decided_by) VALUES ($1, $2, $3, 'rejected', NULL, $4, $5)`,
          [m.tenant_id, decisionId, draftId, reason, m.member_id]);
        return { entityId: draftId, audit: [{ entity: "core.draft", entityId: draftId, after: { status: "rejected", verdict: "rejected", ...(reasonCode ? { reason_code: reasonCode } : {}) } }] };
      },
    };
    const ctx = { tx: <T>(fn: (q: Queryable) => Promise<T>) => fn(c), tenantId: m.tenant_id, actor: actorOf(m), decisionId };
    return executeCommand(ctx, env.data, handler);
  });
  return afterCommit(deps, m, out);
}
