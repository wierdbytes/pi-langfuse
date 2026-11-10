import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { parseFlag, type EnvLike } from "./capture-policy.js";
import { state } from "./state.js";

/**
 * Subscription rate limits (Claude Pro/Max, ChatGPT plans for Codex) as
 * Langfuse scores. Providers report the current state of their usage windows
 * on every response: Anthropic in `anthropic-ratelimit-unified-*` headers,
 * Codex in `x-codex-*` headers (SSE) or a `codex.rate_limits` stream event
 * (WebSocket). Each window becomes a NUMERIC score
 * `rl.<provider>.<account>.<window>` whose value is the share used in percent,
 * with the reset time and status in its metadata. A score is only written when
 * the percentage (to a tenth), the reset time or the status changes, plus a
 * heartbeat, so a busy session adds a handful of scores per hour.
 */

export const RATE_LIMIT_SCORE_PREFIX = "rl";

export type RateLimitProvider = "claude" | "codex";
export type RateLimitStatus = "ok" | "warning" | "exhausted";

export interface RateLimitWindow {
  /** Stable within the account: "5h", "7d", "7d_oi", or "<family>.<window>" for extra Codex limit families. */
  id: string;
  label: string;
  windowSeconds?: number;
  /** Share of the window used, in percent. Can exceed 100. */
  usedPercent: number;
  /** Unix seconds. */
  resetsAt?: number;
  status?: RateLimitStatus;
}

export interface RateLimitReading {
  provider: RateLimitProvider;
  source: "header" | "stream";
  /** The provider's own account id (Anthropic organization, ChatGPT account), when the response names it. */
  accountId?: string;
  plan?: string;
  /** The window that limits the account right now (Anthropic's representative claim). */
  binding?: string;
  status?: RateLimitStatus;
  windows: RateLimitWindow[];
}

export interface RateLimitAccount {
  /** Short, stable and not identifying: the first 8 hex digits of sha256(account id), or "main". */
  slug: string;
  label?: string;
}

export interface RateLimitScore {
  name: string;
  value: number;
  /** ISO time the provider answered: the score's timestamp. */
  timestamp: string;
  metadata: Record<string, string>;
}

// ============================================
// Options
// ============================================

export interface RateLimitOptions {
  /** Write rate-limit scores at all. Off by default. */
  readonly enabled: boolean;
  /** Rewrite an unchanged window after this long, so readers can tell live data from stale. 0: never. */
  readonly heartbeatMs: number;
}

export const DEFAULT_RATE_LIMIT_OPTIONS: RateLimitOptions = {
  enabled: false,
  heartbeatMs: 10 * 60_000,
};

export function createRateLimitOptions(env: EnvLike = process.env as EnvLike): RateLimitOptions {
  const heartbeat = Number(env.PI_LANGFUSE_RATE_LIMIT_HEARTBEAT);
  return {
    enabled: parseFlag(env.PI_LANGFUSE_RATE_LIMIT_SCORES) ?? DEFAULT_RATE_LIMIT_OPTIONS.enabled,
    heartbeatMs:
      env.PI_LANGFUSE_RATE_LIMIT_HEARTBEAT !== undefined && Number.isFinite(heartbeat) && heartbeat >= 0
        ? heartbeat * 1_000
        : DEFAULT_RATE_LIMIT_OPTIONS.heartbeatMs,
  };
}

export function getRateLimitOptions(): RateLimitOptions {
  return state.config?.rateLimits ?? createRateLimitOptions();
}

// ============================================
// Parsing
// ============================================

const num = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

const unifiedStatus = (value: unknown): RateLimitStatus | undefined =>
  value === "allowed" ? "ok" : value === "allowed_warning" ? "warning" : value === "rejected" ? "exhausted" : undefined;

/** "5h" → 18000, "7d" → 604800, "7d_oi" → 604800. */
function claimSeconds(claim: string): number | undefined {
  const m = /^(\d+)([mhd])/.exec(claim);
  if (!m) return undefined;
  return Number(m[1]) * (m[2] === "m" ? 60 : m[2] === "h" ? 3_600 : 86_400);
}

function durationLabel(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`;
  return `${Math.round(seconds / 60)} minutes`;
}

function durationId(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${Math.round(seconds / 60)}m`;
}

