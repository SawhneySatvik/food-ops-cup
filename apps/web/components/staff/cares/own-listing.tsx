// file: components/staff/cares/own-listing.tsx
"use client";
// The owner lists surplus food themselves (cares.listing.publish.v1, owner and judge). The owner says what and how much;
// core ranks the simulated recipients that can take it (a cares.recipient_match snapshot minted for this form) and the
// chosen row gives the pickup window, so the browser does no ranking and no time maths. Nothing is published until the
// owner taps "Publish as …".
import { useState } from "react";
import type { MunimError } from "@/lib/munim/client";
import { matchParams, publishAttempt, unitLabel, unitsFor, type AtRiskRow, type MatchRow, type OwnListing } from "@/lib/munim/cares-flow";
import { dayLabel, formatTime, shownName } from "@/lib/munim/format";
import { parseTyped, type CellFormat, type Snapshot } from "@/lib/munim/refs";
import type { Session } from "@/lib/munim/session";
import type { StaffClient } from "@/lib/munim/staff";
import { staffErrorText } from "@/lib/munim/staff-copy";
import type { Schemas } from "@/lib/munim/types";
import { ErrorNote } from "../../ui";
import { useCommand } from "../use-command";
import { RecipientRanking } from "./recipients";

type Kind = OwnListing["food"]["kind"];

