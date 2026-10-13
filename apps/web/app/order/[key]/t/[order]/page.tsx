import { notFound } from "next/navigation";
import { TrackerView } from "../../../../../lib/order/tracker-view.tsx";

// An id that is not a uuid is the same S-404 as an order that is not this browser's (gotcha 16).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function StorefrontTracker({ params }: { params: Promise<{ order: string }> }) {
  const { order } = await params;
  if (!UUID.test(order)) notFound();
  return <TrackerView orderId={order} />;
}
