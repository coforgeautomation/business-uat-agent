"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { getExecutionStatus, type ExecutionCaseResult, type ExecutionJob } from "@/lib/api";
import ExecutionProgressBar from "@/components/execution/ExecutionProgressBar";
import ExecutionSummary from "@/components/execution/ExecutionSummary";
import TestCaseAccordion from "@/components/execution/TestCaseAccordion";

const terminalStatuses = new Set(["passed", "failed", "blocked"]);

function elapsed(startedAt?: string, now = Date.now(), finishedAt?: string) {
  if (!startedAt) return "—";
  const seconds = Math.max(0, Math.floor(((finishedAt ? Date.parse(finishedAt) : now) - Date.parse(startedAt)) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusBadge(status: ExecutionJob["status"]) {
  if (status === "passed") return "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300";
  if (status === "failed") return "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300";
  if (status === "blocked") return "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300";
  if (status === "executing" || status === "planning") return "bg-yellow-100 text-yellow-900 dark:bg-yellow-950 dark:text-yellow-300";
  return "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
}

export default function ExecutionDashboard({
  executionId,
  returnTo,
}: {
  executionId: string;
  returnTo?: string;
}) {
  const [job, setJob] = useState<ExecutionJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [manuallyExpanded, setManuallyExpanded] = useState<string | null>(null);
  const observationsEndRef = useRef<HTMLDivElement>(null);
  const lastCurrentCaseRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const current = await getExecutionStatus(executionId);
      setJob(current);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }, [executionId]);

  useEffect(() => {
    void refresh();
    const pollId = window.setInterval(() => {
      if (!job || !terminalStatuses.has(job.status)) void refresh();
    }, 1200);
    return () => window.clearInterval(pollId);
  }, [refresh, job?.status]);

  useEffect(() => {
    const clockId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clockId);
  }, []);

  const progress = job?.progress;
  const resultSummary = job?.result as {
    storyTitle?: string;
    totals?: { total: number; passed: number; failed: number; blocked: number };
    results?: ExecutionCaseResult[];
  } | undefined;
  const cases = useMemo(() => {
    const byId = new Map<string, ExecutionCaseResult>();
    for (const testCase of progress?.cases ?? []) byId.set(testCase.testCaseId, testCase);
    if (progress?.currentCase) byId.set(progress.currentCase.testCaseId, progress.currentCase);
    const completed = resultSummary?.results ?? [];
    for (const testCase of completed) {
      if (!byId.has(testCase.testCaseId)) byId.set(testCase.testCaseId, testCase);
    }
    return [...byId.values()];
  }, [progress?.cases, progress?.currentCase, resultSummary?.results]);

  const currentId = progress?.currentCase &&
    (progress.currentCase.status === "planning" || progress.currentCase.status === "executing")
    ? progress.currentCase.testCaseId
    : undefined;

  useEffect(() => {
    if (currentId !== lastCurrentCaseRef.current) {
      setManuallyExpanded(null);
      lastCurrentCaseRef.current = currentId;
    }
  }, [currentId]);

  useEffect(() => {
    observationsEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [progress?.observation.length]);

  if (!job && error) {
    return (
      <main className="min-h-screen bg-slate-50 p-6 dark:bg-slate-950">
        <div className="mx-auto max-w-4xl rounded-2xl border border-red-200 bg-white p-8 dark:border-red-900 dark:bg-slate-900">
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">Could not load execution</h1>
          <p className="mt-2 text-sm text-red-700 dark:text-red-300">{error}</p>
          <Link href={safeReturnPath(returnTo) ?? "/"} className="mt-5 inline-block text-sm font-semibold text-blue-700 dark:text-blue-300">
            Return to {safeReturnPath(returnTo) ? "Test Cases" : "dashboard"}
          </Link>
        </div>
      </main>
    );
  }

  function safeReturnPath(value?: string): string | undefined {
    if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return undefined;
    try {
      const parsed = new URL(value, "http://localhost");
      if (parsed.origin !== "http://localhost") return undefined;
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return undefined;
    }
  }
  if (!job) return <main className="min-h-screen bg-slate-50 p-8 text-slate-600 dark:bg-slate-950 dark:text-slate-300">Loading execution…</main>;

  const total = progress?.totalCases ?? resultSummary?.totals?.total ?? cases.length;
  const completed = progress?.completedCases ?? (resultSummary?.totals
    ? resultSummary.totals.passed + resultSummary.totals.failed + resultSummary.totals.blocked
    : cases.filter(testCase => terminalStatuses.has(testCase.status)).length);
  const terminal = terminalStatuses.has(job.status);
  const observations = progress?.observation ?? [];
  const returnPath = safeReturnPath(returnTo) ??
    (job.storyId && job.testCaseId
      ? `/stories/${encodeURIComponent(job.storyId)}/test-cases`
      : "/");
  const backLabel = returnPath.startsWith("/stories/") ? "Test Cases" : "Sprint dashboard";

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <div className="mx-auto max-w-[1500px] space-y-6 p-4 sm:p-6 lg:p-8">
        <Link href={returnPath} className="inline-flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-blue-700 dark:text-slate-400 dark:hover:text-blue-300">
          <span aria-hidden="true">←</span> Back to {backLabel}
        </Link>

        <header className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7 dark:border-slate-700 dark:bg-slate-900">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-700 dark:text-blue-300">Autonomous UAT execution</p>
              <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
                {job.storyId} <span className="text-slate-400">·</span> {progress?.storyTitle ?? resultSummary?.storyTitle ?? "Story execution"}
              </h1>
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">Execution ID: <span className="font-mono">{job.executionId}</span></p>
            </div>
            <span className={`inline-flex w-fit items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold uppercase ${statusBadge(job.status)}`}>
              {!terminal && <span className="h-2 w-2 animate-pulse rounded-full bg-current" />}
              {job.status}
            </span>
          </div>

          <div className="mt-7 grid gap-5 border-t border-slate-100 pt-5 sm:grid-cols-3 dark:border-slate-800">
            <div><p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Started</p><p className="mt-1 text-sm font-medium">{job.startedAt ? new Date(job.startedAt).toLocaleString() : "Waiting in queue"}</p></div>
            <div><p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Duration</p><p className="mt-1 text-sm font-medium">{elapsed(job.startedAt, now, job.finishedAt)}</p></div>
            <div><p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Current test case</p><p className="mt-1 text-sm font-medium">{currentId ?? (terminal ? "Execution complete" : "Preparing next case")}</p></div>
          </div>
          <div className="mt-6">
            <ExecutionProgressBar completed={completed} total={total} />
          </div>
        </header>

        {job.error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
            {job.error}
          </div>
        )}

        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <section className="space-y-4">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">Test case execution</h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">The active test opens automatically; completed tests are collapsed.</p>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400">{cases.length} visible</span>
            </div>
            {cases.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
                {job.status === "queued" ? "Waiting for an available execution worker…" : "Planning the story test cases…"}
              </div>
            ) : (
              cases.map(testCase => {
                const active = testCase.testCaseId === currentId;
                const expanded = active || manuallyExpanded === testCase.testCaseId;
                return (
                  <TestCaseAccordion
                    key={testCase.testCaseId}
                    testCase={testCase}
                    executionId={job.executionId}
                    expanded={expanded}
                    active={active}
                    onToggle={() => {
                      if (active) return;
                      setManuallyExpanded(current => current === testCase.testCaseId ? null : testCase.testCaseId);
                    }}
                  />
                );
              })
            )}
            {terminal && (
              <ExecutionSummary job={job} cases={cases} />
            )}
          </section>

          <aside className="space-y-4 xl:sticky xl:top-6">
            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
              <div className="border-b border-slate-100 p-4 dark:border-slate-800">
                <div className="flex items-center justify-between">
                  <h2 className="font-bold">AI observations</h2>
                  <span className="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-semibold uppercase text-blue-700 dark:bg-blue-950 dark:text-blue-300">Live</span>
                </div>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Evidence-backed actions and verification updates</p>
              </div>
              <div className="max-h-[420px] space-y-3 overflow-y-auto p-4" aria-live="polite">
                {observations.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400">Observations will appear as the worker plans and executes steps.</p>
                ) : observations.map((observation, index) => (
                  <div key={`${observation.timestamp}-${index}`} className="flex gap-3 text-sm">
                    <span className={
                      observation.status === "passed" ? "text-green-600 dark:text-green-400"
                        : observation.status === "failed" ? "text-red-600 dark:text-red-400"
                          : observation.status === "blocked" ? "text-amber-600 dark:text-amber-400"
                            : "text-yellow-600 dark:text-yellow-400"
                    } aria-hidden="true">
                      {observation.status === "passed" ? "✓" : observation.status === "failed" ? "×" : observation.status === "blocked" ? "!" : "◌"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-slate-700 dark:text-slate-200">{observation.text}</p>
                      <time className="mt-1 block text-[10px] text-slate-400" dateTime={observation.timestamp}>
                        {new Date(observation.timestamp).toLocaleTimeString()}
                      </time>
                    </div>
                  </div>
                ))}
                <div ref={observationsEndRef} />
              </div>
            </section>

            {progress?.currentCase?.evidence && (
              <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
                <h2 className="font-bold">Current case evidence</h2>
                <div className="mt-3 space-y-2 text-xs">
                  {Object.entries(progress.currentCase.evidence).map(([name, file]) => (
                    <p key={name} className="break-all text-slate-600 dark:text-slate-300"><strong>{name}:</strong> {file}</p>
                  ))}
                </div>
              </section>
            )}
          </aside>
        </div>
      </div>
    </main>
  );
}
