import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
    db.exec(SCHEMA);
  }
  return db;
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
