import { z } from "zod";

export const TestTypeSchema = z.enum(["positive", "negative", "boundary"]);
export const TestPrioritySchema = z.enum(["critical", "high", "medium", "low"]);
export const TypeSchema = z.enum([
  "missing-business-rule",
  "missing-validation",
  "missing-boundary",
  "requirement-ambiguity",
]);
export const ReviewStatusSchema = z.enum([
  "draft",
  "updated",
  "approved",
  "removed",
]);

export const TestDataSchema = z.object({
  name: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

export const CoverageSchema = z.object({
  coverageSummary: z.string().default(""),
  coveragePercentage: z.number().min(0).max(100),
  coverageReason: z.string(),
  coveredAreas: z.array(z.string()).default([]),
  missingAreas: z.array(z.string()).default([]),
});

export const AutomationReadinessSchema = z.object({
  score: z.number().min(0).max(100),
  reason: z.string(),
});

export const TestCaseSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  confidence: z.number().min(0).max(100),
  confidenceReason: z.string().default(""),
  acceptanceCriteriaIds: z.array(z.string()).default([]),
  derivedScenario: z.boolean().default(false).optional(),
  type: TestTypeSchema,
  priority: TestPrioritySchema,
  objective: z.string().min(1),
  test_data: z.array(TestDataSchema).default([]).optional(),
  steps: z.array(z.string()).default([]),
  expectedOutcome: z.string().min(1),
  automationFeasibility: z
    .enum(["fully-automatable", "partially-automatable", "manual-only"])
    .optional(),
  automationReason: z.string().optional(),
});

export const ClarificationSchema = z.object({
  type: z.enum([
    "missing-business-rule",
    "missing-validation",
    "missing-boundary",
    "requirement-ambiguity",
  ]),
  id: z.string(),
  question: z.string(),
  businessImpact: z.string(),
  resolved: z.boolean().default(false),
  answer: z.string().optional(),
});

export const TestPlanSchema = z.object({
  storyId: z.string(),
  title: z.string(),
  version: z.number().default(1),
  coverage: CoverageSchema.default({
    coverageSummary: "",
    coveragePercentage: 0,
    coverageReason: "",
    coveredAreas: [],
    missingAreas: [],
  }),
  automationReadiness: AutomationReadinessSchema.default({
    score: 0,
    reason: "",
  }),
  testCases: z.array(TestCaseSchema).default([]),
  clarifications: z.array(ClarificationSchema).default([]),
  status: ReviewStatusSchema.default("draft"),
  generatedOn: z.string().optional(),
  updatedOn: z.string().optional(),
});

export const FeedbackHistorySchema = z.object({
  version: z.number(),
  answers: z.record(z.string(), z.string().optional()),
  additionalFeedback: z.string(),
  createdOn: z.string(),
});

export const StoryReviewSessionSchema = z.object({
  storyId: z.string(),
  approved: z.boolean().default(false),
  feedbackHistory: z.array(FeedbackHistorySchema).default([]),
});

export const ReviewSessionSchema = z.object({
  sprintId: z.number(),
  stories: z.object(StoryReviewSessionSchema),
});

export const FeedbackContextSchema = z.object({
  storyId: z.string(),
  feedbackHistory: z.array(FeedbackHistorySchema).default([]),
});

export const ReviewRequestSchema = z.object({
  storyId: z.string().min(1),
  version: z.number().int().positive(),
  answers: z.record(z.string(), z.string().optional()),
  additionalFeedback: z.string().default(""),
  currentPlan: TestPlanSchema,
});

export const BusinessKnowledgeSchema = z.object({
  id: z.string(),
  storyId: z.string(),
  rule: z.string(),
  addedOn: z.string(),
});

export const BusinessContextSchema = z.object({
  version: z.number().default(1),
  rules: z.array(BusinessKnowledgeSchema).default([]),
});

export const ApproveRequestSchema = z.object({
  storyId: z.string().min(1),
  currentPlan: TestPlanSchema,
});

export type TestCase = z.infer<typeof TestCaseSchema>;

export type TestPlan = z.infer<typeof TestPlanSchema>;

export type Clarification = z.infer<typeof ClarificationSchema>;

export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export type ReviewSession = z.infer<typeof ReviewSessionSchema>;

export type BusinessContext = z.infer<typeof BusinessContextSchema>;
