const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export type ExecutionStatus =
  | "queued"
  | "planning"
  | "executing"
  | "passed"
  | "failed"
  | "blocked";

export type ExecutionCaseResult = {
  testCaseId: string;
  title?: string;
  expectedResult?: string;
  status: ExecutionStatus | "planning" | "executing";
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  currentStep?: number;
  totalSteps?: number;
  activeStepId?: string;
  plannedSteps?: string[];
  actualResult?: string;
  failureType?: "application" | "automation";
  testData?: Array<{ name: string; value: string }>;
  evidence?: Record<string, string>;
  aiAnalysis?: string;
  steps?: Array<{ stepId: string; sourceStep: string; status: string; detail?: string }>;
};

export type ExecutionObservation = {
  timestamp: string;
  text: string;
  status: "passed" | "failed" | "blocked" | "running";
};

export type StoryExecutionResult = {
  status: ExecutionStatus;
  totals?: { total: number; passed: number; failed: number; blocked: number };
  results?: ExecutionCaseResult[];
  artifacts?: Record<string, string>;
};

export type ExecutionJob = {
  executionId: string;
  storyId?: string;
  testCaseId?: string;
  regenerateScript?: boolean;
  status: ExecutionStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: {
    storyTitle: string;
    totalCases: number;
    completedCases: number;
    cases: ExecutionCaseResult[];
    currentCase?: ExecutionCaseResult;
    observation: ExecutionObservation[];
  };
  result?: StoryExecutionResult;
  error?: string;
};

export type AutomationTestCase = {
  testCaseId: string;
  title: string;
  reviewStatus: string;
  objective: string;
  type: "positive" | "negative" | "boundary";
  priority: "critical" | "high" | "medium" | "low";
  acceptanceCriteriaIds: string[];
  preconditions: string[];
  steps: string[];
  expectedOutcome: string;
  testData?: Array<{ name: string; value: string | number | boolean }>;
  automationFeasibility?: "fully-automatable" | "partially-automatable" | "manual-only";
  automationReason?: string;
  automationStatus: "Ready to Execute" | "Needs Automation" | "Needs Healing" | "Blocked";
  lifecycleStatus: string;
  scriptAvailable: boolean;
  lastExecutionAt?: string;
  lastResult?: string;
  lastExecutionId?: string;
  lastPassedStep: number;
  lastExecutedStep: number;
  history: Array<{
    executionId: string;
    status: string;
    createdAt: string;
    finishedAt?: string;
    error?: string;
    evidence?: Record<string, string>;
    testSource?: string;
  }>;
  scriptVersion?: number;
  lastHealingAt?: string;
};

export type ApprovedTestCasesResponse = {
  storyId: string;
  storyTitle: string;
  storyDescription?: string;
  automationCoverage: number;
  totals: {
    testCases: number;
    scriptsGenerated: number;
    passed: number;
    failed: number;
    blocked: number;
    needsAutomation: number;
    needsHealing: number;
    readyToExecute: number;
    lastExecutionAt?: string;
  };
  testCases: AutomationTestCase[];
};

export type AutomationGenerationStage =
  | "queued"
  | "planning"
  | "exploring"
  | "discovering_locators"
  | "generating_script"
  | "validating_script"
  | "saving_script"
  | "completed"
  | "failed"
  | "blocked";

export type AutomationGenerationCase = {
  testCaseId: string;
  title: string;
  executionId?: string;
  stage: AutomationGenerationStage;
  currentAction?: string;
  currentUrl?: string;
  locatorsFound: number;
  confidence?: number;
  failureReason?: string;
  logs: Array<{ timestamp: string; text: string; status: string }>;
};

export type AutomationGenerationBatch = {
  batchId: string;
  storyId: string;
  status: "queued" | "running" | "paused" | "completed";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  totals: {
    total: number;
    completed: number;
    inProgress: number;
    failed: number;
    blocked: number;
    remaining: number;
  };
  currentCase?: AutomationGenerationCase;
  cases: AutomationGenerationCase[];
};

export async function generatePlan(sprintId: number) {
  const response = await fetch(`${API_BASE_URL}/generate-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sprintId }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message ?? "Generate Plan Failed");
  }
  return data;
}

export async function regenerateStory(sprintId: number, storyId: string) {
  const response = await fetch(`${API_BASE_URL}/generate-plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sprintId, storyId }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message ?? "Regenerate Story Failed");
  }
  return data;
}

export async function getJiraStatus(sprintId: number) {
  const response = await fetch(
    `${API_BASE_URL}/jira-status?sprintId=${sprintId}`,
  );
  return response.json();
}

export async function getSprintStories(sprintId: number) {
  const response = await fetch(
    `${API_BASE_URL}/sprint-stories?sprintId=${sprintId}`,
  );
  return response.json();
}

export async function getSprintContext() {
  const response = await fetch(`${API_BASE_URL}/sprint-context`);
  return response.json();
}

export async function getAllSprints() {
  const response = await fetch(`${API_BASE_URL}/sprints`);
  return response.json();
}

export async function createJira(input: {
  sprintId: number;
  description: string;
  file?: File | null;
}) {
  const formData = new FormData();
  formData.append("sprintId", String(input.sprintId));
  formData.append("description", input.description);
  if (input.file) {
    formData.append("file", input.file);
  }

  const response = await fetch(`${API_BASE_URL}/jira-create`, {
    method: "POST",
    body: formData,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message ?? "Create Jira Failed");
  }
  return data;
}

