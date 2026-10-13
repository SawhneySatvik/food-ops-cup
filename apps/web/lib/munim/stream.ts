// Live updates over server-sent events, read with fetch (never EventSource, which cannot send headers).
// The SDK's reader sends the credentials and Last-Event-ID on every (re)connect and backs off with jitter.
export { openStream, parseSse, StreamRefused } from "@munim/sdk";
export type { StreamEvent, StreamHandle, StreamOptions, StreamState } from "@munim/sdk";
