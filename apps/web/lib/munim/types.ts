// The one place the rest of the code gets API types from: the contract types shipped inside @munim/sdk.
import type { paths as SdkPaths, Schemas as SdkSchemas } from "@munim/sdk";

/** GET /v1/me. It ships in SDK 0.2.0, but munim-sdk-0.2.0.tgz is not published yet (its URL answers 404), so the
 *  app stays on 0.1.0 and declares this one response here, exactly as 01 §5 documents it. Delete this shim (and the
 *  path below) once 0.2.0 installs. */
export interface V1Me {
  member_id: string;
  tenant_id: string;
  name: string;
  role: "owner" | "manager" | "staff" | "advisor" | "judge";
  /** "*" = every outlet of the business; otherwise the outlets this person works in (possibly none). */
  outlet_ids: "*" | string[];
}

export type Schemas = SdkSchemas & { V1Me: V1Me };

/** Every path in the contract (plus GET /v1/me, see V1Me). */
export type paths = SdkPaths & {
  "/v1/me": {
    parameters: { query?: never; header?: never; path?: never; cookie?: never };
    get: {
      parameters: { query?: never; header?: never; path?: never; cookie?: never };
      requestBody?: never;
      responses: { 200: { headers: { [name: string]: unknown }; content: { "application/json": V1Me } } };
    };
    put?: never; post?: never; delete?: never; options?: never; head?: never; patch?: never; trace?: never;
  };
};
export type ApiPath = keyof paths;
