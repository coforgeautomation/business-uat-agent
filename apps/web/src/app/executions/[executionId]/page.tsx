import { Suspense } from "react";
import ExecutionDashboard from "./ExecutionDashboard";

export default async function ExecutionPage({
  params,
  searchParams,
}: {
  params: Promise<{ executionId: string }>;
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  return (
    <Suspense fallback={<main className="min-h-screen bg-slate-50 p-8 text-slate-600 dark:bg-slate-950 dark:text-slate-300">Loading execution…</main>}>
      <ExecutionPageContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function ExecutionPageContent({
  params,
  searchParams,
}: {
  params: Promise<{ executionId: string }>;
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const [{ executionId }, query] = await Promise.all([params, searchParams]);
  const returnTo = Array.isArray(query.returnTo) ? query.returnTo[0] : query.returnTo;
  return <ExecutionDashboard executionId={executionId} returnTo={returnTo} />;
}
