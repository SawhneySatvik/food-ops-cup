// file: components/staff/pages/kitchen.tsx
"use client";
// /staff/kitchen: the kitchen display. Live tickets in two lanes (Now, Later), one station or all, one 64 px button
// per ticket for the next step. Every move waits for core's answer and is followed by a refetch; a move someone made
// first (409) says so and refreshes. No AI and no money on this screen except "still to pay" read from the order.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useOnline } from "@/lib/hooks";
import { useAdvance, useBoard } from "@/lib/kitchen-hooks";
import { formatMoney, formatTime } from "@/lib/munim/format";
import { stationLabel, stepErrorText, type Ticket } from "@/lib/munim/kitchen";
import { can } from "@/lib/munim/session";
import { reasonText, staffErrorText } from "@/lib/munim/staff-copy";
import { SITE } from "@/lib/site";
import { ErrorNote, FullPage, OfflineBanner, Toast, useToast } from "../../ui";
import { TicketCard } from "../kitchen-ticket";
import { useStaff } from "../shell";
import { SimulateWebOrder } from "../simulate";

const STATION_KEY = (outletId: string) => `munim.staff.station.${outletId}`;

export function KitchenPage() {
  const { session, outlet } = useStaff();
  if (!can(session, "kitchen")) {
    return (
      <FullPage title="Not for your role" action={<Link href="/staff" className="btn btn-primary">Go to your start page</Link>}>
        <p>The counter and the kitchen are for owners, managers and staff. Ask the owner if you need them.</p>
      </FullPage>
    );
  }
  if (!outlet) return <div className="state-box" role="status">Loading</div>;
  return <Board key={outlet.id} outletId={outlet.id} tz={outlet.tz} />;
}

