import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __resetRateLimitStateForTest,
  accountSlug,
  codexAccountFromAuth,
  createRateLimitOptions,
  isRateLimitStreamEvent,
  rateLimitScores,
  readingFromHeaders,
  readingFromStreamEvent,
} from "../src/rate-limits.ts";
import { recordRateLimitsFromResponse, recordRateLimitsFromStreamEvent } from "../src/handlers/rate-limits.ts";
import { __setRuntimeForTest } from "../src/langfuse.ts";
import { state } from "../src/state.ts";
import type { LangfuseRuntime } from "../src/types.js";

// Captured from a Claude Max OAuth response (organization id replaced).
const CLAUDE_HEADERS = {
  "anthropic-organization-id": "00000000-1111-2222-3333-444444444444",
  "anthropic-ratelimit-unified-5h-reset": "1794321600",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.67",
  "anthropic-ratelimit-unified-7d-reset": "1794571200",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.36",
  "anthropic-ratelimit-unified-fallback": "available",
  "anthropic-ratelimit-unified-fallback-percentage": "0.5",
  "anthropic-ratelimit-unified-overage-disabled-reason": "org_level_disabled",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-reset": "1794321600",
  "anthropic-ratelimit-unified-status": "allowed",
  date: "Tue, 10 Nov 2026 13:08:45 GMT",
  "content-type": "text/event-stream",
};

// Captured from the Codex WebSocket transport (ChatGPT Plus).
const CODEX_EVENT = {
  type: "codex.rate_limits",
  plan_type: "plus",
  rate_limits: {
    allowed: true,
    limit_reached: false,
    primary: { used_percent: 0, window_minutes: 300, reset_after_seconds: 18000, reset_at: 1794334130 },
    secondary: { used_percent: 6, window_minutes: 10080, reset_after_seconds: 174439, reset_at: 1794490569 },
  },
  code_review_rate_limits: null,
  additional_rate_limits: null,
  credits: { has_credits: false, unlimited: false, balance: "0" },
  promo: null,
};

test.beforeEach(() => __resetRateLimitStateForTest());

test("Claude unified headers become 5h and 7d windows in percent", () => {
  const reading = readingFromHeaders(CLAUDE_HEADERS);
  assert.ok(reading);
  assert.equal(reading.provider, "claude");
  assert.equal(reading.accountId, "00000000-1111-2222-3333-444444444444");
  assert.equal(reading.binding, "5h");
  assert.equal(reading.status, "ok");
  assert.deepEqual(reading.windows, [
    { id: "5h", label: "5 hours", windowSeconds: 18000, usedPercent: 67, resetsAt: 1794321600, status: "ok" },
    { id: "7d", label: "7 days", windowSeconds: 604800, usedPercent: 36, resetsAt: 1794571200, status: "ok" },
  ]);
});

test("Claude rejected windows and extra weekly claims are kept", () => {
  const reading = readingFromHeaders({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-representative-claim": "seven_day",
    "anthropic-ratelimit-unified-7d-utilization": "1.01",
    "anthropic-ratelimit-unified-7d-status": "rejected",
    "anthropic-ratelimit-unified-7d-reset": "1794571200",
    "anthropic-ratelimit-unified-7d_oi-utilization": "0.5",
    "anthropic-ratelimit-unified-overage-utilization": "0.2",
  });
  assert.ok(reading);
  assert.equal(reading.binding, "7d");
  assert.deepEqual(reading.windows.map((w) => [w.id, w.usedPercent, w.status]), [
    ["7d", 101, "exhausted"],
    ["7d_oi", 50, undefined],
  ]);
});

test("Codex rate-limit event becomes windows named by their length", () => {
  assert.equal(isRateLimitStreamEvent(CODEX_EVENT), true);
  assert.equal(isRateLimitStreamEvent({ type: "response.output_text.delta" }), false);
  const reading = readingFromStreamEvent(CODEX_EVENT);
  assert.ok(reading);
  assert.equal(reading.provider, "codex");
  assert.equal(reading.plan, "plus");
  assert.equal(reading.status, "ok");
  assert.deepEqual(reading.windows, [
    { id: "5h", label: "5 hours", windowSeconds: 18000, usedPercent: 0, resetsAt: 1794334130, status: undefined },
    { id: "7d", label: "7 days", windowSeconds: 604800, usedPercent: 6, resetsAt: 1794490569, status: undefined },
  ]);
});

