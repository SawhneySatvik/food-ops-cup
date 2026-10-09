// Draft execution handlers (T-008). A module that owns a draftable command registers its handler from its
// own index.ts (`registerDraftHandler({type, run})`); approvals runs it through executeCommand under the
// approver's identity and the decision id. A handler writes only its own command's tables (m-1 binds
// command type → tables in the guard). A type with no handler, or not in the contracts draftable registry,
// is refused (fail closed, gotcha 28).
import type { CommandHandler } from "../../commit/index.ts";

// One Map per process even if this file is loaded twice (vitest imports by path, loadRouters by file URL).
const KEY = Symbol.for("munim.approvals.draftHandlers");
const g = globalThis as unknown as Record<symbol, Map<string, CommandHandler> | undefined>;
const HANDLERS: Map<string, CommandHandler> = (g[KEY] ??= new Map());

/** Registers the execution handler for one draftable command type; returns the unregister function. */
export function registerDraftHandler(h: CommandHandler): () => void {
  if (HANDLERS.has(h.type)) throw new Error(`registerDraftHandler: '${h.type}' already has a handler`);
  HANDLERS.set(h.type, h);
  return () => {
    if (HANDLERS.get(h.type) === h) HANDLERS.delete(h.type);
  };
}

export const draftHandler = (type: string): CommandHandler | undefined => HANDLERS.get(type);