function Board({ outletId, tz }: { outletId: string; tz: string }) {
  const { session, client, handleAuth } = useStaff();
  const online = useOnline();
  const [toast, say] = useToast();
  const [station, setStation] = useState<string | null>(null);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- sessionStorage is only readable after hydration
      setStation(sessionStorage.getItem(STATION_KEY(outletId)) || null);
    } catch {
      // storage blocked: all stations
    }
  }, [outletId]);
  const chooseStation = (s: string | null) => {
    setStation(s);
    try {
      if (s) sessionStorage.setItem(STATION_KEY(outletId), s);
      else sessionStorage.removeItem(STATION_KEY(outletId));
    } catch {
      // storage blocked: the choice lasts for this page only
    }
  };
  const b = useBoard(client, session, outletId, station, handleAuth, (lines) => { if (lines.length) say(lines.join(". ")); });
  const { advance, busy } = useAdvance(client, b.refresh);
  const [confirm, setConfirm] = useState<{ ticket: Ticket; text: string } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (confirm && !d.open) d.showModal();
    if (!confirm && d.open) d.close();
  }, [confirm]);

  const step = async (t: Ticket, to: "preparing" | "ready" | "done") => {
    const r = await advance(t, to);
    if (r.ok) return;
    if (handleAuth(r.error)) return;
    say(stepErrorText(r.error));
  };
  /** "Handed over" completes the order when it is the order's last ticket, paid or not: check the order first. */
  const onAdvance = async (t: Ticket, to: "preparing" | "ready" | "done") => {
    if (to !== "done") return void step(t, to);
    if (checking) return;
    setChecking(t.ticket_id); // the button reads "Saving…" while the payment is checked: a double tap sends nothing twice
    const o = await client.getOrder(t.order_id);
    setChecking(null);
    if (o.ok && o.data.remaining_minor === 0) return void step(t, to);
    if (!o.ok && handleAuth(o.error)) return;
    setConfirm({
      ticket: t,
      text: o.ok ? `${formatMoney(o.data.remaining_minor, o.data.currency, SITE.locale)} is still to pay on order #${t.ticket_no}. Send the customer to the counter first.` : `Couldn't check whether order #${t.ticket_no} is paid.`,
    });
  };

  const err = b.error;
  if (!b.board && err) {
    if (err.kind === "not_found") return <FullPage title="Not found."><p>It may have been removed, or it isn&apos;t in your outlets.</p></FullPage>;
    if (err.reasonCode === "not_applicable") return <FullPage title="No kitchen display"><p>{reasonText("not_applicable")}</p></FullPage>;
    if (err.kind !== "network") return <main className="staff-main-wide"><ErrorNote>{staffErrorText(err, "kitchen")}</ErrorNote><button type="button" className="btn btn-plain mt-3" onClick={b.refresh}>Try again</button></main>;
  }
  const stations = [...new Set([...(b.board?.stations ?? []), ...(station ? [station] : [])])];
  const offline = !online || err?.kind === "network";

  return (
    <>
      <OfflineBanner top="staff" show={offline} text="Offline. Showing the last board; changes will need a retry." />
      <main className="staff-main-wide">
        <div className="flex flex-wrap items-center gap-3 pb-3">
          <h1 className="section-title">Kitchen</h1>
          <div role="radiogroup" aria-label="Station" className="flex flex-wrap gap-2">
            <button type="button" role="radio" aria-checked={station === null} className="chip" aria-current={station === null ? "true" : undefined} onClick={() => chooseStation(null)}>All stations</button>
            {stations.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={station === s} className="chip" aria-current={station === s ? "true" : undefined} onClick={() => chooseStation(s)}>{stationLabel(s)}</button>
            ))}
          </div>
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {b.live === "open" && <span className="badge badge-ready">Live</span>}
            {b.liveOff && <span className="text-[14px] text-muted">Live updates are off. Tap Refresh to update.</span>}
            <button type="button" className="btn btn-plain" onClick={b.refresh}>Refresh</button>
            <SimulateWebOrder onDone={(ok) => { say(ok ? "A simulated web order was sent to the kitchen." : "The simulated order didn't go through."); b.refresh(); }} />
          </span>
        </div>
        {err?.kind === "rate_limited" && <p className="pb-2 font-semibold">{staffErrorText(err, "kitchen")}</p>}

        {!b.board ? (
          <div className="kds-grid">{Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton h-72" aria-hidden="true" />)}</div>
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[1fr_320px]">
            <section aria-labelledby="lane-now">
              <h2 id="lane-now" className="pb-2 text-[22px]">Now · {b.lanes.now.length}</h2>
              {b.lanes.now.length === 0 ? <p className="state-box">No tickets right now.</p> : (
                <div className="kds-grid">
                  {b.lanes.now.map((t) => (
                    <TicketCard key={t.ticket_id} ticket={t} asOf={b.board!.as_of} tz={tz} locale={SITE.locale} names={b.names} sizeOf={(n) => b.sizeOf(t.order_id, n)} busy={busy === t.ticket_id || checking === t.ticket_id} onAdvance={(x, to) => void onAdvance(x, to)} />
                  ))}
                </div>
              )}
            </section>
            <section aria-labelledby="lane-later">
              <h2 id="lane-later" className="pb-2 text-[22px]">Later · {b.lanes.later.length}</h2>
              {b.lanes.later.length === 0 ? <p className="text-muted">Nothing scheduled for later.</p> : (
                <div className="grid gap-3">
                  {b.lanes.later.map((t) => (
                    <div key={t.ticket_id} className="space-y-1">
                      <p className="text-[15px] font-semibold">{t.promised_at ? `Pickup ${formatTime(t.promised_at, tz, SITE.locale)}` : "Scheduled"}{t.surface_at ? ` · on the board from ${formatTime(t.surface_at, tz, SITE.locale)}` : ""}</p>
                      <TicketCard ticket={t} asOf={b.board!.as_of} tz={tz} locale={SITE.locale} names={b.names} sizeOf={(n) => b.sizeOf(t.order_id, n)} busy={busy === t.ticket_id || checking === t.ticket_id} onAdvance={(x, to) => void onAdvance(x, to)} />
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        <dialog ref={dialog} className="modal" aria-labelledby="unpaid-title" onClose={() => setConfirm(null)}>
          {confirm && (
            <div className="grid gap-4 p-6">
              <h2 id="unpaid-title" className="text-[28px]">Not paid yet</h2>
              <p className="text-[20px]">{confirm.text}</p>
              <div className="flex flex-wrap gap-3">
                <button type="button" className="btn btn-primary min-h-16 flex-1" onClick={() => setConfirm(null)}>Not yet</button>
                <button type="button" className="btn btn-plain min-h-16 flex-1" onClick={() => { const t = confirm.ticket; setConfirm(null); void step(t, "done"); }}>Handed over anyway</button>
              </div>
            </div>
          )}
        </dialog>
        <Toast message={toast} />
      </main>
    </>
  );
}
