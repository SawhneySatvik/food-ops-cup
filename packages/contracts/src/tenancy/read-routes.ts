// Tenancy read response and route (T-092b; hand list row 20): an outlet's weekly hours and dated overrides.
import { z } from "zod";
import { IanaZone, IsoDate, LocalTime, Uuid7 } from "../shared/primitives.ts";
import type { Route } from "../shared/routes.ts";

const CalendarRow = z.strictObject({
  calendar_id: Uuid7, kind: z.enum(["weekly", "override"]), weekday: z.int().min(0).max(6).nullable(), on_date: IsoDate.nullable(),
  opens_at: LocalTime.nullable(), closes_at: LocalTime.nullable(), closed: z.boolean(),
});

export const READ_SCHEMAS = {
  "v1.outlet.calendar": z.strictObject({ outlet_id: Uuid7, tz: IanaZone, rows: z.array(CalendarRow) }),
};

export const READ_ROUTES: readonly Route[] = [
  { surface: "public", method: "get", path: "/v1/outlets/{id}/calendar", operationId: "getOutletCalendar", summary: "An outlet's weekly hours and dated overrides (holidays), in the outlet's own zone; an outlet outside the caller's scope is 404",
    auth: "member", response: "v1.outlet.calendar", status: 200, pathParams: [{ name: "id", uuid: true }] },
];
