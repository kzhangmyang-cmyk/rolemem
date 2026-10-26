process.env.ROLEMEM_DB = ":memory:";
process.env.ROLEMEM_ADMIN_TOKEN = "test-admin-token-please";

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/db.ts";
import { fts5Enabled } from "../src/memory/fts.ts";
import { rankForRecall, rankLexical, rankMemories } from "../src/memory/rank.ts";
import { createMemory, recall } from "../src/memory/store.ts";
import type { Memory } from "../src/memory/types.ts";

beforeEach(() => {
  getDb().exec("delete from memories; delete from memory_conflicts; delete from audit_log;");
});

function mem(input: Partial<Memory> & Pick<Memory, "id" | "content" | "type" | "updated_at">): Memory {
  return {
    space: "work",
    source_model: null,
    status: "active",
    flags: [],
    created_at: input.updated_at,
    importance: null,
    project: null,
    work_id: null,
    ...input,
  };
}

const preference = mem({
  id: "pref",
  content: "The billing service must stay on SQLite.",
  type: "preference",
  updated_at: "2024-01-01T00:00:00.000Z",
  project: "billing",
});
const newer = mem({
  id: "new",
  content: "Checked SQLite file size today.",
  type: "fact",
  updated_at: "2026-10-26T00:00:00.000Z",
  project: "billing",
});
const additive = mem({
  id: "abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd",
  content: "Keep schema changes additive and reversible.",
  type: "project",
  updated_at: "2025-01-01T00:00:00.000Z",
  project: "rolemem",
  work_id: "wrk_0123456789abcdef01234567",
});

test("a newer partial match does not outrank an older preference", () => {
  const oldOrder = rankLexical([preference, newer], "SQLite", 2).map((memory) => memory.id);
  const next = rankMemories([preference, newer], "SQLite", 2).map((memory) => memory.id);
  assert.equal(oldOrder[0], "new");
  assert.equal(next[0], "pref");
  assert.equal(next[1], "new");
});

test("project, work id, and memory id rank without being in the text", () => {
  const rows = [preference, newer, additive];
  assert.equal(rankLexical(rows, "rolemem", 3).length, 0);
  assert.equal(rankMemories(rows, "rolemem", 3)[0]?.id, additive.id);
  assert.equal(rankMemories(rows, additive.work_id!, 3)[0]?.id, additive.id);
  assert.equal(rankMemories(rows, additive.id, 3)[0]?.diagnostics.id_match, 1);
  assert.equal(rankMemories(rows, "quantum banana", 3).length, 0);
});

test("chinese and mixed queries keep the closer memory first", () => {
  const tiers = mem({ id: "tiers", content: "报价单确认预算后提供三档方案。", type: "procedure", updated_at: "2024-01-01T00:00:00.000Z" });
  const header = mem({ id: "header", content: "报价单使用红色表头。", type: "preference", updated_at: "2026-01-01T00:00:00.000Z" });
  assert.equal(rankMemories([tiers, header], "三档方案", 2)[0]?.id, "tiers");
  assert.equal(rankMemories([tiers, header], "红色表头", 2)[0]?.id, "header");
  const english = mem({ id: "en", content: "The user lives in Lisbon and commutes by tram.", type: "fact", updated_at: "2020-01-01T00:00:00.000Z" });
  const mixed = mem({ id: "zh", content: "用户住在 Lisbon，通勤靠电车。", type: "fact", updated_at: "2021-01-01T00:00:00.000Z" });
  assert.equal(rankMemories([english, mixed], "Lisbon 电车", 2)[0]?.id, "zh");
});

test("stored memories are recalled, and FTS5 is available in this Node build", () => {
  assert.equal(fts5Enabled(), true);
  const saved = createMemory({
    content: "Quotes should offer three tiers after the budget is confirmed.",
    type: "procedure",
    space: "work",
    project: "quotes",
  });
  const hits = recall("three tiers budget", 3);
  assert.equal(hits[0]?.id, saved.memory.id);
  assert.ok(hits[0]?.diagnostics.reasons.includes("lexical") || hits[0]?.diagnostics.reasons.includes("fts5"));
  const byProject = rankForRecall([saved.memory], "quotes", 1);
  assert.equal(byProject[0]?.diagnostics.reasons.includes("project"), true);
});
