// file: lib/munim/staff-app.ts
// The app's staff wiring, built from the same env vars as the storefront (index.ts): the client and the live
// updates for the signed-in session, plus the mock's "Simulate a web order" switch.
import { API_BASE, IS_MOCK } from "./index";
import { MOCK_CONTROLS_ENABLED, mockHeaders } from "./mock-controls";
import { clientFor, type Session } from "./session";
import { watch, type LiveState } from "./staff-stream";
import { uuidv7 } from "./uuid";

const extra = IS_MOCK ? mockHeaders : undefined;

export const staffFor = (s: Session) => clientFor(API_BASE, s, extra);

export const watchFor = (s: Session, topics: readonly string[], onWake: () => void, onState?: (st: LiveState) => void) =>
  watch({ baseUrl: API_BASE, session: s, topics, onWake, onState, extraHeaders: extra });

/** Mock only (Mock controls panel): places a synthetic web order at the outlet, so the kitchen gets a pickup ticket
 *  the way a storefront order would reach it on the real API. Not a Munim route; never called against the real API. */
export async function simulateWebOrder(s: Session, outletId: string): Promise<boolean> {
  if (!IS_MOCK || !MOCK_CONTROLS_ENABLED) return false;
  try {
    const res = await fetch(`${API_BASE}/v1/_mock/web-order`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.token}`, "X-Munim-Tenant": s.tenantId },
      body: JSON.stringify({ outlet_id: outletId, request_id: uuidv7() }),
    });
    return res.status === 201;
  } catch {
    return false;
  }
}
