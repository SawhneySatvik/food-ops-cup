// Patch validation for platform config drafts (R24, R36). Pure: it runs when a draft is proposed and again when
// it is applied, so a draft cannot apply something the proposal check would have refused. Refusals are
// ApiError codes only; nothing here echoes caller text.
import { MODEL_PROVIDERS, MODEL_ROLES } from "@munim/contracts/platform";
import { CountryPack } from "@munim/contracts/packs";
import { ApiError } from "../lib/errors.ts";

export type Patch = Record<string, unknown>;

export type Parsed =
  | { kind: "model_role"; role: (typeof MODEL_ROLES)[number]; provider: (typeof MODEL_PROVIDERS)[number]; model_id: string;
      /** R47 D1: all three or none; null = unpriced (a model change that omits them clears the price, so a new model is never billed at the old one's rate). */
      prices: { input: number; output: number; currency: string } | null }
  | { kind: "feature_flag"; key: string; value: boolean | number | string }
  | { kind: "llm_budget"; tenant_id: string; month: string; limit_minor: number; currency: string }
  | { kind: "country_pack"; code: string; effective_from: string; doc: CountryPack }
  | { kind: "plan"; code: string; name: string; limits: Record<string, unknown>; status: "active" | "retired" };

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bad = () => new ApiError("invalid_payload");

function only(patch: Patch, keys: string[]): void {
  const extra = Object.keys(patch).filter((k) => !keys.includes(k));
  if (extra.length > 0 || keys.some((k) => !(k in patch))) throw bad();
}

/** The same test the table CHECK applies (case-insensitive, anywhere in the id): gemini-2.5 retires 20 Oct 2026. */
export const isBlockedModel = (id: string): boolean => /gemini-2\.5/i.test(id);

/** Today (UTC) as YYYY-MM-DD; a pack version must start after it. */
export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

export function parsePatch(target: string, patch: Patch, today: string = todayUtc()): Parsed {
  const [kind, id] = target.split(":") as [string, string | undefined];
  switch (kind) {
    case "model_role": {
      if (!id || !(MODEL_ROLES as readonly string[]).includes(id)) throw bad();
      const priced = ["input_price_per_mtok_minor", "output_price_per_mtok_minor", "price_currency"].filter((k) => k in patch);
      // Partial price groups fail here: the three keys must all be present or all absent.
      only(patch, priced.length === 3 ? ["provider", "model_id", "input_price_per_mtok_minor", "output_price_per_mtok_minor", "price_currency"] : ["provider", "model_id"]);
      const { provider, model_id } = patch;
      if (typeof provider !== "string" || !(MODEL_PROVIDERS as readonly string[]).includes(provider)) throw bad(); // unknown provider
      if (typeof model_id !== "string" || !MODEL_ID.test(model_id)) throw bad();
      if (isBlockedModel(model_id)) throw new ApiError("invalid_payload", "model_blocked");
      let prices: Extract<Parsed, { kind: "model_role" }>["prices"] = null;
      if (priced.length === 3) {
        const { input_price_per_mtok_minor: i, output_price_per_mtok_minor: o, price_currency: cur } = patch;
        if (!Number.isSafeInteger(i) || (i as number) < 0 || !Number.isSafeInteger(o) || (o as number) < 0) throw bad();
        if (typeof cur !== "string" || !/^[A-Z]{3}$/.test(cur)) throw bad();
        prices = { input: i as number, output: o as number, currency: cur };
      }
      return { kind, role: id as never, provider: provider as never, model_id, prices };
    }
    case "feature_flag": {
      if (!id || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/.test(id)) throw bad();
      only(patch, ["value"]);
      const v = patch.value;
      if (typeof v === "string" ? v.length > 500 : typeof v !== "boolean" && !Number.isSafeInteger(v)) throw bad();
      return { kind, key: id, value: v as boolean | number | string };
    }
    case "llm_budget": {
      if (!id || !UUID.test(id)) throw bad();
      only(patch, ["month", "limit_minor", "currency"]);
      const { month, limit_minor, currency } = patch;
      if (typeof month !== "string" || !/^\d{4}-\d{2}-01$/.test(month) || Number.isNaN(Date.parse(month))) throw bad();
      if (!Number.isSafeInteger(limit_minor) || (limit_minor as number) < 0) throw bad();
      if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw bad();
      return { kind, tenant_id: id, month, limit_minor: limit_minor as number, currency };
    }
    case "country_pack": {
      if (!id || !/^[A-Z]{2}$/.test(id)) throw bad();
      only(patch, ["effective_from", "doc"]);
      const { effective_from, doc } = patch;
      if (typeof effective_from !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(effective_from)) throw bad();
      if (effective_from <= today) throw bad(); // a new version applies from a future start date
      const parsed = CountryPack.safeParse(doc);
      if (!parsed.success) throw bad();
      if (parsed.data.code !== id || parsed.data.effective_from !== effective_from) throw bad();
      return { kind, code: id, effective_from, doc: parsed.data };
    }
    case "plan": {
      if (!id || !/^[a-z][a-z0-9_]*$/.test(id)) throw bad();
      only(patch, ["name", "limits", "status"]);
      const { name, limits, status } = patch;
      if (typeof name !== "string" || name.length < 1 || name.length > 200) throw bad();
      if (typeof limits !== "object" || limits === null || Array.isArray(limits)) throw bad();
      if (status !== "active" && status !== "retired") throw bad();
      return { kind, code: id, name, limits: limits as Record<string, unknown>, status };
    }
    default:
      throw bad();
  }
}
