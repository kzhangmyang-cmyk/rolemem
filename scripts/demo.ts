// Portable round-trip against an in-memory database. Does not touch data/rolemem.db.
process.env.ROLEMEM_DB = ":memory:";
process.env.ROLEMEM_ADMIN_TOKEN ??= "demo-admin-token-rolemem";

const { call } = await import("./client.ts");
const { getDb } = await import("../src/db.ts");

await call("POST", "/api/memories", {
  content: "The user lives in Lisbon and commutes by tram.",
  type: "fact",
  space: "life",
  source_model: "demo",
});
await call("POST", "/api/memories", {
  content: "Quotes should offer three tiers after the budget is confirmed.",
  type: "procedure",
  space: "work",
  source_model: "demo",
});

const file = await call("GET", "/api/export");
console.log(`Exported ${file.memories.length} memories, sha256 ${file.sha256.slice(0, 12)}…`);
getDb().exec("delete from memories");
const imported = await call("POST", "/api/import", { document: file });
console.log(`Empty store import: added ${imported.added}, skipped ${imported.skipped}`);
const again = await call("GET", "/api/export");
console.log(again.sha256 === file.sha256 ? "Round-trip sha256 matches." : "Round-trip sha256 differs.");
const snapshot = await call("GET", "/api/digest");
console.log(`\nDigest mode ${snapshot.mode}, showing ${snapshot.included} of ${snapshot.total}\n`);
console.log(snapshot.text);
