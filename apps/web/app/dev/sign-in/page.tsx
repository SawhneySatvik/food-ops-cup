import { Button, Card, StateError } from "@munim/ui";
import { notFound } from "next/navigation";
import { t } from "../../../lib/i18n/index.ts";
import { requestHostAllowed } from "../../../lib/origins.ts";
import { DEV_PERSONAS, DEV_WORLDS, devSignInAvailable, type DevWorld } from "../../../lib/session/dev-local.ts";
import { signInAs } from "./actions.ts";

export const dynamic = "force-dynamic";

/** Dev-only persona picker: a 404 unless the Host is a local name (DNS rebinding), NODE_ENV is not production AND core's
 *  /health reports idp "local". Lists personas without minting: the POST action mints one token for the chosen one. */
export default async function DevSignIn({ searchParams }: { searchParams: Promise<{ world?: string; failed?: string }> }) {
  if (!(await requestHostAllowed()) || !(await devSignInAvailable())) notFound();
  const q = await searchParams;
  const world = ((DEV_WORLDS as readonly string[]).includes(q.world ?? "") ? q.world : "restaurant_group") as DevWorld;
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-8) var(--space-6)", display: "grid", gap: "var(--space-7)" }}>
      <header style={{ display: "grid", gap: "var(--space-3)" }}>
        <h1 style={{ font: "var(--type-2xl)", margin: 0 }}>{t("dev.sign_in.title")}</h1>
        <p style={{ margin: 0, color: "var(--text-secondary)" }}>{t("dev.sign_in.lede")}</p>
      </header>
      <nav aria-label={t("dev.sign_in.world")} style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)" }}>
        {DEV_WORLDS.map((w) => (
          <a key={w} className="mu-btn" data-variant={w === world ? "primary" : "secondary"} data-size="sm" href={`/dev/sign-in?world=${w}`}
            aria-current={w === world ? "page" : undefined}>{w}</a>
        ))}
      </nav>
      {q.failed && <StateError detail={t("dev.sign_in.failed")} />}
      {DEV_PERSONAS[world].map((persona) => (
        <Card key={persona} data-persona={persona}>
          <h2>{persona}</h2>
          <form action={signInAs}>
            <input type="hidden" name="world" value={world} />
            <input type="hidden" name="persona" value={persona} />
            <Button type="submit" variant="primary">{t("dev.sign_in.as", { persona })}</Button>
          </form>
        </Card>
      ))}
    </main>
  );
}
