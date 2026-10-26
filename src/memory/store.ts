import { getDb, HttpError, now, withTx } from "../db.ts";
import { injectionFindings } from "./guard.ts";
import { buildDigest, rankForRecall, type Digest } from "./rank.ts";
import {
  isStatus,
  isType,
  memoryId,
  normalizeContent,
  parseSourceModel,
  parseSpace,
  parseType,
  type Memory,
  type MemoryStatus,
  type MemoryType,
} from "./types.ts";

interface MemoryRow {
  id: string;
  content: string;
  type: string;
  space: string;
  source_model: string | null;
  updated_at: string;
  status: string;
  flags: string | null;
  created_at: string;
}

const parse = (row: MemoryRow): Memory => ({
  id: row.id,
  content: row.content,
  type: isType(row.type) ? row.type : "fact",
  space: row.space,
  source_model: row.source_model,
  updated_at: row.updated_at,
  status: isStatus(row.status) ? row.status : "active",
  flags: row.flags ? (JSON.parse(row.flags) as string[]) : [],
  created_at: row.created_at,
});

export function memoryById(id: string): Memory | undefined {
  const row = getDb().prepare("select * from memories where id = ?").get(id) as MemoryRow | undefined;
  return row && parse(row);
}

export function listMemories(filter: { space?: string; type?: MemoryType; status?: MemoryStatus; q?: string } = {}): Memory[] {
  const rows = getDb().prepare("select * from memories order by updated_at desc, id").all() as unknown as MemoryRow[];
  const q = filter.q?.trim().toLowerCase();
  return rows.map(parse).filter((memory) => {
    if (filter.space && memory.space !== filter.space) return false;
    if (filter.type && memory.type !== filter.type) return false;
    if (filter.status && memory.status !== filter.status) return false;
    if (q && !memory.content.toLowerCase().includes(q)) return false;
    return true;
  });
}

export function activeMemories(): Memory[] {
  return listMemories({ status: "active" });
}

export interface WriteResult {
  memory: Memory;
  action: "added" | "updated" | "skipped" | "quarantined";
}

export interface WriteInput {
  content: string;
  type?: unknown;
  space?: unknown;
  source_model?: unknown;
  /** Screen untrusted writers (MCP, pasted exports). The admin form does not. */
  screen?: boolean;
  /** Import keeps the caller's timestamp. Interactive writes use the server clock. */
  updated_at?: string;
}

