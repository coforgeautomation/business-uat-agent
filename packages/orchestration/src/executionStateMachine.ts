import type { ExecutionStatus } from "../../domain/src/testPlan.js";

const transitions: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  queued: ["planning", "failed"],
  planning: ["exploring", "replaying", "blocked", "failed"],
  exploring: ["executing", "blocked", "failed"],
  executing: ["generating", "blocked", "failed"],
  generating: ["replaying", "blocked", "failed"],
  replaying: ["planning", "passed", "failed", "blocked"],
  passed: [], failed: [], blocked: [],
};

export function canTransition(current: ExecutionStatus, next: ExecutionStatus): boolean {
  return transitions[current].includes(next);
}

export function transition(current: ExecutionStatus, next: ExecutionStatus): ExecutionStatus {
  if (!canTransition(current, next)) throw new Error(`Invalid execution transition: ${current} -> ${next}`);
  return next;
}

export function isTerminal(status: ExecutionStatus): boolean {
  return transitions[status].length === 0;
}
