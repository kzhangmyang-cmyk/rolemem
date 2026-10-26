// Recall eval. Structural checks always run. A model check runs when LLM_* is set.
// This is the path toward "almost all correct" cross-model recall. It is not that bar yet.
//   npm run eval
//   npm run eval -- --verbose
process.env.ROLEMEM_DB = ":memory:";
process.env.ROLEMEM_ADMIN_TOKEN ??= "eval-admin-token-rolemem";

import { readFileSync } from "node:fs";
import { createMemory } from "../src/memory/store.ts";
import { digest, recall } from "../src/memory/store.ts";
import { sessionText } from "../src/mcp/norms.ts";
import { complete, llmConfigured } from "../src/llm.ts";

interface FixtureMemory {
  content: string;
  type: "preference" | "fact" | "project" | "procedure";
  space: string;
  source_model: string;
}
interface Question {
  q: string;
  anchors: string[];
  lexical: boolean;
  note?: string;
}

const verbose = process.argv.includes("--verbose");
const fixture = JSON.parse(readFileSync(new URL("../eval/fixtures.json", import.meta.url), "utf8")) as {
  memories: FixtureMemory[];
  questions: Question[];
};

for (const memory of fixture.memories) createMemory({ ...memory, screen: false });

const snapshot = digest();
let failed = 0;
const check = (name: string, pass: boolean, detail: string) => {
  if (!pass) failed++;
  console.log(`${pass ? "ok" : "FAIL"}  ${name}  ${detail}`);
};

check("digest is a full inject", snapshot.mode === "full" && snapshot.included === fixture.memories.length, `mode=${snapshot.mode} showing=${snapshot.included}`);
for (const memory of fixture.memories) {
  check("digest contains taught fact", snapshot.text.includes(memory.content), memory.content);
}

console.log("\nLexical recall (the in-process ranker, not a model):");
for (const question of fixture.questions) {
  const hits = recall(question.q, 3);
  const top = hits[0]?.content ?? "";
  const hit = question.anchors.every((anchor) => top.includes(anchor));
  if (question.lexical) check(`recall “${question.q}”`, hit, top || "no hit");
  else console.log(`gap  recall “${question.q}”  ${hit ? "unexpected hit" : "miss, as expected"}  ${question.note ?? ""}`);
  if (verbose && hits.length) console.log(hits.map((memory) => `    ${memory.score.toFixed(2)} ${memory.content}`).join("\n"));
}

if (!llmConfigured()) {
  console.log("\nModel check skipped. Set LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL to score answers that only have the digest, including the paraphrase lexical recall misses.");
} else {
  console.log(`\nModel check (${process.env.LLM_MODEL}), digest injected as the system prompt:`);
  const system = sessionText();
  for (const question of fixture.questions) {
    const answer = await complete([
      { role: "system", content: system },
      { role: "user", content: question.q },
    ]);
    const hit = question.anchors.some((anchor) => answer.includes(anchor));
    check(`model “${question.q}”`, hit, hit ? "anchor present" : "anchor missing");
    if (verbose) console.log(answer);
  }
}

console.log(`
Gaps before the acceptance bar (almost all taught facts recalled correctly, across models):
- The ranker is character overlap, not meaning. “What is their home city?” does not retrieve Lisbon.
- There is no harness that drives Claude, Cursor, and ChatGPT through MCP and scores them against one fixture.
- Full inject covers a few hundred memories. Above the cap, selection is importance then recency, or relevance when a question is present. It is not a learned ranker.
- FTS5 is not built. Add it only if paraphrase misses show up in a real log.
- Quarantine is a regex list. Rephrased injections pass.
- npm run eval with a model scores one judge looking at the digest. That is necessary and not sufficient.
`);

process.exit(failed ? 1 : 0);
