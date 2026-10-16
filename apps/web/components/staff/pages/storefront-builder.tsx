// file: components/staff/pages/storefront-builder.tsx
"use client";
// /staff/storefront (T-128, R66; design-system §9): the storefront's page builder. The theme — a colour preset or the
// owner's own colours (each with its contrast readout), the corners and the layout — and the home page's sections, dragged
// into order (or moved with "Move up" / "Move down"), shown or hidden, their words edited. A live preview renders the shop's
// own home sections in the page (not a frame), at a phone's width or a desktop's. Saving makes the next numbered version (a
// person's own command: the owner, or a manager of every outlet); only the owner publishes, and publishing an older version
// restores it. On the demo business core refuses publishing (R67 W-3), so the live shop stays Cobnut's for every visitor.
import { useCallback, useEffect, useRef, useState } from "react";
import { useOnline } from "@/lib/hooks";
import type { MunimError } from "@/lib/munim/client";
import { envelope } from "@/lib/munim/commands";
import { formatWhen } from "@/lib/munim/format";
import { BUILT_IN, LAYOUTS, PRESETS, SECTION_NAME, isHex, moveSection, readout, ratioWords, themeOk, themeVars, type PageDoc, type Section, type Theme } from "@/lib/munim/page-theme";
import { can } from "@/lib/munim/session";
import type { SavePageCommand } from "@/lib/munim/staff";
import { staffErrorText, staffWriteErrorText } from "@/lib/munim/staff-copy";
import type { Schemas } from "@/lib/munim/types";
import { uuidv7 } from "@/lib/munim/uuid";
import { SITE } from "@/lib/site";
import { HomeBody } from "../../pages/home";
import { useStaff } from "../shell";
import { ErrorNote, OfflineBanner, Toast, useToast } from "../../ui";
import { NotForRole } from "./inbox";

type Pages = Schemas["V1StorefrontPages"];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function ColourField({ label, token, value, onChange, disabled }: { label: string; token: "primary" | "secondary" | "accent"; value: string; onChange: (hex: string) => void; disabled: boolean }) {
  const r = readout(token, value);
  return (
    <div className="space-y-1">
      <label className="flex flex-wrap items-center gap-3 font-semibold">
        <input type="color" value={isHex(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value.toLowerCase())} disabled={disabled} className="h-12 w-14 cursor-pointer rounded-[10px] border-[1.5px] border-line p-1" aria-label={`${label}: pick a colour`} />
        <span className="min-w-[8ch]">{label}</span>
        <input value={value} onChange={(e) => onChange(e.target.value.trim().toLowerCase())} disabled={disabled} className="w-[10ch] font-mono" aria-label={`${label}: colour code`} maxLength={7} />
      </label>
      <p className={`text-[14px] ${r.ok ? "text-muted" : "font-semibold text-danger"}`}>{r.why}: {ratioWords(r.ratio)} {r.ok ? "· easy to read" : "· too hard to read; saving is refused"}</p>
    </div>
  );
}

