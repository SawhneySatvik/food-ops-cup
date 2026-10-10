// How a sales channel's money and tax flow, read from the country pack (R21: no country branch here).
import type { CountryPack } from "@munim/contracts/packs";
import type { ChannelTreatment } from "./post.ts";

const AGGREGATOR = /^aggregator:([a-z][a-z0-9_]*)$/;

/** An aggregator the pack does not list is treated as merchant-collected (the merchant's own liability) —
 *  the conservative reading for output tax. */
export function channelTreatment(pack: Pick<CountryPack, "aggregators">, channel_kind: string): ChannelTreatment {
  const m = AGGREGATOR.exec(channel_kind);
  if (!m) return { aggregator: false, operator_collects: false };
  const agg = pack.aggregators.find((a) => a.code === m[1]);
  return { aggregator: true, operator_collects: agg?.tax_treatment === "operator_collects_excluded" };
}