export async function getCreatedJiras() {
  const response = await fetch(`${API_BASE_URL}/created-jiras`);
  return response.json();
}

export async function getReportsOverview() {
  const response = await fetch(`${API_BASE_URL}/reports/overview`);
  return response.json();
}

export function getExcelExportUrl(storyId: string) {
  return `${API_BASE_URL}/plans/${storyId}/excel`;
}

export async function executeApprovedTests(storyId: string) {
  const response = await fetch(`${API_BASE_URL}/api/executions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storyId }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? "Could not start automation execution");
  }
  return data as ExecutionJob;
}

export async function executeStoryTests(storyId: string) {
  return executeApprovedTests(storyId);
}

export async function getExecutionStatus(executionId: string) {
  const response = await fetch(
    `${API_BASE_URL}/api/executions/${encodeURIComponent(executionId)}`,
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? "Could not retrieve execution status");
  }
  return data as ExecutionJob;
}

export async function getApprovedTestCases(storyId: string): Promise<ApprovedTestCasesResponse> {
  const response = await fetch(`${API_BASE_URL}/api/scripts/stories/${encodeURIComponent(storyId)}/test-cases`);
  const data = await readApiJson(response);
  if (!response.ok) throw new Error(apiError(data, "Could not load approved test cases"));
  return data as ApprovedTestCasesResponse;
}

export async function startTestCaseExecution(storyId: string, testCaseId: string) {
  return postScriptAction(storyId, testCaseId, "execute");
}

export async function generateTestCaseScript(storyId: string, testCaseId: string) {
  return postScriptAction(storyId, testCaseId, "scripts/generate");
}

export async function regenerateTestCaseScript(storyId: string, testCaseId: string) {
  return postScriptAction(storyId, testCaseId, "scripts/regenerate");
}

export async function generateMissingScripts(storyId: string): Promise<{
  storyId: string;
  total: number;
  skipped: number;
  queued: number;
  batchId: string;
}> {
  const response = await fetch(
    `${API_BASE_URL}/api/scripts/stories/${encodeURIComponent(storyId)}/scripts/generate-all`,
    { method: "POST" },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Could not generate missing scripts");
  return data;
}

export async function resumeAutomationGeneration(storyId: string, batchId: string): Promise<void> {
  const response = await fetch(
    `${API_BASE_URL}/api/scripts/stories/${encodeURIComponent(storyId)}/generation-batches/${encodeURIComponent(batchId)}/resume`,
    { method: "POST" },
  );
  const data = await readApiJson(response);
  if (!response.ok) throw new Error(apiError(data, "Could not resume automation generation"));
}

export async function getAutomationGenerationBatch(storyId: string, batchId: string): Promise<AutomationGenerationBatch> {
  const response = await fetch(
    `${API_BASE_URL}/api/scripts/stories/${encodeURIComponent(storyId)}/generation-batches/${encodeURIComponent(batchId)}`,
  );
  const data = await readApiJson(response);
  if (!response.ok) throw new Error(apiError(data, "Could not retrieve automation generation progress"));
  return data as AutomationGenerationBatch;
}

export async function getActiveAutomationGenerationBatch(storyId: string): Promise<{
  batchId: string;
  status: AutomationGenerationBatch["status"];
} | undefined> {
  const response = await fetch(
    `${API_BASE_URL}/api/scripts/stories/${encodeURIComponent(storyId)}/generation-batches`,
  );
  if (response.status === 404) return undefined;
  const data = await readApiJson(response);
  if (!response.ok) throw new Error(apiError(data, "Could not retrieve active automation generation"));
  return data as { batchId: string; status: AutomationGenerationBatch["status"] };
}

async function postScriptAction(storyId: string, testCaseId: string, action: string) {
  const response = await fetch(
    `${API_BASE_URL}/api/scripts/stories/${encodeURIComponent(storyId)}/test-cases/${encodeURIComponent(testCaseId)}/${action}`,
    { method: "POST" },
  );
  const data = await readApiJson(response);
  if (!response.ok) throw new Error(apiError(data, "Could not start test case action"));
  return data as ExecutionJob & { skipped?: boolean; reason?: string };
}

async function readApiJson(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      `The API returned ${contentType || "an unknown response"} instead of JSON (HTTP ${response.status}). ` +
      `Verify the API server is running the latest code at ${API_BASE_URL}.`,
    );
  }
  return response.json() as Promise<Record<string, unknown>>;
}

function apiError(data: Record<string, unknown>, fallback: string) {
  return typeof data.error === "string" ? data.error : fallback;
}

export async function reviewTestCases(
  storyId: string,
  testCaseIds: string[],
  action: "approve" | "reject",
) {
  const response = await fetch(`${API_BASE_URL}/testcase-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ storyId, testCaseIds, action }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.message ?? "Test Case Review Failed");
  }
  return data;
}

export async function getPlans() {
  const response = await fetch(`${API_BASE_URL}/plans`);
  return response.json();
}

export async function approveSprint() {
  const response = await fetch(`${API_BASE_URL}/approve-sprint`, {
    method: "POST",
  });
  return response.json();
}
