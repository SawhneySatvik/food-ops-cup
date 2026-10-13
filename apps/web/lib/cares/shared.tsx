"use client";
// Small pieces shared by the Cares tabs: the standard labels the API carries, a command outcome in the standard states,
// and per-outlet formatters (pickup windows render in the outlet's own zone, G-14).
import { Badge, SimulatedBadge, StateDeny, StateError, StateOffline, createFormatter, type Formatter } from "@munim/ui";
import type { Schemas } from "@munim/sdk";
import { useMemo, type ReactNode } from "react";
import { useConsole } from "../console/context.tsx";
import { t } from "../i18n/index.ts";
import type { Outcome } from "./data.ts";
import { listingBadge, type Listing, type ListingBadge } from "./model.ts";

type Labels = Pick<Schemas["V1CaresProfile"], "labels">["labels"];

/** hard rule 5: both labels as the API carries them (unconditional), plus the one generic note. */
export function CaresLabels({ labels }: { labels: Labels }) {
  return (
    <div className="cares-labels" data-label="cares-labels">
      <Badge tone="evidence">{labels.data}</Badge>
      <Badge tone="info">{labels.recipients}</Badge>
      <span className="mu-field-hint">{t("cares.note.check_local_rules")}</span>
    </div>
  );
}

const TONE: Record<ListingBadge, "success" | "info" | "evidence" | "neutral" | "warning"> =
  { published: "info", allocated: "warning", handed_over: "success", closed: "neutral", withdrawn: "neutral" };

export function StatusBadge({ listing }: { listing: Pick<Listing, "status" | "handovers"> }) {
  const b = listingBadge(listing);
  return <Badge tone={TONE[b]}>{t(`cares.status.${b}`)}</Badge>;
}

/** A recipient exactly as the API names it ("… (simulated)"), beside the simulated badge. */
export function RecipientName({ name }: { name: string | null }) {
  return <span className="cares-recipient">{name ?? t("cares.recipient.unknown")} <SimulatedBadge of="data" /></span>;
}

export function OutcomeView({ outcome, done, onRetry }: { outcome: Outcome | null; done: ReactNode; onRetry: () => void }) {
  if (!outcome) return null;
  if (outcome.ok) return <p className="mu-recorded" role="status" data-outcome="ok">{done}</p>;
  if (outcome.kind === "deny") return <StateDeny />;
  if (outcome.kind === "offline") return <StateOffline onRetry={onRetry} />;
  return <StateError onRetry={onRetry} {...(outcome.message ? { detail: outcome.message } : {})} />;
}

export function useFormatters() {
  const c = useConsole();
  return useMemo(() => {
    const byOutlet = new Map<string, Formatter>(c.outlets.map((o) => [o.id, createFormatter({ country: c.format.country, tz: o.tz })]));
    const fallback = createFormatter(c.format);
    return { fallback, forOutlet: (id: string) => byOutlet.get(id) ?? fallback };
  }, [c.outlets, c.format]);
}
