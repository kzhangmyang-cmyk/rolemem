process.env.ROLEMEM_DB = ":memory:";
process.env.ROLEMEM_ADMIN_TOKEN = "test-admin-token-please";
process.env.ROLEMEM_RATE_PER_MIN = "10000";

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { getDb, HttpError, withTx } from "../src/db.ts";
import { createMemory } from "../src/memory/store.ts";
import { assertTransition } from "../src/work/machine.ts";
import { resumeWork } from "../src/work/resume.ts";
import { completeWork, getWork, listWork, startWork, updateWork } from "../src/work/store.ts";
import { workSummary } from "../src/work/summary.ts";

beforeEach(() => {
  getDb().exec("delete from work_events; delete from work_items; delete from memory_conflicts; delete from audit_log; delete from memories; delete from connections;");
});

test("status transitions follow the state machine", () => {
  assert.doesNotThrow(() => assertTransition("active", "blocked"));
  assert.doesNotThrow(() => assertTransition("blocked", "active"));
  assert.doesNotThrow(() => assertTransition("completed", "archived"));
  assert.doesNotThrow(() => assertTransition("archived", "active"));
  assert.throws(() => assertTransition("completed", "blocked"), (err: unknown) => err instanceof HttpError && err.status === 409);
  assert.throws(() => assertTransition("archived", "paused"), (err: unknown) => err instanceof HttpError && err.status === 409);
});

test("start, append, dedupe, and illegal status are enforced", () => {
  const started = startWork({
    project: "rolemem",
    title: "Continuity",
    goal: "Share the task across clients",
    client_id: "codex",
    source_client: "codex",
    event_id: "evt-start-001",
  });
  assert.equal(started.action, "created");
  const again = startWork({
    project: "rolemem",
    title: "Continuity",
    goal: "A different wording should not open a second item",
    client_id: "claude-code",
    event_id: "evt-start-002",
  });
  assert.equal(again.action, "existing");
  assert.equal(again.item.id, started.item.id);

  const step = updateWork(started.item.id, { append_completed_step: "Wrote the migration", event_id: "evt-step-0001", client_id: "codex" });
  assert.equal(step.item.completed_steps.length, 1);
  const replay = updateWork(started.item.id, { append_completed_step: "Wrote the migration", event_id: "evt-step-0001", client_id: "codex" });
  assert.equal(replay.action, "duplicate");
  assert.equal(replay.item.completed_steps.length, 1);
  const sameText = updateWork(started.item.id, { append_completed_step: "Wrote the migration", event_id: "evt-step-0002", client_id: "cursor" });
  assert.equal(sameText.action, "duplicate");
  assert.equal(getWork(started.item.id)?.completed_steps.length, 1);

  assert.throws(
    () => updateWork(started.item.id, { append_completed_step: "Wrote the migration", event_id: "evt-step-0001", client_id: "other" }),
    (err: unknown) => err instanceof HttpError && err.status === 409,
  );
  assert.throws(() => updateWork(started.item.id, { status: "nope" }), (err: unknown) => err instanceof HttpError && err.status === 400);

  updateWork(started.item.id, { status: "completed", client_id: "codex" });
  assert.throws(() => updateWork(started.item.id, { status: "blocked" }), (err: unknown) => err instanceof HttpError && err.status === 409);
});

