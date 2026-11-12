import { z } from "zod";

const optionalText = z.preprocess(
  value => typeof value === "string" && !value.trim() ? undefined : value,
  z.string().trim().min(1).optional(),
);
const optionalExpected = z.string().optional();

export const ExecutionActionSchema = z.enum([
  "navigate", "click", "fill", "press", "waitForLoad", "waitForText",
  "assertVisible", "assertHidden", "assertEnabled", "assertDisabled",
  "assertValue", "assertText", "assertUrl", "assertUrlNot", "assertSelected", "assertUnselected", "noOp",
]);

export const PlannedStepSchema = z.object({
  id: z.string().trim().min(1),
  sourceStep: z.string().trim().min(1),
  action: ExecutionActionSchema,
  target: optionalText,
  value: optionalText,
  valueRef: optionalText,
  expected: optionalExpected,
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  locatorKey: optionalText,
}).strict().superRefine((step, ctx) => {
  const targetRequired = ["click", "fill", "press", "assertVisible", "assertHidden", "assertEnabled", "assertDisabled", "assertValue", "assertSelected", "assertUnselected"].includes(step.action);
  if (targetRequired && !step.target && !step.locatorKey) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["target"], message: `${step.action} requires a semantic target or locatorKey` });
  }
  if (step.action === "navigate" && !step.value) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "navigate requires a URL" });
  }
  if (step.action === "fill" && step.value === undefined && !step.valueRef) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "fill requires value or valueRef" });
  }
  if (["waitForText", "assertText", "assertUrl", "assertUrlNot", "assertValue"].includes(step.action) && step.expected === undefined && step.value === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expected"], message: `${step.action} requires expected or value` });
  }
});

export const ExecutionPlanSchema = z.object({
  testCaseId: z.string().trim().min(1),
  storyId: z.string().trim().optional(),
  steps: z.array(PlannedStepSchema).min(1),
}).strict();

export type PlannedStep = z.infer<typeof PlannedStepSchema>;
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;
