import { HttpError, withTx } from "../db.ts";
import { createMemory, listMemories, mergeAll, type MergeStats } from "../memory/store.ts";
import { memoryId, normalizeContent, parseSourceModel, parseSpace, parseType, type Memory } from "../memory/types.ts";
import { fromMarkdown, toMarkdown } from "./markdown.ts";
import { maskText } from "./pii.ts";
import { readPortable, seal, type PortableFile, type PortableMemory } from "./format.ts";
import { isPasteSource, requirePasteItems, type PasteSource } from "./text.ts";

function toPortable(memory: Memory, maskPii: boolean): PortableMemory {
  const content = maskPii ? normalizeContent(maskText(memory.content).text) : memory.content;
  return {
    id: memoryId(content),
    content,
    type: memory.type,
    space: memory.space,
    source_model: memory.source_model,
    updated_at: memory.updated_at,
    deleted: memory.status === "deleted",
  };
}

/** Active memories and deleted markers. Quarantine stays local until the operator decides. */
export function exportMemories(opts: { maskPii?: boolean } = {}): PortableMemory[] {
  const maskPii = opts.maskPii === true;
  const byId = new Map<string, PortableMemory>();
  for (const memory of listMemories()) {
    if (memory.status !== "active" && memory.status !== "deleted") continue;
    const portable = toPortable(memory, maskPii);
    const prev = byId.get(portable.id);
    if (!prev || Date.parse(portable.updated_at) >= Date.parse(prev.updated_at)) byId.set(portable.id, portable);
  }
  return [...byId.values()];
}

export function exportPortable(opts: { maskPii?: boolean } = {}): PortableFile {
  return seal(exportMemories(opts));
}

export function exportMarkdown(opts: { maskPii?: boolean } = {}): string {
  return toMarkdown(exportMemories(opts));
}

export function importPortable(value: unknown, opts: { screen?: boolean } = {}): MergeStats {
  return mergeAll(readPortable(value), { screen: opts.screen === true });
}

export function importMarkdown(text: string, opts: { screen?: boolean } = {}): MergeStats {
  return mergeAll(fromMarkdown(text), { screen: opts.screen === true });
}

export function importPaste(
  text: string,
  opts: { source: string; space?: unknown; type?: unknown; source_model?: unknown },
): MergeStats {
  if (!isPasteSource(opts.source)) throw new HttpError(400, "source must be chatgpt, claude, gemini, or other");
  const source = opts.source as PasteSource;
  const items = requirePasteItems(text);
  const stats: MergeStats = { added: 0, updated: 0, deleted: 0, skipped: 0, quarantined: 0, conflicts: 0 };
  withTx(() => {
    for (const item of items) {
      const result = createMemory({
        content: item.text,
        type: parseType(opts.type, "fact"),
        space: parseSpace(opts.space, "life"),
        source_model: parseSourceModel(opts.source_model) ?? source,
        screen: true,
        updated_at: item.observed,
      });
      stats[result.action]++;
    }
  });
  return stats;
}
