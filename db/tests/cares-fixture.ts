// 0028 fixture: one donation listing at each of the world's outlets 1 and 2 whose pickup slot the world's roster shift
// at that outlet covers (outlet 1: 6 Oct 09:00–17:00 UTC, outlet 2: 7 Oct 09:00–17:00 UTC), so cares.pickup_crew has a
// crew at each (the world's one member-linked cook). The world's own Cares rows (src/world.ts addCares) stay as they are.
import type { TestDb } from "../src/harness.ts";
import { ownerCtx, uuidv7, type World } from "./world.ts";

export async function addCrewListings(db: TestDb, w: World): Promise<[string, string]> {
  const out: [string, string] = [uuidv7(), uuidv7()];
  const recipient = (await db.admin<{ id: string }>(`SELECT l.recipient_id id FROM core.cares_listing l WHERE l.tenant_id = $1 AND l.kind = 'donation' LIMIT 1`,
    [w.tenant])).rows[0]!.id;
  await db.withContext("munim_core", ownerCtx(w, { command_type: "cares.listing.publish.v1" }), async (c) => {
    for (const [k, at] of [[0, "2026-10-06T12:30:00Z"], [1, "2026-10-07T12:30:00Z"]] as const) {
      await c.query(`INSERT INTO core.cares_listing (tenant_id, id, outlet_id, kind, recipient_id, pickup_from, pickup_to, pickup_on, published_by)
                     SELECT $1, $2, $3, 'donation', $4, $5::timestamptz, $5::timestamptz + interval '1 hour',
                            (($5::timestamptz AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date, $6
                       FROM core.outlet ou WHERE ou.tenant_id = $1 AND ou.id = $3`, [w.tenant, out[k], w.outlets[k], recipient, at, w.owner]);
      await c.query(`INSERT INTO core.cares_listing_line (tenant_id, id, listing_id, line_no, food_kind, ingredient_id, qty_milli, unit)
                     VALUES ($1, $2, $3, 1, 'raw', $4, 100000, 'g')`, [w.tenant, uuidv7(), out[k], w.ingredient]);
    }
  });
  return out;
}
