// Plan mode: a fake transport with just enough answers for a world to run without a server, so the request log can
// be produced (and compared across time zones) in a fraction of a second. It never sees a real response shape that
// a world's logic depends on beyond the few reads below; the real-server run is compared against it by the gate.
import { createHash } from "node:crypto";

const uuid = (s: string): string => {
  const h = createHash("sha256").update(`dry|${s}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function dryFetch(o: { tz: string; currency: string }): typeof fetch {
  let n = 0;
  let outlet = uuid("outlet");
  const pos = new Map<string, number>();
  const ok = (type: string, body: Record<string, unknown>) => json(200, { type, entity_id: uuid(`e${n++}`), command_id: String(body.command_id ?? ""), committed_at: "1970-01-01T00:00:00.000Z" });
  return async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const u = new URL(req.url);
    const path = u.pathname;
    if (req.method === "GET") {
      if (path === "/v1/outlets") return json(200, { outlets: [{ id: outlet, tz: o.tz }] });
      if (path === "/v1/tenant") return json(200, { base_currency: o.currency });
      if (path === "/v1/channels") {
        const kinds = ["counter", "table_qr", "pickup", "own_site", "aggregator:swiggy", "aggregator:zomato", "aggregator:ubereats", "aggregator:doordash"];
        return json(200, { channels: kinds.map((kind) => ({ id: uuid(`ch:${kind}`), name: kind, kind, active: true })) });
      }
      if (path === "/v1/devices") return json(200, { devices: [{ id: uuid("dev:pos"), outlet_id: outlet, kind: "pos", invoice_series: "POS1" }, { id: uuid("dev:kds"), outlet_id: outlet, kind: "kds" }] });
      const po = /^\/v1\/purchase-orders\/(.+)$/.exec(path);
      if (po) return json(200, { lines: Array.from({ length: pos.get(po[1]!) ?? 1 }, (_, i) => ({ po_line_id: uuid(`poline:${po[1]}:${i}`) })) });
      const run = /^\/v1\/imports\/runs\/(.+)$/.exec(path);
      if (run) return json(200, { status: "previewed", rows_quarantined: 0, draft_id: uuid(`draft:${run[1]}`) });
      return json(200, {});
    }
    const body = JSON.parse(await req.clone().text()) as { command_id?: string; payload?: { outlet_id?: string; po_id?: string; lines?: unknown[]; filename?: string } };
    if (path === "/v1/onboarding" && body.payload?.outlet_id) outlet = body.payload.outlet_id;
    if (path === "/v1/purchase-orders" && body.payload?.po_id) pos.set(body.payload.po_id, body.payload.lines?.length ?? 1);
    if (path === "/v1/imports/documents") {
      const id = uuid(`run:${n++}`);
      return json(200, { duplicate: false, document: { document_id: uuid(`doc:${id}`) }, run: { import_run_id: id, status: "parsing", draft_id: null }, header: null });
    }
    return ok("dry", body as Record<string, unknown>);
  };
}
