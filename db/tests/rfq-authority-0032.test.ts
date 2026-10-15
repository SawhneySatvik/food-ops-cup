// 0032 gates (T-127: the command authority of purchasing.rfq.request.v1; lane C T-114 report §0.1). Expected values are typed by
// hand here (the row T-114's tests inserted as a stand-in, mirroring purchasing.po.create.v1); none is read from the migration.
//   A1  the row: owner, manager, judge; scope outlet; no book table, no customer table; not draft-only; no role cap, outlet column
//       or amount cap;
//   LOG the person's command is on record under it: a command_log row of that type is accepted (the 0003 foreign key); an unknown
//       type is refused (23503);
//   G   it writes no book table: an owner's write to a book table under it is MB008 (the guard's binding), while the same row under
//       the command bound to that table is accepted; staff, whom the row does not list, are MB001.
// Red-proofs: db/tests/redproof-0032.sh (each gate red with a non-zero exit).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TestDb } from "../src/harness.ts";
import { openDb, pgError } from "./db.ts";
import { buildWorld, ownerCtx, uuidv7, type World } from "./world.ts";

let db: TestDb;
let w: World;
const RFQ = "purchasing.rfq.request.v1";

beforeAll(async () => {
  db = await openDb();
  w = await buildWorld(db);
});
afterAll(async () => db?.stop());

describe("A1 the row", () => {
  test("owner, manager, judge; scope outlet; target_tables '{}'; no customer table, draft-only, role cap, outlet column or amount cap", async () => {
    const r = await db.admin(`SELECT allowed_roles, scope, target_tables, customer_target_tables, draft_only, role_caps, outlet_column, max_amount_minor
                                FROM core.command_authority WHERE command_type = $1`, [RFQ]);
    console.log(`A1: ${JSON.stringify(r.rows)}`);
    expect(r.rows).toEqual([{ allowed_roles: ["owner", "manager", "judge"], scope: "outlet", target_tables: [], customer_target_tables: [],
      draft_only: false, role_caps: {}, outlet_column: null, max_amount_minor: null }]);
  });
});

describe("LOG the command is on record", () => {
  test("a command_log row of this type is accepted; an unknown type is refused 23503", async () => {
    const log = (type: string) => db.withContext("munim_core", ownerCtx(w, { command_type: type }), (c) =>
      c.query(`INSERT INTO core.command_log (tenant_id, idempotency_key, command_id, command_type, actor, request_hash, result)
               VALUES ($1, $2, $3, $4, $5, repeat('a', 64), '{}')`,
        [w.tenant, `rfq-${uuidv7()}`, uuidv7(), type, { kind: "member", id: w.owner, role: "owner" }]));
    const got = [await pgError(() => log(RFQ)), await pgError(() => log("purchasing.rfq.unknown.v1"))].map((e) => e?.code ?? "accepted");
    console.log(`LOG: ${got.join(", ")}`);
    expect(got).toEqual(["accepted", "23503"]);
  });
});

describe("G it writes no book table", () => {
  const budget = (role: "owner" | "staff", type: string) => {
    const ctx = role === "owner" ? ownerCtx(w, { command_type: type }) : { ...ownerCtx(w, { command_type: type }), role: "staff", member_id: w.staff };
    return pgError(() => db.withContext("munim_core", ctx, (c) =>
      c.query(`INSERT INTO core.budget (tenant_id, id, outlet_id, category, period_month, amount_minor, currency, origin)
               VALUES ($1, $2, NULL, 'other', $3, 100, $4, '{}')`, [w.tenant, uuidv7(), `2031-0${role === "owner" ? 1 : 2}-01`, w.currency])));
  };
  test("an owner's book write under it → MB008; the same write under finance.budget.set.v1 is accepted", async () => {
    const got = [await budget("owner", RFQ), await budget("owner", "finance.budget.set.v1")].map((e) => e?.code ?? "accepted");
    console.log(`G owner: ${got.join(", ")}`);
    expect(got).toEqual(["MB008", "accepted"]);
  });
  test("staff, whom the row does not list, → MB001 under it", async () => {
    const e = await budget("staff", RFQ);
    console.log(`G staff: ${e?.code}`);
    expect(e?.code).toBe("MB001");
  });
});
