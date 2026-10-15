// scripts/smoke.ts: from 01-api-client.md
// Exercises the client against the mock (or the real API): outlets, menu, preview, place, replay, read, stream, 404, 429 (mock only).
import { createMunimClient, type MunimError } from "../lib/munim/client";
import { newAttempt, newCartLine, previewRequest, type Cart } from "../lib/munim/checkout";
import { openStream } from "../lib/munim/stream";
import { formatMoney } from "../lib/munim/format";

const baseUrl = process.env.NEXT_PUBLIC_MUNIM_API ?? "";
const storefrontKey = process.env.NEXT_PUBLIC_MUNIM_STOREFRONT_KEY ?? "";
const munim = createMunimClient({ baseUrl, storefrontKey });
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const why = (e: MunimError) => `${e.kind} ${e.status} ${e.code ?? ""} ${e.reasonCode ?? ""}`;

async function main(): Promise<void> {
  const outlets = await munim.listOutlets();
  if (!outlets.ok) throw new Error(`outlets: ${why(outlets.error)}`);
  check("outlets", outlets.data.outlets.length > 0, outlets.data.outlets.map((o) => o.name).join(", "));
  const outlet = outlets.data.outlets[0]!;

  const menu = await munim.getMenu(outlet.outlet_id);
  if (!menu.ok) throw new Error(`menu: ${why(menu.error)}`);
  const item = menu.data.items.find((i) => i.available && i.price_minor !== null && i.option_groups.every((g) => !g.required));
  if (!item) throw new Error("no simple item on the menu");
  check("menu", true, `${menu.data.items.length} items, state ${menu.data.accepting.state}, first simple item ${item.display_name ?? item.name_key}`);

  const cart: Cart = { outletId: outlet.outlet_id, lines: [newCartLine(item.item_id, null, [], 2)], slot: { pickupWindowId: null, promisedAt: null }, couponCodes: [] };
  const preview = await munim.previewOrder(previewRequest(cart, menu.data));
  if (!preview.ok) throw new Error(`preview: ${why(preview.error)}`);
  const p = preview.data;
  check("preview", p.label === "preview" && p.refusals.length === 0, `total ${formatMoney(p.total_minor, p.currency, "en")} tax ${p.tax_components.map((t) => `${t.code} ${t.amount_minor}`).join(" + ") || "none"}`);

  const attempt = newAttempt(cart, menu.data, { name: "Smoke Test", phone: null, email: "smoke@example.com", marketing: false }, p.total_minor);
  const placed = await munim.placeOrder(attempt.body);
  if (!placed.ok) throw new Error(`place: ${why(placed.error)}`);
  const token = placed.data.guest_access_token;
  check("place", placed.status === 201 && !placed.replayed && token !== null, `ticket ${placed.data.ticket_no}, status ${placed.data.status}`);

  const replay = await munim.placeOrder(attempt.body); // the SAME attempt object, sent again
  check("replay", replay.ok && replay.replayed && replay.data.order_id === placed.data.order_id && replay.data.guest_access_token === null,
    replay.ok ? `replayed=${replay.replayed}, token ${replay.data.guest_access_token === null ? "null" : "present"}` : why(replay.error));

  const order = await munim.getOrder(placed.data.order_id, token);
  check("read order", order.ok && order.data.total_minor === p.total_minor, order.ok ? `status ${order.data.status}, ${order.data.events.length} event(s)` : why(order.error));

  const noToken = await munim.getOrder(placed.data.order_id, null);
  check("read without token is 404", !noToken.ok && noToken.error.kind === "not_found");

  // Stream: wait for "ready", then for one event. The cursor "n=0" replays the mock's history so the "placed"
  // event arrives at once (a test trick for the mock only; in the app never invent a cursor).
  const got = await new Promise<string>((resolve) => {
    let open = false;
    const timer = setTimeout(() => (s.close(), resolve(open ? "ready only" : "nothing")), 15_000);
    const s = openStream({
      baseUrl,
      topics: [`order:${placed.data.order_id}`],
      guestToken: token!,
      headers: () => ({ "X-Munim-Storefront-Key": storefrontKey }),
      lastEventId: "n=0",
      onState: (st) => { if (st === "open") open = true; },
      onEvent: (e) => { clearTimeout(timer); s.close(); resolve(`${e.type} ${JSON.stringify(e.data)}`); },
    });
    s.done.catch((e: unknown) => { clearTimeout(timer); resolve(`refused ${String(e)}`); });
  });
  check("stream", got.startsWith("order.status"), got);

  const badKey = await createMunimClient({ baseUrl, storefrontKey: "sfk_wrong_key_000000" }).listOutlets();
  check("bad key is 404", !badKey.ok && badKey.error.kind === "not_found" && badKey.error.status === 404, badKey.ok ? "200?" : why(badKey.error));

  // X-Mock-Force-429 is the mock's switch; the real API ignores it.
  if (!/\/mock$/.test(baseUrl.replace(/\/+$/, ""))) console.log("skip 429 parsed: real API (the forced 429 is a mock switch)");
  else {
    const limited = await createMunimClient({ baseUrl, storefrontKey, extraHeaders: () => ({ "X-Mock-Force-429": "1" }) }).getMenu(outlet.outlet_id);
    check("429 parsed", !limited.ok && limited.error.kind === "rate_limited" && limited.error.reasonCode === "rate_limited" && limited.error.retryAfterMs === 5000,
      limited.ok ? "200?" : `${why(limited.error)} retryAfterMs ${limited.error.retryAfterMs}`);
  }

  const changed = newAttempt(cart, menu.data, { name: "Smoke Test", phone: null, email: "smoke@example.com", marketing: false }, p.total_minor + 1);
  const refused = await munim.placeOrder(changed.body);
  check("stale preview total refused", !refused.ok && refused.error.kind === "refusal" && refused.error.reasonCode === "preview_total_changed", refused.ok ? "placed?" : why(refused.error));

  const impact = await munim.getNetworkImpact();
  check("network impact (404 on the mock: hide it)", impact.ok || impact.error.kind === "not_found", impact.ok ? "served" : why(impact.error));

}

main().then(
  () => {
    console.log(failed === 0 ? "smoke: all ok" : `smoke: ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  },
  (e: unknown) => {
    console.log(`FAIL ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
