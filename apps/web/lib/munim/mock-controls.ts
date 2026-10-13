// lib/munim/mock-controls.ts: from 01-api-client.md
// Dev-only switches for the mock API's test headers. Sent only when the base URL is the mock (index.ts) AND
// NEXT_PUBLIC_MUNIM_MOCK_CONTROLS=1. Render a small panel (two selects) that calls writeMockControls(); never in production.
export type ForcedAccepting = "open" | "busy" | "paused" | "closed";
export interface MockControls {
  accepting: ForcedAccepting | null;
  force429: boolean;
}

const STORAGE_KEY = "munim.mock.controls";
export const MOCK_CONTROLS_ENABLED = process.env.NEXT_PUBLIC_MUNIM_MOCK_CONTROLS === "1";

export function readMockControls(): MockControls {
  const none: MockControls = { accepting: null, force429: false };
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
  return h;
}
