import { getDb } from "../db.ts";

let enabled = false;
let reason: string | undefined;

export function setFts5(on: boolean, error?: string): void {
  enabled = on;
  reason = error;
}

export function fts5Enabled(): boolean {
  return enabled;
}

export function fts5Status(): { enabled: boolean; error?: string } {
  return { enabled, ...(reason ? { error: reason } : {}) };
}

export interface FtsHit {
  id: string;
  /** 1 is the best FTS row. */
  rank: number;
}

/** `match` is an FTS5 MATCH expression built by the ranker. */
export function ftsHits(match: string): FtsHit[] {
  if (!enabled || !match.trim()) return [];
  try {
    const rows = getDb()
      .prepare(`select id from memories_fts where memories_fts match ? order by bm25(memories_fts) limit 20`)
      .all(match) as { id: string }[];
    return rows.map((row, index) => ({ id: row.id, rank: index + 1 }));
  } catch {
    return [];
  }
}
