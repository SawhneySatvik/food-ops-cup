// Access token for Google APIs from the Cloud Run metadata server (the service account the revision runs as).
// Cached until a minute before it expires. Never logged; errors carry the HTTP status only.
const URL_DEFAULT = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

export type TokenSource = () => Promise<string>;

export function metadataTokenSource(o: { fetch?: typeof fetch | undefined; url?: string; now?: () => number } = {}): TokenSource {
  const call = o.fetch ?? fetch;
  const clock = o.now ?? Date.now;
  let cached: { token: string; until: number } | null = null;
  return async () => {
    if (cached && clock() < cached.until) return cached.token;
    let res: Response;
    try {
      res = await call(o.url ?? URL_DEFAULT, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(3_000) });
    } catch {
      throw new Error("metadata token: server unreachable");
    }
    if (!res.ok) throw new Error(`metadata token: HTTP ${res.status}`);
    const j = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
    if (typeof j.access_token !== "string" || typeof j.expires_in !== "number") throw new Error("metadata token: malformed reply");
    cached = { token: j.access_token, until: clock() + Math.max(0, j.expires_in - 60) * 1000 };
    return cached.token;
  };
}
