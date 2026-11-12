"use client";

import { useState } from "react";
import { reviewTestCases } from "@/lib/api";

const APPROVAL_THRESHOLD_PERCENT = 70;

function formatDescription(description: string) {
  const normalized = description
    .replace(/\r\n/g, "\n")
    .replace(/^Description(?=\S)/i, "Description\n")
    .replace(/\n?Acceptance Criteria\s*:/gi, "\n\nAcceptance Criteria:\n")
    .trim();

  return normalized
    .split(/\n{2,}/)
    .map((section) => {
      const lines = section
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const isAcceptanceCriteria = /^Acceptance Criteria:$/i.test(lines[0] ?? "");
      const items = (isAcceptanceCriteria ? lines.slice(1) : lines)
        .map((line) => line.replace(/^[-*•]\s*/, "").trim())
        .filter(Boolean);

      return {
        heading: isAcceptanceCriteria ? "Acceptance Criteria" : null,
        items,
        isList: isAcceptanceCriteria || lines.every((line) => /^[-*•]\s+/.test(line)),
      };
    })
    .filter((section) => section.items.length > 0);
}

export default function ReviewModal({
  plan,
  onClose,
  onUpdated,
  onApproved,
}: {
  plan: any;
  onClose: () => void;
  onUpdated: (updatedPlan: any) => void;
  onApproved: () => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState("");
  const [loading, setLoading] = useState(false);
  const [approving, setApproving] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [reviewingIds, setReviewingIds] = useState<Set<string>>(new Set());
  const [bulkReviewing, setBulkReviewing] = useState(false);

  const testCases = plan.testCases ?? [];
  const approvedCount = testCases.filter(
    (tc: any) => tc.reviewStatus === "approved",
  ).length;
  const totalTestCases = testCases.length;
  const approvedPercentage =
    totalTestCases > 0 ? Math.round((approvedCount / totalTestCases) * 100) : 0;
  const readyToMove = approvedPercentage > APPROVAL_THRESHOLD_PERCENT;

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(testCases.map((tc: any) => tc.id)));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function reviewOne(testCaseId: string, action: "approve" | "reject") {
    try {
      setReviewingIds((prev) => new Set(prev).add(testCaseId));
      const result = await reviewTestCases(plan.storyId, [testCaseId], action);
      onUpdated(result.plan);
    } catch (error) {
      console.error(error);
      alert("Test Case Review Failed");
    } finally {
      setReviewingIds((prev) => {
        const next = new Set(prev);
        next.delete(testCaseId);
        return next;
      });
    }
  }

  async function reviewSelected(action: "approve" | "reject") {
    if (selectedIds.size === 0) return;
    try {
      setBulkReviewing(true);
      const result = await reviewTestCases(
        plan.storyId,
        Array.from(selectedIds),
        action,
      );
      onUpdated(result.plan);
      clearSelection();
    } catch (error) {
      console.error(error);
      alert("Test Case Review Failed");
    } finally {
      setBulkReviewing(false);
    }
  }

  async function submitReview() {
    try {
      setLoading(true);

      const response = await fetch("http://localhost:4000/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storyId: plan.storyId,
          version: plan.version || 1,
          answers,
          additionalFeedback: feedback,
          currentPlan: plan,
        }),
      });

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.message);
      }

      if (result.updatedPlan) {
        onUpdated(result.updatedPlan);
      }

      setAnswers({});
      setFeedback("");
    } catch (error) {
      console.error(error);
      alert("Failed To Update Plan");
    } finally {
      setLoading(false);
    }
  }

  async function approveStory() {
    try {
      setApproving(true);

      const response = await fetch("http://localhost:4000/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storyId: plan.storyId, currentPlan: plan }),
      });

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.message);
      }

      onApproved();
    } catch (error) {
      console.error(error);
      alert("Story Approval Failed");
    } finally {
      setApproving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-slate-100 rounded-2xl shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bg-white border-b border-slate-200 px-8 py-6 rounded-t-2xl flex items-start justify-between sticky top-0 z-10">
          <div>
            <h1 className="text-xl font-bold text-slate-800">{plan.title}</h1>
            <p className="text-sm text-slate-500 mt-1">Story ID: {plan.storyId}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-slate-400 hover:text-slate-600 text-2xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="p-8">
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
            <h2 className="text-lg font-bold text-slate-800">Story Description</h2>
            {plan.description ? (
              <div className="mt-4 space-y-5 text-sm text-slate-600">
                {formatDescription(plan.description).map((section, index) => (
                  <section key={`${section.heading ?? "description"}-${index}`}>
                    {section.heading && (
                      <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-800">
                        {section.heading}
                      </h3>
                    )}
                    {section.isList ? (
                      <ul className="list-disc space-y-2 pl-5">
                        {section.items.map((item, itemIndex) => (
                          <li key={`${index}-${itemIndex}`}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="whitespace-pre-line leading-7">
                        {section.items.join("\n")}
                      </p>
                    )}
                  </section>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-500">No description available.</p>
            )}
          </div>

          {/* Header */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex items-center justify-between">
            <div className="flex gap-8 text-sm text-slate-600">
              <span>
                <strong className="text-slate-800">Version:</strong> {plan.version || 1}
              </span>
              <span>
                <strong className="text-slate-800">Status:</strong> {plan.status || "draft"}
              </span>
            </div>

          </div>

          {/* Test Coverage */}
          {(plan.coverage || plan.coverageSummary) && (
            <div className="mt-6 bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-slate-800">Test Coverage</h2>
                {typeof plan.coverage?.coveragePercentage === "number" && (
                  <span
                    className={`text-sm font-semibold px-3 py-1 rounded-full ${
                      plan.coverage.coveragePercentage >= 80
                        ? "bg-green-100 text-green-700"
                        : plan.coverage.coveragePercentage >= 50
                          ? "bg-yellow-100 text-yellow-700"
                          : "bg-red-100 text-red-700"
                    }`}
                  >
                    {plan.coverage.coveragePercentage}% Covered
                  </span>
                )}
              </div>

              {typeof plan.coverage?.coveragePercentage === "number" && (
                <div className="w-full bg-slate-200 rounded-full h-2 mt-3">
                  <div
                    className={`h-2 rounded-full ${
                      plan.coverage.coveragePercentage >= 80
                        ? "bg-green-500"
                        : plan.coverage.coveragePercentage >= 50
                          ? "bg-yellow-500"
                          : "bg-red-500"
                    }`}
                    style={{ width: `${plan.coverage.coveragePercentage}%` }}
                  />
                </div>
              )}

              {(plan.coverage?.coverageSummary || plan.coverageSummary) && (
                <p className="text-sm text-slate-600 mt-3">
                  {plan.coverage?.coverageSummary || plan.coverageSummary}
                </p>
              )}

              {plan.coverage?.coverageReason && (
                <p className="text-sm text-slate-500 mt-2">{plan.coverage.coverageReason}</p>
              )}

              {(plan.coverage?.coveredAreas?.length > 0 ||
                plan.coverage?.missingAreas?.length > 0) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                  {plan.coverage?.coveredAreas?.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-slate-500 uppercase">
                        Covered Areas
                      </h4>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {plan.coverage.coveredAreas.map((area: string, index: number) => (
                          <span
                            key={index}
                            className="bg-green-50 text-green-700 text-xs px-2 py-1 rounded-full border border-green-200"
                          >
                            {area}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {plan.coverage?.missingAreas?.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold text-slate-500 uppercase">
                        Missing Areas
                      </h4>
                      <div className="flex flex-wrap gap-2 mt-2">
                        {plan.coverage.missingAreas.map((area: string, index: number) => (
                          <span
                            key={index}
                            className="bg-red-50 text-red-700 text-xs px-2 py-1 rounded-full border border-red-200"
                          >
                            {area}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Clarification Status */}
          {plan.clarifications?.length === 0 ? (
            <div className="mt-6 p-4 rounded-xl bg-green-50 border border-green-200 text-green-700 font-semibold">
              ✅ All Clarifications Resolved
            </div>
          ) : (
            <div className="mt-6 p-4 rounded-xl bg-yellow-50 border border-yellow-200 text-yellow-800 font-semibold">
              Open Clarifications: {plan.clarifications.length}
            </div>
          )}

          {/* Test Cases */}
          <div className="flex items-center justify-between mt-10">
            <h2 className="text-xl font-bold text-slate-800">Test Cases</h2>
            <div className="text-sm font-semibold">
              <span className={readyToMove ? "text-green-600" : "text-slate-500"}>
                {approvedCount}/{totalTestCases} approved ({approvedPercentage}%)
              </span>
              {readyToMove && (
                <span className="ml-2 bg-green-100 text-green-700 px-2 py-1 rounded-full text-xs">
                  Ready to move
                </span>
              )}
            </div>
          </div>

          <div className="w-full bg-slate-200 rounded-full h-2 mt-3">
            <div
              className={`h-2 rounded-full transition-all ${readyToMove ? "bg-green-500" : "bg-blue-500"}`}
              style={{ width: `${approvedPercentage}%` }}
            />
          </div>

          <div className="flex items-center justify-between mt-4 bg-white border border-slate-200 rounded-xl p-4">
            <div className="flex items-center gap-3 text-sm">
              <button
                onClick={selectAll}
                className="text-blue-600 font-medium hover:underline"
              >
                Select All
              </button>
              <button
                onClick={clearSelection}
                className="text-slate-500 font-medium hover:underline"
              >
                Clear
              </button>
              <span className="text-slate-500">{selectedIds.size} selected</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => reviewSelected("approve")}
                disabled={selectedIds.size === 0 || bulkReviewing}
                className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {bulkReviewing ? "Updating..." : "Approve Selected"}
              </button>
              <button
                onClick={() => reviewSelected("reject")}
                disabled={selectedIds.size === 0 || bulkReviewing}
                className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                {bulkReviewing ? "Updating..." : "Reject Selected"}
              </button>
            </div>
          </div>

          {testCases.map((tc: any) => {
            const isSelected = selectedIds.has(tc.id);
            const isReviewing = reviewingIds.has(tc.id);
            const reviewStatus = tc.reviewStatus ?? "pending";

            return (
            <div
              key={tc.id}
              className={`bg-white shadow-sm border rounded-xl p-5 mt-5 ${
                isSelected ? "border-blue-400 ring-2 ring-blue-100" : "border-slate-200"
              }`}
            >
              <div className="flex justify-between items-start gap-3">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelected(tc.id)}
                    className="mt-1.5 h-4 w-4"
                  />
                  <h3 className="font-bold text-lg text-slate-800">
                    {tc.id}
                    {" - "}
                    {tc.title}
                  </h3>
                </div>

                <div className="flex items-center gap-2">
                  <span
                    className={`text-xs font-semibold px-3 py-1 rounded-full whitespace-nowrap ${
                      reviewStatus === "approved"
                        ? "bg-green-100 text-green-700"
                        : reviewStatus === "rejected"
                          ? "bg-red-100 text-red-700"
                          : "bg-slate-100 text-slate-500"
                    }`}
                  >
                    {reviewStatus === "approved"
                      ? "Approved"
                      : reviewStatus === "rejected"
                        ? "Rejected"
                        : "Pending"}
                  </span>
                  <span className="bg-blue-100 text-blue-700 text-xs font-semibold px-3 py-1 rounded-full">
                    {tc.priority}
                  </span>
                </div>
              </div>

              <div className="mt-3 text-sm text-slate-600 space-y-1">
                <p>
                  <strong className="text-slate-800">Type:</strong> {tc.type}
                </p>
                <p>
                  <strong className="text-slate-800">Acceptance Criteria:</strong>{" "}
                  {tc.acceptanceCriteriaIds?.join(", ")}
                </p>
              </div>

              <div className="mt-4">
                <h4 className="font-semibold text-slate-800">Objective</h4>
                <p className="text-slate-600">{tc.objective}</p>
              </div>

              <div className="mt-4">
                <h4 className="font-semibold text-slate-800">Preconditions</h4>
                <ul className="list-disc ml-6 text-slate-600">
                  {tc.preconditions?.map((pre: string, index: number) => (
                    <li key={index}>{pre}</li>
                  ))}
                </ul>
              </div>

              <div className="mt-4">
                <h4 className="font-semibold text-slate-800">Steps</h4>
                <ol className="list-decimal ml-6 text-slate-600">
                  {tc.steps?.map((step: string, index: number) => (
                    <li key={index}>{step}</li>
                  ))}
                </ol>
              </div>

              <div className="mt-4">
                <h4 className="font-semibold text-slate-800">Expected Result</h4>
                <p className="text-slate-600">{tc.expectedOutcome}</p>
              </div>

              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => reviewOne(tc.id, "approve")}
                  disabled={isReviewing}
                  className="bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                >
                  {isReviewing ? "Updating..." : "Approve"}
                </button>
                <button
                  onClick={() => reviewOne(tc.id, "reject")}
                  disabled={isReviewing}
                  className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                >
                  {isReviewing ? "Updating..." : "Reject"}
                </button>
              </div>
            </div>
            );
          })}

          {/* Clarifications */}
          {plan.clarifications?.length > 0 && (
            <>
              <h2 className="text-xl font-bold mt-12 text-slate-800">Clarifications</h2>

              {plan.clarifications.map((cl: any) => (
                <div
                  key={cl.id}
                  className="border border-slate-200 rounded-xl bg-white shadow-sm mt-5 p-5"
                >
                  <h4 className="font-semibold text-slate-800">{cl.question}</h4>
                  <p className="mt-2 text-red-600">{cl.businessImpact}</p>

                  <textarea
                    rows={4}
                    className="w-full border border-slate-300 rounded-lg mt-4 p-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    value={answers[cl.id] || ""}
                    onChange={(e) =>
                      setAnswers((prev) => ({
                        ...prev,
                        [cl.id]: e.target.value,
                      }))
                    }
                  />
                </div>
              ))}
            </>
          )}

          {/* Feedback */}
          <h2 className="text-xl font-bold mt-12 text-slate-800">Additional Feedback</h2>

          <textarea
            rows={6}
            className="w-full border border-slate-300 rounded-lg mt-3 p-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />

          {/* Actions */}
          <div className="mt-10 flex gap-3 items-center">
            {plan.status === "approved" ? (
              <span className="text-green-600 font-semibold px-6 py-3">
                ✅ Story Approved
                {readyToMove && totalTestCases > 0 && " (auto-approved via test case threshold)"}
              </span>
            ) : plan.clarifications?.length > 0 ? (
              <button
                onClick={submitReview}
                disabled={loading}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white px-6 py-3 rounded-lg font-medium transition-colors"
              >
                {loading ? "Updating Plan..." : "Submit Review"}
              </button>
            ) : (
              <button
                onClick={approveStory}
                disabled={approving}
                className="bg-green-600 hover:bg-green-700 disabled:opacity-60 text-white px-6 py-3 rounded-lg font-medium transition-colors"
              >
                {approving ? "Approving..." : "Approve Story"}
              </button>
            )}

            <button
              onClick={onClose}
              className="bg-slate-200 hover:bg-slate-300 text-slate-700 px-6 py-3 rounded-lg font-medium transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
