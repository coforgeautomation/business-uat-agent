import type { ExecutionJob } from "../controllers/executionController.js";
import { getExecutionJob, listQueuedExecutionJobs } from "../controllers/executionController.js";
import { runExecutionWorker } from "./executionWorker.js";

export class ExecutionQueue {
  private readonly pending: ExecutionJob[] = [];
  private readonly known = new Set<string>();
  private readonly waiters = new Map<string, { resolve: (job: ExecutionJob) => void; reject: (error: Error) => void }>();
  private active = 0;

  constructor(readonly concurrency = configuredConcurrency()) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("EXECUTION_QUEUE_CONCURRENCY must be a positive integer");
    }
  }

  async restorePending(): Promise<void> {
    const jobs = await listQueuedExecutionJobs();
    for (const job of jobs) this.enqueue(job);
  }

  enqueue(job: ExecutionJob): void {
    if (this.known.has(job.executionId)) return;
    this.known.add(job.executionId);
    this.pending.push(job);
    this.drain();
  }

  enqueueAndWait(job: ExecutionJob): Promise<ExecutionJob> {
    return new Promise((resolve, reject) => {
      this.waiters.set(job.executionId, { resolve, reject });
      this.enqueue(job);
    });
  }

  get queuedCount() { return this.pending.length; }
  get activeCount() { return this.active; }
  isKnown(executionId: string) { return this.known.has(executionId); }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const job = this.pending.shift()!;
      this.active += 1;
      void runExecutionWorker(job)
        .catch(error => {
          console.error(`Execution worker failed for ${job.executionId}:`, error);
        })
        .finally(() => {
          this.active -= 1;
          this.known.delete(job.executionId);
          const waiter = this.waiters.get(job.executionId);
          if (waiter) {
            this.waiters.delete(job.executionId);
            void getExecutionJob(job.executionId).then(completed => {
              if (completed) waiter.resolve(completed);
              else waiter.reject(new Error(`Completed execution ${job.executionId} was not saved`));
            }).catch(error => {
              waiter.reject(error instanceof Error ? error : new Error(String(error)));
              console.error(`Could not read completed execution ${job.executionId}:`, error);
            });
          }
          this.drain();
        });
    }
  }
}

function configuredConcurrency(): number {
  const raw = process.env.EXECUTION_QUEUE_CONCURRENCY ?? "1";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("EXECUTION_QUEUE_CONCURRENCY must be a positive integer");
  }
  return value;
}
