"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  executeStoryTests,
  getActiveAutomationGenerationBatch,
  getAutomationGenerationBatch,
  generateMissingScripts,
  resumeAutomationGeneration,
  getApprovedTestCases,
  getExcelExportUrl,
  regenerateTestCaseScript,
  startTestCaseExecution,
  type ApprovedTestCasesResponse,
  type AutomationGenerationBatch,
  type AutomationGenerationStage,
  type AutomationTestCase,
} from "@/lib/api";

type CaseFilter = "all" | AutomationTestCase["automationStatus"];

function automationStyle(status: AutomationTestCase["automationStatus"]) {
  if (status === "Ready to Execute") return "bg-green-100 text-green-800";
  if (status === "Needs Healing") return "bg-orange-100 text-orange-800";
  if (status === "Blocked") return "bg-red-100 text-red-800";
  return "bg-amber-100 text-amber-800";
}

function executionStyle(status?: string) {
  const normalized = status?.toLowerCase();
  if (normalized === "passed") return "bg-green-100 text-green-800";
  if (normalized === "failed") return "bg-red-100 text-red-800";
  if (normalized === "blocked") return "bg-orange-100 text-orange-800";
  if (normalized === "queued" || normalized === "planning" || normalized === "executing") {
    return "bg-blue-100 text-blue-800";
  }
  return "bg-slate-100 text-slate-600";
}

function executionLabel(status?: string) {
  if (!status) return "Not run";
  const labels: Record<string, string> = {
    passed: "Passed",
    failed: "Failed",
    blocked: "Blocked",
    queued: "Queued",
    planning: "Preparing",
    executing: "Running",
    PASSED: "Passed",
    FAILED: "Failed",
    BLOCKED: "Blocked",
    EXECUTING: "Running",
  };
  return labels[status] ?? status;
}

function generationStageLabel(stage: AutomationGenerationStage) {
  const labels: Record<AutomationGenerationStage, string> = {
    queued: "Queued",
    planning: "Planning",
    exploring: "Exploring",
    discovering_locators: "Discovering Locators",
    generating_script: "Generating Script",
    validating_script: "Validating Script",
    saving_script: "Saving Script",
    completed: "Completed",
    failed: "Failed",
    blocked: "Blocked",
  };
  return labels[stage];
}

