import { appendFileSync, readFileSync } from "node:fs";
import type { Reporter, TestCase, TestResult, TestStep } from "@playwright/test/reporter";
import path from "node:path";

type StepProgress = {
  stepId: string;
  status: "running" | "passed" | "failed";
  detail: string;
  timestamp: string;
};

class ExecutionProgressReporter implements Reporter {
  private readonly progressFile = process.env.PLAYWRIGHT_EXECUTION_PROGRESS_FILE;
  private readonly sourceByFile = new Map<string, string[]>();
  private activeBusinessStep?: string;

  onStepBegin(test: TestCase, _result: TestResult, step: TestStep): void {
    const businessStep = step.title.match(/^(S\d+):/);
    if (businessStep) {
      this.activeBusinessStep = businessStep[1];
      this.emit({ stepId: businessStep[1], status: "running", detail: step.title, timestamp: new Date().toISOString() });
      return;
    }

    if (step.category !== "pw:api" || this.activeBusinessStep) return;
    const stepId = this.stepAtLocation(step.location?.file ?? test.location.file, step.location?.line);
    if (stepId) this.emit({ stepId, status: "running", detail: step.title, timestamp: new Date().toISOString() });
  }

  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep): void {
    const businessStep = step.title.match(/^(S\d+):/);
    if (businessStep) {
      const failed = Boolean(step.error);
      this.emit({
        stepId: businessStep[1],
        status: failed ? "failed" : "passed",
        detail: step.error?.message ?? step.title,
        timestamp: new Date().toISOString(),
      });
      this.activeBusinessStep = undefined;
      return;
    }

    if (step.category !== "pw:api" || this.activeBusinessStep) return;
    const stepId = this.stepAtLocation(step.location?.file ?? "", step.location?.line);
    if (stepId) {
      this.emit({
        stepId,
        status: step.error ? "failed" : "passed",
        detail: step.error?.message ?? step.title,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private stepAtLocation(file: string, line?: number): string | undefined {
    if (!file || !line) return undefined;
    const normalized = path.resolve(file);
    let source = this.sourceByFile.get(normalized);
    if (!source) {
      source = readFileSync(normalized, "utf8").split(/\r?\n/);
      this.sourceByFile.set(normalized, source);
    }
    for (let index = Math.min(line - 1, source.length - 1); index >= 0; index -= 1) {
      const marker = source[index].match(/^\s*\/\/\s*(S\d+)\s*$/);
      if (marker) return marker[1];
    }
    return undefined;
  }

  private emit(progress: StepProgress): void {
    if (this.progressFile) appendFileSync(this.progressFile, `${JSON.stringify(progress)}\n`, "utf8");
  }
}

export default ExecutionProgressReporter;
