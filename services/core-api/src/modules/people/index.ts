// People module (T-027): staff, rosters + shifts, attendance, payroll drafts (IN only), advances, tip pools,
// training, hiring candidates, and the overtime / payroll-preview read models.
//   POST /v1/people/staff:upsert · /rosters · /rosters:update · /attendance · /payroll-drafts · /advances ·
//        /tip-pools · /training · /candidates:upsert     (command envelope → CommandResult)
//   GET  /v1/people/overtime?outlet=&from=&to=         GET /v1/people/payroll-preview?outlet=&month=
//   GET  /v1/people/rosters · attendance · advances · payroll-drafts   row lists (T-092b, routes.ts; staff see only their own shifts)
//   GET  /v1/people/staff?outlet=                      (staff with pay terms; not for staff-role members)
// Two commands are draftable (R16): people.roster.create.v1 and people.payroll_draft.create.v1. Their handlers are
// registered with approvals; a draft writes nothing until a person with authority approves it.
import {
  commandEnvelopeOf,
} from "@munim/contracts";
import {
  PeopleAdvanceRecordV1, PeopleAttendanceRecordV1, PeopleCandidateUpsertV1, PeoplePayrollDraftCreateV1, PeoplePayrollDraftStatusV1, PeopleRosterCreateV1,
  PeopleRosterUpdateV1, PeopleStaffUpsertV1, PeopleTipPoolRecordV1, PeopleTrainingRecordV1,
} from "@munim/contracts/people";
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { type CommandHandler, executeCommand, replayHeaders, publishCommitted, type Actor } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { registerDraftHandler } from "../approvals/index.ts";
import {
  advanceHandler, attendanceHandler, candidateHandler, rosterCreateHandler, rosterUpdateHandler, staffUpsertHandler, tipPoolHandler, trainingHandler,
} from "./commands.ts";
import { overtimeRows, requireAttendance } from "./overtime.ts";
import { listStaff, payrollDraftHandler, payrollStatusHandler, previewPayroll } from "./payroll.ts";
import { readRoutes } from "./routes.ts";

