import { z } from "zod";

export class StructuredResponseService {
  parse<T>(
    rawResponse: string,
    schema: z.ZodType<T>,
    normalize: (value: unknown) => unknown = value => value,
  ): T {
    const cleaned = this.removeMarkdownCodeFence(rawResponse);

    let parsed: unknown;

    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(
        `AI returned invalid JSON.

Raw response:
${rawResponse}`,
      );
    }

    const result = schema.safeParse(normalize(parsed));

    if (!result.success) {
      throw new Error(
        `AI response failed schema validation.

Validation:
${JSON.stringify(result.error.issues, null, 2)}

Response:
${cleaned}`,
      );
    }

    return result.data;
  }

  private removeMarkdownCodeFence(value: string): string {
    const trimmed = value.trim();

    if (trimmed.startsWith("```")) {
      return trimmed
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
    }

    return trimmed;
  }
}
