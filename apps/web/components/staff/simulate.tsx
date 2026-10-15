// file: components/staff/simulate.tsx
"use client";
// Mock only: the "Simulate a web order" button (03 §6). A shopper's storefront order cannot reach the mock kitchen
// (it lives in the shopper's signed token), so this places a synthetic pickup order at the chosen outlet. Never
// rendered against the real API, where real storefront orders arrive on their own.
import { useState } from "react";
import { IS_MOCK } from "@/lib/munim";
import { MOCK_CONTROLS_ENABLED } from "@/lib/munim/mock-controls";
import { simulateWebOrder } from "@/lib/munim/staff-app";
import { useStaff } from "./shell";

export function SimulateWebOrder({ onDone }: { onDone: (ok: boolean) => void }) {
  const { session, outlet } = useStaff();
  const [busy, setBusy] = useState(false);
  if (!IS_MOCK || !MOCK_CONTROLS_ENABLED || !outlet) return null;
  return (
    <button type="button" className="btn btn-plain" disabled={busy} onClick={async () => {
      setBusy(true);
      const ok = await simulateWebOrder(session, outlet.id);
      setBusy(false);
      onDone(ok);
    }}>
      {busy ? "Sending…" : "Simulate a web order"}
    </button>
  );
}