function insertMemory(memory: Memory): void {
  getDb()
    .prepare(
      `insert into memories(id, content, type, space, source_model, updated_at, status, flags, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      memory.id,
      memory.content,
      memory.type,
      memory.space,
      memory.source_model,
      memory.updated_at,
      memory.status,
      memory.flags.length ? JSON.stringify(memory.flags) : null,
      memory.created_at,
    );
}

function writeMemory(id: string, fields: Omit<Memory, "id" | "created_at">): void {
  getDb()
    .prepare(
      `update memories set content = ?, type = ?, space = ?, source_model = ?, updated_at = ?, status = ?, flags = ? where id = ?`,
    )
    .run(
      fields.content,
      fields.type,
      fields.space,
      fields.source_model,
      fields.updated_at,
      fields.status,
      fields.flags.length ? JSON.stringify(fields.flags) : null,
      id,
    );
}

/** Remember or refresh one fact. The same normalized content is one row. */
export function createMemory(input: WriteInput): WriteResult {
  const content = normalizeContent(input.content);
  const id = memoryId(content);
  const type = parseType(input.type, "fact");
  const space = parseSpace(input.space, "life");
  const source = parseSourceModel(input.source_model);
  const at = input.updated_at ?? now();
  const flags = input.screen ? injectionFindings(content) : [];
  const status: MemoryStatus = flags.length ? "quarantined" : "active";
  const existing = memoryById(id);

  if (!existing) {
    insertMemory({ id, content, type, space, source_model: source, updated_at: at, status, flags, created_at: at });
    return { memory: memoryById(id)!, action: status === "quarantined" ? "quarantined" : "added" };
  }

  if (Date.parse(at) < Date.parse(existing.updated_at)) return { memory: existing, action: "skipped" };

  writeMemory(id, { content, type, space, source_model: source, updated_at: at, status, flags });
  const action = status === "quarantined" ? "quarantined" : "updated";
  return { memory: memoryById(id)!, action };
}

export interface UpdateInput {
  content?: unknown;
  type?: unknown;
  space?: unknown;
  source_model?: unknown;
  screen?: boolean;
}

/**
 * Edit a memory. Changing the text mints a new content-hash id and leaves a
 * deleted marker on the old id, so an older export of the previous wording
 * cannot bring it back.
 */
export function updateMemory(id: string, patch: UpdateInput): { memory: Memory; previousId: string } {
  const existing = memoryById(id);
  if (!existing || existing.status === "deleted") throw new HttpError(404, "Memory not found");
  if (existing.status === "quarantined") throw new HttpError(409, "Approve or delete this quarantined memory before editing it");

  const content = patch.content === undefined ? existing.content : normalizeContent(String(patch.content));
  const type = patch.type === undefined ? existing.type : parseType(patch.type);
  const space = patch.space === undefined ? existing.space : parseSpace(patch.space);
  const source = patch.source_model === undefined ? existing.source_model : parseSourceModel(patch.source_model);
  const at = now();

  if (content === existing.content) {
    writeMemory(id, { content, type, space, source_model: source, updated_at: at, status: "active", flags: [] });
    return { memory: memoryById(id)!, previousId: id };
  }

  const flags = patch.screen ? injectionFindings(content) : [];
  const status: MemoryStatus = flags.length ? "quarantined" : "active";
  const nextId = memoryId(content);
  withTx(() => {
    writeMemory(id, { ...existing, status: "deleted", flags: [], updated_at: at });
    const prior = memoryById(nextId);
    const row: Memory = {
      id: nextId,
      content,
      type,
      space,
      source_model: source,
      updated_at: at,
      status,
      flags,
      created_at: prior?.created_at ?? at,
    };
    if (prior) writeMemory(nextId, row);
    else insertMemory(row);
  });
  return { memory: memoryById(nextId)!, previousId: id };
}

export function forgetMemory(id: string): { id: string; already: boolean } {
  const existing = memoryById(id);
  if (!existing) throw new HttpError(404, "Memory not found");
  if (existing.status === "deleted") return { id, already: true };
  writeMemory(id, { ...existing, status: "deleted", flags: [], updated_at: now() });
  return { id, already: false };
}

export function approveMemory(id: string): Memory {
  const existing = memoryById(id);
  if (!existing) throw new HttpError(404, "Memory not found");
  if (existing.status !== "quarantined") throw new HttpError(409, "Memory is not quarantined");
  writeMemory(id, { ...existing, status: "active", flags: [], updated_at: now() });
  return memoryById(id)!;
}

export function decideQuarantine(action: "approve" | "delete"): { action: "approve" | "delete"; count: number } {
  if (action !== "approve" && action !== "delete") throw new HttpError(400, "action must be approve or delete");
  const rows = listMemories({ status: "quarantined" });
  for (const memory of rows) {
    if (action === "approve") approveMemory(memory.id);
    else forgetMemory(memory.id);
  }
  return { action, count: rows.length };
}

export function recall(query: string, limit = 8): (Memory & { score: number })[] {
  const size = Math.min(Math.max(limit, 1), 30);
  return rankForRecall(activeMemories(), query, size);
}

export function digest(query?: string): Digest {
  return buildDigest(activeMemories(), query);
}

export type MergeAction = "added" | "updated" | "deleted" | "skipped" | "quarantined";

export interface MergeStats {
  added: number;
  updated: number;
  deleted: number;
  skipped: number;
  quarantined: number;
}

export interface PortableWrite {
  id: string;
  content: string;
  type: MemoryType;
  space: string;
  source_model: string | null;
  updated_at: string;
  deleted: boolean;
}

/**
 * Merge one portable record.
 * Newer updated_at wins. The same timestamp keeps the local row, except a
 * delete beats an active row. An older export therefore cannot revive a
 * memory this store has already deleted.
 */
export function mergePortable(record: PortableWrite, opts: { screen: boolean }): MergeAction {
  const flags = opts.screen && !record.deleted ? injectionFindings(record.content) : [];
  const status: MemoryStatus = record.deleted ? "deleted" : flags.length ? "quarantined" : "active";
  const existing = memoryById(record.id);
  const actionFor = (): MergeAction => (status === "quarantined" ? "quarantined" : status === "deleted" ? "deleted" : "added");

  if (!existing) {
    insertMemory({
      id: record.id,
      content: record.content,
      type: record.type,
      space: record.space,
      source_model: record.source_model,
      updated_at: record.updated_at,
      status,
      flags,
      created_at: record.updated_at,
    });
    return actionFor();
  }

  const delta = Date.parse(record.updated_at) - Date.parse(existing.updated_at);
  if (delta < 0) return "skipped";
  if (delta === 0) {
    if (record.deleted && existing.status !== "deleted") {
      writeMemory(record.id, {
        content: record.content,
        type: record.type,
        space: record.space,
        source_model: record.source_model,
        updated_at: record.updated_at,
        status: "deleted",
        flags: [],
      });
      return "deleted";
    }
    return "skipped";
  }

  writeMemory(record.id, {
    content: record.content,
    type: record.type,
    space: record.space,
    source_model: record.source_model,
    updated_at: record.updated_at,
    status,
    flags,
  });
  if (status === "quarantined") return "quarantined";
  if (status === "deleted") return "deleted";
  return "updated";
}

export function mergeAll(records: PortableWrite[], opts: { screen: boolean }): MergeStats {
  const stats: MergeStats = { added: 0, updated: 0, deleted: 0, skipped: 0, quarantined: 0 };
  withTx(() => {
    for (const record of records) stats[mergePortable(record, opts)]++;
  });
  return stats;
}
