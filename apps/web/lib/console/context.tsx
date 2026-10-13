"use client";
// Console session context (T-060 shell; T-064 / T-100 pages read it). Holds what the chrome shows and what pages need
// to render numbers: the business, its pack format, the scope, the inbox list the badge counts, the live state, and
// whether AI surfaces show. The inbox badge is the length of the list held here (R40 C3) — pages that show the inbox
// read the same list, so badge and list cannot disagree.
import type { Schemas } from "@munim/sdk";
import { SnapshotSourceProvider, type FormatSpec, type LiveState } from "@munim/ui";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { api, snapshotSource } from "../api.ts";
import { useStream } from "../live.ts";

export type InboxItem = Schemas["V1InboxResponse"]["items"][number];
export type Outlet = Schemas["V1Outlets"]["outlets"][number];
export type Role = "owner" | "manager" | "staff" | "advisor" | "judge";

export interface ConsoleSession {
  tenant: { id: string; name: string; isDemo: boolean };
  member: { name: string; role: Role };
  format: FormatSpec;
  /** Outlets in the member's scope; `outletId` null = all of them. */
  outlets: Outlet[];
  outletId: string | null;
  inbox: { items: InboxItem[]; nextCursor: string | null } | null;
  aiEnabled: boolean;
}

interface ConsoleValue extends ConsoleSession {
  live: LiveState;
  refreshInbox: () => Promise<void>;
  setAiOff: () => void;
}

const Ctx = createContext<ConsoleValue | null>(null);

export function useConsole(): ConsoleValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useConsole outside the console layout");
  return v;
}

const INBOX_LIMIT = 50;

export function ConsoleProvider({ session, children }: { session: ConsoleSession; children: ReactNode }) {
  const [inbox, setInbox] = useState(session.inbox);
  const [aiEnabled, setAiEnabled] = useState(session.aiEnabled);
  const canReadInbox = session.inbox !== null;

  const refreshInbox = useCallback(async () => {
    const { data } = await api.GET("/v1/inbox", { params: { query: { limit: INBOX_LIMIT } } });
    if (data) setInbox({ items: data.items, nextCursor: data.next_cursor });
  }, []);

  // inbox:<tenant> is readable by owners and managers only (core stream authorise); others get no stream.
  const topics = useMemo(() => (canReadInbox ? [`inbox:${session.tenant.id}`] : null), [canReadInbox, session.tenant.id]);
  const live = useStream(topics, () => void refreshInbox());

  const value = useMemo<ConsoleValue>(() => ({
    ...session,
    inbox,
    aiEnabled,
    live: topics ? live : "closed",
    refreshInbox,
    setAiOff: () => setAiEnabled(false),
  }), [session, inbox, aiEnabled, live, topics, refreshInbox]);

  return (
    <Ctx.Provider value={value}>
      <SnapshotSourceProvider source={snapshotSource}>{children}</SnapshotSourceProvider>
    </Ctx.Provider>
  );
}
