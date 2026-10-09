// Draftable command types register when their contracts module is imported (gotcha 28): without this,
// approvals refuses every type. `loadRegistry` is not in @munim/contracts' `exports` map (its `./*` pattern
// resolves to src/<name>/index.ts), so it is imported by path until T-002 exports it (T-004 report).
import { loadRegistry } from "../../../../packages/contracts/src/registry.ts";

export async function loadContracts(): Promise<{ modules: number; routes: number }> {
  const reg = await loadRegistry();
  return { modules: reg.modules.length, routes: reg.routes.length };
}
