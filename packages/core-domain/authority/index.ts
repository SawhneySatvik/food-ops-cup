// Command authority (R27, 02-schema §2.1 `core.command_authority`, 03-architecture §1.3 branch 1).
// A member's own command is its approval when the authority row for the command type lists the member's
// role, the target lies inside the member's outlet scope, and any amount is within the row's cap. The
// database trigger is the authoritative check; this is the same rule for core-api to refuse early and for
// the approvals module to re-check a draft's final payload. Fails closed on every missing input.

export type AuthorityRow = {
  command_type: string;
  allowed_roles: string[];
  /** `outlet` | `tenant` | `own_order` | `own` (0003 check). Typed as text: a scope this code does not
   *  know (a later migration) is denied, never allowed. */
  scope: string;
  max_amount_minor: number | null;
};

export type AuthorityRequest = {
  command_type: string;
  role: string;
  /** `app.outlet_ids` form: outlet ids, or ["*"] for every outlet. */
  outlet_scope: string[];
  /** The outlet the command writes to (scope `outlet`). */
  target_outlet_id?: string | null;
  /** The command's money amount, when its authority row has a cap. */
  amount_minor?: number | null;
  /** The acting principal (scope `own_order`: the customer). */
  actor_id?: string;
  /** The customer the order belongs to (scope `own_order`). */
  order_customer_id?: string | null;
  /** The customer record being changed (scope `own`: the customer's own profile). */
  target_customer_id?: string | null;
};

export type AuthorityDenial = "unknown_command" | "unknown_scope" | "role" | "outlet_scope" | "own_order" | "own" | "amount";
export type AuthorityVerdict = { allow: true } | { allow: false; reason_code: "authority_denied"; why: AuthorityDenial };

const deny = (why: AuthorityDenial): AuthorityVerdict => ({ allow: false, reason_code: "authority_denied", why });

export function evaluateAuthority(req: AuthorityRequest, rows: readonly AuthorityRow[]): AuthorityVerdict {
  const row = rows.find((r) => r.command_type === req.command_type);
  if (!row) return deny("unknown_command");
  if (!row.allowed_roles.includes(req.role)) return deny("role");
  const all = req.outlet_scope.includes("*");
  switch (row.scope) {
    case "outlet": {
      const t = req.target_outlet_id;
      if (!t || !(all || req.outlet_scope.includes(t))) return deny("outlet_scope");
      break;
    }
    case "tenant": // a tenant-wide write needs an all-outlet context, as the 0003 guard requires
      if (!all) return deny("outlet_scope");
      break;
    case "own_order":
      if (!req.actor_id || req.order_customer_id !== req.actor_id) return deny("own_order");
      break;
    case "own":
      if (!req.actor_id || req.target_customer_id !== req.actor_id) return deny("own");
      break;
    default:
      return deny("unknown_scope");
  }
  if (row.max_amount_minor !== null && (req.amount_minor == null || req.amount_minor > row.max_amount_minor)) return deny("amount");
  return { allow: true };
}

// Membership `outlet_ids = {}` means every outlet only for these roles (02-schema §2.1 `membership`).
const ALL_OUTLETS_WHEN_EMPTY = new Set(["owner", "advisor", "judge"]);

/** A membership's outlet scope in `app.outlet_ids` form. */
export function outletScopeOf(m: { role: string; outlet_ids: string[] }): string[] {
  if (m.outlet_ids.length === 0) return ALL_OUTLETS_WHEN_EMPTY.has(m.role) ? ["*"] : [];
  return [...m.outlet_ids];
}
