import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { renameWithRetry } from "../../domain/src/atomicFile.js";
import { LocatorDescriptorSchema, type LocatorDescriptor } from "../schemas/locator.schema.js";

const RecordSchema = z.object({
  key: z.string().min(1),
  app: z.string().min(1),
  page: z.string().min(1),
  target: z.string().min(1),
  locator: LocatorDescriptorSchema,
  verifiedAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().optional(),
  reuseCount: z.number().int().nonnegative().default(0),
  missCount: z.number().int().nonnegative().default(0),
  repairCount: z.number().int().nonnegative().default(0),
  failureCount: z.number().int().nonnegative().default(0),
  status: z.enum(["verified", "needs_revalidation", "unresolved"]).default("verified"),
  evidence: z.string().optional(),
}).strict();

const StoreSchema = z.object({ version: z.literal(1), records: z.record(z.string(), RecordSchema) }).strict();
export type LocatorRecord = z.infer<typeof RecordSchema>;
export type LocatorMetrics = {
  locatorCount: number; verifiedCount: number; reuseCount: number;
  missCount: number; repairCount: number; failureCount: number;
};

let registryWriteTail = Promise.resolve();

/** Persistent, semantic locator catalog. MCP ref IDs must never be stored in it. */
export class LocatorRegistry {
  constructor(private readonly file = "output/automation/locator-registry/etihad.json") {}

  static key(app: string, page: string, target: string): string {
    return [app, page, target].map(normalizeKeyPart).join(".");
  }

  async get(key: string): Promise<LocatorRecord | undefined> {
    const store = await this.load();
    const record = store.records[key];
    if (!record || record.status !== "verified") return undefined;
    return record;
  }

  /** Call only after the retrieved locator has been revalidated on the live page. */
  async recordReuse(key: string): Promise<void> {
    await this.update(store => {
      const record = store.records[key];
      if (!record || record.status !== "verified") throw new Error(`Cannot count reuse for unverified locator: ${key}`);
      record.reuseCount += 1;
      record.lastUsedAt = new Date().toISOString();
    });
  }

  async getByTarget(app: string, page: string, target: string) {
    return this.get(LocatorRegistry.key(app, page, target));
  }

  async upsert(input: {
    app: string; page: string; target: string; locator: LocatorDescriptor;
    evidence?: string; repaired?: boolean;
  }): Promise<LocatorRecord> {
    const locator = LocatorDescriptorSchema.parse(input.locator);
    let updated!: LocatorRecord;
    await this.update(store => {
      const key = LocatorRegistry.key(input.app, input.page, input.target);
      const previous = store.records[key];
      updated = RecordSchema.parse({
        key, app: input.app, page: input.page, target: input.target, locator,
        verifiedAt: new Date().toISOString(), lastUsedAt: previous?.lastUsedAt,
        reuseCount: previous?.reuseCount ?? 0, missCount: previous?.missCount ?? 0,
        repairCount: (previous?.repairCount ?? 0) + (input.repaired ? 1 : 0),
        failureCount: previous?.failureCount ?? 0, status: "verified", evidence: input.evidence,
      });
      store.records[key] = updated;
    });
    return updated;
  }

  async recordMiss(app: string, page: string, target: string): Promise<void> {
    await this.update(store => {
      const key = LocatorRegistry.key(app, page, target);
      const previous = store.records[key];
      if (previous) previous.missCount += 1;
      else store.records[key] = RecordSchema.parse({
        key, app, page, target,
        locator: { strategy: "text", value: target, exact: true },
        verifiedAt: new Date().toISOString(), missCount: 1, status: "unresolved",
      });
    });
  }

  async recordFailure(key: string): Promise<void> {
    await this.update(store => {
      const record = store.records[key];
      if (!record) return;
      record.failureCount += 1;
      record.status = "needs_revalidation";
    });
  }

  async markRepaired(key: string, locator: LocatorDescriptor, evidence: string): Promise<void> {
    const parsedLocator = LocatorDescriptorSchema.parse(locator);
    await this.update(store => {
      const previous = store.records[key];
      if (!previous) throw new Error(`Cannot repair unknown locator key: ${key}`);
      store.records[key] = RecordSchema.parse({
        ...previous,
        locator: parsedLocator,
        verifiedAt: new Date().toISOString(),
        repairCount: previous.repairCount + 1,
        status: "verified",
        evidence,
      });
    });
  }

  async list(filter: { app?: string; page?: string } = {}): Promise<LocatorRecord[]> {
    const store = await this.load();
    return Object.values(store.records).filter(record =>
      (!filter.app || record.app === filter.app) && (!filter.page || record.page === filter.page));
  }

  async metrics(): Promise<LocatorMetrics> {
    const records = Object.values((await this.load()).records);
    return {
      locatorCount: records.length,
      verifiedCount: records.filter(record => record.status === "verified").length,
      reuseCount: sum(records, "reuseCount"), missCount: sum(records, "missCount"),
      repairCount: sum(records, "repairCount"), failureCount: sum(records, "failureCount"),
    };
  }

  private async load(): Promise<z.infer<typeof StoreSchema>> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, "utf8"));
      return StoreSchema.parse(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, records: {} };
      throw new Error(`Locator registry is unreadable or invalid (${this.file}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async save(store: z.infer<typeof StoreSchema>) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tempFile = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempFile, JSON.stringify(store, null, 2), "utf8");
      await renameWithRetry(tempFile, this.file);
    } catch (error) {
      await unlink(tempFile).catch(cleanupError => {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
      });
      throw error;
    }
  }

  private async update(mutator: (store: z.infer<typeof StoreSchema>) => void): Promise<void> {
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const previous = registryWriteTail;
    registryWriteTail = previous.then(() => next);
    await previous;
    try {
      const store = await this.load();
      mutator(store);
      await this.save(store);
    } finally {
      release();
    }
  }
}

function normalizeKeyPart(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function sum(records: LocatorRecord[], key: "reuseCount" | "missCount" | "repairCount" | "failureCount") {
  return records.reduce((total, record) => total + record[key], 0);
}