export default function ApprovedTestCases({ storyId }: { storyId: string }) {
  const router = useRouter();
  const [data, setData] = useState<ApprovedTestCasesResponse | null>(null);
  const [generationBatch, setGenerationBatch] = useState<AutomationGenerationBatch | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null);
  const [caseFilter, setCaseFilter] = useState<CaseFilter>("all");
  const [pageStateRestored, setPageStateRestored] = useState(false);
  const savedScrollY = useRef<number | null>(null);
  const pageStateKey = `test-cases:${storyId}`;
  const storyUrl = `/stories/${encodeURIComponent(storyId)}/test-cases`;

  const savePageState = useCallback((caseId = expandedCaseId) => {
    try {
      sessionStorage.setItem(pageStateKey, JSON.stringify({
        expandedCaseId: caseId,
        caseFilter,
        message,
        scrollY: window.scrollY,
      }));
    } catch (storageError) {
      console.warn("Could not preserve test-case page state:", storageError);
    }
  }, [caseFilter, expandedCaseId, message, pageStateKey]);

  const refresh = useCallback(async () => {
    try {
      const current = await getApprovedTestCases(storyId);
      setData(current);
      setError("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }, [storyId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved = sessionStorage.getItem(pageStateKey);
        if (saved) {
          const state = JSON.parse(saved) as {
            expandedCaseId?: string | null;
            caseFilter?: CaseFilter;
            message?: string;
            scrollY?: number;
          };
          setExpandedCaseId(state.expandedCaseId ?? null);
          setMessage(state.message ?? "");
          if (state.caseFilter) setCaseFilter(state.caseFilter);
          if (typeof state.scrollY === "number") savedScrollY.current = state.scrollY;
        }
      } catch (storageError) {
        console.warn("Could not restore test-case page state:", storageError);
      }
      setPageStateRestored(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [pageStateKey]);

  useEffect(() => {
    if (!data || savedScrollY.current === null) return;
    const scrollY = savedScrollY.current;
    savedScrollY.current = null;
    window.requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: "instant" }));
  }, [data]);

  useEffect(() => {
    if (pageStateRestored) savePageState();
  }, [caseFilter, expandedCaseId, message, pageStateRestored, savePageState]);

  useEffect(() => {
    let active = true;
    const load = () => {
      if (active) void refresh();
    };
    const initialTimer = window.setTimeout(load, 0);
    const interval = window.setInterval(load, 3000);
    return () => {
      active = false;
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [refresh]);

  useEffect(() => {
    let active = true;
    void getActiveAutomationGenerationBatch(storyId).then(result => {
      if (active && result) {
        setGenerationBatch(current =>
          current?.batchId === result.batchId ? current : {
            batchId: result.batchId,
            storyId,
            status: result.status,
            createdAt: new Date().toISOString(),
            totals: { total: 0, completed: 0, inProgress: 0, failed: 0, blocked: 0, remaining: 0 },
            cases: [],
          },
        );
      }
    }).catch(requestError => {
      if (active) setMessage(requestError instanceof Error ? requestError.message : String(requestError));
    });
    return () => { active = false; };
  }, [storyId]);

  useEffect(() => {
    const batchId = generationBatch?.batchId;
    if (!batchId) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const current = await getAutomationGenerationBatch(storyId, batchId);
        if (!active) return;
        setGenerationBatch(current);
        await refresh();
        if (active && (current.status === "running" || current.status === "queued")) {
          timer = window.setTimeout(() => void poll(), 1200);
        }
      } catch (requestError) {
        if (!active) return;
        setMessage(requestError instanceof Error ? requestError.message : String(requestError));
        timer = window.setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [generationBatch?.batchId, generationBatch?.status, refresh, storyId]);

  async function startCaseAction(
    testCaseId: string,
    action: () => Promise<{ executionId?: string }>,
  ) {
    setExpandedCaseId(testCaseId);
    setBusyAction(testCaseId);
    setMessage("");
    try {
      const job = await action();
      if (!job.executionId) throw new Error("The requested action did not return an execution.");
      savePageState(testCaseId);
      router.push(executionHref(job.executionId, currentPageUrl()));
    } catch (requestError) {
      setMessage(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyAction(null);
    }
  }

  async function generateMissingAutomation() {
    setBusyAction("generate-all");
    setMessage("");
    try {
      const result = await generateMissingScripts(storyId);
      setMessage(
        result.queued > 0
          ? `${result.queued} automation ${result.queued === 1 ? "setup is" : "setups are"} running sequentially. ${result.skipped} existing automations were kept.`
          : `All ${result.total} test cases already have automation. No new work was queued.`,
      );
      if (result.queued > 0) {
        setGenerationBatch(await getAutomationGenerationBatch(storyId, result.batchId));
      } else {
        setGenerationBatch(null);
      }
      await refresh();
    } catch (requestError) {
      setMessage(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyAction(null);
    }
  }

  async function resumeAutomation() {
    if (!generationBatch) return;
    setBusyAction("resume-generation");
    setMessage("");
    try {
      await resumeAutomationGeneration(storyId, generationBatch.batchId);
      setGenerationBatch(current => current ? { ...current, status: "running" } : current);
      setMessage("Paused automation generation resumed by your request.");
    } catch (requestError) {
      setMessage(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusyAction(null);
    }
  }

  async function executeAllTests() {
    setBusyAction("execute-all");
    setMessage("");
    try {
      const job = await executeStoryTests(storyId);
      savePageState(expandedCaseId);
      router.push(executionHref(job.executionId, currentPageUrl()));
    } catch (requestError) {
      setMessage(requestError instanceof Error ? requestError.message : String(requestError));
      setBusyAction(null);
    }
  }

  const visibleCases = (data?.testCases ?? []).filter(testCase =>
    caseFilter === "all" || testCase.automationStatus === caseFilter,
  );
  const summary = data?.totals;

  return (
    <main className="min-h-screen bg-slate-50 p-4 text-slate-900 sm:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <Link href="/" className="text-sm font-medium text-blue-700 hover:underline">
          ← Sprint dashboard
        </Link>

        <header className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-widest text-blue-700">Story UAT</p>
              <h1 className="mt-2 text-2xl font-bold sm:text-3xl">
                {data?.storyId ?? storyId} · {data?.storyTitle ?? "Test cases"}
              </h1>
              <p className="mt-2 text-sm text-slate-500">
                {summary?.testCases ?? data?.testCases.length ?? "—"} test cases
                {summary?.lastExecutionAt && <> · Last run {new Date(summary.lastExecutionAt).toLocaleString()}</>}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              {generationBatch?.status === "paused" ? (
                <button
                  type="button"
                  onClick={() => void resumeAutomation()}
                  disabled={busyAction !== null}
                  className="rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busyAction === "resume-generation" ? "Resuming…" : "Resume Automation Generation"}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void generateMissingAutomation()}
                  disabled={busyAction !== null || (generationBatch?.status !== undefined && generationBatch.status !== "completed") || !data?.totals.needsAutomation}
                  className="rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busyAction === "generate-all" ? "Preparing…" : "Generate Missing Automation"}
                </button>
              )}
              <button
                type="button"
                onClick={() => void executeAllTests()}
                disabled={busyAction !== null || !data?.testCases.length}
                className="rounded-lg bg-violet-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busyAction === "execute-all" ? "Starting…" : "Execute All Tests"}
              </button>
              <a
                href={getExcelExportUrl(storyId)}
                className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Download Excel
              </a>
            </div>
          </div>

          <StoryHealth data={data} />
        </header>

        {message && <p className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900" role="status">{message}</p>}
        {error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{error}</p>}
        {generationBatch && <AutomationGenerationMonitor batch={generationBatch} />}

        <section className="space-y-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-xl font-bold">Test cases</h2>
              <p className="mt-1 text-sm text-slate-500">Review each case, run validations, and open prior results.</p>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              Show
              <select
                value={caseFilter}
                onChange={event => setCaseFilter(event.target.value as CaseFilter)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-800"
              >
                <option value="all">All test cases</option>
                <option value="Ready to Execute">Ready to Execute</option>
                <option value="Needs Automation">Needs Automation</option>
                <option value="Needs Healing">Needs Healing</option>
                <option value="Blocked">Blocked</option>
              </select>
            </label>
          </div>

          {visibleCases.length === 0 && data ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
              {data.testCases.length ? "No test cases match this filter." : "No test cases are available for this story."}
            </div>
          ) : (
            <div className="space-y-3">
              {visibleCases.map(testCase => (
                <TestCaseCard
                  key={testCase.testCaseId}
                  testCase={testCase}
                  storyUrl={storyUrl}
                  expanded={expandedCaseId === testCase.testCaseId}
                  busy={busyAction === testCase.testCaseId}
                  disabled={busyAction !== null}
                  onToggle={() => setExpandedCaseId(expandedCaseId === testCase.testCaseId ? null : testCase.testCaseId)}
                  onViewRuns={() => setExpandedCaseId(testCase.testCaseId)}
                  onRun={() => void startCaseAction(testCase.testCaseId, () => startTestCaseExecution(storyId, testCase.testCaseId))}
                  onRepair={() => void startCaseAction(testCase.testCaseId, () => startTestCaseExecution(storyId, testCase.testCaseId))}
                  onUpdateAutomation={() => void startCaseAction(testCase.testCaseId, () => regenerateTestCaseScript(storyId, testCase.testCaseId))}
                  savePageState={savePageState}
                  currentPageUrl={currentPageUrl}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function AutomationGenerationMonitor({ batch }: { batch: AutomationGenerationBatch }) {
  const current = batch.currentCase;
  const metrics = [
    { label: "Total", value: batch.totals.total },
    { label: "Completed", value: batch.totals.completed },
    { label: "In Progress", value: batch.totals.inProgress },
    { label: "Failed", value: batch.totals.failed },
    { label: "Blocked", value: batch.totals.blocked },
    { label: "Remaining", value: batch.totals.remaining },
  ];
  const stageTone = (stage: AutomationGenerationStage) => stage === "completed"
    ? "bg-green-100 text-green-800"
    : stage === "failed" || stage === "blocked"
      ? "bg-red-100 text-red-800"
      : stage === "queued" ? "bg-slate-100 text-slate-700" : "bg-blue-100 text-blue-800";

  return (
    <section aria-label="Automation generation progress" aria-live="polite" className="space-y-5 rounded-2xl border border-blue-200 bg-white p-5 shadow-sm">
      <div>
        <h2 className="text-xl font-bold text-slate-900">{batch.storyId} Automation Generation</h2>
        <p className="mt-1 text-sm text-slate-500">
          {batch.status === "completed" ? "Batch finished"
            : batch.status === "paused" ? "Paused after service restart. Resume only when you are ready."
              : "Processing missing automation one test case at a time"}
          {batch.startedAt ? ` · Started ${new Date(batch.startedAt).toLocaleTimeString()}` : ""}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {metrics.map(metric => (
          <div key={metric.label} className="rounded-lg bg-slate-50 p-3">
            <p className="text-xs font-medium text-slate-500">{metric.label}</p>
            <p className="mt-1 text-xl font-bold text-slate-900">{metric.value}</p>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
        <h3 className="text-sm font-bold text-slate-900">Current item</h3>
        {current ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <p className="text-sm text-slate-700"><strong>{current.testCaseId}</strong> · {current.title}</p>
            <p className="text-sm text-slate-700">Status: <strong>{generationStageLabel(current.stage)}</strong></p>
            <p className="text-sm text-slate-700">Current Action: {current.currentAction ?? generationStageLabel(current.stage)}</p>
            <p className="min-w-0 break-all text-sm text-slate-700">Current URL: {current.currentUrl ?? "Waiting for navigation"}</p>
            <p className="text-sm text-slate-700">Locators Found: {current.locatorsFound}</p>
            <p className="text-sm text-slate-700">Confidence: {current.confidence === undefined ? "Not provided" : `${current.confidence}%`}</p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-600">
            {batch.status === "completed" ? "All queued test cases have finished." : "Waiting for the next test case to start."}
          </p>
        )}
      </div>
      <div className="space-y-3">
        <h3 className="text-sm font-bold text-slate-900">Test case progress and logs</h3>
        {batch.cases.map(testCase => (
          <article key={testCase.testCaseId} className="rounded-lg border border-slate-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-slate-900">
                <span className="font-mono">{testCase.testCaseId}</span> · {testCase.title}
              </p>
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${stageTone(testCase.stage)}`}>
                {generationStageLabel(testCase.stage)}
              </span>
            </div>
            {testCase.failureReason && (
              <p className="mt-2 text-sm text-red-800"><strong>Failure reason:</strong> {testCase.failureReason}</p>
            )}
            {testCase.logs.length > 0 && (
              <ol className="mt-3 space-y-1 border-l-2 border-slate-200 pl-3">
                {testCase.logs.slice(-5).map((log, index) => (
                  <li key={`${log.timestamp}-${index}`} className="text-xs text-slate-600">
                    <time dateTime={log.timestamp} className="mr-2 text-slate-400">{new Date(log.timestamp).toLocaleTimeString()}</time>
                    {log.text}
                  </li>
                ))}
              </ol>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function StoryHealth({ data }: { data: ApprovedTestCasesResponse | null }) {
  const totals = data?.totals;
  const progress = data?.automationCoverage ?? 0;
  const metrics = [
    { label: "Scripts generated", value: totals?.scriptsGenerated ?? 0, tone: "text-blue-700" },
    { label: "Ready to execute", value: totals?.readyToExecute ?? 0, tone: "text-green-700" },
    { label: "Passed", value: totals?.passed ?? 0, tone: "text-green-700" },
    { label: "Failed", value: totals?.failed ?? 0, tone: "text-red-700" },
    { label: "Blocked", value: totals?.blocked ?? 0, tone: "text-orange-700" },
    { label: "Needs automation", value: totals?.needsAutomation ?? 0, tone: "text-amber-700" },
    { label: "Needs healing", value: totals?.needsHealing ?? 0, tone: "text-orange-700" },
  ];

  return (
    <section aria-label="Story health" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 sm:col-span-2">
        <div className="flex items-end justify-between">
          <h2 className="text-sm font-semibold text-slate-700">Automation coverage</h2>
          <span className="text-lg font-bold text-slate-900">{progress}%</span>
        </div>
        <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Automation coverage">
          <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${progress}%` }} />
        </div>
        <p className="mt-2 text-xs text-slate-500">{totals?.scriptsGenerated ?? 0} of {totals?.testCases ?? 0} test cases have automation</p>
      </div>
      {metrics.map(metric => (
        <div key={metric.label} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-medium text-slate-500">{metric.label}</p>
          <p className={`mt-2 text-2xl font-bold ${metric.tone}`}>{metric.value}</p>
        </div>
      ))}
    </section>
  );
}

function TestCaseCard({
  testCase,
  storyUrl,
  expanded,
  busy,
  disabled,
  onToggle,
  onViewRuns,
  onRun,
  onRepair,
  onUpdateAutomation,
  savePageState,
  currentPageUrl,
}: {
  testCase: AutomationTestCase;
  storyUrl: string;
  expanded: boolean;
  busy: boolean;
  disabled: boolean;
  onToggle: () => void;
  onViewRuns: () => void;
  onRun: () => void;
  onRepair: () => void;
  onUpdateAutomation: () => void;
  savePageState: (caseId?: string | null) => void;
  currentPageUrl: () => string;
}) {
  const latestStatus = testCase.history[0]?.status ?? testCase.lastResult;
  const needsRepair = testCase.scriptAvailable &&
    (testCase.automationStatus === "Needs Healing" || latestStatus === "failed" || latestStatus === "blocked");

  return (
    <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-center">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`test-case-details-${testCase.testCaseId}`}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
        >
          <span aria-hidden="true" className="mt-0.5 text-lg text-slate-400">{expanded ? "⌄" : "›"}</span>
          <span className="min-w-0 flex-1">
            <span className="block font-mono text-xs font-bold tracking-wide text-blue-700">{testCase.testCaseId}</span>
            <span className="mt-1 block font-semibold text-slate-900">{testCase.title}</span>
            <span className="mt-3 flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${executionStyle(latestStatus)}`}>
                {executionLabel(latestStatus)}
              </span>
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${automationStyle(testCase.automationStatus)}`}>
                {testCase.automationStatus}
              </span>
              <span className="text-xs text-slate-500">
                Last run: {testCase.lastExecutionAt ? new Date(testCase.lastExecutionAt).toLocaleString() : "Never"}
              </span>
            </span>
          </span>
        </button>
        <div className="flex shrink-0 flex-wrap gap-2 pl-7 sm:pl-8 lg:pl-0">
          <button type="button" disabled={disabled} onClick={onRun} className="rounded-lg bg-violet-700 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-800 disabled:opacity-50">
            {busy ? "Starting…" : "Run Test"}
          </button>
          {testCase.history.length > 0 && (
            <button type="button" onClick={onViewRuns} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              View Runs ({testCase.history.length})
            </button>
          )}
          {needsRepair && (
            <button type="button" disabled={disabled} onClick={onRepair} className="rounded-lg bg-orange-100 px-3 py-2 text-xs font-semibold text-orange-800 hover:bg-orange-200 disabled:opacity-50">
              Repair Automation
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div id={`test-case-details-${testCase.testCaseId}`} className="space-y-6 border-t border-slate-200 bg-slate-50 p-4 sm:p-6">
          <TestCaseDetails testCase={testCase} />
          <section>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">Automation</h3>
                <p className="mt-1 text-sm text-slate-600">
                  {testCase.automationStatus}
                  {testCase.scriptVersion ? ` · Version ${testCase.scriptVersion}` : ""}
                  {testCase.lastHealingAt ? ` · Last repaired ${new Date(testCase.lastHealingAt).toLocaleString()}` : ""}
                </p>
              </div>
              {testCase.scriptAvailable && (
                <button type="button" disabled={disabled} onClick={onUpdateAutomation} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:opacity-50">
                  Update Automation
                </button>
              )}
            </div>
          </section>
          <ExecutionHistory testCase={testCase} storyUrl={storyUrl} savePageState={savePageState} currentPageUrl={currentPageUrl} />
        </div>
      )}
    </article>
  );
}

function TestCaseDetails({ testCase }: { testCase: AutomationTestCase }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="space-y-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Description</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{testCase.objective || "Not provided"}</p>
        </div>
        {testCase.acceptanceCriteriaIds.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Acceptance criteria</h3>
            <p className="mt-1 text-sm text-slate-800">{testCase.acceptanceCriteriaIds.join(", ")}</p>
          </div>
        )}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Preconditions</h3>
          {testCase.preconditions.length > 0 ? (
            <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-slate-800">
              {testCase.preconditions.map((precondition, index) => <li key={`${index}-${precondition}`}>{precondition}</li>)}
            </ul>
          ) : <p className="mt-1 text-sm text-slate-500">None specified</p>}
        </div>
      </section>
      <section className="space-y-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Test steps</h3>
          {testCase.steps.length > 0 ? (
            <ol className="mt-1 list-inside list-decimal space-y-1 text-sm text-slate-800">
              {testCase.steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}
            </ol>
          ) : <p className="mt-1 text-sm text-slate-500">No steps provided</p>}
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Expected result</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{testCase.expectedOutcome || "Not provided"}</p>
        </div>
        {testCase.testData && testCase.testData.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Test data</h3>
            <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
              {testCase.testData.map(({ name, value }) => (
                <Fragment key={name}>
                  <dt className="font-medium text-slate-600">{name}</dt>
                  <dd className="break-words text-slate-800">{String(value)}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
        )}
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-600">
          <span>Type: <strong className="capitalize">{testCase.type}</strong></span>
          <span>Priority: <strong className="capitalize">{testCase.priority}</strong></span>
          {testCase.automationFeasibility && <span>Automation: <strong>{testCase.automationFeasibility}</strong></span>}
        </div>
        {testCase.automationReason && <p className="text-xs text-slate-600"><strong>Automation notes:</strong> {testCase.automationReason}</p>}
      </section>
    </div>
  );
}

function ExecutionHistory({
  testCase,
  storyUrl,
  savePageState,
  currentPageUrl,
}: {
  testCase: AutomationTestCase;
  storyUrl: string;
  savePageState: (caseId?: string | null) => void;
  currentPageUrl: () => string;
}) {
  const router = useRouter();
  return (
    <section>
      <h3 className="text-sm font-bold text-slate-900">Execution history</h3>
      {testCase.history.length ? (
        <ol className="mt-3 space-y-2">
          {testCase.history.map((run, index) => (
            <li key={run.executionId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3">
              <div>
                <p className="text-sm font-semibold text-slate-800">
                  Run #{testCase.history.length - index} · {run.status === "passed" && run.testSource === "healed" ? "Healed & Passed" : executionLabel(run.status)}
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  {new Date(run.finishedAt ?? run.createdAt).toLocaleString()}
                  {run.error ? ` · ${run.error}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {run.evidence && Object.keys(run.evidence).map(name => (
                  <a
                    key={name}
                    href={executionArtifactUrl(run.executionId, name)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-medium text-blue-700 hover:underline"
                  >
                    {name.toLowerCase().includes("screenshot") ? "View screenshot" : `View ${name}`}
                  </a>
                ))}
                <Link
                  href={executionHref(run.executionId, storyUrl)}
                  onClick={event => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
                      savePageState(testCase.testCaseId);
                      return;
                    }
                    event.preventDefault();
                    savePageState(testCase.testCaseId);
                    router.push(executionHref(run.executionId, currentPageUrl()));
                  }}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Open run
                </Link>
              </div>
            </li>
          ))}
        </ol>
      ) : <p className="mt-2 text-sm text-slate-500">No runs yet.</p>}
    </section>
  );
}

function currentPageUrl(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function executionHref(executionId: string, returnTo: string): string {
  return `/executions/${encodeURIComponent(executionId)}?returnTo=${encodeURIComponent(returnTo)}`;
}

function executionArtifactUrl(executionId: string, artifactName: string): string {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";
  return `${apiBase}/api/executions/${encodeURIComponent(executionId)}/artifacts/${encodeURIComponent(artifactName)}`;
}
