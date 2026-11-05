import dotenv from "dotenv";
import { promises as fs } from "fs";
import { Story } from "./JiraStoryMapper";
import { JiraSprintService } from "./JiraSprintService";
import { JiraStoryService } from "./JiraStoryService";
import { StoryMapper } from "./JiraStoryMapper";
import { PlannerService } from "../../ai/services/planner.service";
import { Requirement } from "../../ai/schemas/requirement.schema";
import { AIProvider } from "../../ai/providers/AIProvider";
import { StructuredResponseService } from "../../ai/services/structured-response.service";
dotenv.config();



function storyToRequirement(story: Story): Requirement {
  const title = (story.title || "").trim();
  const description = (story.description || "").trim();

  const parsedCriteria = StoryMapper.extractAcceptanceCriteria(
    story.acceptanceCriteria || "",
    story.description,
  );

  return {
    storyId: story.id,
    title: title || story.id,
    description: description || undefined,
    acceptanceCriteria: parsedCriteria,
  };
}

async function test() {
  const jira = new JiraSprintService();
  const storyService = new JiraStoryService();
  const provider = new AIProvider();
  const parser = new StructuredResponseService();
  const planner = new PlannerService(provider, parser);
  const sprints=await jira.getSprints(2);
  // console.log("Sprints "+(JSON.stringify(sprints, null, 2)))
  const issues = await jira.getSprintStories(70);
  let testPlan;
  // console.log(issues);
  const aggregatedTestCases = [];
  const storyTestPlans = [];
  for (const story of issues) {
    console.log(`Story: ${story.summary}`);
    const issue = await storyService.getIssue(story.key);
    const mappedStory = StoryMapper.map(issue);
    const requirement = storyToRequirement(mappedStory);
    // console.log(JSON.stringify(requirement, null, 2));
    testPlan = await planner.createPlan(requirement);
    storyTestPlans.push(testPlan);
    aggregatedTestCases.push(...testPlan.testCases);
    // console.log(`[PLANNER] Generated ${testPlan.testCases.length} test cases`);
    // console.log(
    //   `[Feedback] to Proceed further we need some clarifications on : `,
    // );
    // console.log(JSON.stringify(testPlan.clarifications, null, 2));
    
  }

  console.log(JSON.stringify(storyTestPlans, null, 2));


  await fs.writeFile(
        "./output/sprint-plans.json",
        JSON.stringify(storyTestPlans, null, 2),
      );

  // console.log(JSON.stringify(aggregatedTestCases, null, 2));
}

test();
