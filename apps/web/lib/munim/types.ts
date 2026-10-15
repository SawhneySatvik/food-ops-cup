// The one place the rest of the code gets API types from: the contract types in @munim/sdk (GET /v1/me included).
import type { paths as SdkPaths, Schemas as SdkSchemas } from "@munim/sdk";

export type V1Me = SdkSchemas["V1Me"];
export type Schemas = SdkSchemas;
export type paths = SdkPaths;
export type ApiPath = keyof paths;
