import { HttpError } from "../db.ts";
import { memoryId, normalizeContent, parseSourceModel, parseSpace, parseType, type MemoryType } from "../memory/types.ts";
import { FORMAT_VERSION, type PortableMemory } from "./format.ts";

/**
 * Human-readable native markdown. The heading is the memory text.
 * JSON is the checksummed format; this one still round-trips the same fields.
 */
export function toMarkdown(memories: PortableMemory[]): string {
  const blocks = [...memories]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((memory) =>
      [
        `## ${memory.content}`,
        `- id: ${memory.id}`,
        `- type: ${memory.type}`,
        `- space: ${memory.space}`,
        `- source_model: ${memory.source_model ?? ""}`,
        `- updated_at: ${memory.updated_at}`,
        `- deleted: ${memory.deleted ? "true" : "false"}`,
      ].join("\n"),
    );
  return `# rolemem memories\nversion: ${FORMAT_VERSION}\n\n${blocks.join("\n\n")}\n`;
}

export function fromMarkdown(text: string): PortableMemory[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const version = /^version:\s*(\d+)\s*$/m.exec(normalized);
  if (version && version[1] !== String(FORMAT_VERSION)) throw new HttpError(400, "Unsupported markdown export version");
  const memories: PortableMemory[] = [];
  const seen = new Set<string>();
  for (const chunk of normalized.split(/\n(?=## )/)) {
    if (!chunk.startsWith("## ")) continue;
    const lines = chunk.trimEnd().split("\n");
    const content = normalizeContent(lines[0]!.replace(/^## /, ""));
    const meta: Record<string, string> = {};
    for (const line of lines.slice(1)) {
      const match = /^-\s+([a-z_]+):\s*(.*)$/.exec(line.trim());
      if (match) meta[match[1]!] = match[2] ?? "";
    }
    const id = meta.id ?? "";
    if (id !== memoryId(content)) throw new HttpError(400, "Markdown memory id does not match the content hash");
    if (seen.has(id)) throw new HttpError(400, `Duplicate memory id ${id.slice(0, 8)}`);
    seen.add(id);
    if (!meta.updated_at || !Number.isFinite(Date.parse(meta.updated_at))) throw new HttpError(400, "Markdown memory is missing updated_at");
    const deleted = meta.deleted === "true";
    if (meta.deleted !== "true" && meta.deleted !== "false") throw new HttpError(400, "Markdown memory is missing deleted");
    memories.push({
      id,
      content,
      type: parseType(meta.type as MemoryType | undefined),
      space: parseSpace(meta.space),
      source_model: parseSourceModel(meta.source_model),
      updated_at: meta.updated_at,
      deleted,
    });
  }
  if (!memories.length) throw new HttpError(400, "No memories found in markdown");
  return memories;
}
