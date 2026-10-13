// Whether AI surfaces show (S-aioff, rule 11). GAP (reported, T-060): no member-readable route exposes the typed
// `intel.enabled` kill switch — only the operator route /platform/v1/feature-flags. Until contracts add one, AI starts
// enabled and the console context's `setAiOff()` removes Ask for the session when an AI call answers `unavailable`.
export async function aiEnabled(): Promise<boolean> {
  return true;
}
