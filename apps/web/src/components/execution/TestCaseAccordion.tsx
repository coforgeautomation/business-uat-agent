"use client";

import type { ExecutionCaseResult, ExecutionStatus } from "@/lib/api";

type TestCaseAccordionProps = {
  testCase: ExecutionCaseResult;
  executionId: string;
  expanded: boolean;
  active: boolean;
  onToggle: () => void;
};

const terminal = new Set<ExecutionStatus>(["passed", "failed", "blocked"]);

function statusStyle(status: ExecutionCaseResult["status"]) {
  if (status === "passed") return "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300";
  if (status === "failed") return "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300";
  if (status === "blocked") return "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
  if (status === "executing" || status === "planning") return "bg-yellow-100 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-300";
  return "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
}

function duration(startedAt?: string, finishedAt?: string) {
  if (!startedAt) return undefined;
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  const seconds = Math.max(0, Math.floor((end - Date.parse(startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default function TestCaseAccordion({
  testCase,
  executionId,
  expanded,
  active,
  onToggle,
}: TestCaseAccordionProps) {
  const steps = testCase.plannedSteps ?? testCase.steps?.map(step => step.sourceStep) ?? [];
  const completedSteps = testCase.steps ?? [];
  const isTerminal = terminal.has(testCase.status as ExecutionStatus);
  const activeStepNumber = testCase.activeStepId
    ? Number(testCase.activeStepId.slice(1))
    : testCase.currentStep ?? 0;

  return (
    <article className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <button
        type="button"
        className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 dark:hover:bg-slate-800"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span aria-hidden="true" className="text-lg text-slate-400">
          {expanded ? "⌄" : "›"}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-slate-900 dark:text-white">
            {testCase.testCaseId}
          </span>
          <span className="mt-0.5 block truncate text-sm text-slate-600 dark:text-slate-300">
            {testCase.title ?? "Test case"}
          </span>
        </span>
        {active && (
          <span className="hidden rounded-full bg-yellow-100 px-2.5 py-1 text-xs font-semibold text-yellow-900 sm:inline dark:bg-yellow-950 dark:text-yellow-300">
            Step {activeStepNumber} / {testCase.totalSteps ?? steps.length}
          </span>
        )}
        {isTerminal && testCase.startedAt && (
          <span className="hidden text-xs text-slate-500 sm:inline dark:text-slate-400">
            {duration(testCase.startedAt, testCase.finishedAt)}
          </span>
        )}
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold uppercase ${statusStyle(testCase.status)}`}>
          {testCase.status}
        </span>
      </button>

      <div
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-in-out ${
          expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">
          {expanded && (
            <div className="space-y-5 border-t border-slate-200 p-4 dark:border-slate-700">
              <section>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Executed steps</h3>
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {completedSteps.filter(step => step.status === "passed").length} / {steps.length} passed
                  </span>
                </div>
                <ol className="space-y-2">
                  {steps.map((label, index) => {
                    const step = completedSteps.find(item => item.stepId === `S${index + 1}`);
                    const current = active && testCase.activeStepId === `S${index + 1}`;
                    const state = step?.status ?? (current ? "running" : "pending");
                    return (
                      <li key={`${testCase.testCaseId}-${index}`} className="flex items-start gap-3 text-sm">
                        <span className={
                          state === "passed"
                            ? "text-green-600 dark:text-green-400"
                            : state === "failed"
                              ? "text-red-600 dark:text-red-400"
                              : state === "blocked"
                                ? "text-amber-600 dark:text-amber-400"
                                : state === "running"
                                  ? "text-yellow-600 dark:text-yellow-400"
                                  : "text-slate-400 dark:text-slate-500"
                        }>
                          {state === "passed" ? "✓" : state === "failed" ? "×" : state === "blocked" ? "!" : state === "running" ? "◌" : "○"}
                        </span>
                        <span className={`flex-1 ${state === "pending" ? "text-slate-400 dark:text-slate-500" : "text-slate-700 dark:text-slate-200"}`}>
                          {label}
                          {step?.detail && (
                            <span className="mt-0.5 block break-words text-xs text-slate-500 dark:text-slate-400">
                              {step.detail}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-xs capitalize text-slate-500 dark:text-slate-400">
                          {state}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </section>

              {isTerminal && (
                <div className="grid gap-4 md:grid-cols-2">
                  <section className="rounded-lg bg-slate-50 p-4 dark:bg-slate-800">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Test data</h3>
                    {testCase.testData?.length ? (
                      <dl className="mt-2 space-y-1 text-sm">
                        {testCase.testData.map(item => (
                          <div key={item.name} className="flex justify-between gap-3">
                            <dt className="text-slate-600 dark:text-slate-300">{item.name}</dt>
                            <dd className="font-mono text-slate-800 dark:text-slate-100">{item.value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : <p className="mt-2 text-sm text-slate-500">No test data recorded.</p>}
                  </section>
                  <section className="rounded-lg bg-slate-50 p-4 dark:bg-slate-800">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Expected result</h3>
                    <p className="mt-2 whitespace-pre-wrap text-sm text-slate-800 dark:text-slate-100">{testCase.expectedResult || "Not recorded"}</p>
                  </section>
                  <section className="rounded-lg bg-slate-50 p-4 md:col-span-2 dark:bg-slate-800">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Actual result</h3>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-800 dark:text-slate-100">{testCase.actualResult || "No actual result recorded."}</p>
                  </section>
                </div>
              )}

              {testCase.aiAnalysis && (
                <section className="rounded-lg border border-violet-200 bg-violet-50 p-4 dark:border-violet-900 dark:bg-violet-950/40">
                  <h3 className="text-sm font-semibold text-violet-900 dark:text-violet-200">AI analysis</h3>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-violet-900 dark:text-violet-100">{testCase.aiAnalysis}</p>
                </section>
              )}

              {isTerminal && (
                <section>
                  <h3 className="mb-3 text-sm font-semibold text-slate-900 dark:text-white">Evidence</h3>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {Object.entries(testCase.evidence ?? {}).filter(([name]) => /screenshot/i.test(name)).map(([name]) => (
                      <a
                        key={name}
                        href={`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}/api/executions/${encodeURIComponent(executionId)}/artifacts/${encodeURIComponent(name)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800"
                      >
                        {/* Artifact endpoint returns the captured screenshot for this case. */}
                        <img
                          src={`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}/api/executions/${encodeURIComponent(executionId)}/artifacts/${encodeURIComponent(name)}`}
                          alt={`${testCase.testCaseId} ${name}`}
                          className="aspect-video w-full object-cover"
                          loading="lazy"
                        />
                        <span className="block p-2 text-xs text-slate-600 dark:text-slate-300">Screenshot · {name}</span>
                      </a>
                    ))}
                    {Object.entries(testCase.evidence ?? {}).filter(([name]) => /history|steps|result/i.test(name)).map(([name, file]) => (
                      <div key={name} className="rounded-lg border border-slate-200 p-3 text-xs dark:border-slate-700">
                        <p className="font-semibold text-slate-800 dark:text-slate-100">Execution log · {name}</p>
                        <p className="mt-1 break-all text-slate-500 dark:text-slate-400">{file}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