test("Codex headers cover extra limit families", () => {
  const reading = readingFromHeaders(
    {
      "x-codex-primary-used-percent": "42.5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1794334130",
      "x-codex-secondary-used-percent": "100",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-after-seconds": "100",
      "x-bengalfox-primary-used-percent": "3",
      "x-bengalfox-primary-window-minutes": "300",
      "x-bengalfox-limit-name": "gpt-5.2-codex-sonic",
      "x-codex-credits-has-credits": "false",
    },
    1_000,
  );
  assert.ok(reading);
  assert.deepEqual(reading.windows.map((w) => [w.id, w.label, w.usedPercent, w.resetsAt, w.status]), [
    ["5h", "5 hours", 42.5, 1794334130, undefined],
    ["bengalfox.5h", "gpt-5.2-codex-sonic 5h", 3, undefined, undefined],
    ["7d", "7 days", 100, 1100, "exhausted"],
  ]);
});

test("responses without limit headers are ignored", () => {
  assert.equal(readingFromHeaders({ "content-type": "application/json", "x-request-id": "1" }), null);
  assert.equal(readingFromStreamEvent({ type: "codex.response.metadata", headers: { "x-models-etag": "x" } }), null);
});

test("scores are written on change and on heartbeat only", () => {
  const reading = readingFromHeaders(CLAUDE_HEADERS)!;
  const account = { slug: accountSlug(reading.accountId) };
  const first = rateLimitScores(reading, account, { now: 0, heartbeatMs: 600_000, model: "claude-sonnet-5-5" });
  assert.deepEqual(first.map((s) => s.name), [`rl.claude.${account.slug}.5h`, `rl.claude.${account.slug}.7d`]);
  assert.equal(first[0].value, 67);
  assert.equal(first[0].timestamp, new Date(0).toISOString());
  assert.deepEqual(first[0].metadata, {
    provider: "claude",
    account: account.slug,
    window: "5h",
    label: "5 hours",
    source: "header",
    host: first[0].metadata.host,
    window_s: "18000",
    resets_at: "1794321600",
    status: "ok",
    binding: "true",
    model: "claude-sonnet-5-5",
  });

  // Same values a minute later: nothing to write.
  assert.equal(rateLimitScores(reading, account, { now: 60_000, heartbeatMs: 600_000 }).length, 0);

  // 5h moves by less than a percent: still nothing; by a percent: only 5h.
  const nudged = { ...reading, windows: reading.windows.map((w) => (w.id === "5h" ? { ...w, usedPercent: 67.3 } : w)) };
  assert.equal(rateLimitScores(nudged, account, { now: 120_000, heartbeatMs: 600_000 }).length, 0);
  const moved = { ...reading, windows: reading.windows.map((w) => (w.id === "5h" ? { ...w, usedPercent: 68 } : w)) };
  assert.deepEqual(rateLimitScores(moved, account, { now: 180_000, heartbeatMs: 600_000 }).map((s) => s.metadata.window), ["5h"]);

  // The heartbeat rewrites what has not changed for its interval.
  assert.deepEqual(rateLimitScores(moved, account, { now: 600_000, heartbeatMs: 600_000 }).map((s) => s.metadata.window), ["7d"]);
});

test("account slugs are short hashes, main without an id", () => {
  assert.equal(accountSlug(undefined), "main");
  assert.match(accountSlug("acc-1"), /^[0-9a-f]{8}$/);
  assert.equal(accountSlug("acc-1"), accountSlug("acc-1"));
});

