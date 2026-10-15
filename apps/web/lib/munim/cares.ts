// lib/munim/cares.ts: from 01-api-client.md
// Munim Cares helpers. Listings are this business's surplus food offered to SIMULATED recipients.
import type { Schemas } from "./types";

export type CaresListing = Schemas["V1StorefrontCares"]["items"][number];
export type ImpactRow = Schemas["V1CaresNetworkImpact"]["rows"][number];

/** The all-cities row (city_code null); null when absent. Never pick a row by position. */
export const impactTotal = (impact: Schemas["V1CaresNetworkImpact"]): ImpactRow | null => impact.rows.find((r) => r.city_code === null) ?? null;

export const FOOD_KIND_LABEL: Record<string, string> = { cooked: "Cooked", raw: "Raw", packaged: "Packaged" };
const UNIT_LABEL: Record<string, string> = { portion: "portions", piece: "pieces", kg: "kg", g: "g", l: "L", ml: "ml" };
export const unitLabel = (unit: string): string => UNIT_LABEL[unit] ?? unit;
