// file: components/staff/cares/listing-card.tsx
"use client";
// One listing (GET /v1/cares/listings): what, how much, to which simulated recipient, when, its hand-overs, and the
// person's own commands on it: record a hand-over (owner, manager, staff) and withdraw (owner, manager). Every quantity
// is a row field shown as it is; "Hand over everything listed" only before any hand-over (no "listed minus handed").
import { useState } from "react";
import type { MunimError } from "@/lib/munim/client";
import { canHandOverAll, caresCan, FOOD_KIND, handoverAttempt, lineName, qtyText, recordedHandovers, unitLabel, withdrawAttempt, type Listing, type Recipient } from "@/lib/munim/cares-flow";
import { dayLabel, formatDate, formatDayTime, formatTime } from "@/lib/munim/format";
import { parseTyped } from "@/lib/munim/refs";
import type { Session } from "@/lib/munim/session";
import type { StaffClient } from "@/lib/munim/staff";
import { LISTING_STATUS } from "@/lib/munim/staff-copy";
import type { Schemas } from "@/lib/munim/types";
import { ErrorNote } from "../../ui";
import { SimulatedRecipient, StatusPill, type PillTone } from "../source";
import { useCommand } from "../use-command";

const TONE: Record<string, PillTone> = { published: "new", allocated: "work", closed: "done", withdrawn: "stop" };