const CLAUDE_PREFIX = "anthropic-ratelimit-unified-";
const CLAUDE_LABELS: Record<string, string> = {
  "5h": "5 hours",
  "7d": "7 days",
  "7d_oi": "7 days + extra",
  "7d_opus": "Opus",
  "7d_sonnet": "Sonnet",
};
// representative-claim names the binding window by its long name.
const CLAUDE_CLAIMS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_overage_included: "7d_oi",
  seven_day_opus: "7d_opus",
  seven_day_sonnet: "7d_sonnet",
  overage: "overage",
};

function claudeFromHeaders(headers: Record<string, string>): RateLimitReading | null {
  const windows: RateLimitWindow[] = [];
  for (const [key, raw] of Object.entries(headers)) {
    if (!key.startsWith(CLAUDE_PREFIX) || !key.endsWith("-utilization")) continue;
    const claim = key.slice(CLAUDE_PREFIX.length, -"-utilization".length);
    // Windows only ("5h", "7d", "7d_oi"…): overage, grace and slow-mode budgets are not usage windows.
    if (!/^\d+[mhd](_[a-z0-9_]+)?$/.test(claim)) continue;
    const utilization = num(raw);
    if (utilization === undefined) continue;
    const windowSeconds = claimSeconds(claim);
    windows.push({
      id: claim,
      label: CLAUDE_LABELS[claim] ?? claim,
      windowSeconds,
      usedPercent: round2(utilization * 100),
      resetsAt: num(headers[`${CLAUDE_PREFIX}${claim}-reset`]),
      status: unifiedStatus(headers[`${CLAUDE_PREFIX}${claim}-status`]),
    });
  }
  if (!windows.length) return null;
  const claim = headers[`${CLAUDE_PREFIX}representative-claim`];
  return {
    provider: "claude",
    source: "header",
    accountId: headers["anthropic-organization-id"] || undefined,
    binding: claim ? CLAUDE_CLAIMS[claim] ?? claim : undefined,
    status: unifiedStatus(headers[`${CLAUDE_PREFIX}status`]),
    windows: sortWindows(windows),
  };
}

interface CodexWindowInput {
  usedPercent?: number;
  windowSeconds?: number;
  resetsAt?: number;
}

function codexWindow(family: string, familyLabel: string | undefined, w: CodexWindowInput): RateLimitWindow | null {
  if (w.usedPercent === undefined) return null;
  const seconds = w.windowSeconds;
  const base = seconds ? durationId(seconds) : "window";
  // The main Codex family keeps the plain ids ("5h", "7d") the other providers use.
  const main = family === "codex";
  const id = main ? base : `${family.replace(/[^a-z0-9_-]+/gi, "_")}.${base}`;
  const label = main
    ? seconds ? durationLabel(seconds) : "Window"
    : `${familyLabel || family} ${seconds ? durationId(seconds) : ""}`.trim();
  return {
    id,
    label,
    windowSeconds: seconds,
    usedPercent: round2(w.usedPercent),
    resetsAt: w.resetsAt,
    status: w.usedPercent >= 100 ? "exhausted" : undefined,
  };
}

function codexFromHeaders(headers: Record<string, string>, nowS: number): RateLimitReading | null {
  const windows: RateLimitWindow[] = [];
  for (const key of Object.keys(headers)) {
    // x-<family>-<primary|secondary>-used-percent; the family is "codex" or another limit
    // ("codex-secondary", "bengalfox"…) that names itself in x-<family>-limit-name.
    const m = /^x-(.+)-(primary|secondary)-used-percent$/.exec(key);
    if (!m) continue;
    const [, family, slot] = m;
    const prefix = `x-${family}-${slot}`;
    const minutes = num(headers[`${prefix}-window-minutes`]);
    const after = num(headers[`${prefix}-reset-after-seconds`]);
    const w = codexWindow(family, headers[`x-${family}-limit-name`], {
      usedPercent: num(headers[key]),
      windowSeconds: minutes ? minutes * 60 : undefined,
      resetsAt: num(headers[`${prefix}-reset-at`]) ?? (after !== undefined ? Math.floor(nowS + after) : undefined),
    });
    if (w) windows.push(w);
  }
  if (!windows.length) return null;
  return { provider: "codex", source: "header", windows: sortWindows(windows) };
}