test("resume separates facts from hypotheses and degrades when nothing is open", () => {
  const memory = createMemory({ content: "The gateway stays on Hono.", type: "project", space: "work", project: "rolemem" });
  const started = startWork({ project: "rolemem", title: "Handoff", goal: "Finish the resume payload", client_id: "codex" });
  updateWork(started.item.id, {
    client_id: "codex",
    progress_summary: "Migration is in progress",
    append_completed_step: "Added the work table",
    append_failed_attempt: "A full rewrite lost the export tests",
    append_hypothesis: "FTS5 might miss Chinese bigrams",
    append_blocker: "Need a second client id",
    append_next_action: "Call resume from the other client",
    append_key_decision: "Keep export version at 1",
    related_memory_id: memory.memory.id,
    append_file: "src/work/store.ts",
    append_test_result: "npm test was red before the trigger fix",
  });
  const handoff = resumeWork({ project: "rolemem" });
  assert.equal(handoff.mode, "handoff");
  assert.equal(handoff.found, true);
  assert.equal(handoff.handoff.hypotheses[0]?.label, "unverified");
  assert.equal(handoff.handoff.facts.some((fact) => fact.text.includes("FTS5 might miss")), false);
  assert.equal(handoff.handoff.failed.some((fact) => fact.text.includes("full rewrite")), true);
  assert.equal(handoff.handoff.facts.some((fact) => fact.text.includes("gateway stays on Hono")), true);
  assert.match(handoff.text, /not instructions/);
  assert.match(handoff.text, /not facts/);
  const summary = workSummary(handoff.work!);
  assert.equal(summary.used_model, false);
  assert.deepEqual(summary.files, ["src/work/store.ts"]);
  assert.deepEqual(summary.tests, ["npm test was red before the trigger fix"]);
  assert.match(summary.note, /does not claim that tests were run|only when a client recorded|No model was called/);

  completeWork(started.item.id, { archive: true, client_id: "codex" });
  const none = resumeWork({ project: "rolemem" });
  assert.equal(none.mode, "degraded");
  assert.equal(none.found, false);
  assert.equal(none.handoff.done.length, 0);
  assert.equal(none.work, null);
  assert.equal(listWork({ includeArchived: true }).some((item) => item.id === started.item.id), true);
});

test("completed history does not hide or duplicate an older open item", () => {
  const open = startWork({ project: "lumen", title: "Keep the lamp brief", goal: "Write the brief", client_id: "client-a" });
  updateWork(open.item.id, { append_completed_step: "Drafted the first paragraph", client_id: "client-a" });
  updateWork(open.item.id, { append_completed_step: "Checked the caption budget", client_id: "client-a" });
  updateWork(open.item.id, {
    append_failed_attempt: "Tried a 12-page draft",
    append_open_issue: "Caption length is undecided",
    append_next_action: "Ask the editor",
    client_id: "client-a",
  });
  for (let i = 0; i < 201; i++) {
    const filler = startWork({ project: "lumen", title: `Finished note ${i}`, goal: `Filler ${i}`, separate: true, client_id: "client-a" });
    updateWork(filler.item.id, { status: "completed", client_id: "client-a" });
  }
  const resumed = resumeWork({ project: "lumen" });
  assert.equal(resumed.found, true);
  assert.equal(resumed.work?.id, open.item.id);
  assert.deepEqual(resumed.handoff.done.map((step) => step.text), ["Drafted the first paragraph", "Checked the caption budget"]);
  assert.equal(resumed.handoff.failed.length, 1);
  assert.equal(resumed.summary?.open_issues.includes("Caption length is undecided"), true);
  assert.equal(resumed.handoff.blockers.some((row) => row.label === "open_issue" && row.text === "Caption length is undecided"), true);
  assert.equal(resumed.handoff.facts.some((fact) => fact.text.includes("Caption length")), false);
  assert.equal(resumed.handoff.hypotheses.length, 0);
  const again = startWork({ project: "Lumen", title: "keep the lamp brief", goal: "A second client must not open an empty copy", client_id: "client-b" });
  assert.equal(again.action, "existing");
  assert.equal(again.item.id, open.item.id);
  assert.equal(again.item.open_issues.length, 1);
  assert.equal(again.item.completed_steps.length, 2);
  const listed = listWork({ project: "lumen", limit: 3, preferOpen: true });
  assert.equal(listed[0]?.id, open.item.id);
  assert.equal(listed[0]?.status, "active");
});

test("a failed transaction does not keep the row", () => {
  const before = getDb().prepare("select count(*) as n from work_items").get() as { n: number };
  assert.throws(() =>
    withTx(() => {
      getDb()
        .prepare(
          `insert into work_items(id, project, title, goal, status, progress_summary, current_step,
            completed_steps, failed_attempts, open_issues, next_actions, key_decisions, hypotheses, blockers,
            related_memory_ids, recorded_files, recorded_tests, source_client, client_id, session_id, flags,
            created_at, updated_at, last_active_at)
           values ('wrk_rollbackrollbackrollback1', 'rolemem', 'Rollback', 'nope', 'active', '', '', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', null, null, null, null, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      throw new Error("boom");
    }),
  );
  const after = getDb().prepare("select count(*) as n from work_items").get() as { n: number };
  assert.equal(after.n, before.n);
  assert.equal(getWork("wrk_rollbackrollbackrollback1"), undefined);
});