export function ListingCard({ listing: l, recipients, menu, ingredients, session, client, tz, locale, currency, onAuth, onChanged }: {
  listing: Listing;
  recipients: readonly Recipient[];
  menu: Schemas["V1CatalogueMenu"] | null;
  ingredients: readonly Schemas["V1InventoryIngredients"]["items"][number][];
  session: Session;
  client: StaffClient;
  tz: string;
  locale: string;
  currency: string;
  onAuth: (e: MunimError) => boolean;
  /** Refetch the listings (and impact); `text` is the toast, null when the error note already says it. */
  onChanged: (text: string | null) => void;
}) {
  const [mode, setMode] = useState<"idle" | "part" | "withdraw">("idle");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const hand = useCommand<"cares.handover.record.v1", Schemas["CaresHandoverRecordV1"]>("cares", onAuth);
  const withdraw = useCommand<"cares.listing.withdraw.v1", Schemas["CaresListingWithdrawV1"]>("cares", onAuth);
  const recipient = recipients.find((r) => r.recipient_id === l.recipient_id);
  const parsed = Object.fromEntries(Object.entries(typed).flatMap(([id, t]) => { const v = parseTyped(t, "qty_milli", currency); return v ? [[id, v]] : []; }));
  const partReady = Object.keys(parsed).length > 0 && Object.entries(typed).every(([, t]) => t.trim() === "" || parseTyped(t, "qty_milli", currency));
  const open = l.status === "published";

  const handOver = async (what: "all" | Record<string, number>) => {
    const r = await hand.send((prev) => handoverAttempt(prev, l, what), (body) => client.recordHandover(body));
    if (r?.ok) { setMode("idle"); setTyped({}); onChanged("Hand-over recorded."); }
    else if (r && !r.ok && r.error.code === "illegal_transition") onChanged(null);
  };
  const doWithdraw = async () => {
    const r = await withdraw.send((prev) => withdrawAttempt(prev, l.listing_id), (body) => client.withdrawListing(l.listing_id, body));
    if (r?.ok) { setMode("idle"); onChanged("Listing withdrawn."); }
    else if (r && !r.ok && r.error.code === "illegal_transition") onChanged(null);
  };

  return (
    <article className="card grid gap-3 p-5" aria-label={`Listing for ${dayLabel(l.pickup_from, tz, locale)}`}>
      <header className="flex flex-wrap items-center gap-2">
        <StatusPill tone={TONE[l.status] ?? "new"}>{LISTING_STATUS[l.status] ?? l.status}</StatusPill>
        <span className="font-semibold">Pickup {dayLabel(l.pickup_from, tz, locale)} {formatTime(l.pickup_from, tz, locale)} – {formatTime(l.pickup_to, tz, locale)}</span>
      </header>
      <p className="flex flex-wrap items-center gap-2">To {recipient?.name ?? "a simulated recipient that is no longer listed"} <SimulatedRecipient /></p>
      <ul className="grid gap-1">
        {l.lines.map((x) => (
          <li key={x.line_id}>
            <span className="badge">{FOOD_KIND[x.food_kind]}</span> {lineName(x, menu, ingredients)} · <span className="num">{qtyText(x.qty_milli, x.unit, locale)}</span>
            {x.expires_on && <span className="text-muted"> · use by {formatDate(x.expires_on, locale)}</span>}
          </li>
        ))}
      </ul>
      {recordedHandovers(l).map((h) => (
        <p key={h.handover_id} className="text-[15px] text-muted">
          Handed over {formatDayTime(h.handed_at, tz, locale)}{h.recorded_by === session.me.member_id ? " · recorded by you" : ""}:{" "}
          {h.lines.map((hl) => { const line = l.lines.find((x) => x.line_id === hl.listing_line_id); return line ? `${lineName(line, menu, ingredients)} ${qtyText(hl.qty_milli, line.unit, locale)}` : qtyText(hl.qty_milli, "", locale); }).join(" · ")}
        </p>
      ))}

      {open && mode === "part" && (
        <div className="grid gap-3">
          {l.lines.map((x) => (
            <label key={x.line_id} className="block font-semibold">
              {lineName(x, menu, ingredients)}: how much was handed over? ({unitLabel(x.unit)})
              <input inputMode="decimal" value={typed[x.line_id] ?? ""} onChange={(e) => { setTyped((t) => ({ ...t, [x.line_id]: e.target.value })); hand.reset(); }} />
            </label>
          ))}
        </div>
      )}
      {open && mode === "withdraw" && <p className="font-semibold">Withdraw this listing? The simulated recipient will no longer see it.</p>}

      {open && (
        <div className="flex flex-wrap gap-3">
          {mode === "idle" && caresCan(session.me.role, "handover") && canHandOverAll(l) && (
            <button type="button" className="btn btn-primary" disabled={hand.busy || hand.wait > 0} onClick={() => void handOver("all")}>
              {hand.busy ? "Saving…" : `Hand over everything listed as ${session.me.name}`}
            </button>
          )}
          {mode === "idle" && caresCan(session.me.role, "handover") && (
            <button type="button" className="btn btn-plain" onClick={() => setMode("part")}>{canHandOverAll(l) ? "Hand over part of it" : "Record a hand-over"}</button>
          )}
          {mode === "part" && (
            <>
              <button type="button" className="btn btn-primary" disabled={!partReady || hand.busy || hand.wait > 0} onClick={() => void handOver(parsed)}>
                {hand.busy ? "Saving…" : `Record hand-over as ${session.me.name}`}
              </button>
              <button type="button" className="btn btn-plain" disabled={hand.busy} onClick={() => { setMode("idle"); setTyped({}); hand.reset(); }}>Cancel</button>
            </>
          )}
          {mode === "idle" && caresCan(session.me.role, "withdraw") && (
            <button type="button" className="btn btn-plain text-danger" onClick={() => setMode("withdraw")}>Withdraw</button>
          )}
          {mode === "withdraw" && (
            <>
              <button type="button" className="btn btn-plain text-danger" disabled={withdraw.busy || withdraw.wait > 0} onClick={() => void doWithdraw()}>
                {withdraw.busy ? "Saving…" : `Withdraw as ${session.me.name}`}
              </button>
              <button type="button" className="btn btn-plain" disabled={withdraw.busy} onClick={() => setMode("idle")}>Keep it</button>
            </>
          )}
        </div>
      )}
      {hand.error && <ErrorNote>{hand.error}</ErrorNote>}
      {withdraw.error && <ErrorNote>{withdraw.error}</ErrorNote>}
    </article>
  );
}
