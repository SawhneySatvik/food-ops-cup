// Money as integer minor units + ISO 4217 currency (03-architecture §1.5). Products and quotients go
// through BigInt so a rate or ratio never passes through a float. Rounding is half away from zero
// ("half-up" for positive amounts, mirrored for refunds and reversals).
import type { CountryPack } from "@munim/contracts/packs";

export type Money = { amount_minor: number; currency: string };

export class MoneyError extends Error {
  readonly code: "currency_mismatch" | "unsafe_integer" | "zero_weights";
  constructor(code: MoneyError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

function safe(n: number | bigint, what: string): number {
  const v = Number(n);
  if (!Number.isSafeInteger(v) || BigInt(v) !== BigInt(n)) throw new MoneyError("unsafe_integer", `${what} is not a safe integer`);
  return v;
}

export function money(amount_minor: number, currency: string): Money {
  return { amount_minor: safe(amount_minor, "amount_minor"), currency };
}

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new MoneyError("currency_mismatch", `currency mismatch: ${a.currency} vs ${b.currency}`);
}

export function add(a: Money, b: Money): Money {
  same(a, b);
  return money(a.amount_minor + b.amount_minor, a.currency);
}

export function sub(a: Money, b: Money): Money {
  same(a, b);
  return money(a.amount_minor - b.amount_minor, a.currency);
}

export function sum(items: Money[], currency: string): Money {
  return items.reduce((acc, m) => add(acc, m), money(0, currency));
}

/** n / d rounded half away from zero (d > 0). */
export function roundDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  const r2 = 2n * (n % d);
  if (r2 >= d) return q + 1n;
  if (-r2 >= d) return q - 1n;
  return q;
}

/** a × b / d, rounded half away from zero, exact (BigInt). */
export function mulDiv(a: number, b: number, d: number): number {
  return safe(roundDiv(BigInt(a) * BigInt(b), BigInt(d)), "mulDiv result");
}

/** Split `total` across `weights` in proportion, largest remainder first (ties → lower index), so the
 *  parts always sum to `total` exactly. */
export function allocate(total: number, weights: number[]): number[] {
  const W = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (W <= 0n) throw new MoneyError("zero_weights", "allocate: weights sum to zero");
  const sign = total < 0 ? -1n : 1n;
  const T = BigInt(total) * sign;
  const shares = weights.map((w) => (T * BigInt(w)) / W);
  const rems = weights.map((w, i) => ({ i, r: (T * BigInt(w)) % W }));
  let left = T - shares.reduce((a, s) => a + s, 0n);
  rems.sort((x, y) => (x.r === y.r ? x.i - y.i : x.r > y.r ? -1 : 1));
  for (const { i } of rems) {
    if (left === 0n) break;
    shares[i]! += 1n;
    left -= 1n;
  }
  return shares.map((s) => safe(s * sign, "allocated part"));
}

/** An integer scaled by 10^scale as an exact decimal string: (1500, 3) → "1.500". */
export function decimalString(value: number | bigint, scale: number): `${number}` {
  const v = BigInt(value);
  const digits = (v < 0n ? -v : v).toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  return `${v < 0n ? "-" : ""}${int}${scale > 0 ? `.${frac}` : ""}` as `${number}`;
}

/** Display form from the pack's locale and currency (grouping such as lakh/crore comes from the locale). */
export function formatMoney(m: Money, pack: CountryPack): string {
  if (m.currency !== pack.currency.code) throw new MoneyError("currency_mismatch", `currency mismatch: ${m.currency} vs pack ${pack.currency.code}`);
  const nf = new Intl.NumberFormat(pack.locale, {
    style: "currency",
    currency: pack.currency.code,
    minimumFractionDigits: pack.currency.minor_unit,
    maximumFractionDigits: pack.currency.minor_unit,
  });
  // A decimal string keeps Intl exact (no float conversion of the amount).
  return nf.format(decimalString(m.amount_minor, pack.currency.minor_unit));
}
