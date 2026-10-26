import type { Memory, MemoryType } from "./types.ts";

const TYPE_WEIGHT: Record<MemoryType, number> = {
  preference: 4,
  procedure: 3,
  project: 2,
  fact: 1,
};

/** Chinese has no spaces: CJK bigrams plus Latin words. Enough while the store is small. */
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const word of lower.match(/[a-z0-9]+/g) ?? []) out.add(word);
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

export function overlap(query: Set<string>, text: string): number {
  if (!query.size) return 0;
  let hit = 0;
  for (const term of terms(text)) if (query.has(term)) hit++;
  return hit / query.size;
}

export function digestCharCap(): number {
  const n = Number(process.env.ROLEMEM_DIGEST_CHAR_CAP);
  return Number.isFinite(n) && n >= 200 ? n : 48_000;
}

export function digestCountCap(): number {
  const n = Number(process.env.ROLEMEM_DIGEST_MAX);
  return Number.isFinite(n) && n >= 1 ? n : 300;
}

export interface DigestMemory {
  id: string;
  content: string;
  type: MemoryType;
  space: string;
  source_model: string | null;
  updated_at: string;
}

export interface Digest {
  mode: "full" | "important" | "relevance";
  total: number;
  included: number;
  text: string;
  memories: DigestMemory[];
}

export function compareImportance(a: Memory, b: Memory): number {
  const weight = TYPE_WEIGHT[b.type] - TYPE_WEIGHT[a.type];
  if (weight) return weight;
  return b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id);
}

function block(memory: Memory): string {
  const source = memory.source_model ? ` source=${memory.source_model}` : "";
  return `- [${memory.id}] (${memory.type}/${memory.space}) ${memory.updated_at}${source}\n  ${memory.content}`;
}

function render(mode: Digest["mode"], shown: Memory[], total: number): string {
  const omitted = total - shown.length;
  const note =
    omitted > 0
      ? `\n\n${omitted} more memories are not in this digest. Call recall with a specific query before relying on memory.`
      : "";
  const body = shown.map(block).join("\n");
  return `# Memory digest\nmode: ${mode}\nshowing: ${shown.length} of ${total}\n\n${body}${note}`;
}

/**
 * Full inject while the archive is small. Past the count or character cap,
 * keep the most important and recent memories. A query switches that cut to
 * lexical relevance so the prompt can focus on the question in front of the model.
 */
export function buildDigest(memories: Memory[], query?: string): Digest {
  const total = memories.length;
  const cap = digestCharCap();
  const maxCount = digestCountCap();
  const ordered = [...memories].sort(compareImportance);
  const fullText = render("full", ordered, total);
  if (total <= maxCount && fullText.length <= cap) {
    return { mode: "full", total, included: total, text: fullText, memories: ordered.map(pick) };
  }

  const q = query?.trim() ? terms(query) : undefined;
  const mode: Digest["mode"] = q ? "relevance" : "important";
  const ranked = q
    ? [...memories].sort((a, b) => overlap(q, b.content) - overlap(q, a.content) || compareImportance(a, b))
    : ordered;

  const shown: Memory[] = [];
  let size = render(mode, [], total).length;
  for (const memory of ranked) {
    const next = block(memory);
    const extra = (shown.length ? 1 : 0) + next.length;
    if (shown.length > 0 && size + extra > cap) break;
    if (shown.length >= maxCount) break;
    shown.push(memory);
    size += extra;
    if (shown.length === 1 && size > cap) break;
  }
  return { mode, total, included: shown.length, text: render(mode, shown, total), memories: shown.map(pick) };
}

function pick(memory: Memory): DigestMemory {
  return {
    id: memory.id,
    content: memory.content,
    type: memory.type,
    space: memory.space,
    source_model: memory.source_model,
    updated_at: memory.updated_at,
  };
}

export function rankForRecall(memories: Memory[], query: string, limit: number): (Memory & { score: number })[] {
  const q = terms(query);
  return memories
    .map((memory) => ({ ...memory, score: overlap(q, memory.content) }))
    .filter((memory) => memory.score > 0)
    .sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
    .slice(0, limit);
}
