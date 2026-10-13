import { notFound } from "next/navigation";
import { Gallery } from "./gallery.tsx";

export const dynamic = "force-dynamic";

/** Dev-only gallery of the standard states (for screenshots and wave-B reference). A 404 in production. */
export default async function StatesPage({ searchParams }: { searchParams: Promise<{ snap?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { snap } = await searchParams;
  return <Gallery snapshotId={snap && /^[0-9a-f-]{36}$/.test(snap) ? snap : null} />;
}
