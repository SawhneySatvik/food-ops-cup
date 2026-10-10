// Cross-module seams this module calls (W2 lane brief): inventory.deriveGoodsReceipt (T-024) and
// finance.postFor (T-026). Neither module is imported statically: until it lands, a static import would stop
// `loadRouters` and every lane's app tests. The real functions are resolved on first use; a missing module
// fails closed with `unavailable`. Tests install fakes with setSeams (a fake still writes through the book guard).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";

export interface Seams {
  /** inventory.receive_grn: the receipt movements of one goods-received note, written in the caller's transaction. */
  deriveGoodsReceipt(tx: Queryable, grnId: string): Promise<unknown>;
  /** finance: the derived journal entry for one seeded posting rule, `sourceRef` = "core.<table>:<id>". */
  postFor(tx: Queryable, ruleId: string, sourceRef: string): Promise<unknown>;
  /** finance: the reversal of an approved invoice's entry once it is disputed or voided (0015 A6). Optional in an
   *  installed set: absent, the real finance seam reverses whatever entry the set's postFor wrote. */
  reverseSource?(tx: Queryable, ruleId: "finance.reverse_supplier_invoice", sourceRef: string): Promise<unknown>;
}

let installed: Seams | undefined;

/** Installs seam implementations (tests, T-034 wiring). Returns the restore function. */
export function setSeams(s: Seams): () => void {
  const prev = installed;
  installed = s;
  return () => {
    installed = prev;
  };
}

async function load<T>(dir: string, fn: string): Promise<T> {
  const file = join(import.meta.dirname, "..", dir, "index.ts");
  if (!existsSync(file)) throw new ApiError("unavailable");
  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  if (typeof mod[fn] !== "function") throw new ApiError("unavailable");
  return mod[fn] as T;
}

export const seams: Seams = {
  async deriveGoodsReceipt(tx, grnId) {
    if (installed) return installed.deriveGoodsReceipt(tx, grnId);
    return (await load<Seams["deriveGoodsReceipt"]>("inventory", "deriveGoodsReceipt"))(tx, grnId);
  },
  async postFor(tx, ruleId, sourceRef) {
    if (installed) return installed.postFor(tx, ruleId, sourceRef);
    return (await load<Seams["postFor"]>("finance", "postFor"))(tx, ruleId, sourceRef);
  },
  async reverseSource(tx, ruleId, sourceRef) {
    if (installed?.reverseSource) return installed.reverseSource(tx, ruleId, sourceRef);
    return (await load<NonNullable<Seams["reverseSource"]>>("finance", "reverseSource"))(tx, ruleId, sourceRef);
  },
};
