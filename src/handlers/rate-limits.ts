import { state } from "../state.js";
import { sendScore } from "../langfuse.js";
import { getRequestKey } from "../utils.js";
import { getOpenGeneration } from "./generation.js";
import {
  getRateLimitOptions,
  isRateLimitStreamEvent,
  rateLimitScores,
  readingFromHeaders,
  readingFromStreamEvent,
  resolveAccount,
  type RateLimitReading,
} from "../rate-limits.js";

/**
 * Writes the subscription limits a provider response carries as scores on
 * the generation that received them (or on the session, when no generation
 * is open: cache warming, a request outside an agent run). Never awaits the
 * network: pi awaits these hooks, and the score buffer flushes on its own.
 */
function record(reading: RateLimitReading | null, event: Record<string, unknown>, model?: string) {
  if (!reading || state.isTracingDisabled) return;
  const options = getRateLimitOptions();
  const scores = rateLimitScores(reading, resolveAccount(reading), { heartbeatMs: options.heartbeatMs, model });
  if (!scores.length) return;

  const key = getRequestKey(event, "");
  const generation = (key ? state.agentState?.activeGenerations.get(key) : undefined) ?? getOpenGeneration();
  const traceId = generation?.observation.traceId ?? state.agentState?.traceId;
  const observationId = traceId ? generation?.observation.id : undefined;
  if (!traceId && !state.currentSessionId) return;

  for (const score of scores) {
    void sendScore(score.name, score.value, {
      traceId,
      observationId,
      metadata: score.metadata,
      timestamp: score.timestamp,
    });
  }
}

export function recordRateLimitsFromResponse(event: Record<string, unknown>, model?: string) {
  try {
    if (!getRateLimitOptions().enabled) return;
    record(readingFromHeaders(event.headers), event, model);
  } catch (e) {
    console.warn("📊 Langfuse: Failed to record rate limits", e);
  }
}

export function recordRateLimitsFromStreamEvent(event: Record<string, unknown>) {
  try {
    if (!isRateLimitStreamEvent(event.data) || !getRateLimitOptions().enabled) return;
    record(readingFromStreamEvent(event.data), event, typeof event.model === "string" ? event.model : undefined);
  } catch (e) {
    console.warn("📊 Langfuse: Failed to record rate limits", e);
  }
}
