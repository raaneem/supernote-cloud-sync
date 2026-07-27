export type SyncCompletionOutcome = "succeeded" | "failed";

export const syncCompletionOutcome = (
  attentionCount: number,
): SyncCompletionOutcome => (attentionCount > 0 ? "failed" : "succeeded");
