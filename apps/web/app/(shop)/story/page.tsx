import type { Metadata } from "next";
import Link from "next/link";
import { CategoryMotif, Hazelnut, HeroArt } from "@/components/art";
import { SiteHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Our story" };

const PROMISES = [
  { motif: "pastries", title: "Laminated by hand", body: "Our croissant dough rests overnight and is folded three times before dawn. Nothing is par-baked." },
  { motif: "cookies", title: "Eggless, clearly marked", body: "Every item carries its own mark: the green dot means eggless, the dark oval means it contains egg, the leaf means vegan." },
  { motif: "gift_boxes", title: "Boxed to give", body: "Build a box of truffle cookies, add a ribbon and a handwritten card, and pick it up on your way." },
];

export default function StoryPage() {
  return (
    <>
      <SiteHeader />
      <main>
        <section className="wrap grid items-center gap-8 py-12 sm:grid-cols-[1.1fr_1fr]">
          <div>
            <p className="badge badge-accent">A sample shop · all of this is synthetic</p>
            <h1 className="mt-4 text-[clamp(40px,8vw,72px)]">
              A small bakehouse that <span className="italic text-secondary">loves hazelnuts</span>
            </h1>
            <p className="mt-5 max-w-[46ch] text-[18px] text-muted">
              Cobnut Bakehouse is an invented bakery with two invented counters in Lucknow. It exists to show how a
              shop can take pickup orders through Munim&apos;s storefront API: the menu, prices, taxes, deals and
              order status all come from the API, and nothing is ever charged.
            </p>
            <p className="mt-4 max-w-[46ch] text-[18px] text-muted">
              A cobnut is an old English name for a cultivated hazelnut. We named the shop after it because almost
              everything here has a hazelnut in it somewhere.
            </p>
            <Link href="/#outlets" className="btn btn-primary mt-8">Order for pickup</Link>
          </div>
          <HeroArt className="mx-auto w-full max-w-[400px]" />
        </section>
        <div className="scallop" aria-hidden="true" />
        <section className="bg-bg-deep py-12" aria-labelledby="promises">
          <div className="wrap">
            <h2 id="promises" className="section-title">What we promise</h2>
            <ul className="mt-6 grid gap-4 md:grid-cols-3">
              {PROMISES.map((p) => (
                <li key={p.title} className="card p-6">
                  <span aria-hidden="true" className="grid size-12 place-items-center rounded-full bg-accent"><CategoryMotif slug={p.motif} size={28} /></span>
                  <h3 className="mt-4 text-[24px]">{p.title}</h3>
                  <p className="mt-2 text-muted">{p.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>
        <div className="scallop scallop-up" aria-hidden="true" />
        <section className="wrap py-12">
          <div className="card flex flex-col items-start gap-4 p-8 sm:flex-row sm:items-center">
            <Hazelnut size={56} />
            <div className="flex-1">
              <h2 className="text-[28px]">Surplus never goes in the bin</h2>
              <p className="mt-2 text-muted">What&apos;s left at closing is listed on Munim Cares for simulated recipients.</p>
            </div>
            <Link href="/cares" className="btn btn-plain">See Munim Cares</Link>
          </div>
        </section>
      </main>
    </>
  );
}