// Register once per process even if this file is loaded twice (vitest imports by path, loadRouters by URL).
const REGISTERED = Symbol.for("munim.people.draftHandlersRegistered");
const g = globalThis as unknown as Record<symbol, true | undefined>;
if (!g[REGISTERED]) {
  g[REGISTERED] = true;
  for (const h of [rosterCreateHandler, payrollDraftHandler]) registerDraftHandler(h);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function member(c: Context<AppEnv>) {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

async function json(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError("bad_request");
  }
}

/** `pathId`: for `/v1/…/{id}:<verb>` routes, the path id must equal the payload field it names. */
function commandRoute(handler: CommandHandler, payload: Parameters<typeof commandEnvelopeOf>[1], pathId?: { field: string; verb: string }) {
  const Envelope = commandEnvelopeOf(handler.type, payload);
  return async (c: Context<AppEnv>) => {
    const m = member(c);
    const env = Envelope.safeParse(await json(c));
    if (!env.success) throw new ApiError("invalid_payload");
    if (pathId && (env.data.payload as Record<string, unknown>)[pathId.field] !== c.req.param("action")!.slice(0, -pathId.verb.length)) {
      throw new ApiError("invalid_payload");
    }
    const actor: Actor = { kind: "member", id: m.member_id, role: m.role };
    const out = await withContext(c.var.deps.pools.core, contextOf(m), (db) =>
      executeCommand({ tx: <T>(fn: (q: Queryable) => Promise<T>) => fn(db), tenantId: m.tenant_id, actor }, env.data as Parameters<typeof executeCommand>[1], handler));
    const deps = c.var.deps;
    if (deps.publish && out.outbox.length) await publishCommitted(deps.publish, m.tenant_id, out.outbox, () => {});
    return c.body(out.body, 200, { "Content-Type": "application/json", ...replayHeaders(out) });
  };
}

/** An outlet outside the member's scope reads as not found (gotcha 16), before any row is touched. */
function inScope(m: { outlet_ids: "*" | string[] }, outlet: string) {
  if (m.outlet_ids !== "*" && !m.outlet_ids.includes(outlet)) throw new ApiError("not_found");
}

/** Wage-bearing reads: staff-role members do not see them. */
function readerOf(c: Context<AppEnv>) {
  const m = member(c);
  if (m.role === "staff") throw new ApiError("forbidden", "authority_denied");
  return m;
}

export const router = new Hono<AppEnv>()
  .post("/v1/people/staff:upsert", requireMember, commandRoute(staffUpsertHandler, PeopleStaffUpsertV1))
  .post("/v1/people/rosters", requireMember, commandRoute(rosterCreateHandler, PeopleRosterCreateV1))
  .post("/v1/people/rosters:update", requireMember, commandRoute(rosterUpdateHandler, PeopleRosterUpdateV1))
  .post("/v1/people/attendance", requireMember, commandRoute(attendanceHandler, PeopleAttendanceRecordV1))
  .post("/v1/people/payroll-drafts", requireMember, commandRoute(payrollDraftHandler, PeoplePayrollDraftCreateV1))
  .post("/v1/people/payroll-drafts/:action{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:status}", requireMember,
    commandRoute(payrollStatusHandler, PeoplePayrollDraftStatusV1, { field: "payroll_draft_id", verb: ":status" }))
  .post("/v1/people/advances", requireMember, commandRoute(advanceHandler, PeopleAdvanceRecordV1))
  .post("/v1/people/tip-pools", requireMember, commandRoute(tipPoolHandler, PeopleTipPoolRecordV1))
  .post("/v1/people/training", requireMember, commandRoute(trainingHandler, PeopleTrainingRecordV1))
  .post("/v1/people/candidates:upsert", requireMember, commandRoute(candidateHandler, PeopleCandidateUpsertV1))
  .get("/v1/people/overtime", requireMember, async (c) => {
    const m = readerOf(c);
    const outlet = c.req.query("outlet") ?? "", from = c.req.query("from") ?? "", to = c.req.query("to") ?? "";
    if (!UUID.test(outlet) || !DATE.test(from) || !DATE.test(to) || to < from) throw new ApiError("bad_request");
    inScope(m, outlet);
    const rows = await withContext(c.var.deps.pools.core, contextOf(m), async (db) => {
      if (!(await db.query(`SELECT 1 FROM core.outlet WHERE id = $1`, [outlet])).rows[0]) throw new ApiError("not_found");
      await requireAttendance(db, outlet, from, to);
      return overtimeRows(db, outlet, from, to);
    });
    return c.json({ outlet_id: outlet, from, to, rows }, 200);
  })
  .get("/v1/people/staff", requireMember, async (c) => {
    const m = readerOf(c);
    const outlet = c.req.query("outlet") ?? "";
    if (!UUID.test(outlet)) throw new ApiError("bad_request");
    inScope(m, outlet);
    const staff = await withContext(c.var.deps.pools.core, contextOf(m), (db) => listStaff(db, outlet));
    return c.json({ outlet_id: outlet, staff }, 200);
  })
  .get("/v1/people/payroll-preview", requireMember, async (c) => {
    const m = readerOf(c);
    const outlet = c.req.query("outlet") ?? "", month = c.req.query("month") ?? "";
    if (!UUID.test(outlet) || !DATE.test(month) || !month.endsWith("-01")) throw new ApiError("bad_request");
    inScope(m, outlet);
    const out = await withContext(c.var.deps.pools.core, contextOf(m), async (db) => {
      if (!(await db.query(`SELECT 1 FROM core.outlet WHERE id = $1`, [outlet])).rows[0]) throw new ApiError("not_found");
      return previewPayroll(db, outlet, month);
    });
    return c.json({ outlet_id: outlet, period_month: month, ...out }, 200);
  })
  .route("/", readRoutes);