export function OwnListingForm({ outletId, prefill, menu, ingredients, session, client, fmt, tz, onOpen, onAuth, onPublished, onCancel }: {
  outletId: string;
  /** "List this" on a food-at-risk row: the batch, its unit and use-by date (never its quantity). */
  prefill: AtRiskRow | null;
  menu: Schemas["V1CatalogueMenu"] | null;
  ingredients: readonly Schemas["V1InventoryIngredients"]["items"][number][];
  session: Session;
  client: StaffClient;
  fmt: CellFormat;
  tz: string;
  onOpen: (snapshotId: string, refToken: string) => void;
  onAuth: (e: MunimError) => boolean;
  /** Published: the chosen recipient's name and when it picks up, for the confirmation (shown with its badge). */
  onPublished: (listed: { name: string; when: string }) => void;
  /** "Cancel": close the form; nothing is published. */
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<Kind>(prefill?.foodKind ?? "packaged");
  const [itemId, setItemId] = useState("");
  const [ingredientId, setIngredientId] = useState(prefill?.ingredientId ?? "");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState(prefill?.unit ?? "");
  const [expiresOn, setExpiresOn] = useState(prefill?.expiresOn ?? "");
  const [match, setMatch] = useState<Snapshot | "loading" | "failed" | null>(null);
  const [chosen, setChosen] = useState<MatchRow | null>(null);
  const [findError, setFindError] = useState<string | null>(null);
  const cmd = useCommand<"cares.listing.publish.v1", Schemas["CaresListingPublishV1"]>("cares", onAuth);

  const items = (menu?.entries ?? []).filter((e, i, all) => all.findIndex((x) => x.item_id === e.item_id) === i);
  const base = ingredients.find((x) => x.ingredient_id === ingredientId)?.base_unit ?? null;
  const units = unitsFor(kind, base);
  const shownUnit = units.includes(unit) ? unit : (units[0] ?? "");
  const qtyMilli = parseTyped(qty, "qty_milli", fmt.currency);
  const food: OwnListing["food"] | null = kind === "cooked" ? (itemId ? { kind, itemId } : null) : ingredientId ? { kind, ingredientId, batchId: prefill && prefill.ingredientId === ingredientId ? prefill.batchId : null } : null;
  const form: OwnListing | null = food && qtyMilli && shownUnit ? { outletId, food, qtyMilli, unit: shownUnit, expiresOn: kind === "cooked" || expiresOn === "" ? null : expiresOn } : null;
  // Any change to what is listed makes the ranking (and the chosen recipient) out of date.
  const changed = <V,>(set: (v: V) => void) => (v: V) => { set(v); setMatch(null); setChosen(null); cmd.reset(); };

  const find = async () => {
    if (!form) return;
    setMatch("loading");
    setFindError(null);
    const r = await client.mintSnapshot({ template_id: "cares.recipient_match", params: matchParams(form) });
    if (r.ok) setMatch(r.data);
    else if (!onAuth(r.error)) { setMatch("failed"); setFindError(staffErrorText(r.error, "cares")); }
  };
  const publish = async () => {
    if (!form || !chosen) return;
    const r = await cmd.send((prev) => publishAttempt(prev, form, chosen), (body) => client.publishListing(body));
    if (r?.ok) onPublished({ name: chosen.name, when: `${dayLabel(chosen.pickupFrom, tz, fmt.locale)} from ${formatTime(chosen.pickupFrom, tz, fmt.locale)}` });
  };

  return (
    <section className="card grid gap-4 p-5" aria-labelledby="own-listing">
      <h3 id="own-listing" className="text-[22px]">List food yourself</h3>
      <fieldset className="grid gap-2">
        <legend className="font-semibold">What are you giving away?</legend>
        {([["cooked", "Cooked food from the menu"], ["raw", "Raw stock"], ["packaged", "Packaged stock"]] as const).map(([k, text]) => (
          <label key={k} className="choice"><input type="radio" name="food-kind" checked={kind === k} onChange={() => changed(setKind)(k)} /> {text}</label>
        ))}
      </fieldset>
      {kind === "cooked" ? (
        <label className="block font-semibold">
          Item
          <select value={itemId} onChange={(e) => changed(setItemId)(e.target.value)}>
            <option value="">Choose an item</option>
            {items.map((e) => <option key={e.item_id} value={e.item_id}>{shownName(e)}</option>)}
          </select>
        </label>
      ) : (
        <label className="block font-semibold">
          Stock item
          <select value={ingredientId} onChange={(e) => changed(setIngredientId)(e.target.value)}>
            <option value="">Choose a stock item</option>
            {ingredients.filter((i) => i.active).map((i) => <option key={i.ingredient_id} value={i.ingredient_id}>{i.name}</option>)}
          </select>
        </label>
      )}
      <div className="flex flex-wrap gap-3">
        <label className="block font-semibold">
          How much? {shownUnit && `(${unitLabel(shownUnit)})`}
          <input inputMode="decimal" value={qty} onChange={(e) => changed(setQty)(e.target.value)} />
        </label>
        {units.length > 1 && (
          <label className="block font-semibold">
            Unit
            <select value={shownUnit} onChange={(e) => changed(setUnit)(e.target.value)}>
              {units.map((u) => <option key={u} value={u}>{unitLabel(u)}</option>)}
            </select>
          </label>
        )}
        {kind !== "cooked" && (
          <label className="block font-semibold">
            Use by (optional)
            <input type="date" value={expiresOn} onChange={(e) => changed(setExpiresOn)(e.target.value)} />
          </label>
        )}
      </div>
      {qty !== "" && qtyMilli === null && <p className="text-danger">Type the quantity as a number.</p>}
      {kind === "cooked" && <p className="text-muted">Cooked food can only be listed for a pickup that starts soon. Munim will say if this one is too far off.</p>}

      <button type="button" className="btn btn-secondary justify-self-start" disabled={!form || match === "loading"} onClick={() => void find()}>
        {match === "loading" ? "Finding…" : "Find simulated recipients"}
      </button>
      {findError && <ErrorNote>{findError}</ErrorNote>}
      {match && match !== "loading" && match !== "failed" && (
        <RecipientRanking snapshot={match} fmt={fmt} tz={tz} chosen={chosen?.recipientId ?? null} onChoose={setChosen} onOpen={onOpen} />
      )}

      {chosen && <p className="text-[14px] text-muted">Shown to the simulated recipient only. Check your local food-donation rules.</p>}
      <div className="flex flex-wrap items-center gap-3">
        {chosen && (
          <button type="button" className="btn btn-primary" disabled={cmd.busy || cmd.wait > 0} onClick={() => void publish()}>
            {cmd.busy ? "Saving…" : cmd.wait > 0 ? `Try again in ${cmd.wait} s` : `Publish as ${session.me.name}`}
          </button>
        )}
        <button type="button" className="btn btn-plain" disabled={cmd.busy} onClick={onCancel}>Cancel</button>
      </div>
      {cmd.error && <ErrorNote>{cmd.error}</ErrorNote>}
    </section>
  );
}
