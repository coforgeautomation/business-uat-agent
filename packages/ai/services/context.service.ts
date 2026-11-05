import fs from "fs/promises";
import path from "path";

export class ContextService {
  async appendKnowledge(rules: string[]) {
    const file = path.join(
      process.cwd(),
      "output",
      "context",
      "business-knowledge.json",
    );

    await fs.mkdir(path.dirname(file), {
      recursive: true,
    });

    let context: {
      rules: {
        clarification: string;
        rule: string;
        addedOn: string;
      }[];
    } = {
      rules: [],
    };

    try {
      const content = await fs.readFile(file, "utf8");

      const parsed = JSON.parse(content);

      context = {
        rules: parsed?.rules ?? [],
      };
    } catch {
      context = {
        rules: [],
      };
    }

    context.rules.push(
      ...rules.map((rule) => ({
        clarification: "",
        rule,
        addedOn: new Date().toISOString(),
      })),
    );

    await fs.writeFile(file, JSON.stringify(context, null, 2));
  }
}
