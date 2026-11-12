import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";

import { generatePlanRouter } from "./routes/generate-plan.route";
import { reviewRouter } from "./routes/review.route";
import { approveRouter } from "./routes/approve.route";
import { plansRouter }from "./routes/plans.route";
import { approveSprintRouter } from "./routes/approve-sprint.route";
import { jiraStatusRouter } from "./routes/jira-status.route";
import { sprintStoriesRouter } from "./routes/sprint-stories.route";
import { sprintContextRouter } from "./routes/sprint-context.route";
import { jiraCreateRouter } from "./routes/jira-create.route";
import { createdJirasRouter } from "./routes/created-jiras.route";
import { sprintsRouter } from "./routes/sprints.route";
import { reportsRouter } from "./routes/reports.route";
import { testCaseReviewRouter } from "./routes/testcase-review.route";
import { createAutomationRouter } from "./routes/automation.route.js";
import { createExecutionsRouter } from "./routes/executions.route.js";
import { createScriptsRouter, pausePendingAutomationGenerationBatches } from "./routes/scripts.route.js";
import { ExecutionQueue } from "./workers/executionQueue.js";
const app = express();

const allowedOrigins = (process.env.WEB_ORIGIN ?? "http://localhost:3000").split(",");

app.use(cors({ origin: allowedOrigins }));

app.use(express.json());
app.use("/generate-plan", generatePlanRouter);
app.use("/review", reviewRouter);
app.use("/approve", approveRouter);
app.use("/plans",plansRouter);
app.use("/approve-sprint",approveSprintRouter);
app.use("/jira-status", jiraStatusRouter);
app.use("/sprint-stories", sprintStoriesRouter);
app.use("/sprint-context", sprintContextRouter);
app.use("/jira-create", jiraCreateRouter);
app.use("/created-jiras", createdJirasRouter);
app.use("/sprints", sprintsRouter);
app.use("/testcase-review", testCaseReviewRouter);
app.use("/reports", reportsRouter);
const executionQueue = new ExecutionQueue();
app.use("/automation", createAutomationRouter(executionQueue));
app.use("/api/executions", createExecutionsRouter(executionQueue));
app.use("/api/scripts", createScriptsRouter(executionQueue));

void pausePendingAutomationGenerationBatches().catch(error => {
  console.error("Could not pause interrupted automation generation batches:", error);
});

const PORT = 4000;

app.listen(PORT, () => {

  console.log(
    `API running on ${PORT}`
  );

});