// What a new outlet starts with, by kind (T-020, ON2/ON3). A literal table, not a computation: the gate's
// expected row counts are typed by hand beside it. Pack-driven parts (aggregator channels, currency, FY
// start, time zones, tax-id patterns) come from the country pack, never from here (project rule 7).
//   kind (UI) → outlet kind (DB): "shop" is `store`.
export type OnboardKind = "restaurant" | "cloud_kitchen" | "shop";
export type OutletKind = "restaurant" | "cloud_kitchen" | "store";

export interface KindDefaults {
  outlet_kind: OutletKind;
  /** Own channels (core.channel kinds); the pack's aggregators are added when `aggregators`. */
  channels: ReadonlyArray<{ kind: "counter" | "table_qr" | "pickup" | "own_site"; name: string }>;
  aggregators: boolean;
  /** One POS device always; a KDS only where there is a kitchen line. */
  kds: boolean;
  /** Outlet timing knobs (minutes) — the pickup-window settings. */
  default_prep_min: number;
  pickup_slot_min: number;
  pickup_lead_min: number;
}

export const KIND_DEFAULTS: Readonly<Record<OnboardKind, KindDefaults>> = {
  restaurant: {
    outlet_kind: "restaurant",
    channels: [
      { kind: "counter", name: "Counter" }, { kind: "table_qr", name: "Table QR" },
      { kind: "pickup", name: "Pickup" }, { kind: "own_site", name: "Own site" },
    ],
    aggregators: true, kds: true, default_prep_min: 15, pickup_slot_min: 15, pickup_lead_min: 20,
  },
  cloud_kitchen: {
    outlet_kind: "cloud_kitchen",
    channels: [{ kind: "pickup", name: "Pickup" }, { kind: "own_site", name: "Own site" }],
    aggregators: true, kds: true, default_prep_min: 20, pickup_slot_min: 15, pickup_lead_min: 30,
  },
  shop: {
    outlet_kind: "store",
    channels: [{ kind: "counter", name: "Counter" }, { kind: "pickup", name: "Pickup" }, { kind: "own_site", name: "Own site" }],
    aggregators: false, kds: false, default_prep_min: 5, pickup_slot_min: 30, pickup_lead_min: 15,
  },
};

export const DEFAULT_HOURS = { opens: "09:00", closes: "22:00" } as const;
/** Invoice series prefix of the first POS (gapless per device per FY — the database numbers it). */
export const FIRST_POS_SERIES = "POS1";