function codexEventWindow(raw: unknown, nowS: number): CodexWindowInput | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  const minutes = num(w.window_minutes);
  const seconds = num(w.limit_window_seconds);
  const after = num(w.reset_after_seconds);
  return {
    usedPercent: num(w.used_percent),
    windowSeconds: minutes ? minutes * 60 : seconds,
    resetsAt: num(w.reset_at) ?? num(w.resets_at) ?? (after !== undefined ? Math.floor(nowS + after) : undefined),
  };
}

function codexEventFamily(
  family: string,
  label: string | undefined,
  limits: unknown,
  nowS: number,
  out: RateLimitWindow[],
) {
  if (!limits || typeof limits !== "object") return;
  const l = limits as Record<string, unknown>;
  for (const slot of [l.primary ?? l.primary_window, l.secondary ?? l.secondary_window]) {
    const input = codexEventWindow(slot, nowS);
    const w = input && codexWindow(family, label, input);
    if (w) out.push(w);
  }
}

function codexFromEvent(data: Record<string, unknown>, nowS: number): RateLimitReading | null {
  const windows: RateLimitWindow[] = [];
  const main = data.rate_limits as Record<string, unknown> | null | undefined;
  codexEventFamily("codex", undefined, main, nowS, windows);
  codexEventFamily("code_review", "Code review", data.code_review_rate_limits, nowS, windows);
  const extra = data.additional_rate_limits;
  const items = Array.isArray(extra)
    ? extra
    : extra && typeof extra === "object"
      ? Object.entries(extra as Record<string, unknown>).map(([k, v]) => ({ limit_id: k, ...(v as object) }))
      : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const family = String(it.metered_feature ?? it.limit_id ?? it.limit_name ?? "extra");
    const label = typeof it.limit_name === "string" ? it.limit_name : undefined;
    codexEventFamily(family, label, it.rate_limits ?? it.rate_limit ?? it, nowS, windows);
  }
  if (!windows.length) return null;
  const blocked = main && (main.limit_reached === true || main.allowed === false);
  return {
    provider: "codex",
    source: "stream",
    plan: typeof data.plan_type === "string" ? data.plan_type : undefined,
    status: blocked ? "exhausted" : main?.allowed === true ? "ok" : undefined,
    windows: sortWindows(windows),
  };
}

function sortWindows(windows: RateLimitWindow[]): RateLimitWindow[] {
  return windows.sort((a, b) => (a.windowSeconds ?? Infinity) - (b.windowSeconds ?? Infinity) || a.id.localeCompare(b.id));
}

/** Limits in a provider response's headers (keys lower-case, as pi hands them over). */
export function readingFromHeaders(headers: unknown, nowS = Date.now() / 1_000): RateLimitReading | null {
  if (!headers || typeof headers !== "object") return null;
  const h = headers as Record<string, string>;
  return claudeFromHeaders(h) ?? codexFromHeaders(h, nowS);
}

/** Limits in a provider stream event (`provider_stream_event.data`). */
export function readingFromStreamEvent(data: unknown, nowS = Date.now() / 1_000): RateLimitReading | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type === "codex.rate_limits") return codexFromEvent(d, nowS);
  // The WebSocket transport forwards the response headers in this event.
  if (d.type === "codex.response.metadata" && d.headers && typeof d.headers === "object") {
    const headers = Object.fromEntries(
      Object.entries(d.headers as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)]),
    );
    const reading = codexFromHeaders(headers, nowS);
    return reading ? { ...reading, source: "stream" } : null;
  }
  return null;
}

/** Cheap pre-check for the stream-event hook, which fires for every delta. */
export function isRateLimitStreamEvent(data: unknown): boolean {
  const type = (data as { type?: unknown } | null | undefined)?.type;
  return type === "codex.rate_limits" || type === "codex.response.metadata";
}

// ============================================
// Accounts
// ============================================

export function accountSlug(accountId: string | undefined): string {
  return accountId ? createHash("sha256").update(accountId).digest("hex").slice(0, 8) : "main";
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

let codexAccountCache: { mtimeMs: number; checkedAt: number; account?: { id?: string; label?: string } } | undefined;

function decodeJwtClaims(token: unknown): Record<string, unknown> | undefined {
  if (typeof token !== "string") return undefined;
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
  } catch {
    return undefined;
  }
}

