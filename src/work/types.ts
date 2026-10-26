import { randomBytes } from "node:crypto";
import { HttpError } from "../db.ts";
import { isWorkStatus, type WorkStatus } from "./machine.ts";

export interface WorkNote {
  id: string;
  text: string;
  at: string;
  client_id: string | null;
}

export interface WorkItem {
  id: string;
  project: string;
  title: string;
  goal: string;
  status: WorkStatus;
  progress_summary: string;
  current_step: string;
  completed_steps: WorkNote[];
  failed_attempts: WorkNote[];
  open_issues: WorkNote[];
  next_actions: WorkNote[];
  key_decisions: WorkNote[];
  hypotheses: WorkNote[];
  blockers: WorkNote[];
  related_memory_ids: string[];
  recorded_files: WorkNote[];
  recorded_tests: WorkNote[];
  source_client: string | null;
  client_id: string | null;
  session_id: string | null;
  flags: string[];
  created_at: string;
  updated_at: string;
  last_active_at: string;
}

export interface WorkEvent {
  id: string;
  work_id: string;
  kind: string;
  payload: string;
  client_id: string | null;
  created_at: string;
}

const MAX_PROJECT = 80;
const MAX_TITLE = 200;
const MAX_GOAL = 4000;
const MAX_SUMMARY = 8000;
const MAX_STEP = 2000;
const MAX_NOTE = 2000;

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export function cleanText(value: unknown, label: string, max: number): string {
  const text = String(value ?? "").trim().replace(/\s+/g, " ").replace(/\u0000/g, "");
  if (!text) throw new HttpError(400, `${label} is empty`);
  if (text.length > max) throw new HttpError(400, `${label} is longer than ${max} characters`);
  return text;
}

export function parseProjectName(value: unknown): string {
  return cleanText(value, "project", MAX_PROJECT);
}

export function parseTitle(value: unknown): string {
  return cleanText(value, "title", MAX_TITLE);
}

export function parseGoal(value: unknown): string {
  return cleanText(value, "goal", MAX_GOAL);
}

export function parseSummary(value: unknown): string {
  return cleanText(value, "progress_summary", MAX_SUMMARY);
}

export function parseStep(value: unknown): string {
  return cleanText(value, "current_step", MAX_STEP);
}

export function parseNote(value: unknown, label: string): string {
  return cleanText(value, label, MAX_NOTE);
}

export function parseClientId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > 64) throw new HttpError(400, "client_id is longer than 64 characters");
  return text;
}

export function parseEventId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = String(value).trim();
  if (!/^[A-Za-z0-9._:-]{8,80}$/.test(text)) {
    throw new HttpError(400, "event_id must be 8–80 characters: letters, digits, dot, underscore, colon, or hyphen");
  }
  return text;
}

export function parseStatus(value: unknown): WorkStatus {
  if (typeof value === "string" && isWorkStatus(value)) return value;
  throw new HttpError(400, "status must be active, paused, blocked, completed, or archived");
}

export function parseMemoryLink(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!/^[a-f0-9]{64}$/.test(text)) throw new HttpError(400, "related_memory_id must be a memory id");
  return text;
}

export function noteKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}
