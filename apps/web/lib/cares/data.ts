"use client";
// Cares reads and the person's own commands. Reads go through the same-origin proxy; nothing here computes a number.
import { uuidv7 } from "@munim/sdk";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import type { Batch, Listing, Profile, Recipient } from "./model.ts";

export type Load<T> = { status: "loading" } | { status: "ok"; data: T } | { status: "err" };

export type Outcome = { ok: true } | { ok: false; kind: "deny" | "offline" | "error"; message?: string };

/** One user intent = one command id + one idempotency key: a retry after S-off resends the SAME pair (03-arch §1.6);
 *  an edit makes a new intent. `ids` carries the entity ids the payload mints, so a replay is byte-identical. */
export const newIntent = () => ({ command_id: uuidv7(), idempotency_key: uuidv7(), listing_id: uuidv7(), line_id: uuidv7(), handover_id: uuidv7() });
export type Intent = ReturnType<typeof newIntent>;

/** Runs one command call and sorts the result into the standard states. The message is core-composed, never model text. */
export async function send(call: () => Promise<{ response: Response; error?: unknown }>): Promise<Outcome> {
  try {
    const { response, error } = await call();
    if (response.ok) return { ok: true };
    if (response.status === 403) return { ok: false, kind: "deny" };
    const message = (error as { error?: { message?: unknown } } | undefined)?.error?.message;
    return { ok: false, kind: "error", ...(typeof message === "string" ? { message } : {}) };
  } catch {
    return { ok: false, kind: "offline" };
  }
}

/** One impact snapshot per (scope, window) per page session: evidence is append-only, so re-opening the tab reuses it.
 *  Cleared by `reload` (a command changed the numbers) and per key after a failed mint. */
export const impactCache = new Map<string, Promise<unknown>>();

export interface CaresData {
  profile: Load<Profile>;
  listings: Load<Listing[]>;
  /** Simulated recipients of every enrolled outlet in scope, by id and per outlet. */
  recipients: Map<string, Recipient>;
  recipientsByOutlet: Map<string, Recipient[]>;
  batches: Map<string, Batch>;
  batchesByOutlet: Map<string, Batch[]>;
  /** Active, enrolled outlets inside the member's scope: what recipients, batches and the new-listing form use. */
  enrolledIds: string[];
  reload: () => void;
}

/** `scopeIds` = the outlets the member can see; `scopeOutletId` = the one picked in the scope switch, if any. */
export function useCaresData(scopeOutletId: string | null, scopeIds: readonly string[]): CaresData {
  const [version, setVersion] = useState(0);
  const [profile, setProfile] = useState<Load<Profile>>({ status: "loading" });
  const [listings, setListings] = useState<Load<Listing[]>>({ status: "loading" });
  const [recipientsByOutlet, setRecipients] = useState(new Map<string, Recipient[]>());
  const [batchesByOutlet, setBatches] = useState(new Map<string, Batch[]>());
  const enrolledIds = profile.status === "ok"
    ? profile.data.outlets.filter((o) => o.active && scopeIds.includes(o.outlet_id) && (scopeOutletId === null || o.outlet_id === scopeOutletId)).map((o) => o.outlet_id)
    : [];
  // Names (recipients, batch codes) are also fetched for outlets that only appear on a listing the API returned, so a
  // manager whose own outlet list is unknown still sees the recipient names core gives them.
  const listingOutlets = listings.status === "ok" ? listings.data.map((l) => l.outlet_id) : [];
  const key = [...new Set([...enrolledIds, ...listingOutlets])].join(",");

  useEffect(() => {
    let live = true;
    (async () => {
      const [p, l] = await Promise.all([
        api.GET("/v1/cares/profile"),
        api.GET("/v1/cares/listings", { params: { query: { limit: 200, ...(scopeOutletId ? { outlet: scopeOutletId } : {}) } } }),
      ]).catch(() => [null, null] as const);
      if (!live) return;
      setProfile(p?.data ? { status: "ok", data: p.data } : { status: "err" });
      setListings(l?.data ? { status: "ok", data: l.data.items } : { status: "err" });
    })();
    return () => { live = false; };
  }, [scopeOutletId, version]);

  useEffect(() => {
    let live = true;
    const ids = key ? key.split(",") : [];
    // Names are a convenience: a failed lookup falls back to generic labels, never to an error state.
    Promise.all(ids.map(async (outlet) => {
      const [r, b] = await Promise.all([
        api.GET("/v1/cares/recipients", { params: { query: { outlet } } }).catch(() => null),
        api.GET("/v1/inventory/batches", { params: { query: { outlet } } }).catch(() => null),
      ]);
      return [outlet, r?.data?.items ?? [], b?.data?.batches ?? []] as const;
    })).then((rows) => {
      if (!live) return;
      setRecipients(new Map(rows.map(([o, r]) => [o, r])));
      setBatches(new Map(rows.map(([o, , b]) => [o, b])));
    });
    return () => { live = false; };
  }, [key, version]);

  const reload = useCallback(() => { impactCache.clear(); setVersion((v) => v + 1); }, []);
  const flat = <T, K extends string>(m: Map<string, T[]>, id: (x: T) => K) => new Map([...m.values()].flat().map((x) => [id(x), x] as const));
  return {
    profile, listings, reload, enrolledIds,
    recipientsByOutlet, batchesByOutlet,
    recipients: flat(recipientsByOutlet, (r) => r.recipient_id),
    batches: flat(batchesByOutlet, (b) => b.batch_id),
  };
}
