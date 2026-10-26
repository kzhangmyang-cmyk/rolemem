import { createHash } from "node:crypto";
import { HttpError } from "../db.ts";

export const MEMORY_TYPES = ["preference", "fact", "project", "procedure"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_STATUSES = ["active", "quarantined", "deleted"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

const SPACE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_CONTENT = 8000;

export interface Memory {
  id: string;
  content: string;
  type: MemoryType;
  space: string;
  source_model: string | null;
  updated_at: string;
  status: MemoryStatus;
  flags: string[];
  created_at: string;
}

/** Collapse whitespace so the same fact written with different spacing is one memory. */
export function normalizeContent(content: string): string {
  const text = content.trim().replace(/\s+/g, " ");
  if (!text) throw new HttpError(400, "Memory content is empty");
  if (text.length > MAX_CONTENT) throw new HttpError(400, `Memory content is longer than ${MAX_CONTENT} characters`);
  return text;
}

export function memoryId(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function parseType(value: unknown, fallback?: MemoryType): MemoryType {
  if (value === undefined || value === null || value === "") {
    if (fallback) return fallback;
    throw new HttpError(400, "type must be preference, fact, project, or procedure");
  }
  if (typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value)) return value as MemoryType;
  throw new HttpError(400, "type must be preference, fact, project, or procedure");
}

export function parseSpace(value: unknown, fallback = "life"): string {
  const space = (value === undefined || value === null || String(value).trim() === "" ? fallback : String(value)).trim().toLowerCase();
  if (!SPACE_RE.test(space)) {
    throw new HttpError(400, "space must be 1–32 characters: a letter, then lowercase letters, digits, _ or -");
  }
  return space;
}

export function parseSourceModel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > 64) throw new HttpError(400, "source_model is longer than 64 characters");
  return text;
}

export function isType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

export function isStatus(value: string): value is MemoryStatus {
  return (MEMORY_STATUSES as readonly string[]).includes(value);
}
