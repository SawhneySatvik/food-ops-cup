// file: lib/munim/mock-controls.ts
// Dev-only switches for the mock API's test headers. Sent only when the base URL is the mock (index.ts) AND
// NEXT_PUBLIC_MUNIM_MOCK_CONTROLS=1. The storefront's two switches are unchanged; the staff screens add two
// (both optional, so the storefront's MockPanel keeps compiling): how the next approve is answered, and the AI's state.
export type ForcedAccepting = "open" | "busy" | "paused" | "closed";
export type ForcedDecision = "stale" | "already_decided" | "execution_failed";
export type ForcedAi = "off" | "abstain";
export interface MockControls {
  accepting: ForcedAccepting | null;
  force429: boolean;
  /** Approve answers 409 stale_draft, 409 already_decided or 422 execution_failed. */
  decision?: ForcedDecision | null;
  /** Ask answers 503 (AI unavailable: hide the surface) or an abstention (model_blocked). */
  ai?: ForcedAi | null;
  /** A request for quotes answers this negotiation status (core's X-Munim-Negotiation values). */
  negotiation?: string | null;
  /** T-128: the business runs three brands (a cloud kitchen), so the brand switch shows. */
  brands?: "three" | null;
  /** T-128: a business that is not a demo: publishing the storefront works, recording a campaign as sent does not. */
  demo?: "off" | null;
  /** T-128: a new investigation's later month is missing bank lines, so it waits for the books. */
  investigation?: "waiting" | null;
}

const STORAGE_KEY = "munim.mock.controls";
export const MOCK_CONTROLS_ENABLED = process.env.NEXT_PUBLIC_MUNIM_MOCK_CONTROLS === "1";

export function readMockControls(): MockControls {
  const none: MockControls = { accepting: null, force429: false, decision: null, ai: null, negotiation: null, brands: null, demo: null, investigation: null };
  if (!MOCK_CONTROLS_ENABLED || typeof window === "undefined") return none;
  try {
    return { ...none, ...(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<MockControls>) };
  } catch {
    return none;
  }
}

export function writeMockControls(c: MockControls): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    // storage blocked (private mode): the switches simply stay off
  }
}

export function mockHeaders(): Record<string, string> {
  const c = readMockControls();
  const h: Record<string, string> = {};
  if (c.accepting) h["X-Mock-Force-Accepting"] = c.accepting;
  if (c.force429) h["X-Mock-Force-429"] = "1";
  if (c.decision) h["X-Mock-Force-Decision"] = c.decision;
  if (c.ai) h["X-Mock-Force-Ai"] = c.ai;
  if (c.negotiation) h["X-Mock-Force-Negotiation"] = c.negotiation;
  if (c.brands) h["X-Mock-Brands"] = c.brands;
  if (c.demo) h["X-Mock-Demo"] = c.demo;
  if (c.investigation) h["X-Mock-Force-Investigation"] = c.investigation;
  return h;
}
