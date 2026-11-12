import { z } from "zod";
import type { PlannedStep } from "../schemas/actionPlan.schema.js";
import browserExecutionPlannerPrompt from "../prompts/browserExecutionPlanner.prompt.js";

type ChatModel = {
  chat(messages: Array<{ role: "system" | "user"; content: string }>): Promise<string>;
};

const RecoveryDecisionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("retry"),
    target: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  }).strict(),
  z.object({
    status: z.literal("blocked"),
    reason: z.string().trim().min(1),
  }).strict(),
]);

export type McpRecoveryContext = {
  testCase: {
    id: string;
    title: string;
    objective: string;
    expectedOutcome: string;
  };
  step: PlannedStep;
  snapshot: string;
  failure: string;
  attempt: number;
};

export class McpExecutionPlanner {
  constructor(private readonly model: ChatModel) {}

  async suggestAlternateStep(context: McpRecoveryContext): Promise<{
    step: PlannedStep;
    reason: string;
  } | {
    blockedReason: string;
  }> {
    if (isIrreversibleTarget(context.step)) {
      return {
        blockedReason: "Recovery is disabled for steps that may complete a booking, payment, or purchase.",
      };
    }

    const response = await this.model.chat([
      { role: "system", content: browserExecutionPlannerPrompt },
      {
        role: "user",
        content: JSON.stringify({
          testCase: context.testCase,
          approvedStep: context.step,
          currentSnapshot: context.snapshot,
          failure: context.failure,
          recoveryAttempt: context.attempt,
        }),
      },
    ]);

    let raw: unknown;
    try {
      raw = JSON.parse(response);
    } catch (error) {
      throw new Error(
        `MCP execution planner returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const decision = RecoveryDecisionSchema.parse(raw);
    if (decision.status === "blocked") return { blockedReason: decision.reason };
    if (decision.target === context.step.target) {
      throw new Error("MCP execution planner did not provide an alternate target");
    }
    if (looksLikeSelector(decision.target)) {
      throw new Error("MCP execution planner returned a selector instead of an evidence-backed semantic target");
    }

    return {
      step: { ...context.step, target: decision.target },
      reason: decision.reason,
    };
  }
}

function looksLikeSelector(target: string): boolean {
  return /(?:^|[\s])(?:xpath=|css=|text=|role=|\/\/|\.\/)|[>+~]\s*[.#[]|#[\w-]+|\[[\w-]+(?:=|\])/i.test(target);
}

function isIrreversibleTarget(step: PlannedStep): boolean {
  return /\b(?:payment|pay now|purchase|book (?:now|a flight|a ticket)|confirm (?:booking|purchase)|complete (?:booking|payment))\b/i
    .test(`${step.sourceStep} ${step.target ?? ""}`);
}
