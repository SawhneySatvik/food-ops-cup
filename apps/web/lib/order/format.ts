// Display formatting for the storefront. The storefront API names no country, so the pack is found by the currency the
// server priced in (a data lookup over the packs — no country branch, rule 7); times render in the outlet's own zone.
// Language comes from the pack's locale (`fmt.pack.locale`).
import { PACKS } from "@munim/contracts/packs";
import { createFormatter, type Formatter } from "@munim/ui";

/** The pack whose currency the server priced in, or null when none matches (callers then show S-err, never a guess). */
export function countryFor(currency: string | null): string | null {
  return Object.entries(PACKS).find(([, p]) => p.currency.code === currency)?.[0] ?? null;
}

/** null when the currency names no pack or the zone is unknown: never format in a default country or in UTC. */
export function formatterFor(currency: string | null, tz: string | null | undefined): Formatter | null {
  const country = countryFor(currency);
  return country && tz ? createFormatter({ country, tz }) : null;
}

/** "Mon–Fri"-style day list from ISO weekdays: runs of three or more consecutive days collapse to "a–b". */
export function dayRuns(days: readonly number[], name: (d: number) => string): string {
  const sorted = [...days].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    runs.push(j - i >= 2 ? `${name(sorted[i]!)}–${name(sorted[j]!)}` : sorted.slice(i, j + 1).map(name).join(", "));
    i = j + 1;
  }
  return runs.join(", ");
}
