// Kitchen events (03-architecture §1.6). Written to core.outbox in the transaction that changes the ticket;
// the stream's `kds:<outlet>` topic selects `munim.kitchen.%` rows by data.outlet_id (stream/feed.ts).
// Data: ids and categorical fields only — no counts, durations or amounts (shared/cloudevents.ts).
import { z } from "zod";
import { cloudEvent } from "../shared/cloudevents.ts";
import { Uuid7 } from "../shared/primitives.ts";

export const KitchenTicketStatus = z.enum(["queued", "preparing", "ready", "done"]);
export const Station = z.string().regex(/^[a-z][a-z0-9_]*$/).max(40);

const ticketData = {
  ticket_id: Uuid7,
  order_id: Uuid7,
  outlet_id: Uuid7,
  station: Station,
  status: KitchenTicketStatus,
};

export const KitchenTicketCreatedV1 = cloudEvent("munim.kitchen.ticket.created.v1", "kitchen", z.strictObject(ticketData));

export const KitchenTicketAdvancedV1 = cloudEvent(
  "munim.kitchen.ticket.advanced.v1",
  "kitchen",
  z.strictObject({ ...ticketData, from_status: KitchenTicketStatus }),
);
