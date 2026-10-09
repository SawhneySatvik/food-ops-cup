// Kitchen commands (02-schema §2.4 kitchen_ticket — operational, not a book table).
import { z } from "zod";
import { Uuid7 } from "../shared/primitives.ts";
import type { Route } from "../shared/routes.ts";

/** The DB set (core.kitchen_ticket.status, 0004). Order-level acceptance stays on the order (W1 fix #41). */
export const KitchenTicketStatus = z.enum(["queued", "preparing", "ready", "done"]);

export const KitchenTicketAdvanceV1 = z.strictObject({
  ticket_id: Uuid7,
  /** Optimistic guard: the update applies only `WHERE status = from_status`; illegal moves → 409. */
  from_status: KitchenTicketStatus,
  to_status: KitchenTicketStatus,
});

export const SCHEMAS = { "kitchen.ticket.advance.v1": KitchenTicketAdvanceV1 };
export const ROUTES: readonly Route[] = [];
