// Platform config (02-schema §1; R21, R36). Operator-owned; merchants never see providers. A role's
// provider + model changes only through an approved platform config draft (T-031).
import { z } from "zod";
import type { Route } from "../shared/routes.ts";

export const MODEL_ROLES = ["router", "reason", "extract", "narrate", "vision", "embed"] as const;
export const MODEL_PROVIDERS = ["gemini", "openai", "openrouter", "nvidia"] as const;
export const ModelRoleName = z.enum(MODEL_ROLES);
export const ModelProvider = z.enum(MODEL_PROVIDERS);

/** platform.model_role — one row per role. */
export const ModelRole = z.strictObject({
  role: ModelRoleName,
  provider: ModelProvider,
  /** The provider's model identifier, e.g. "gemini-2.5-flash", "meta/llama-3.3-70b-instruct". */
  model_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/),
});
export type ModelRole = z.infer<typeof ModelRole>;

export const SCHEMAS = { "platform.model-role": ModelRole };
export const ROUTES: readonly Route[] = [];
