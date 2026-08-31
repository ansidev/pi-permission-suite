/**
 * Pi Permission Suite — Public Types
 */

/** Approval mode */
export type ApprovalMode = "act" | "auto" | "ask" | "plan";

/** Approval decision */
export interface ApprovalDecision {
  approved: boolean;
  source: "subagent" | "human";
  reason?: string;
}

/** Persistent state */
export interface ApprovalState {
  mode: ApprovalMode;
  approved: number;
  denied: number;
  escalated: number;
}
