// feedback.service.ts

import { buildFeedbackPrompt } from "@ai/prompts/feedback.prompt";
import { AIProvider } from "@ai/providers/AIProvider";
import { TestPlan, TestPlanSchema } from "@domain/schemas/test-plan.schema";
import { StructuredResponseService } from "./structured-response.service";

export class FeedbackService {

  constructor(
    private readonly ai:
      AIProvider,

    private readonly parser:
      StructuredResponseService
  ) {}

  async updatePlan(
    currentPlan: TestPlan,
    feedback: string,
    previousContext?: string
  ): Promise<TestPlan> {

    const prompt =
      buildFeedbackPrompt(currentPlan,
        [feedback],
      );

    const response =
      await this.ai.chat(
        [{
        role: "system",
        content:"You are a senior web testing architect/Engineer. Return only valid JSON.",
      },
      {
        role: "user",
        content: prompt,
      },]
      );

    const re=this.parser.parse(
      response,
      TestPlanSchema
    );
    return re;

  }

}