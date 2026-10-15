// file: components/staff/use-command.ts
"use client";
// One person's command from a form (publish a listing, record a hand-over, withdraw, place a purchase order, receive
// goods): one frozen attempt per thing confirmed (01 §4). Tapping the same button again after a network error, 429
// or 5xx resends the same envelope (the attempt's fingerprint is unchanged); any change to the form is a new attempt.
// A 429 disables the button for Retry-After and shows the wait.
import { useRef, useState } from "react";
import { useCountdown } from "@/lib/hooks";
import type { MunimError, Result } from "@/lib/munim/client";
import { retryable, type CommandAttempt, type Envelope } from "@/lib/munim/commands";
import { staffErrorText, type StaffWhere } from "@/lib/munim/staff-copy";
import type { Schemas } from "@/lib/munim/types";

export function useCommand<T extends string, P>(where: StaffWhere, onAuth: (e: MunimError) => boolean) {
  const attempt = useRef<CommandAttempt<T, P> | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const wait = useCountdown(retryAt, () => setRetryAt(null));

  /** Builds (or reuses) the attempt and sends it. null = a send was already in flight (a double tap). */
  const send = async (
    make: (prev: CommandAttempt<T, P> | null) => CommandAttempt<T, P>,
    call: (body: Envelope<T, P>) => Promise<Result<Schemas["CommandResult"]>>,
    text: (e: MunimError) => string = (e) => staffErrorText(e, where),
  ): Promise<Result<Schemas["CommandResult"]> | null> => {
    if (inFlight.current) return null;
    const a = make(attempt.current);
    attempt.current = a;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const r = await call(a.body);
    inFlight.current = false;
    setBusy(false);
    if (r.ok || !retryable(r.error)) attempt.current = null;
    if (!r.ok && !onAuth(r.error)) {
      setError(text(r.error));
      if (r.error.retryAfterMs) setRetryAt(Date.now() + r.error.retryAfterMs);
    }
    return r;
  };
  return { busy, error, wait, send, reset: () => { attempt.current = null; setError(null); } };
}
