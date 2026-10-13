// The one place the rest of the code gets API types from: the contract types shipped inside @munim/sdk.
import type { paths, Schemas } from "@munim/sdk";

export type { Schemas };
/** Every path in the contract. */
export type ApiPath = keyof paths;
