import { Button, Card, StateError } from "@munim/ui";
import { notFound } from "next/navigation";
import { serverClient } from "../../../lib/core.ts";
import { t } from "../../../lib/i18n/index.ts";
import { tokenClaims } from "../../../lib/session/port.ts";
import { DEV_WORLDS, devSignInAvailable, mintPersonaTokens, type DevWorld } from "../../../lib/session/dev-local.ts";
import { signInAs } from "./actions.ts";

export const dynamic = "force-dynamic";

/** Dev-only persona picker: a 404 unless NODE_ENV is not production AND core's /health reports idp "local". */
export default async function DevSignIn({ searchParams }: { searchParams: Promise<{ world?: string; failed?: string }> }) {
  if (!(await devSignInAvailable())) notFound();
  const q = await searchParams;
  const world = ((DEV_WORLDS as readonly string[]).includes(q.world ?? "") ? q.world : "restaurant_group") as DevWorld;
  const tokens = await mintPersonaTokens(world);
  const personas = await Promise.all(Object.entries(tokens).map(async ([persona, token]) => {
    const { data } = await serverClient(token).GET("/v1/me/tenants");
    return { persona, email: tokenClaims(token).email ?? "", tenant: data?.tenants[0] ?? null };
  }));
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
      {personas.length === 0 && <p>{t("dev.sign_in.empty", { world })}</p>}
      {personas.map((p) => (
        <Card key={p.persona} data-persona={p.persona}>
          <h2>{p.persona}</h2>
          <p style={{ margin: "0 0 var(--space-4)", color: "var(--text-secondary)" }}>
            {p.email}{p.tenant ? ` · ${p.tenant.tenant_name} · ${t(`chrome.role.${p.tenant.role}`)}` : ` · ${t("chrome.no_tenant")}`}
          </p>
          <form action={signInAs}>
            <input type="hidden" name="world" value={world} />
            <input type="hidden" name="persona" value={p.persona} />
            <Button type="submit" variant="primary" disabled={!p.tenant}>{t("dev.sign_in.as", { persona: p.persona })}</Button>
          </form>
        </Card>
      ))}
    </main>
  );
}