/** The ChatGPT account pi signs in to Codex with (auth.json), re-read when the file changes. */
export function codexAccountFromAuth(path = join(agentDir(), "auth.json"), now = Date.now()): { id?: string; label?: string } | undefined {
  if (codexAccountCache && now - codexAccountCache.checkedAt < 60_000) return codexAccountCache.account;
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (codexAccountCache && codexAccountCache.mtimeMs === mtimeMs) {
      codexAccountCache.checkedAt = now;
      return codexAccountCache.account;
    }
    const credential = (JSON.parse(readFileSync(path, "utf-8")) as Record<string, Record<string, unknown>>)["openai-codex"];
    const claims = decodeJwtClaims(credential?.access);
    const auth = claims?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const profile = claims?.["https://api.openai.com/profile"] as Record<string, unknown> | undefined;
    const id = typeof credential?.accountId === "string" ? credential.accountId
      : typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
    const email = typeof profile?.email === "string" ? profile.email : typeof claims?.email === "string" ? claims.email : undefined;
    codexAccountCache = { mtimeMs, checkedAt: now, account: id || email ? { id, label: email } : undefined };
  } catch {
    codexAccountCache = { mtimeMs: -1, checkedAt: now, account: undefined };
  }
  return codexAccountCache.account;
}

export function resolveAccount(reading: RateLimitReading): RateLimitAccount {
  if (reading.provider === "codex") {
    const account = codexAccountFromAuth();
    return { slug: accountSlug(reading.accountId ?? account?.id), label: account?.label };
  }
  return { slug: accountSlug(reading.accountId) };
}

// ============================================
// Scores
// ============================================

interface Written {
  percent: number;
  resetsAt?: number;
  status?: string;
  plan?: string;
  at: number;
}

// Per process: every session of this pi shares one subscription, so one write per change is enough.
const lastWritten = new Map<string, Written>();

export function __resetRateLimitStateForTest() {
  lastWritten.clear();
  codexAccountCache = undefined;
}

export function rateLimitScoreName(provider: string, account: string, windowId: string): string {
  return `${RATE_LIMIT_SCORE_PREFIX}.${provider}.${account}.${windowId}`;
}

function changed(prev: Written | undefined, next: Written, heartbeatMs: number): boolean {
  if (!prev) return true;
  if (prev.percent !== next.percent || prev.status !== next.status || prev.plan !== next.plan) return true;
  if ((prev.resetsAt === undefined) !== (next.resetsAt === undefined)) return true;
  // Codex derives resets from "reset after N seconds": allow some drift before calling it a new window.
  if (prev.resetsAt !== undefined && next.resetsAt !== undefined && Math.abs(prev.resetsAt - next.resetsAt) > 60) return true;
  return heartbeatMs > 0 && next.at - prev.at >= heartbeatMs;
}

/**
 * The scores to write for a reading: one per window that changed since this
 * process last wrote it (or whose heartbeat is due). Marks them written.
 */
export function rateLimitScores(
  reading: RateLimitReading,
  account: RateLimitAccount,
  options: { now?: number; heartbeatMs?: number; model?: string } = {},
): RateLimitScore[] {
  const now = options.now ?? Date.now();
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_RATE_LIMIT_OPTIONS.heartbeatMs;
  const out: RateLimitScore[] = [];
  for (const w of reading.windows) {
    const name = rateLimitScoreName(reading.provider, account.slug, w.id);
    const status = w.status ?? (reading.status === "exhausted" && reading.binding === w.id ? "exhausted" : reading.status ? "ok" : undefined);
    // Tenths of a percent: Codex reports fractions, Anthropic whole percents (two-decimal shares).
    const next: Written = { percent: Math.round(w.usedPercent * 10) / 10, resetsAt: w.resetsAt, status, plan: reading.plan, at: now };
    if (!changed(lastWritten.get(name), next, heartbeatMs)) continue;
    lastWritten.set(name, next);
    const metadata: Record<string, string> = {
      provider: reading.provider,
      account: account.slug,
      window: w.id,
      label: w.label,
      source: reading.source,
      host: hostname(),
    };
    if (account.label) metadata.account_label = account.label;
    if (w.windowSeconds !== undefined) metadata.window_s = String(w.windowSeconds);
    if (w.resetsAt !== undefined) metadata.resets_at = String(Math.floor(w.resetsAt));
    if (status) metadata.status = status;
    if (reading.plan) metadata.plan = reading.plan;
    if (reading.binding === w.id) metadata.binding = "true";
    if (options.model) metadata.model = options.model;
    out.push({ name, value: w.usedPercent, timestamp: new Date(now).toISOString(), metadata });
  }
  return out;
}