function SectionCard({ s, i, count, editable, onChange, onMove, drag }: {
  s: Section; i: number; count: number; editable: boolean; onChange: (s: Section) => void; onMove: (to: number) => void;
  drag: { onStart: (i: number) => void; onOver: (i: number) => void; onDrop: () => void; over: boolean };
}) {
  const text = (label: string, value: string, max: number, set: (v: string) => void, area = false) => (
    <label className="block text-[15px] font-semibold">
      {label}
      {area ? <textarea rows={2} maxLength={max} value={value} onChange={(e) => set(e.target.value)} disabled={!editable} />
        : <input maxLength={max} value={value} onChange={(e) => set(e.target.value)} disabled={!editable} />}
    </label>
  );
  return (
    <li className="card space-y-3 p-4" style={drag.over ? { borderColor: "var(--primary)", borderStyle: "dashed" } : undefined}
      draggable={editable} onDragStart={() => drag.onStart(i)} onDragOver={(e) => { e.preventDefault(); drag.onOver(i); }} onDrop={(e) => { e.preventDefault(); drag.onDrop(); }}>
      <div className="flex flex-wrap items-center gap-2">
        {editable && <span aria-hidden="true" className="cursor-grab select-none px-1 text-[22px] text-muted" title="Drag to move">⠿</span>}
        <p className="text-[19px] font-semibold">{SECTION_NAME[s.kind]}</p>
        <span className="ml-auto flex flex-wrap gap-2">
          <button type="button" className="btn btn-plain" disabled={!editable || i === 0} onClick={() => onMove(i - 1)} aria-label={`Move ${SECTION_NAME[s.kind]} up`}>Move up</button>
          <button type="button" className="btn btn-plain" disabled={!editable || i === count - 1} onClick={() => onMove(i + 1)} aria-label={`Move ${SECTION_NAME[s.kind]} down`}>Move down</button>
        </span>
      </div>
      {s.kind === "outlets" ? <p className="text-[14px] text-muted">Always shown: it is how customers reach the menu.</p> : (
        <label className="choice">
          <input type="checkbox" checked={s.visible} onChange={(e) => onChange({ ...s, visible: e.target.checked } as Section)} disabled={!editable} className="size-5" />
          Show this section
        </label>
      )}
      {s.kind === "hero" && <>{text("Small line above the name", s.badge, 60, (v) => onChange({ ...s, badge: v }))}{text("Welcome line", s.tagline, 160, (v) => onChange({ ...s, tagline: v }), true)}</>}
      {s.kind === "outlets" && text("Heading", s.title, 60, (v) => onChange({ ...s, title: v }))}
      {s.kind === "cards" && s.cards.map((c, k) => (
        <fieldset key={k} className="space-y-2 rounded-[14px] border-[1.5px] border-bg-deep p-3">
          <legend className="px-1 text-[14px] font-bold text-muted">{k === 0 ? "First card" : "Second card"}</legend>
          {text("Title", c.title, 60, (v) => onChange({ ...s, cards: s.cards.map((x, j) => (j === k ? { ...x, title: v } : x)) }))}
          {text("Words", c.body, 240, (v) => onChange({ ...s, cards: s.cards.map((x, j) => (j === k ? { ...x, body: v } : x)) }), true)}
        </fieldset>
      ))}
      {s.kind === "cards" && <p className="text-[14px] text-muted">The Munim Cares card beside them is fixed.</p>}
    </li>
  );
}

/** The storefront at a real phone's or desktop's width, scaled down to fit the column (never a frame: the page's own
 *  components, wearing the draft theme). */
function ScaledPreview({ width, style, children }: { width: number; style: React.CSSProperties; children: React.ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ scale: 1, height: 600 });
  useEffect(() => {
    const o = outer.current, i = inner.current;
    if (!o || !i) return;
    const measure = () => {
      const scale = Math.min(1, o.clientWidth / width);
      setBox({ scale, height: i.offsetHeight * scale });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(o);
    ro.observe(i);
    return () => ro.disconnect();
  }, [width]);
  return (
    <div className="max-h-[78vh] overflow-y-auto overflow-x-hidden rounded-[22px] border-[1.5px] border-line bg-bg">
      <div ref={outer} className="relative mx-auto" style={{ height: box.height, maxWidth: width }} aria-label="Preview of the storefront's home page">
        <div ref={inner} className="absolute left-0 top-0 bg-bg" style={{ ...style, width, transform: `scale(${box.scale})`, transformOrigin: "top left" }}>{children}</div>
      </div>
    </div>
  );
}