test("the Codex account comes from pi's auth.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "rl-auth-"));
  const claims = {
    "https://api.openai.com/auth": { chatgpt_account_id: "from-jwt" },
    "https://api.openai.com/profile": { email: "me@example.com" },
  };
  const jwt = `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify({ "openai-codex": { type: "oauth", access: jwt, accountId: "acc-123" } }));
  assert.deepEqual(codexAccountFromAuth(path), { id: "acc-123", label: "me@example.com" });
});

test("rate-limit options are opt-in", () => {
  assert.deepEqual(createRateLimitOptions({}), { enabled: false, heartbeatMs: 600_000 });
  assert.deepEqual(createRateLimitOptions({ PI_LANGFUSE_RATE_LIMIT_SCORES: "true", PI_LANGFUSE_RATE_LIMIT_HEARTBEAT: "0" }), {
    enabled: true,
    heartbeatMs: 0,
  });
});

function withRecordingState(fn: (runtime: LangfuseRuntime) => Promise<void> | void) {
  return async () => {
    const previous = { config: state.config, agentState: state.agentState, agentDir: process.env.PI_CODING_AGENT_DIR };
    // Never read the real auth.json from tests.
    process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "rl-agent-"));
    const runtime = {
      startObservation: () => {
        throw new Error("not used");
      },
      propagateAttributes: () => {
        throw new Error("not used");
      },
      scoreClient: {},
      pendingScores: [],
      scoreFlushStopped: true,
    } as unknown as LangfuseRuntime;
    try {
      state.config = {
        publicKey: "pk",
        secretKey: "sk",
        host: "http://localhost",
        rateLimits: { enabled: true, heartbeatMs: 600_000 },
      };
      state.agentState = {
        traceId: "trace-1",
        activeGenerations: new Map([
          ["gen-1", { observation: { id: "obs-1", traceId: "trace-1", update() {}, end() {} }, requestKey: "gen-1", ended: false, metadata: {} }],
        ]),
        generationOrder: ["gen-1"],
      } as any;
      __setRuntimeForTest(runtime);
      await fn(runtime);
    } finally {
      __setRuntimeForTest(null);
      state.config = previous.config;
      state.agentState = previous.agentState;
      if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    }
  };
}

test("response headers become scores on the open generation", withRecordingState(async (runtime) => {
  recordRateLimitsFromResponse({ status: 200, headers: CLAUDE_HEADERS }, "claude-sonnet-5-5");
  await new Promise((resolve) => setImmediate(resolve));
  const scores = runtime.pendingScores ?? [];
  assert.deepEqual(scores.map((s) => [s.name.split(".").at(-1), s.value, s.traceId, s.observationId, s.sessionId]), [
    ["5h", 67, "trace-1", "obs-1", undefined],
    ["7d", 36, "trace-1", "obs-1", undefined],
  ]);
  assert.equal(scores[0].dataType, "NUMERIC");
  assert.equal(scores[0].metadata?.resets_at, "1794321600");
  assert.ok(scores[0].timestamp);
}));

test("stream events become scores, other events cost nothing", withRecordingState(async (runtime) => {
  recordRateLimitsFromStreamEvent({ type: "provider_stream_event", provider: "openai-codex", model: "gpt-6", data: { type: "response.output_text.delta" } });
  recordRateLimitsFromStreamEvent({ type: "provider_stream_event", provider: "openai-codex", model: "gpt-6", data: CODEX_EVENT });
  await new Promise((resolve) => setImmediate(resolve));
  const scores = runtime.pendingScores ?? [];
  assert.equal(scores.length, 2);
  assert.equal(scores[1].metadata?.plan, "plus");
  assert.equal(scores[1].metadata?.model, "gpt-6");
}));

test("nothing is recorded while the option is off", withRecordingState(async (runtime) => {
  state.config = { ...state.config!, rateLimits: { enabled: false, heartbeatMs: 0 } };
  recordRateLimitsFromResponse({ status: 200, headers: CLAUDE_HEADERS });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.pendingScores?.length, 0);
}));

test("a score's own timestamp is sent as the event timestamp, not in the body", async () => {
  const originalFetch = globalThis.fetch;
  const previousConfig = state.config;
  const bodies: any[] = [];
  const runtime = {
    startObservation: () => {
      throw new Error("not used");
    },
    propagateAttributes: () => {
      throw new Error("not used");
    },
    scoreClient: {},
    pendingScores: [],
    scoreFlushAt: 1,
    scoreFlushIntervalMs: 60_000,
    scoreRequestTimeoutMs: 1_000,
    runtimeConfig: { publicKey: "pk_test", secretKey: "sk_test", host: "https://example.com" },
  } as unknown as LangfuseRuntime & { scoreFlushPromise?: Promise<void>; scoreFlushStopped?: boolean };
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ errors: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    state.config = { ...runtime.runtimeConfig! };
    __setRuntimeForTest(runtime);
    const { sendScore } = await import("../src/langfuse.ts");
    await sendScore("rl.claude.main.5h", 42, {
      traceId: "trace-1",
      metadata: { resets_at: "1794321600" },
      timestamp: "2026-11-10T13:08:45.000Z",
    });
    await runtime.scoreFlushPromise;
    const event = bodies[0].batch[0];
    assert.equal(event.type, "score-create");
    assert.equal(event.timestamp, "2026-11-10T13:08:45.000Z");
    assert.equal("timestamp" in event.body, false);
    assert.deepEqual(event.body.metadata, { resets_at: "1794321600" });
  } finally {
    runtime.scoreFlushStopped = true;
    __setRuntimeForTest(null);
    state.config = previousConfig;
    globalThis.fetch = originalFetch;
  }
});
