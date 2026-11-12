import { Suspense } from "react";
import ApprovedTestCases from "./TestCases";

export default async function TestCasesPage({
  params,
}: {
  params: Promise<{ storyId: string }>;
}) {
  return (
    <Suspense fallback={<main className="min-h-screen bg-slate-50 p-8 text-slate-600">Loading test cases…</main>}>
      <TestCasesContent params={params} />
    </Suspense>
  );
}

async function TestCasesContent({
  params,
}: {
  params: Promise<{ storyId: string }>;
}) {
  const { storyId } = await params;
  return <ApprovedTestCases storyId={storyId} />;
}
