export const SAMPLES: Record<string, unknown> = {
  "ai_policy.ceiling.set.v1": { role: "manager", mode_ceiling: "plan" },
  "ai_policy.cap.set.v1": { monthly_cap_minor: 500000 },
  "v1.ai.policy": {
    ceilings: [
      { role: "owner", mode_ceiling: "auto", source: "default" },
      { role: "manager", mode_ceiling: "step", source: "set" },
      { role: "staff", mode_ceiling: "step", source: "default" },
      { role: "advisor", mode_ceiling: "step", source: "default" },
      { role: "judge", mode_ceiling: "plan", source: "default" },
    ],
    cap: { monthly_cap_minor: 500000, currency: "INR" },
  },
};