export function StorefrontBuilderPage() {
  const { session, client, outlets, outlet, handleAuth } = useStaff();
  const me = session.me;
  const allowed = can(session, "storefront");
  // Saving is the whole business's (scope tenant): the owner, a judge, or a manager of every outlet. Only an owner publishes.
  const mayEdit = me.outlet_ids === "*" && ["owner", "manager", "judge"].includes(me.role);
  const mayPublish = me.outlet_ids === "*" && ["owner", "judge"].includes(me.role);
  const online = useOnline();
  const [pages, setPages] = useState<Pages | null>(null);
  const [tenant, setTenant] = useState<Schemas["V1Tenant"] | null>(null);
  const [loadError, setLoadError] = useState<MunimError | null>(null);
  const [draft, setDraft] = useState<PageDoc>(BUILT_IN);
  const [loaded, setLoaded] = useState<{ doc: PageDoc; version: number | null }>({ doc: BUILT_IN, version: null });
  const [width, setWidth] = useState<"phone" | "desktop">("desktop");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [toast, say] = useToast();
  const dragFrom = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const saveAttempt = useRef<{ key: string; body: SavePageCommand } | null>(null);

  const load = useCallback(async (into: "editor" | "list") => {
    const r = await client.listStorefrontPages();
    if (!r.ok) {
      if (!handleAuth(r.error)) setLoadError(r.error);
      return;
    }
    setPages(r.data);
    setLoadError(null);
    if (into === "list") return;
    const newest = r.data.versions[0];
    if (!newest) {
      setLoaded({ doc: BUILT_IN, version: null });
      setDraft(BUILT_IN);
      return;
    }
    const v = await client.getStorefrontPage(newest.page_id);
    if (v.ok) {
      setLoaded({ doc: v.data.doc, version: v.data.version });
      setDraft(v.data.doc);
    } else if (!handleAuth(v.error)) setLoadError(v.error);
  }, [client, handleAuth]);

  useEffect(() => {
    if (!allowed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the response
    void load("editor");
    void client.getTenant().then((r) => r.ok && setTenant(r.data));
  }, [allowed, load, client]);

  if (!allowed) return <NotForRole />;
  if (!outlet) return <main className="wrap staff-main"><div className="state-box" role="status">Loading</div></main>;
  const tz = outlet.tz;
  const dirty = !same(draft, loaded.doc);
  const ok = themeOk(draft.theme);
  const setTheme = (t: Partial<Theme>) => setDraft((d) => ({ ...d, theme: { ...d.theme, ...t } }));
  const setSection = (i: number, s: Section) => setDraft((d) => ({ ...d, sections: d.sections.map((x, j) => (j === i ? s : x)) }));
  const move = (from: number, to: number) => setDraft((d) => ({ ...d, sections: moveSection(d.sections, from, to) }));
  const textsOk = draft.sections.every((s) => s.kind === "ribbon" || (s.kind === "hero" ? s.badge.trim() && s.tagline.trim() : s.kind === "outlets" ? s.title.trim() : s.cards.every((c) => c.title.trim() && c.body.trim())));
  const preset = PRESETS.find((p) => p.colours.primary === draft.theme.primary && p.colours.secondary === draft.theme.secondary && p.colours.accent === draft.theme.accent);

  const save = async () => {
    // One envelope per document confirmed: tapping again after a dropped connection resends it, and core replays it.
    const key = JSON.stringify([draft, loaded.version]);
    if (saveAttempt.current?.key !== key) saveAttempt.current = { key, body: envelope("storefront.page.save.v1", { page_id: uuidv7(), based_on_version: loaded.version, doc: draft }) };
    setBusy("save");
    setError(null);
    setStale(false);
    const r = await client.saveStorefrontPage(saveAttempt.current.body);
    setBusy(null);
    if (r.ok) {
      saveAttempt.current = null;
      say("Saved as a new version. The live storefront has not changed.");
      return void load("editor");
    }
    if (handleAuth(r.error)) return;
    if (r.error.reasonCode === "page_version_stale") setStale(true);
    setError(staffWriteErrorText(r.error, "storefront"));
  };
  const publish = async (pageId: string, version: number) => {
    setBusy(`publish:${pageId}`);
    setError(null);
    const r = await client.publishStorefrontPage(pageId, envelope("storefront.page.publish.v1", { publish_id: uuidv7(), page_id: pageId }));
    setBusy(null);
    if (r.ok) {
      say(`Version ${version} is live on the storefront.`);
      return void load("list");
    }
    if (handleAuth(r.error)) return;
    setError(staffWriteErrorText(r.error, "storefront"));
  };
  const openVersion = async (pageId: string) => {
    const v = await client.getStorefrontPage(pageId);
    if (v.ok) {
      setLoaded({ doc: v.data.doc, version: pages?.versions[0]?.version ?? v.data.version });
      setDraft(v.data.doc);
    } else if (!handleAuth(v.error)) setError(staffErrorText(v.error, "storefront"));
  };
  const previewOutlets: Schemas["StorefrontOutletsResponse"] = {
    outlets: outlets.map((o) => ({ outlet_id: o.id, name: o.name, kind: o.kind, tz: o.tz, address: o.address, phone: null, tax_ids: [] })), pay_at_counter_methods: null,
  };
  const live = pages?.live ?? null;
  // R67 W-3: on the demo business core refuses publishing (the R64 X-2 deny-list), so the button is not offered there.
  const publishOff = tenant?.is_demo !== false;

  return (
    <>
      <OfflineBanner top="staff" show={!online} text="You're offline. Nothing can be saved until you're back." />
      <main className="staff-main-wide space-y-5 pb-10">
        <div className="wrap !px-0">
          <h1 className="section-title">Storefront</h1>
          <p className="mt-3 max-w-[75ch] text-muted">Shape how your ordering site looks: its colours, its layout and its home page. Saving keeps a numbered version and changes nothing customers see; publishing puts a version live.</p>
        </div>
        {loadError && <div className="space-y-2"><ErrorNote>{staffErrorText(loadError, "storefront")}</ErrorNote><button type="button" className="btn btn-plain" onClick={() => void load("editor")}>Try again</button></div>}
        <p className="card p-4" role="status">
          <span className="font-semibold">Live now:</span>{" "}
          {pages === null ? "…" : live ? `version ${live.version}, published ${formatWhen(live.published_at, tz, SITE.locale)} by ${live.published_by_name || "a team member"}.` : "Cobnut's built-in page (nothing has been published)."}
          {" "}{loaded.version ? `Editing from version ${loaded.version}.` : "Editing from the built-in page."}{dirty ? " Unsaved changes." : ""}
        </p>
        {!mayEdit && <p className="note-warn">Only the owner, or a manager of every outlet, can change the storefront. You can look around and preview.</p>}

        <div className="grid items-start gap-5 xl:grid-cols-[minmax(360px,460px)_minmax(0,1fr)] [&>*]:min-w-0">
          <div className="space-y-5">
            <section aria-labelledby="theme-title" className="card space-y-4 p-5">
              <h2 id="theme-title" className="text-[24px]">Colours</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {PRESETS.map((p) => (
                  <label key={p.id} className="choice">
                    <input type="radio" name="preset" checked={preset?.id === p.id} onChange={() => setTheme(p.colours)} disabled={!mayEdit} className="size-5" />
                    <span className="flex gap-1" aria-hidden="true">{[p.colours.primary, p.colours.secondary, p.colours.accent].map((c) => <span key={c} className="size-5 rounded-full border border-line" style={{ background: c }} />)}</span>
                    {p.name}
                  </label>
                ))}
              </div>
              <ColourField label="Main" token="primary" value={draft.theme.primary} onChange={(v) => setTheme({ primary: v })} disabled={!mayEdit} />
              <ColourField label="Second" token="secondary" value={draft.theme.secondary} onChange={(v) => setTheme({ secondary: v })} disabled={!mayEdit} />
              <ColourField label="Soft" token="accent" value={draft.theme.accent} onChange={(v) => setTheme({ accent: v })} disabled={!mayEdit} />
              <fieldset className="space-y-2">
                <legend className="font-semibold">Corners</legend>
                <div className="flex flex-wrap gap-2">
                  {(["round", "soft"] as const).map((r) => (
                    <label key={r} className="choice"><input type="radio" name="radius" checked={draft.theme.radius === r} onChange={() => setTheme({ radius: r })} disabled={!mayEdit} className="size-5" />{r === "round" ? "Round" : "Soft"}</label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="space-y-2">
                <legend className="font-semibold">Layout</legend>
                {LAYOUTS.map((l) => (
                  <label key={l.id} className="choice items-start p-3">
                    <input type="radio" name="layout" checked={draft.theme.layout === l.id} onChange={() => setTheme({ layout: l.id })} disabled={!mayEdit} className="mt-1 size-5 flex-none" />
                    <span><span className="block font-semibold">{l.name}</span><span className="block text-[15px] text-muted">{l.how}</span></span>
                  </label>
                ))}
              </fieldset>
              <p className="text-[14px] text-muted">Fonts, the warning and status colours, &quot;Pay at the counter&quot; and the tax lines stay as they are.</p>
            </section>

            <section aria-labelledby="sections-title" className="space-y-3">
              <h2 id="sections-title" className="text-[24px]">Home page sections</h2>
              <p className="text-[15px] text-muted">Drag a section to move it, or use Move up and Move down.</p>
              <ol className="space-y-3">
                {draft.sections.map((s, i) => (
                  <SectionCard key={s.kind} s={s} i={i} count={draft.sections.length} editable={mayEdit} onChange={(x) => setSection(i, x)} onMove={(to) => move(i, to)}
                    drag={{ onStart: (n) => { dragFrom.current = n; }, onOver: (n) => setOver(n), onDrop: () => { if (dragFrom.current !== null && over !== null) move(dragFrom.current, over); dragFrom.current = null; setOver(null); }, over: over === i }} />
                ))}
              </ol>
            </section>

            {mayEdit && (
              <section className="card space-y-3 p-5">
                {!ok && <p className="font-semibold text-danger">Some colours are too hard to read. Fix them to save.</p>}
                {!textsOk && <p className="font-semibold text-danger">Every shown text needs some words.</p>}
                {error && <ErrorNote>{error}</ErrorNote>}
                {stale && <button type="button" className="btn btn-plain" onClick={() => void load("editor")}>Load the newest version</button>}
                <div className="flex flex-wrap gap-3">
                  <button type="button" className="btn btn-primary" disabled={!dirty || !ok || !textsOk || busy !== null} onClick={() => void save()}>{busy === "save" ? "Saving…" : `Save as a new version as ${me.name}`}</button>
                  <button type="button" className="btn btn-plain" disabled={!dirty || busy !== null} onClick={() => setDraft(loaded.doc)}>Undo my changes</button>
                </div>
              </section>
            )}

            <section aria-labelledby="versions-title" className="card space-y-3 p-5">
              <h2 id="versions-title" className="text-[24px]">Saved versions</h2>
              {pages === null ? <div className="skeleton h-16" aria-hidden="true" /> : pages.versions.length === 0 ? <p className="text-muted">Nothing saved yet. The storefront shows Cobnut&apos;s built-in page.</p> : (
                <ul className="space-y-2">
                  {pages.versions.map((v) => {
                    const isLive = live?.page_id === v.page_id;
                    return (
                      <li key={v.page_id} className="flex flex-wrap items-center gap-2 border-b-[1.5px] border-bg-deep py-2">
                        <span className="font-semibold">Version {v.version}</span>
                        <span className="text-[15px] text-muted">saved by {v.created_by_name || "a team member"} · {formatWhen(v.created_at, tz, SITE.locale)}</span>
                        {isLive && <span className="badge badge-ready">Live</span>}
                        <span className="ml-auto flex flex-wrap gap-2">
                          <button type="button" className="btn btn-plain" disabled={busy !== null} onClick={() => void openVersion(v.page_id)}>Open in the editor</button>
                          {mayPublish && !publishOff && !isLive && (
                            <button type="button" className="btn btn-secondary" disabled={busy !== null || dirty} onClick={() => void publish(v.page_id, v.version)}>
                              {busy === `publish:${v.page_id}` ? "Publishing…" : `${live && live.version > v.version ? "Restore" : "Publish"} version ${v.version} as ${me.name}`}
                            </button>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {mayPublish && !publishOff && dirty && pages && pages.versions.length > 0 && <p className="text-[14px] text-muted">Save or undo your changes before publishing.</p>}
              {mayPublish && publishOff && <p className="note-warn">Publishing is switched off on the demo business, so the live storefront stays the same for every visitor. Saving and the versions work as usual.</p>}
            </section>
          </div>

          <section aria-labelledby="preview-title" className="space-y-3 xl:sticky xl:top-[calc(var(--staff-bar-h)+12px)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="preview-title" className="text-[24px]">Preview</h2>
              <div role="radiogroup" aria-label="Preview width" className="flex gap-2">
                {(["phone", "desktop"] as const).map((w) => (
                  <button key={w} type="button" role="radio" aria-checked={width === w} className="chip" aria-current={width === w ? "true" : undefined} onClick={() => setWidth(w)}>{w === "phone" ? "Phone" : "Desktop"}</button>
                ))}
              </div>
            </div>
            <ScaledPreview width={width === "phone" ? 390 : 1280} style={themeVars(draft.theme)}>
              <HomeBody doc={draft} outlets={previewOutlets} states={{}} counts={{}} error={null} seconds={0} onRetry={() => undefined} preview />
            </ScaledPreview>
            <p className="text-[14px] text-muted">The preview shows your outlets without their live opening state. Nothing in it can be tapped.</p>
          </section>
        </div>
        <Toast message={toast} />
      </main>
    </>
  );
}
