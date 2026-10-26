process.env.ROLEMEM_DB = ":memory:";
process.env.ROLEMEM_ADMIN_TOKEN = "test-admin-token-please";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { closeDb, getDb, migrateDatabase } from "../src/db.ts";
import { createMemory, memoryById } from "../src/memory/store.ts";
import { getWork, startWork, updateWork } from "../src/work/store.ts";

const OLD = `
create table memories(
  id text primary key,
  content text not null,
  type text not null,
  space text not null,
  source_model text,
  updated_at text not null,
  status text not null,
  flags text,
  created_at text not null
);
create table connections(
  id text primary key,
  label text not null,
  key_hash text not null unique,
  created_at text not null,
  last_used_at text,
  revoked_at text
);
`;

test("an old database keeps its memories through a repeated migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "rolemem-old-"));
  const database = new DatabaseSync(join(dir, "old.db"));
  database.exec(OLD);
  database
    .prepare("insert into memories(id, content, type, space, source_model, updated_at, status, flags, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("abc", "keep me", "fact", "life", null, "2024-01-01T00:00:00.000Z", "active", null, "2024-01-01T00:00:00.000Z");
  const first = migrateDatabase(database);
  assert.ok(first.applied.includes("20261026-work"));
  assert.ok(first.applied.includes("20261026-memory-columns"));
  assert.equal(first.fts5, true);
  const row = database.prepare("select content, importance, project from memories where id = ?").get("abc") as {
    content: string;
    importance: number | null;
    project: string | null;
  };
  assert.equal(row.content, "keep me");
  assert.equal(row.importance, null);
  assert.equal(row.project, null);
  const tables = database.prepare("select name from sqlite_master where type = 'table' and name in ('work_items', 'work_events', 'audit_log', 'memory_conflicts')").all() as { name: string }[];
  assert.equal(tables.length, 4);
  const second = migrateDatabase(database);
  assert.deepEqual(second.applied, []);
  database.exec("delete from schema_migrations where id = '20261026-memory-columns'");
  const third = migrateDatabase(database);
  assert.deepEqual(third.applied, ["20261026-memory-columns"]);
  assert.equal((database.prepare("select content from memories where id = ?").get("abc") as { content: string }).content, "keep me");
  database.close();
  rmSync(dir, { recursive: true, force: true });
});

test("an empty database accepts the same migration twice", () => {
  const database = new DatabaseSync(":memory:");
  const first = migrateDatabase(database);
  assert.ok(first.applied.length >= 3);
  const second = migrateDatabase(database);
  assert.deepEqual(second.applied, []);
  database.close();
});

const previousDb = process.env.ROLEMEM_DB;
after(() => {
  closeDb();
  process.env.ROLEMEM_DB = previousDb;
  getDb();
});

test("memories and work survive closing and reopening the sqlite file", () => {
  const dir = mkdtempSync(join(tmpdir(), "rolemem-restart-"));
  const file = join(dir, "rolemem.db");
  closeDb();
  process.env.ROLEMEM_DB = file;
  const memory = createMemory({ content: "Restart token phrase alpha.", type: "fact", space: "work" });
  const work = startWork({ project: "rolemem", title: "Restart", goal: "Prove the file survives", client_id: "codex", source_client: "codex" });
  updateWork(work.item.id, { append_completed_step: "Wrote the row", client_id: "codex" });
  closeDb();
  process.env.ROLEMEM_DB = file;
  assert.equal(memoryById(memory.memory.id)?.content, "Restart token phrase alpha.");
  assert.equal(getWork(work.item.id)?.completed_steps[0]?.text, "Wrote the row");
  assert.equal(getWork(work.item.id)?.completed_steps.length, 1);
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
