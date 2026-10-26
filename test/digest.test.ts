process.env.ROLEMEM_DB = ":memory:";
process.env.ROLEMEM_ADMIN_TOKEN = "test-admin-token-please";
process.env.ROLEMEM_RATE_PER_MIN = "10000";

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { getDb } from "../src/db.ts";
import { digest } from "../src/memory/store.ts";
import { call } from "../scripts/client.ts";

beforeEach(() => {
  getDb().exec("delete from memories; delete from connections;");
  delete process.env.ROLEMEM_DIGEST_CHAR_CAP;
  delete process.env.ROLEMEM_DIGEST_MAX;
});

test("a small archive is injected in full, preferences before facts", async () => {
  await call("POST", "/api/memories", { content: "A fact about the office kettle.", type: "fact", space: "work" });
  await call("POST", "/api/memories", { content: "Always write the answer in short paragraphs.", type: "preference", space: "work" });
  const snapshot = digest();
  assert.equal(snapshot.mode, "full");
  assert.equal(snapshot.included, 2);
  assert.ok(snapshot.text.indexOf("short paragraphs") < snapshot.text.indexOf("office kettle"));
});

test("over the cap, a question falls back to relevance and a bare digest keeps important memories", async () => {
  process.env.ROLEMEM_DIGEST_MAX = "2";
  await call("POST", "/api/memories", { content: "The user lives in Lisbon and commutes by tram.", type: "fact", space: "life" });
  await call("POST", "/api/memories", { content: "Always write the answer in short paragraphs.", type: "preference", space: "work" });
  await call("POST", "/api/memories", { content: "Quotes should offer three tiers after the budget is confirmed.", type: "procedure", space: "work" });
  const bare = digest();
  assert.equal(bare.mode, "important");
  assert.equal(bare.included, 2);
  assert.match(bare.text, /short paragraphs/);
  assert.match(bare.text, /three tiers/);
  assert.doesNotMatch(bare.text, /Lisbon/);

  const focused = digest("Where is Lisbon and which tram?");
  assert.equal(focused.mode, "relevance");
  assert.match(focused.text, /Lisbon/);
});
