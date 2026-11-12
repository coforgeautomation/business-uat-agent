"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  generatePlan,
  getPlans,
  approveSprint,
  getJiraStatus,
  getSprintStories,
  getSprintContext,
  regenerateStory,
  getExcelExportUrl,
  getCreatedJiras,
} from "@/lib/api";

import StatCard from "@/components/StatCard";
import ReviewModal from "@/components/ReviewModal";

export default function HomePage() {
  const [sprintId, setSprintId] = useState("37");
  const [loading, setLoading] = useState(false);
  const [plans, setPlans] = useState<any[]>([]);
  const [jiraStatuses, setJiraStatuses] = useState<Record<string, any>>({});
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [sprintStories, setSprintStories] = useState<any[]>([]);
  const [loadingSprintStories, setLoadingSprintStories] = useState(false);
  const [sprintContext, setSprintContext] = useState<{
    previous: any;
    current: any;
    next: any;
  } | null>(null);
  const [loadingSprintContext, setLoadingSprintContext] = useState(false);
  const [reviewPlan, setReviewPlan] = useState<any>(null);
  const [createdJirasCount, setCreatedJirasCount] = useState(0);

  async function loadCreatedJirasCount() {
    try {
      const response = await getCreatedJiras();
      if (response.success) {
        setCreatedJirasCount(response.count || 0);
      }
    } catch (error) {
      console.error(error);
    }
  }

  async function loadSprintContext() {
    try {
      setLoadingSprintContext(true);
      const response = await getSprintContext();
      if (response.success) {
        setSprintContext({
          previous: response.previous,
          current: response.current,
          next: response.next,
        });
      }
    } catch (error) {
      console.error(error);
    } finally {
      setLoadingSprintContext(false);
    }
  }

  async function loadSprintStories(id: string) {
    try {
      setLoadingSprintStories(true);
      const response = await getSprintStories(Number(id));
      if (response.success) {
        setSprintStories(response.stories || []);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setLoadingSprintStories(false);
    }
  }

  function selectSprint(sprint: any) {
    if (!sprint) return;
    setSprintId(String(sprint.id));
    loadSprintStories(String(sprint.id));
  }

  async function loadPlans() {
    try {
      const response = await getPlans();
      setPlans(response.stories || []);
    } catch (error) {
      console.error(error);
    }
  }

  async function checkJiraStatus(id: string) {
    try {
      const response = await getJiraStatus(Number(id));
      if (response.success) {
        const byStoryId: Record<string, any> = {};
        for (const status of response.statuses) {
          byStoryId[status.storyId] = status;
        }
        setJiraStatuses(byStoryId);
      }
    } catch (error) {
      console.error(error);
    }
  }

  useEffect(() => {
    loadPlans();
    loadCreatedJirasCount();

    // If we just came from creating a Jira, jump straight to its sprint.
    const focusSprintId = sessionStorage.getItem("focusSprintId");
    if (focusSprintId) {
      sessionStorage.removeItem("focusSprintId");
      setSprintId(focusSprintId);
      loadSprintStories(focusSprintId);
    }

    loadSprintContext();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (plans.length > 0 && sprintId) {
      checkJiraStatus(sprintId);
    }
  }, [plans.length, sprintId]);

  // Periodically re-check Jira for story updates so drift is detected without a manual reload.
  useEffect(() => {
    if (plans.length === 0 || !sprintId) return;

    const intervalId = setInterval(
      () => checkJiraStatus(sprintId),
      5 * 60 * 1000,
    );

    return () => clearInterval(intervalId);
  }, [plans.length, sprintId]);

  async function handleGenerate() {
    try {
      setLoading(true);
      // Sync Jira data for the sprint first so generation reads from the cached file (fast).
      await loadSprintStories(sprintId);
      const result = await generatePlan(Number(sprintId));
      setPlans(result.plans || []);
    } catch (error) {
      console.error(error);
      alert("Plan generation failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleRegenerate(storyId: string) {
    try {
      setRegeneratingId(storyId);
      const result = await regenerateStory(Number(sprintId), storyId);
      setPlans(result.plans || []);
      await checkJiraStatus(sprintId);
    } catch (error) {
      console.error(error);
      alert("Regenerate failed");
    } finally {
      setRegeneratingId(null);
    }
  }

  async function handlePublishSprint() {
    try {
      setPublishing(true);
      const result = await approveSprint();
      if (result.success) {
        alert("Sprint Plan Published Successfully");
      }
    } catch (error) {
      console.error(error);
      alert("Publish Failed");
    } finally {
      setPublishing(false);
    }
  }

  // Merge raw Jira stories (for the selected sprint) with their generated test plans,
  // keyed by story/Jira key. Only stories synced for this sprint are included, so
  // plans left over from a different sprint don't leak into this sprint's view.
  const combinedStories = sprintStories.map((story) => ({
    ...story,
    plan: plans.find((p) => p.storyId === story.key) ?? null,
  }));

  const scopedPlans = combinedStories
    .map((s) => s.plan)
    .filter((p): p is any => Boolean(p));

  const allStoriesApproved =
    scopedPlans.length > 0 && scopedPlans.every((p) => p.status === "approved");

  const approvedCount = scopedPlans.filter((p) => p.status === "approved").length;
  const openClarificationsCount = scopedPlans.reduce(
    (sum, p) => sum + (p.clarifications?.length || 0),
    0,
  );
  const jiraDriftCount = scopedPlans.filter(
    (p) => jiraStatuses[p.storyId]?.changed,
  ).length;

  const plansWithCoverage = scopedPlans.filter(
    (p) => typeof p.coverage?.coveragePercentage === "number",
  );
  const avgCoveragePercentage =
    plansWithCoverage.length > 0
      ? Math.round(
          plansWithCoverage.reduce(
            (sum, p) => sum + p.coverage.coveragePercentage,
            0,
          ) / plansWithCoverage.length,
        )
      : null;

  function handlePlanUpdated(updatedPlan: any) {
    setPlans((prev) =>
      prev.map((p) => (p.storyId === updatedPlan.storyId ? updatedPlan : p)),
    );
    setReviewPlan((current: any) => ({
      ...updatedPlan,
      description: current?.description ?? "",
    }));
  }

  function handlePlanApproved() {
    setReviewPlan(null);
    loadPlans();
  }

  return (
    <main className="min-h-screen">
      <header className="bg-white border-b border-slate-200 px-8 py-6">
        <h1 className="text-2xl font-bold text-slate-800">Sprint Dashboard</h1>
        <p className="text-sm text-slate-500 mt-1">
          Generate, review, and publish AI-powered UAT test plans from Jira sprints.
        </p>
      </header>

      <div className="w-full px-8 py-8">
        {/* Stats + Sprint Controls combined */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <div className="grid grid-cols-2 md:grid-cols-6 gap-5">
            <StatCard label="Total Stories" value={combinedStories.length} accent="slate" />
            <StatCard label="Approved" value={approvedCount} accent="green" />
            <StatCard
              label="Open Clarifications"
              value={openClarificationsCount}
              accent="yellow"
            />
            <StatCard
              label="Jira Changes Detected"
              value={jiraDriftCount}
              accent="blue"
            />
            <StatCard
              label="Jira Created (AI)"
              value={createdJirasCount}
              accent="blue"
            />
            <StatCard
              label="Avg Test Coverage"
              value={avgCoveragePercentage !== null ? `${avgCoveragePercentage}%` : "-"}
              accent="blue"
            />
          </div>

          <div className="flex items-center justify-between mt-6 pt-6 border-t border-slate-100 mb-4">
            <h2 className="text-lg font-bold text-slate-800">Sprint Controls</h2>
            {(loadingSprintContext || loadingSprintStories) && (
              <span className="text-xs text-slate-400">Syncing...</span>
            )}
          </div>

          {sprintContext ? (
            <div className="flex flex-wrap gap-3">
              {[
                { key: "previous", label: "← Previous Sprint", sprint: sprintContext.previous },
                { key: "current", label: "Current Sprint", sprint: sprintContext.current },
                { key: "next", label: "Next Sprint →", sprint: sprintContext.next },
              ].map(({ key, label, sprint }) => {
                const isSelected = sprint && String(sprint.id) === sprintId;
                return (
                  <button
                    key={key}
                    disabled={!sprint}
                    onClick={() => selectSprint(sprint)}
                    className={`text-left px-4 py-3 rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      isSelected
                        ? "bg-blue-600 border-blue-600 text-white"
                        : "bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100"
                    }`}
                  >
                    <p className="text-xs font-semibold uppercase tracking-wide opacity-80">
                      {label}
                    </p>
                    <p className="font-medium mt-1">
                      {sprint ? sprint.name : "Not Available"}
                    </p>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              {loadingSprintContext ? "Loading sprints..." : "Unable to load sprints."}
            </p>
          )}
        </div>

        {/* Sprint Stories (Jira details + generated test plan combined) */}
        <div className="mt-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-slate-800">
              Sprint Stories {sprintId && `(Sprint ${sprintId})`}
            </h2>

            <button
              onClick={handleGenerate}
              disabled={loading}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              <span aria-hidden="true">{scopedPlans.length > 0 ? "🔄" : "✨"}</span>
              {loading
                ? "Generating..."
                : scopedPlans.length > 0
                  ? "Regenerate Plan"
                  : "Generate Plan"}
            </button>
          </div>

          {combinedStories.length === 0 ? (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 text-sm text-slate-500">
              Click a sprint above to view its Jira stories, or generate a plan.
            </div>
          ) : (
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead>
                  <tr className="text-slate-500 border-b border-slate-200">
                    <th className="py-3 px-4">Story</th>
                    <th className="py-3 px-4">Jira Updated</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Version</th>
                    <th className="py-3 px-4">Coverage</th>
                    <th className="py-3 px-4">Test Cases</th>
                    <th className="py-3 px-4">Clarifications</th>
                    <th className="py-3 px-4">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {combinedStories.map((story) => {
                    const plan = story.plan;
                    const jiraStatus = plan ? jiraStatuses[plan.storyId] : null;

                    return (
                      <tr key={story.key} className="border-b border-slate-100 align-top">
                        <td className="py-3 px-4">
                          <p className="font-bold text-slate-800">
                            {story.key} — {plan?.title ?? story.summary}
                          </p>
                          <div className="flex gap-1 mt-1">
                            {story.isNew && (
                              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                                New
                              </span>
                            )}
                            {!story.inSprint && (
                              <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
                                Removed
                              </span>
                            )}
                          </div>
                          {jiraStatus?.changed && (
                            <div className="mt-2 p-2 rounded-lg bg-orange-50 border border-orange-200 text-orange-800 text-xs max-w-sm">
                              ⚠ Jira updated on{" "}
                              {new Date(jiraStatus.currentJiraUpdatedAt).toLocaleString()} since
                              generation.
                              <button
                                onClick={() => handleRegenerate(story.key)}
                                disabled={regeneratingId === story.key}
                                className="ml-2 underline font-semibold disabled:opacity-60"
                              >
                                {regeneratingId === story.key ? "Regenerating..." : "Regenerate"}
                              </button>
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-600 whitespace-nowrap">
                          {new Date(story.updated).toLocaleString()}
                        </td>
                        <td className="py-3 px-4">
                          {plan ? (
                            <span
                              className={`text-xs font-semibold px-3 py-1 rounded-full whitespace-nowrap ${
                                plan.status === "approved"
                                  ? "bg-green-100 text-green-700"
                                  : plan.status === "updated"
                                    ? "bg-yellow-100 text-yellow-700"
                                    : "bg-blue-100 text-blue-700"
                              }`}
                            >
                              {plan.status === "approved"
                                ? "Approved"
                                : plan.status === "updated"
                                  ? "Ready For Approval"
                                  : "In Review"}
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400">No plan yet</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-600">
                          {plan ? `v${plan.version || 1}` : "-"}
                        </td>
                        <td className="py-3 px-4">
                          {plan && typeof plan.coverage?.coveragePercentage === "number" ? (
                            <span
                              className={`text-xs font-semibold px-3 py-1 rounded-full whitespace-nowrap ${
                                plan.coverage.coveragePercentage >= 80
                                  ? "bg-green-100 text-green-700"
                                  : plan.coverage.coveragePercentage >= 50
                                    ? "bg-yellow-100 text-yellow-700"
                                    : "bg-red-100 text-red-700"
                              }`}
                            >
                              {plan.coverage.coveragePercentage}%
                            </span>
                          ) : (
                            <span className="text-xs text-slate-400">-</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-600">
                          {plan ? plan.testCases?.length || 0 : "-"}
                        </td>
                        <td className="py-3 px-4 text-slate-600">
                          {plan ? plan.clarifications?.length || 0 : "-"}
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex flex-wrap gap-2">
                            {!plan ? (
                              <button
                                onClick={() => handleRegenerate(story.key)}
                                disabled={regeneratingId === story.key}
                                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                              >
                                {regeneratingId === story.key ? "Generating..." : "Generate"}
                              </button>
                            ) : plan.status === "approved" ? (
                              <>
                                <Link
                                  href={`/stories/${encodeURIComponent(plan.storyId)}/test-cases`}
                                  className="bg-blue-100 hover:bg-blue-200 text-blue-700 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                                >
                                  View Test Cases
                                </Link>
                                <a
                                  href={getExcelExportUrl(plan.storyId)}
                                  className="bg-green-100 hover:bg-green-200 text-green-700 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                                >
                                  Download Excel
                                </a>
                              </>
                            ) : (
                              <>
                                <button
                                  onClick={() =>
                                    setReviewPlan({
                                      ...plan,
                                      description: story.description ?? "",
                                    })
                                  }
                                  className="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                                >
                                  Open Review
                                </button>
                                <a
                                  href={getExcelExportUrl(plan.storyId)}
                                  className="bg-green-100 hover:bg-green-200 text-green-700 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                                >
                                  Download Excel
                                </a>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Sprint Publish */}
        {allStoriesApproved && (
          <div className="mt-8 bg-green-50 border border-green-200 p-6 rounded-xl">
            <h3 className="text-lg font-bold text-green-800">✅ All stories approved</h3>
            <p className="mt-2 text-green-700">Sprint is ready to be published.</p>

            <button
              onClick={handlePublishSprint}
              disabled={publishing}
              className="mt-4 bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white px-5 py-3 rounded-lg font-medium transition-colors"
            >
              {publishing ? "Publishing..." : "Publish Sprint Plan"}
            </button>
          </div>
        )}
      </div>

      {reviewPlan && (
        <ReviewModal
          plan={reviewPlan}
          onClose={() => setReviewPlan(null)}
          onUpdated={handlePlanUpdated}
          onApproved={handlePlanApproved}
        />
      )}
    </main>
  );
}