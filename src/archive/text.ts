import { HttpError } from "../db.ts";

export const PASTE_SOURCES = ["chatgpt", "claude", "gemini", "other"] as const;
export type PasteSource = (typeof PASTE_SOURCES)[number];

const LINE = /^\s*(?:[-*•]\s*)?(?:\[([^\]]*)\]\s*[-–—:：]?\s*)?(.+?)\s*$/;

export function isPasteSource(value: string): value is PasteSource {
  return (PASTE_SOURCES as readonly string[]).includes(value);
}

/** ChatGPT, Claude, and Gemini memory exports: one memory per line, optional `[date] -`. */
export function parseMemoryExport(text: string): { text: string; observed?: string }[] {
  const out: { text: string; observed?: string }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("```")) continue;
    const match = LINE.exec(raw);
    const content = match?.[2]?.replace(/^[-–—]\s*/, "").trim();
    if (!content || /[:：]$/.test(content)) continue;
    const date = match?.[1] ? new Date(match[1]) : undefined;
    out.push({ text: content, ...(date && !Number.isNaN(date.getTime()) ? { observed: date.toISOString() } : {}) });
  }
  return out;
}

export function requirePasteItems(text: string): { text: string; observed?: string }[] {
  const items = parseMemoryExport(text ?? "");
  if (!items.length) throw new HttpError(400, "No memories found. Use one per line, optionally prefixed with [date] -");
  return items;
}
