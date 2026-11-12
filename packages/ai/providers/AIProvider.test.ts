import assert from "node:assert/strict";
import { test } from "node:test";
import { AIProvider } from "./AIProvider.js";

test("aborts AI requests that exceed the configured timeout", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnvironment = {
    API_URL: process.env.API_URL,
    API_KEY: process.env.API_KEY,
    MODEL_NAME: process.env.MODEL_NAME,
    AI_REQUEST_TIMEOUT_MS: process.env.AI_REQUEST_TIMEOUT_MS,
    PLANNING_TIMEOUT_MS: process.env.PLANNING_TIMEOUT_MS,
  };
  process.env.API_URL = "https://ai.example.test";
  process.env.API_KEY = "test-key";
  process.env.MODEL_NAME = "test-model";
  process.env.AI_REQUEST_TIMEOUT_MS = "5";
  delete process.env.PLANNING_TIMEOUT_MS;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })) as typeof fetch;

  try {
    await assert.rejects(
      new AIProvider().chat([{ role: "user", content: "test" }]),
      /Coforge AI request timed out after 5ms/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
