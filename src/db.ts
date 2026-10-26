import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setFts5 } from "./memory/fts.ts";

const SCHEMA = `
create table if not exists memories(
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
create index if not exists memories_status on memories(status, updated_at desc);
create index if not exists memories_space on memories(space, status);

create table if not exists connections(
  id text primary key,
  label text not null,
  key_hash text not null unique,
  created_at text not null,
  last_used_at text,
  revoked_at text
);
`;

let db: DatabaseSync | undefined;

export interface MigrationReport {
  applied: string[];
  fts5: boolean;
  fts5Error?: string;
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  const rows = database.prepare(`pragma table_info(${table})`).all() as { name: string }[];
  return rows.some((row) => row.name === column);
}

function alreadyApplied(database: DatabaseSync, id: string): boolean {
  const row = database.prepare("select id from schema_migrations where id = ?").get(id) as { id: string } | undefined;
  return Boolean(row);
}

function markApplied(database: DatabaseSync, id: string): void {
  database.prepare("insert into schema_migrations(id, applied_at) values (?, ?)").run(id, new Date().toISOString());
}

function step(database: DatabaseSync, id: string, run: () => void, applied: string[]): void {
  if (alreadyApplied(database, id)) return;
  database.exec("begin immediate");
  try {
    run();
    markApplied(database, id);
    database.exec("commit");
    applied.push(id);
  } catch (err) {
    try {
      database.exec("rollback");
    } catch {
      /* the transaction may already be closed */
    }
    throw err;
  }
}

/**
 * Additive only. Old memory rows stay. Re-running is a no-op.
 * Rollback is a file restore: new tables can be ignored by an older build,
 * and the new memory columns are nullable.
 */
export function migrateDatabase(database: DatabaseSync, opts?: { publish?: boolean }): MigrationReport {
  database.exec(`create table if not exists schema_migrations(id text primary key, applied_at text not null)`);
  database.exec(SCHEMA);
  const applied: string[] = [];

  step(database, "20261026-work", () => {
    database.exec(`
      create table if not exists work_items(
        id text primary key,
        project text not null,
        title text not null,
        goal text not null,
        status text not null,
        progress_summary text not null default '',
        current_step text not null default '',
        completed_steps text not null default '[]',
        failed_attempts text not null default '[]',
        open_issues text not null default '[]',
        next_actions text not null default '[]',
        key_decisions text not null default '[]',
        hypotheses text not null default '[]',
        blockers text not null default '[]',
        related_memory_ids text not null default '[]',
        recorded_files text not null default '[]',
        recorded_tests text not null default '[]',
        source_client text,
        client_id text,
        session_id text,
        flags text,
        created_at text not null,
        updated_at text not null,
        last_active_at text not null
      );
      create index if not exists work_items_status on work_items(status, last_active_at desc);
      create index if not exists work_items_project on work_items(project, status);
      create table if not exists work_events(
        id text primary key,
        work_id text not null,
        kind text not null,
        payload text not null,
        client_id text,
        created_at text not null
      );
      create index if not exists work_events_work on work_events(work_id, created_at);
    `);
  }, applied);

  step(database, "20261026-memory-columns", () => {
    if (!hasColumn(database, "memories", "importance")) database.exec("alter table memories add column importance integer");
    if (!hasColumn(database, "memories", "project")) database.exec("alter table memories add column project text");
    if (!hasColumn(database, "memories", "work_id")) database.exec("alter table memories add column work_id text");
  }, applied);

  step(database, "20261026-audit", () => {
    database.exec(`
      create table if not exists audit_log(
        id integer primary key,
        at text not null,
        actor text,
        action text not null,
        target text,
        detail text
      );
      create index if not exists audit_log_at on audit_log(at desc);
      create table if not exists memory_conflicts(
        id text primary key,
        memory_id text not null,
        previous_id text,
        old_content text not null,
        new_content text not null,
        old_updated_at text not null,
        new_updated_at text not null,
        resolution text not null,
        created_at text not null
      );
    `);
  }, applied);

  let fts5 = false;
  let fts5Error: string | undefined;
  try {
    database.exec(`
      create virtual table if not exists memories_fts using fts5(content, id unindexed);
      create trigger if not exists memories_fts_ai after insert on memories when new.status = 'active' begin
        insert into memories_fts(content, id) values (new.content, new.id);
      end;
      create trigger if not exists memories_fts_ad after delete on memories begin
        delete from memories_fts where id = old.id;
      end;
      create trigger if not exists memories_fts_au after update on memories begin
        delete from memories_fts where id = old.id;
      end;
      create trigger if not exists memories_fts_au_ins after update on memories when new.status = 'active' begin
        insert into memories_fts(content, id) values (new.content, new.id);
      end;
      delete from memories_fts;
      insert into memories_fts(content, id) select content, id from memories where status = 'active';
    `);
    fts5 = true;
  } catch (err) {
    fts5 = false;
    fts5Error = err instanceof Error ? err.message : String(err);
  }
  if (opts?.publish) setFts5(fts5, fts5Error);
  return { applied, fts5, ...(fts5Error ? { fts5Error } : {}) };
}

export function getDb(): DatabaseSync {
  if (!db) {
    const path = process.env.ROLEMEM_DB ?? "data/rolemem.db";
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    db = new DatabaseSync(path);
    try {
      db.exec("pragma journal_mode = WAL");
    } catch {
      /* :memory: databases stay on the default journal */
    }
    migrateDatabase(db, { publish: true });
  }
  return db;
}

export function closeDb(): void {
  db?.close();
  db = undefined;
  setFts5(false);
}

export function withTx<T>(fn: () => T): T {
  const database = getDb();
  database.exec("begin immediate");
  try {
    const value = fn();
    database.exec("commit");
    return value;
  } catch (err) {
    try {
      database.exec("rollback");
    } catch {
      /* the transaction may already be closed */
    }
    throw err;
  }
}

export const now = () => new Date().toISOString();

export class HttpError extends Error {
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502;
  retryAfter?: number;
  constructor(status: HttpError["status"], message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}
