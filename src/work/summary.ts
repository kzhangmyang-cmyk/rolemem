import type { WorkItem } from "./types.ts";

export interface WorkSummary {
  goal: string;
  progress_summary: string;
  current_step: string;
  completed: string[];
  failed: string[];
  open_issues: string[];
  blockers: string[];
  next: string[];
  decisions: string[];
  hypotheses: string[];
  /** Only notes the client explicitly recorded. Never inferred from a filesystem. */
  files: string[];
  /** Only notes the client explicitly recorded. This server does not run tests. */
  tests: string[];
  used_model: false;
  note: string;
}

const NOTE =
  "Assembled from recorded work fields. Files and test results appear only when a client recorded them. Hypotheses are not facts. No model was called.";

/** Deterministic summary. Works with no LLM configured and does not invent results. */
export function workSummary(item: WorkItem): WorkSummary {
  return {
    goal: item.goal,
    progress_summary: item.progress_summary,
    current_step: item.current_step,
    completed: item.completed_steps.map((note) => note.text),
    failed: item.failed_attempts.map((note) => note.text),
    open_issues: item.open_issues.map((note) => note.text),
    blockers: item.blockers.map((note) => note.text),
    next: item.next_actions.map((note) => note.text),
    decisions: item.key_decisions.map((note) => note.text),
    hypotheses: item.hypotheses.map((note) => note.text),
    files: item.recorded_files.map((note) => note.text),
    tests: item.recorded_tests.map((note) => note.text),
    used_model: false,
    note: NOTE,
  };
}
