import { Router } from "express";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SprintPlanningService } from "../../../../packages/orchestration/SprintPlanningService";

export const generatePlanRouter = Router();

const sprintPlanFile = path.join(process.cwd(), "output", "sprint-plan.json");

function sprintDocPath(sprintId: number) {
  return path.join(process.cwd(), "output", "sprints", `${sprintId}.json`);
}

async function readSprintPlan(): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(sprintPlanFile, "utf8"));
  } catch {
    return null;
  }
}

// Synced Jira data (key, summary, requirement) for the sprint — see /sprint-stories.
// Using this avoids re-hitting Jira during generation, which is what made this slow.
async function readSprintDoc(sprintId: number): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(sprintDocPath(sprintId), "utf8"));
  } catch {
    return null;
  }
}

generatePlanRouter.post("/", async (req, res) => {
  try {
    const { sprintId, storyId } = req.body;
    const service = new SprintPlanningService();
    await fs.mkdir(path.join(process.cwd(), "output"), { recursive: true });
    const now = new Date().toISOString();
    const sprintDoc = await readSprintDoc(Number(sprintId));

    if (storyId) {
      const cachedStory = sprintDoc?.stories?.[storyId];

      const testPlan = cachedStory?.requirement
        ? await service.generatePlanForRequirement(
            cachedStory.requirement,
            cachedStory.updated,
          )
        : await service.regenerateStory(storyId);

      const existing = (await readSprintPlan()) ?? {
        sprintId,
        status: "in-review",
        stories: [],
      };

      const index = existing.stories.findIndex(
        (s: any) => s.storyId === storyId,
      );
      const nextVersion =
        index >= 0 ? (existing.stories[index].version || 1) + 1 : 1;
      const updatedStory = {
        ...testPlan,
        version: nextVersion,
        status: "draft",
        generatedOn: now,
      };

      if (index >= 0) {
        existing.stories[index] = updatedStory;
      } else {
        existing.stories.push(updatedStory);
      }
      existing.status = "in-review";

      await fs.writeFile(sprintPlanFile, JSON.stringify(existing, null, 2));

      return res.json({ success: true, plans: existing.stories });
    }

    const syncedStories = Object.values(sprintDoc?.stories ?? {}).filter(
      (s: any) => s.inSprint && s.requirement,
    ) as any[];

    const plans = syncedStories.length > 0
      ? await service.generatePlansFromRequirements(
          syncedStories.map((s) => ({
            requirement: s.requirement,
            jiraUpdatedAt: s.updated,
          })),
        )
      : await service.generateSprintPlan(Number(sprintId));

    const sprintPlan = {
      sprintId,
      status: "in-review",
      stories: plans.map((plan) => ({
        ...plan,
        version: 1,
        status: "draft",
        generatedOn: now,
      })),
    };

    await fs.writeFile(
      sprintPlanFile,
      JSON.stringify(sprintPlan, null, 2),
    );
    return res.json({
      success: true,
      plans: sprintPlan.stories,
    });
  } catch (error: any) {
    console.error("Generate Plan Error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});
