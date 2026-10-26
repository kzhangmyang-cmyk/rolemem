import { HttpError } from "../db.ts";

export const WORK_STATUSES = ["active", "paused", "blocked", "completed", "archived"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

/** Same-state writes are allowed. Anything else must be listed. */
const NEXT: Record<WorkStatus, readonly WorkStatus[]> = {
  active: ["paused", "blocked", "completed", "archived"],
  paused: ["active", "blocked", "completed", "archived"],
  blocked: ["active", "paused", "completed", "archived"],
  completed: ["active", "archived"],
  archived: ["active"],
};

export function isWorkStatus(value: string): value is WorkStatus {
  return (WORK_STATUSES as readonly string[]).includes(value);
}

export function assertTransition(from: WorkStatus, to: WorkStatus): void {
  if (from === to) return;
  if (!NEXT[from].includes(to)) {
    throw new HttpError(409, `Cannot change work status from ${from} to ${to}`);
  }
}
