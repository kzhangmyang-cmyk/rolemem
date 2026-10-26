import { HttpError } from "./db.ts";

const WINDOW_MS = 60_000;
const AUTH_WINDOW_MS = 15 * 60_000;
const hits = new Map<string, number[]>();

function prune(key: string, windowMs: number): number[] {
  const now = Date.now();
  const kept = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  hits.set(key, kept);
  return kept;
}

export function rateLimit(key: string, limit: number, windowMs = WINDOW_MS): void {
  if (!Number.isFinite(limit) || limit <= 0) return;
  const bucket = prune(key, windowMs);
  if (bucket.length >= limit) {
    const retryAfter = Math.max(1, Math.ceil((windowMs - (Date.now() - bucket[0]!)) / 1000));
    throw new HttpError(429, `Too many requests. Retry in ${retryAfter}s`, retryAfter);
  }
  bucket.push(Date.now());
}

export function noteAuthFailure(ip: string): void {
  const limit = Number(process.env.ROLEMEM_AUTH_FAILS) || 20;
  rateLimit(`authfail:${ip}`, limit, AUTH_WINDOW_MS);
}

export function clearAuthFailures(ip: string): void {
  hits.delete(`authfail:${ip}`);
}

export function requestLimit(kind: "api" | "mcp"): number {
  const fromEnv = Number(process.env.ROLEMEM_RATE_PER_MIN);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return kind === "mcp" ? 120 : 240;
}
