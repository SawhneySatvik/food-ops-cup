// file: components/staff/suppliers/receive.tsx
"use client";
// Goods received against a purchase order (purchasing.grn.receive.v1): the person types what came in (or "Received in
// full" before anything has come in), with a batch code for batch-tracked stock. Core prices each line from the PO,
// moves the stock and marks the PO received once every line has come in. Nothing is worked out here.
import { useState } from "react";
import type { MunimError } from "@/lib/munim/client";
import { parseTyped } from "@/lib/munim/refs";
import type { Session } from "@/lib/munim/session";
import type { StaffClient } from "@/lib/munim/staff";
import { canReceiveInFull, fullLines, ingredientOf, receiveAttempt, receiveErrorText, type GoodsReceived, type PurchaseOrder, type ReceiveLine } from "@/lib/munim/supply-flow";
import type { Schemas } from "@/lib/munim/types";
import { ErrorNote } from "../../ui";
import { useCommand } from "../use-command";

export function ReceiveForm({ po, grns, outlets, ingredients, session, client, currency, onAuth, onDone }: {
  po: PurchaseOrder;
  /** Goods already received against this PO (GET /v1/goods-received, filtered by po_id). */
  grns: readonly GoodsReceived[];
  /** The PO's outlets the person works in; goods come in at one of them. */
  outlets: readonly { id: string; name: string }[];
  ingredients: readonly Schemas["V1InventoryIngredients"]["items"][number][];
  session: Session;
  client: StaffClient;
  currency: string;
  onAuth: (e: MunimError) => boolean;
  /** Refetch the PO and its goods received; `text` is the toast, null when the error note already says it. */
  onDone: (text: string | null) => void;
}) {
  const [outletId, setOutletId] = useState(outlets[0]?.id ?? "");
  const [chosenMode, setMode] = useState<"full" | "part">("full");
  // "Everything on this order" exists only before anything has come in against it.
  const mode = canReceiveInFull(po, grns) ? chosenMode : "part";
  const [qty, setQty] = useState<Record<string, string>>({});
  const [batch, setBatch] = useState<Record<string, { code: string; expiresOn: string }>>({});
  const [note, setNote] = useState("");
  const cmd = useCommand<"purchasing.grn.receive.v1", Schemas["PurchasingGrnReceiveV1"]>("suppliers", onAuth);
  const tracked = (ingredientId: string) => ingredients.find((i) => i.ingredient_id === ingredientId)?.tracked_by_batch === true;
  const batchOf = (poLineId: string): ReceiveLine["batch"] => {
    const b = batch[poLineId];
    return b && b.code.trim() !== "" ? { code: b.code.trim(), expiresOn: b.expiresOn === "" ? null : b.expiresOn } : null;
  };
  const lines: ReceiveLine[] = mode === "full"
    ? fullLines(po, ingredients, batchOf)
    : po.lines.flatMap((l) => {
        const q = parseTyped(qty[l.po_line_id] ?? "", "qty_milli", currency);
        return q ? [{ poLineId: l.po_line_id, ingredientId: l.ingredient_id, qtyMilli: q, unit: l.unit, batch: tracked(l.ingredient_id) ? batchOf(l.po_line_id) : null }] : [];
      });
  const ready = outletId !== "" && lines.length > 0 && lines.every((l) => !tracked(l.ingredientId) || l.batch !== null);
  const edit = () => cmd.reset();

  const submit = async () => {
    const r = await cmd.send((prev) => receiveAttempt(prev, po, outletId, lines, note.trim() === "" ? null : note.trim()), (body) => client.receiveGoods(body), receiveErrorText);
    if (r?.ok) onDone("Goods received. Stock is updated.");
    else if (r && !r.ok && r.error.code === "conflict") onDone(null);
  };

  return (
    <section className="card grid gap-4 p-5" aria-labelledby="receive">
      <h2 id="receive" className="text-[24px]">Record goods received</h2>
      {outlets.length > 1 && (
        <label className="block font-semibold">
          Received at
          <select value={outletId} onChange={(e) => { setOutletId(e.target.value); edit(); }}>
            {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      )}
      {canReceiveInFull(po, grns) && (
        <fieldset className="grid gap-2">
          <legend className="font-semibold">What came in?</legend>
          <label className="choice"><input type="radio" name="grn-mode" checked={mode === "full"} onChange={() => { setMode("full"); edit(); }} /> Everything on this order</label>
          <label className="choice"><input type="radio" name="grn-mode" checked={mode === "part"} onChange={() => { setMode("part"); edit(); }} /> Part of it</label>
        </fieldset>
      )}
      {po.lines.map((l) => {
        const ing = ingredientOf(ingredients, l.ingredient_id);
        return (
          <div key={l.po_line_id} className="grid gap-2 rounded-[var(--radius-field)] border-[1.5px] border-bg-deep p-3">
            <p className="font-semibold">{ing.name}</p>
            {mode === "part" && (
              <label className="block font-semibold">
                How much came in? ({l.unit})
                <input inputMode="decimal" value={qty[l.po_line_id] ?? ""} onChange={(e) => { setQty((q) => ({ ...q, [l.po_line_id]: e.target.value })); edit(); }} />
              </label>
            )}
            {tracked(l.ingredient_id) && (
              <div className="flex flex-wrap gap-3">
                <label className="block font-semibold">
                  Batch code
                  <input value={batch[l.po_line_id]?.code ?? ""} maxLength={60} onChange={(e) => { setBatch((b) => ({ ...b, [l.po_line_id]: { code: e.target.value, expiresOn: b[l.po_line_id]?.expiresOn ?? "" } })); edit(); }} />
                </label>
                <label className="block font-semibold">
                  Use by (optional)
                  <input type="date" value={batch[l.po_line_id]?.expiresOn ?? ""} onChange={(e) => { setBatch((b) => ({ ...b, [l.po_line_id]: { code: b[l.po_line_id]?.code ?? "", expiresOn: e.target.value } })); edit(); }} />
                </label>
              </div>
            )}
          </div>
        );
      })}
      <label className="block font-semibold">
        Note (optional)
        <textarea rows={2} maxLength={500} value={note} onChange={(e) => { setNote(e.target.value); edit(); }} />
      </label>
      <button type="button" className="btn btn-primary justify-self-start" disabled={!ready || cmd.busy || cmd.wait > 0} onClick={() => void submit()}>
        {cmd.busy ? "Saving…" : cmd.wait > 0 ? `Try again in ${cmd.wait} s` : `Record as received by ${session.me.name}`}
      </button>
      {cmd.error && <ErrorNote>{cmd.error}</ErrorNote>}
    </section>
  );
}
