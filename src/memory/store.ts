import { createHash } from "node:crypto";
import { audit } from "../audit.ts";
import { getDb, HttpError, now, withTx } from "../db.ts";
import { secretFindings } from "../work/redact.ts";
import { injectionFindings } from "./guard.ts";
import { buildDigest, rankForRecall, type Digest, type RankedMemory } from "./rank.ts";
import {
  isStatus,
  isType,
  memoryId,
  normalizeContent,
  parseImportance,
  parseProject,
  parseSourceModel,
  parseSpace,
  parseType,
  parseWorkId,
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
  importance: number | null;
  project: string | null;
  work_id: string | null;
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
  importance: row.importance ?? null,
  project: row.project ?? null,
  work_id: row.work_id ?? null,
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
  importance?: unknown;
  project?: unknown;
  work_id?: unknown;
  actor?: string | null;
}

function insertMemory(memory: Memory): void {
  getDb()
    .prepare(
      `insert into memories(id, content, type, space, source_model, updated_at, status, flags, created_at, importance, project, work_id)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      memory.importance,
      memory.project,
      memory.work_id,
    );
}

function writeMemory(id: string, fields: Omit<Memory, "id" | "created_at">): void {
  getDb()
    .prepare(
      `update memories set content = ?, type = ?, space = ?, source_model = ?, updated_at = ?, status = ?, flags = ?, importance = ?, project = ?, work_id = ? where id = ?`,
    )
    .run(
      fields.content,
      fields.type,
      fields.space,
      fields.source_model,
      fields.updated_at,
      fields.status,
      fields.flags.length ? JSON.stringify(fields.flags) : null,
      fields.importance,
      fields.project,
      fields.work_id,
      id,
    );
}

/** Remember or refresh one fact. The same normalized content is one row. */
function linksFrom(input: { importance?: unknown; project?: unknown; work_id?: unknown }, fallback?: Pick<Memory, "importance" | "project" | "work_id">) {
  return {
    importance: input.importance === undefined ? (fallback?.importance ?? null) : parseImportance(input.importance),
    project: input.project === undefined ? (fallback?.project ?? null) : parseProject(input.project),
    work_id: input.work_id === undefined ? (fallback?.work_id ?? null) : parseWorkId(input.work_id),
  };
}

function refuseSecret(content: string): void {
  const labels = secretFindings(content);
  if (labels.length) throw new HttpError(400, "Refused: the text looks like a credential and was not stored");
}

export interface MemoryConflict {
  id: string;
  memory_id: string;
  previous_id: string | null;
  old_content: string;
  new_content: string;
  old_updated_at: string;
  new_updated_at: string;
  resolution: string;
  created_at: string;
}

function recordConflict(input: {
  memoryId: string;
  previousId: string | null;
  oldContent: string;
  newContent: string;
  oldUpdated: string;
  newUpdated: string;
}): void {
  if (input.oldContent === input.newContent) return;
  const id = createHash("sha256")
    .update(`${input.memoryId}\n${input.newUpdated}\n${input.oldContent}\n${input.newContent}`)
    .digest("hex")
    .slice(0, 32);
  getDb()
    .prepare(
      `insert or ignore into memory_conflicts(id, memory_id, previous_id, old_content, new_content, old_updated_at, new_updated_at, resolution, created_at)
       values (?, ?, ?, ?, ?, ?, ?, 'kept_newer', ?)`,
    )
    .run(id, input.memoryId, input.previousId, input.oldContent, input.newContent, input.oldUpdated, input.newUpdated, now());
}

export function listConflicts(limit = 50): MemoryConflict[] {
  const size = Math.min(Math.max(limit, 1), 200);
  return getDb().prepare("select * from memory_conflicts order by created_at desc, id limit ?").all(size) as unknown as MemoryConflict[];
}

/** Remember or refresh one fact. The same normalized content is one row. */
export function createMemory(input: WriteInput): WriteResult {
  const content = normalizeContent(input.content);
  refuseSecret(content);
  const id = memoryId(content);
  const type = parseType(input.type, "fact");
  const space = parseSpace(input.space, "life");
  const source = parseSourceModel(input.source_model);
  const at = input.updated_at ?? now();
  const flags = input.screen ? injectionFindings(content) : [];
  const status: MemoryStatus = flags.length ? "quarantined" : "active";
  const linked = linksFrom(input);
  const existing = memoryById(id);

  if (!existing) {
    insertMemory({ id, content, type, space, source_model: source, updated_at: at, status, flags, created_at: at, ...linked });
    audit(status === "quarantined" ? "memory.quarantine" : "memory.create", id, status, input.actor ?? source);
    return { memory: memoryById(id)!, action: status === "quarantined" ? "quarantined" : "added" };
  }

  if (Date.parse(at) < Date.parse(existing.updated_at)) return { memory: existing, action: "skipped" };

  writeMemory(id, { content, type, space, source_model: source, updated_at: at, status, flags, ...linksFrom(input, existing) });
  audit(status === "quarantined" ? "memory.quarantine" : "memory.update", id, status, input.actor ?? source);
  const action = status === "quarantined" ? "quarantined" : "updated";
  return { memory: memoryById(id)!, action };
}

export interface UpdateInput {
  content?: unknown;
  type?: unknown;
  space?: unknown;
  source_model?: unknown;
  screen?: boolean;
  importance?: unknown;
  project?: unknown;
  work_id?: unknown;
  actor?: string | null;
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
  refuseSecret(content);
  const type = patch.type === undefined ? existing.type : parseType(patch.type);
  const space = patch.space === undefined ? existing.space : parseSpace(patch.space);
  const source = patch.source_model === undefined ? existing.source_model : parseSourceModel(patch.source_model);
  const linked = linksFrom(patch, existing);
  const at = now();

  if (content === existing.content) {
    writeMemory(id, { content, type, space, source_model: source, updated_at: at, status: "active", flags: [], ...linked });
    audit("memory.update", id, "metadata", patch.actor ?? source);
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
      ...linked,
    };
    if (prior) writeMemory(nextId, row);
    else insertMemory(row);
    recordConflict({
      memoryId: nextId,
      previousId: id,
      oldContent: existing.content,
      newContent: content,
      oldUpdated: existing.updated_at,
      newUpdated: at,
    });
  });
  audit("memory.update", nextId, "content replaced", patch.actor ?? source);
  return { memory: memoryById(nextId)!, previousId: id };
}

export function forgetMemory(id: string): { id: string; already: boolean } {
  const existing = memoryById(id);
  if (!existing) throw new HttpError(404, "Memory not found");
  if (existing.status === "deleted") return { id, already: true };
  writeMemory(id, { ...existing, status: "deleted", flags: [], updated_at: now() });
  audit("memory.forget", id, "deleted", null);
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

export function recall(query: string, limit = 8): RankedMemory[] {
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
  conflicts: number;
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
export function mergePortable(record: PortableWrite, opts: { screen: boolean }): { action: MergeAction; conflict: boolean } {
  const flags = opts.screen && !record.deleted ? injectionFindings(record.content) : [];
  const status: MemoryStatus = record.deleted ? "deleted" : flags.length ? "quarantined" : "active";
  const existing = memoryById(record.id);
  const actionFor = (): MergeAction => (status === "quarantined" ? "quarantined" : status === "deleted" ? "deleted" : "added");
  const linked = { importance: null, project: null, work_id: null };

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
      ...linked,
    });
    return { action: actionFor(), conflict: false };
  }

  const delta = Date.parse(record.updated_at) - Date.parse(existing.updated_at);
  if (delta < 0) return { action: "skipped", conflict: false };
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
        importance: existing.importance,
        project: existing.project,
        work_id: existing.work_id,
      });
      return { action: "deleted", conflict: false };
    }
    return { action: "skipped", conflict: false };
  }

  const conflict = record.content !== existing.content;
  if (conflict) {
    recordConflict({
      memoryId: record.id,
      previousId: record.id,
      oldContent: existing.content,
      newContent: record.content,
      oldUpdated: existing.updated_at,
      newUpdated: record.updated_at,
    });
  }
  writeMemory(record.id, {
    content: record.content,
    type: record.type,
    space: record.space,
    source_model: record.source_model,
    updated_at: record.updated_at,
    status,
    flags,
    importance: existing.importance,
    project: existing.project,
    work_id: existing.work_id,
  });
  if (status === "quarantined") return { action: "quarantined", conflict };
  if (status === "deleted") return { action: "deleted", conflict };
  return { action: "updated", conflict };
}

export function mergeAll(records: PortableWrite[], opts: { screen: boolean }): MergeStats {
  const stats: MergeStats = { added: 0, updated: 0, deleted: 0, skipped: 0, quarantined: 0, conflicts: 0 };
  withTx(() => {
    for (const record of records) {
      const merged = mergePortable(record, opts);
      stats[merged.action]++;
      if (merged.conflict) stats.conflicts++;
    }
  });
  if (records.length) audit("memory.import", null, `added ${stats.added} updated ${stats.updated} deleted ${stats.deleted}`, null);
  return stats;
}
