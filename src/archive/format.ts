import { createHash } from "node:crypto";
import { HttpError } from "../db.ts";
import { memoryId, normalizeContent, parseSourceModel, parseSpace, parseType, type MemoryType } from "../memory/types.ts";

export const FORMAT_VERSION = 1;

export interface PortableMemory {
  id: string;
  content: string;
  type: MemoryType;
  space: string;
  source_model: string | null;
  updated_at: string;
  deleted: boolean;
}

export interface PortableFile {
  version: number;
  memories: PortableMemory[];
  sha256: string;
}

function canonical(memories: PortableMemory[]): string {
  const rows = memories
    .map((memory) => ({
      id: memory.id,
      content: memory.content,
      type: memory.type,
      space: memory.space,
      source_model: memory.source_model,
      updated_at: memory.updated_at,
      deleted: memory.deleted,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify({ version: FORMAT_VERSION, memories: rows });
}

export function sha256Of(memories: PortableMemory[]): string {
  return createHash("sha256").update(canonical(memories)).digest("hex");
}

export function seal(memories: PortableMemory[]): PortableFile {
  const sorted = [...memories].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { version: FORMAT_VERSION, memories: sorted, sha256: sha256Of(sorted) };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${label} must be a JSON object`);
  return value as Record<string, unknown>;
}

/** Validate a native export. Reject the whole file on any problem so a bad import writes nothing. */
export function readPortable(value: unknown): PortableMemory[] {
  const file = asRecord(value, "Export");
  if (file.version !== FORMAT_VERSION) throw new HttpError(400, `Unsupported export version (expected ${FORMAT_VERSION})`);
  if (!Array.isArray(file.memories)) throw new HttpError(400, "Export is missing memories");
  const seen = new Set<string>();
  const memories: PortableMemory[] = [];
  for (const raw of file.memories) {
    const row = asRecord(raw, "Memory");
    const content = normalizeContent(typeof row.content === "string" ? row.content : "");
    const id = typeof row.id === "string" ? row.id : "";
    if (id !== memoryId(content)) throw new HttpError(400, "Memory id does not match the content hash");
    if (seen.has(id)) throw new HttpError(400, `Duplicate memory id ${id}`);
    seen.add(id);
    if (typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at))) {
      throw new HttpError(400, `Memory ${id.slice(0, 8)} has no valid updated_at`);
    }
    if (typeof row.deleted !== "boolean") throw new HttpError(400, `Memory ${id.slice(0, 8)} is missing deleted`);
    memories.push({
      id,
      content,
      type: parseType(row.type),
      space: parseSpace(row.space),
      source_model: parseSourceModel(row.source_model),
      updated_at: row.updated_at,
      deleted: row.deleted,
    });
  }
  if (file.sha256 !== sha256Of(memories)) throw new HttpError(400, "sha256 does not match the memories");
  return memories;
}
