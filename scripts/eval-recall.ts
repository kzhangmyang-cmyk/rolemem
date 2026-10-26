// Compare the 0.3 lexical ranker with the current ranker on a fixed bench.
// Prints Recall@5 and MRR. Exits 1 only when the new ranker drops a hit the old one had,
// or returns a hit for a query both should leave empty.
//   npm run eval:recall
process.env.ROLEMEM_DB = ":memory:";
process.env.ROLEMEM_ADMIN_TOKEN ??= "eval-admin-token-rolemem";

import { readFileSync } from "node:fs";
import { createMemory } from "../src/memory/store.ts";
import { activeMemories } from "../src/memory/store.ts";
import { fts5Enabled } from "../src/memory/fts.ts";
import { rankForRecall, rankLexical } from "../src/memory/rank.ts";

interface BenchMemory {
  key: string;
  content: string;
  type: "preference" | "fact" | "project" | "procedure";
  space: string;
  project?: string;
  work_id?: string;
  updated_at: string;
}
interface BenchQuestion {
  name: string;
  q: string;
  expect: string[];
  kind: string;
  gap?: boolean;
}

const bench = JSON.parse(readFileSync(new URL("../eval/recall-bench.json", import.meta.url), "utf8")) as {
  memories: BenchMemory[];
  questions: BenchQuestion[];
};

const ids = new Map<string, string>();
for (const memory of bench.memories) {
  const saved = createMemory({ ...memory, screen: false });
  ids.set(memory.key, saved.memory.id);
}

const memories = activeMemories();
const K = 5;

function expand(query: string): string {
  return query.replace(/\$id:([a-z0-9-]+)/g, (_, key: string) => ids.get(key) ?? key);
}

function firstRank(ranked: { id: string }[], expect: string[]): number | null {
  const wanted = new Set(expect);
  const index = ranked.findIndex((memory) => wanted.has(memory.id));
  return index === -1 ? null : index + 1;
}

let oldMrr = 0;
let newMrr = 0;
let oldRecall = 0;
let newRecall = 0;
let scored = 0;
let regressions = 0;
const rows: string[] = [];

for (const question of bench.questions) {
  const query = expand(question.q);
  const expect = question.expect.map((key) => ids.get(key) ?? key);
  const oldHits = rankLexical(memories, query, K);
  const newHits = rankForRecall(memories, query, K);
  const oldRank = firstRank(oldHits, expect);
  const newRank = firstRank(newHits, expect);
  const oldEmptyOk = expect.length === 0 && oldHits.length === 0;
  const newEmptyOk = expect.length === 0 && newHits.length === 0;
  if (!question.gap) {
    scored++;
    if (expect.length === 0) {
      oldMrr += oldEmptyOk ? 1 : 0;
      newMrr += newEmptyOk ? 1 : 0;
      oldRecall += oldEmptyOk ? 1 : 0;
      newRecall += newEmptyOk ? 1 : 0;
      if (oldEmptyOk && !newEmptyOk) regressions++;
    } else {
      oldMrr += oldRank ? 1 / oldRank : 0;
      newMrr += newRank ? 1 / newRank : 0;
      oldRecall += oldRank && oldRank <= K ? 1 : 0;
      newRecall += newRank && newRank <= K ? 1 : 0;
      if (oldRank && !newRank) regressions++;
    }
  }
  const format = (rank: number | null, emptyOk: boolean) => {
    if (question.gap) return rank ? `unexpected #${rank}` : "miss (known gap)";
    if (!expect.length) return emptyOk ? "empty" : "false positive";
    return rank ? `#${rank}` : "miss";
  };
  rows.push(
    `${format(oldRank, oldEmptyOk).padEnd(18)} ${format(newRank, newEmptyOk).padEnd(18)} ${question.kind.padEnd(18)} ${question.name}`,
  );
}

const summary = {
  fts5: fts5Enabled(),
  questions: scored,
  gaps: bench.questions.filter((question) => question.gap).length,
  old: { recallAt5: oldRecall / scored, mrr: oldMrr / scored },
  new: { recallAt5: newRecall / scored, mrr: newMrr / scored },
  regressions,
};

console.log(`FTS5: ${summary.fts5 ? "on" : "off"}`);
console.log(`${"old".padEnd(18)} ${"new".padEnd(18)} ${"kind".padEnd(18)} question`);
for (const row of rows) console.log(row);
console.log("");
console.log(
  `Recall@5  old ${summary.old.recallAt5.toFixed(3)}  new ${summary.new.recallAt5.toFixed(3)}`,
);
console.log(`MRR       old ${summary.old.mrr.toFixed(3)}  new ${summary.new.mrr.toFixed(3)}`);
console.log(`Regressions ${summary.regressions}. Paraphrase gaps are reported and are not counted as a win.`);
const improved = summary.new.mrr > summary.old.mrr && summary.new.recallAt5 >= summary.old.recallAt5 && summary.regressions === 0;
console.log(improved ? "Comparison: the new ranker scores higher on this bench." : "Comparison: this bench does not support a quality claim.");
console.log(`BENCH ${JSON.stringify(summary)}`);
process.exit(summary.regressions ? 1 : 0);
