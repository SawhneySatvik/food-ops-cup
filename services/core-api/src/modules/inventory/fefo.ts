// First-expiry-first-out batch picking (T-024; ledger R40 C7; W1 ruling #61). Pure: the caller loads batch
// stock, overrides and the business date in its transaction and writes the picks.
//
// Per line, in the order given, drawing from one shared stock map (two lines of the same ingredient never claim
// the same remainder):
//   1. unexpired batches with stock, earliest `expires_on` first (no expiry last), then `received_at`, then id;
//   2. still short: expired batches (same order). A batch bound to this line by an unused override (one cart
//      line, one batch, up to its quantity) is drawn; any other expired stock blocks the line → `expired_batch`.
//      A batch-tracked item with only expired stock cannot be sold by going negative (C7);
//   3. still short and no stock at all: the rest is an unbatched draw (on-hand goes negative → alert).
// Expired = `expires_on` < the business date (a batch is sellable on its expiry date). INFERENCE: fresh stock is
// sold past expired stock still on the shelf (flow shop-barcode-sale: refuse only when "only expired stock is
// left"); the expiry_risk finding and the "write off expired batch" shortcut deal with what stays behind.
export type BatchStock = {
  batch_id: string;
  ingredient_id: string;
  /** YYYY-MM-DD, or null for a batch with no expiry. */
  expires_on: string | null;
  received_at: string;
  remaining_milli: number;
};

/** `expired_blocks: false` (recipe consumption of a batch-tracked ingredient, which a sale never refuses): skip
 *  step 2 — no override, no refusal, the uncovered rest is unbatched. Default true (a SKU sale line). */
export type PickLine = { line_id: string; ingredient_id: string; qty_milli: number; expired_blocks?: boolean };
export type OverrideGrant = { override_id: string; line_id: string; batch_id: string; qty_milli: number };

export type BatchPick = {
  line_id: string;
  ingredient_id: string;
  /** null = unbatched draw (no stock left to pick from). */
  batch_id: string | null;
  qty_milli: number;
  expired: boolean;
  override_id: string | null;
};
export type PickRefusal = { line_id: string; reason_code: "expired_batch"; batch_id: string };

const fefoOrder = (a: BatchStock, b: BatchStock): number => {
  if (a.expires_on !== b.expires_on) {
    if (a.expires_on === null) return 1;
    if (b.expires_on === null) return -1;
    return a.expires_on < b.expires_on ? -1 : 1;
  }
  if (a.received_at !== b.received_at) return a.received_at < b.received_at ? -1 : 1;
  return a.batch_id < b.batch_id ? -1 : a.batch_id > b.batch_id ? 1 : 0;
};

export const isExpired = (b: Pick<BatchStock, "expires_on">, businessDate: string): boolean => b.expires_on !== null && b.expires_on < businessDate;

export function fefoPick(
  stock: readonly BatchStock[],
  lines: readonly PickLine[],
  businessDate: string,
  overrides: readonly OverrideGrant[] = [],
): { picks: BatchPick[]; refusals: PickRefusal[] } {
  const left = new Map(stock.map((b) => [b.batch_id, b.remaining_milli]));
  const grantLeft = new Map(overrides.map((o) => [o.override_id, o.qty_milli]));
  const sorted = [...stock].sort(fefoOrder);
  const picks: BatchPick[] = [];
  const refusals: PickRefusal[] = [];

  for (const line of lines) {
    let short = line.qty_milli;
    const mine = sorted.filter((b) => b.ingredient_id === line.ingredient_id);
    const draw = (b: BatchStock, max: number, override_id: string | null) => {
      const q = Math.min(short, left.get(b.batch_id)!, max);
      if (q <= 0) return 0;
      left.set(b.batch_id, left.get(b.batch_id)! - q);
      short -= q;
      picks.push({ line_id: line.line_id, ingredient_id: line.ingredient_id, batch_id: b.batch_id, qty_milli: q, expired: override_id !== null, override_id });
      return q;
    };
    for (const b of mine) if (short > 0 && !isExpired(b, businessDate)) draw(b, Infinity, null);

    let blocked: string | null = null;
    for (const b of mine) {
      if (line.expired_blocks === false) break;
      if (short <= 0 || !isExpired(b, businessDate) || left.get(b.batch_id)! <= 0) continue;
      const grant = overrides.find((o) => o.line_id === line.line_id && o.batch_id === b.batch_id);
      if (grant) grantLeft.set(grant.override_id, grantLeft.get(grant.override_id)! - draw(b, grantLeft.get(grant.override_id)!, grant.override_id));
      if (short > 0 && left.get(b.batch_id)! > 0) blocked ??= b.batch_id;
    }
    if (short > 0 && blocked !== null) refusals.push({ line_id: line.line_id, reason_code: "expired_batch", batch_id: blocked });
    else if (short > 0) picks.push({ line_id: line.line_id, ingredient_id: line.ingredient_id, batch_id: null, qty_milli: short, expired: false, override_id: null });
  }
  return { picks, refusals };
}

/** The printed MRP that binds a line (W1 ruling #61): the lowest MRP among the batches it draws from (one
 *  price for the whole line must sit under each), a batch without a printed MRP standing in with the item's;
 *  the item's MRP when no batch is drawn. null = no MRP applies. */
export function bindingMrp(itemMrp: number | null, pickedBatchMrps: ReadonlyArray<number | null>): number | null {
  const mrps = (pickedBatchMrps.length === 0 ? [itemMrp] : pickedBatchMrps.map((m) => m ?? itemMrp)).filter((m): m is number => m !== null);
  return mrps.length === 0 ? null : Math.min(...mrps);
}
