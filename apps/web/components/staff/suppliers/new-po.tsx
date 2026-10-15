// file: components/staff/suppliers/new-po.tsx
"use client";
// A person's own purchase order (purchasing.po.create.v1: owner, manager) to a simulated supplier, for the outlet they
// are working in. They choose the supplier and type every quantity and price; the supplier's last price observation is
// shown beside the price as its own row, never copied in. Core numbers the lines and works out the total.
import { useState } from "react";
import type { MunimError } from "@/lib/munim/client";
import { dayKey, formatDate, formatMoney } from "@/lib/munim/format";
import { parseTyped } from "@/lib/munim/refs";
import type { Session } from "@/lib/munim/session";
import type { StaffClient } from "@/lib/munim/staff";
import { newPoAttempt, orderUnits, type NewPoLine, type Supplier } from "@/lib/munim/supply-flow";
import type { Schemas } from "@/lib/munim/types";
import { uuidv7 } from "@/lib/munim/uuid";
import { ErrorNote } from "../../ui";
import { SimulatedSupplier } from "../source";
import { useCommand } from "../use-command";

interface Draft {
  key: string;
  ingredientId: string;
  qty: string;
  unit: string;
  price: string;
}

export function NewPoForm({ suppliers, ingredients, outletId, currency, locale, tz, prefillIngredient, session, client, onAuth, onCreated }: {
  suppliers: readonly Supplier[];
  ingredients: readonly Schemas["V1InventoryIngredients"]["items"][number][];
  outletId: string;
  /** The business's base currency (GET /v1/tenant). */
  currency: string;
  locale: string;
  /** The outlet's zone, for the price observation's date. */
  tz: string;
  /** "Order this" on a below-minimum row: that ingredient is the first line (its quantity is never filled in). */
  prefillIngredient: string | null;
  session: Session;
  client: StaffClient;
  onAuth: (e: MunimError) => boolean;
  onCreated: (poId: string) => void;
}) {
  const fresh = (ingredientId = ""): Draft => ({ key: uuidv7(), ingredientId, qty: "", unit: "", price: "" });
  const [supplierId, setSupplierId] = useState(suppliers.find((s) => s.active)?.supplier_id ?? "");
  const [lines, setLines] = useState<Draft[]>(() => [fresh(prefillIngredient ?? "")]);
  const [expectedOn, setExpectedOn] = useState("");
  const cmd = useCommand<"purchasing.po.create.v1", Schemas["PurchasingPoCreateV1"]>("suppliers", onAuth);
  const supplier = suppliers.find((s) => s.supplier_id === supplierId);
  const set = (key: string, patch: Partial<Draft>) => { setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l))); cmd.reset(); };
  const unitOf = (l: Draft) => { const units = orderUnits(ingredients.find((i) => i.ingredient_id === l.ingredientId)?.base_unit ?? ""); return units.includes(l.unit) ? l.unit : (units[0] ?? ""); };
  const parsed: (NewPoLine | null)[] = lines.map((l) => {
    const q = parseTyped(l.qty, "qty_milli", currency);
    const p = parseTyped(l.price, "unit_price_minor", currency);
    return l.ingredientId && q && p !== null ? { ingredientId: l.ingredientId, qtyMilli: q, unit: unitOf(l), unitPriceMinor: p } : null;
  });
  const ready = supplierId !== "" && parsed.every((p) => p !== null);
  /** The supplier's latest price observation for this ingredient in this unit (prices come oldest first). */
  const lastPrice = (l: Draft) => supplier?.prices.filter((p) => p.ingredient_id === l.ingredientId && p.unit === unitOf(l)).at(-1) ?? null;

  const place = async () => {
    if (!ready) return;
    const input = { supplierId, outletId, currency, expectedOn: expectedOn === "" ? null : expectedOn, lines: parsed as NewPoLine[] };
    const r = await cmd.send((prev) => newPoAttempt(prev, input), (body) => client.createPurchaseOrder(body));
    if (r?.ok) onCreated(r.data.entity_id);
  };

  return (
    <section className="card grid gap-4 p-5" aria-labelledby="new-po">
      <h2 id="new-po" className="text-[24px]">New purchase order</h2>
      <fieldset className="grid gap-2">
        <legend className="font-semibold">Supplier</legend>
        {suppliers.filter((s) => s.active).map((s) => (
          <label key={s.supplier_id} className="choice flex flex-wrap items-center gap-2">
            <input type="radio" name="po-supplier" checked={supplierId === s.supplier_id} onChange={() => { setSupplierId(s.supplier_id); cmd.reset(); }} />
            {s.name} {s.label && <SimulatedSupplier />}
            {s.payment_days !== null && <span className="text-muted">· pay within {s.payment_days} days</span>}
          </label>
        ))}
      </fieldset>
      {lines.map((l) => {
        const units = orderUnits(ingredients.find((i) => i.ingredient_id === l.ingredientId)?.base_unit ?? "");
        const p = lastPrice(l);
        return (
          <div key={l.key} className="grid gap-2 rounded-[var(--radius-field)] border-[1.5px] border-bg-deep p-3">
            <label className="block font-semibold">
              Item
              <select value={l.ingredientId} onChange={(e) => set(l.key, { ingredientId: e.target.value, unit: "" })}>
                <option value="">Choose a stock item</option>
                {ingredients.filter((i) => i.active).map((i) => <option key={i.ingredient_id} value={i.ingredient_id}>{i.name}</option>)}
              </select>
            </label>
            <div className="flex flex-wrap gap-3">
              <label className="block font-semibold">
                Quantity
                <input inputMode="decimal" value={l.qty} onChange={(e) => set(l.key, { qty: e.target.value })} />
              </label>
              {units.length > 1 && (
                <label className="block font-semibold">
                  Unit
                  <select value={unitOf(l)} onChange={(e) => set(l.key, { unit: e.target.value })}>
                    {units.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </label>
              )}
              <label className="block font-semibold">
                Price per {unitOf(l) || "unit"} ({currency})
                <input inputMode="decimal" value={l.price} onChange={(e) => set(l.key, { price: e.target.value })} />
              </label>
            </div>
            {p && <p className="text-[14px] text-muted">{p.source_ref}: {formatMoney(p.unit_price_minor, p.currency, locale)} per {p.unit} · {formatDate(dayKey(p.observed_at, tz), locale)}</p>}
            {lines.length > 1 && <button type="button" className="btn btn-plain justify-self-start" onClick={() => { setLines((ls) => ls.filter((x) => x.key !== l.key)); cmd.reset(); }}>Remove this item</button>}
          </div>
        );
      })}
      <button type="button" className="btn btn-plain justify-self-start" onClick={() => { setLines((ls) => [...ls, fresh()]); cmd.reset(); }}>Add another item</button>
      <label className="block font-semibold">
        Expected on (optional)
        <input type="date" value={expectedOn} onChange={(e) => { setExpectedOn(e.target.value); cmd.reset(); }} />
      </label>
      <p className="text-[14px] text-muted">Munim works out the total when you place it. Recorded only — Munim does not process payments. Simulated supplier: nothing is sent to a real business.</p>
      <button type="button" className="btn btn-primary justify-self-start" disabled={!ready || cmd.busy || cmd.wait > 0} onClick={() => void place()}>
        {cmd.busy ? "Saving…" : cmd.wait > 0 ? `Try again in ${cmd.wait} s` : `Place order as ${session.me.name}`}
      </button>
      {cmd.error && <ErrorNote>{cmd.error}</ErrorNote>}
    </section>
  );
}
