"use client";
// Live updates over fetch-based SSE through the proxy (gotcha 23: no EventSource). The SDK's openStream does the
// reading, Last-Event-ID replay on every reconnect, and exponential backoff with jitter; this hook adds React state for
// the live pill. Members: the proxy swaps the placeholder bearer for the session's token on every (re)connect, so an
// expired dev token is re-minted server-side. Guests: their order token rides as X-Munim-Guest-Token.
import { openStream, type StreamEvent } from "@munim/sdk";
import type { LiveState } from "@munim/ui";
import { useEffect, useRef, useState } from "react";
import { API_BASE } from "./api.ts";

// openStream requires a token or a guest token; the proxy never forwards the browser's Authorization header.
const VIA_PROXY = () => "session-cookie";

export type { StreamEvent };

export function useStream(
  topics: readonly string[] | null,
  onEvent: (event: StreamEvent) => void,
  opts: { storefrontKey?: string; guestToken?: string } = {},
): LiveState {
  const [state, setState] = useState<LiveState>("connecting");
  const handler = useRef(onEvent);
  useEffect(() => { handler.current = onEvent; });
  const key = topics && topics.length ? topics.join(",") : "";
  const { storefrontKey, guestToken } = opts;
  useEffect(() => {
    if (!key) return;
    const stream = openStream({
      baseUrl: API_BASE,
      topics: key.split(","),
      ...(guestToken ? { guestToken } : { token: VIA_PROXY }),
      ...(storefrontKey ? { headers: () => ({ "X-Munim-Storefront-Key": storefrontKey }) } : {}),
      onEvent: (e) => handler.current(e),
      onState: (s) => setState(s),
    });
    // A refusal (403/404 topic) ends the stream: the pill stays "Reconnecting…" rather than claiming live.
    stream.done.catch(() => setState("closed"));
    return () => stream.close();
  }, [key, storefrontKey, guestToken]);
  return state;
}
