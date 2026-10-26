process.env.ROLEMEM_DB = ":memory:";
process.env.ROLEMEM_ADMIN_TOKEN = "test-admin-token-please";
process.env.ROLEMEM_RATE_PER_MIN = "10000";

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { app } from "../src/app.ts";
import { getDb } from "../src/db.ts";
import { call } from "../scripts/client.ts";

beforeEach(() => {
  getDb().exec("delete from work_events; delete from work_items; delete from memory_conflicts; delete from audit_log; delete from memories; delete from connections;");
});

const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } };

async function rpc(method: string, params: object, key: string) {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = JSON.parse(await res.text()) as {
    result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text: string }[] };
  };
  assert.equal(res.status, 200);
  return data.result ?? {};
}

async function tool(key: string, name: string, args: object) {
  const result = await rpc("tools/call", { name, arguments: args }, key);
  assert.notEqual(result.isError, true, result.content?.[0]?.text ?? "tool call failed");
  return result.structuredContent as Record<string, any>;
}

test("a second client resumes work started by the first and the first sees the update", async () => {
  const codex = await call("POST", "/api/connections", { label: "Codex" });
  const claude = await call("POST", "/api/connections", { label: "Claude Code" });
  await rpc("initialize", { ...INIT, clientInfo: { name: "codex", version: "1" } }, codex.key);
  await rpc("initialize", { ...INIT, clientInfo: { name: "claude-code", version: "1" } }, claude.key);

  const memory = await tool(codex.key, "remember", {
    content: "Rolemem stays on SQLite and Hono.",
    type: "project",
    space: "work",
    source_model: "codex",
  });
  const started = await tool(codex.key, "start_work", {
    project: "rolemem",
    title: "Cross-client handoff",
    goal: "Let another client continue the same task",
    client_id: "codex",
    event_id: "evt-e2e-start1",
  });
  await tool(codex.key, "update_work", {
    id: started.id,
    client_id: "codex",
    event_id: "evt-e2e-update1",
    progress_summary: "Codex opened the task",
    append_completed_step: "Created the work item",
    append_failed_attempt: "Tried to paste the whole chat and stopped",
    append_hypothesis: "The failure might be a locked sqlite file",
    append_next_action: "Resume from Claude Code",
    related_memory_id: memory.id,
  });

  const resumed = await tool(claude.key, "resume_work", { project: "rolemem", query: "handoff" });
  assert.equal(resumed.found, true);
  assert.equal(resumed.work_id, started.id);
  assert.equal(resumed.handoff.facts.some((fact: { text: string }) => fact.text.includes("SQLite and Hono")), true);
  assert.equal(resumed.handoff.done.some((fact: { text: string }) => fact.text.includes("Created the work item")), true);
  assert.equal(resumed.handoff.failed.some((fact: { text: string }) => fact.text.includes("whole chat")), true);
  assert.equal(resumed.handoff.hypotheses[0].label, "unverified");
  assert.equal(resumed.handoff.facts.some((fact: { text: string }) => fact.text.includes("locked sqlite")), false);
  assert.match(resumed.note, /not facts|Connecting a client does not capture chat/);

  await tool(claude.key, "update_work", {
    id: started.id,
    client_id: "claude-code",
    event_id: "evt-e2e-claude1",
    append_completed_step: "Claude continued from the handoff",
    append_next_action: "Ask Codex to read the shared item",
    current_step: "Sharing the update back",
  });

  const seen = await tool(codex.key, "get_work", { id: started.id });
  assert.equal(seen.work.client_id, "claude-code");
  assert.equal(seen.work.current_step, "Sharing the update back");
  assert.equal(seen.work.completed_steps.some((step: { text: string }) => step.text.includes("Claude continued")), true);
  assert.equal(seen.summary.used_model, false);
  assert.deepEqual(seen.summary.tests, []);
  assert.deepEqual(seen.summary.files, []);

  const done = await tool(claude.key, "complete_work", { id: started.id, client_id: "claude-code", event_id: "evt-e2e-done1" });
  assert.equal(done.status, "completed");
  const after = await tool(codex.key, "get_work", { id: started.id });
  assert.equal(after.work.status, "completed");

  const idle = await tool(codex.key, "resume_work", { project: "rolemem" });
  assert.equal(idle.found, false);
  assert.equal(idle.mode, "degraded");
  assert.equal(idle.handoff.done.length, 0);

  const listed = await tool(codex.key, "recall", { query: "SQLite Hono" });
  assert.equal(listed.memories[0].content, "Rolemem stays on SQLite and Hono.");
});
