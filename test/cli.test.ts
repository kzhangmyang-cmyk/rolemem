import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeCodeCommand, codexSnippet, launchdPlist, upsertCodexToml, upsertCursorJson } from "../src/cli/clients.ts";

test("Codex config replaces the named server and can keep the key in a header", () => {
  const original = 'model = "gpt-5"\n\n[mcp_servers.other]\nurl = "http://x"\n\n[mcp_servers.rolemem]\nurl = "http://old"\n\n[profiles.fast]\nmodel = "mini"\n';
  const out = upsertCodexToml(original, "rolemem", "http://127.0.0.1:8787/mcp/rmk_new");
  assert.ok(out.includes('model = "gpt-5"'));
  assert.ok(out.includes('[mcp_servers.other]\nurl = "http://x"'));
  assert.ok(out.includes('[profiles.fast]\nmodel = "mini"'));
  assert.ok(!out.includes("http://old"));
  assert.equal(out.match(/\[mcp_servers\.rolemem\]/g)!.length, 1);
  assert.ok(out.endsWith('[mcp_servers.rolemem]\nurl = "http://127.0.0.1:8787/mcp/rmk_new"\n'));
  assert.equal(upsertCodexToml("", "rolemem", "u"), '[mcp_servers.rolemem]\nurl = "u"\n');

  const headed = upsertCodexToml(out, "rolemem", "http://127.0.0.1:8787/mcp", { Authorization: "Bearer rmk_new" });
  assert.equal(headed.match(/\[mcp_servers\.rolemem\]/g)!.length, 1);
  assert.match(headed, /\[mcp_servers\.rolemem\.http_headers\]\nAuthorization = "Bearer rmk_new"/);
  assert.ok(!headed.includes("/mcp/rmk_new"));
  assert.equal(codexSnippet("http://127.0.0.1:8787/mcp", "rmk_k").includes("Bearer rmk_k"), true);
});

test("Cursor config merges mcpServers and puts the key in a header", () => {
  const out = JSON.parse(upsertCursorJson('{"mcpServers":{"gh":{"command":"gh"}},"x":1}', "rolemem", "http://h/mcp", "rmk_k"));
  assert.deepEqual(out.mcpServers.gh, { command: "gh" });
  assert.deepEqual(out.mcpServers.rolemem, { url: "http://h/mcp", headers: { Authorization: "Bearer rmk_k" } });
  assert.equal(out.x, 1);
  assert.match(claudeCodeCommand("rolemem", "http://h/mcp", "rmk_k"), /--transport http rolemem http:\/\/h\/mcp --header "Authorization: Bearer rmk_k"/);
});

test("launchd plist escapes the working directory and restarts on exit", () => {
  const plist = launchdPlist({
    node: "/opt/node/bin/node",
    projectDir: "/srv/rolemem",
    env: { PORT: "8787", ROLEMEM_DB: "/srv/a&b.db" },
    log: "/srv/rolemem/data/server.log",
  });
  assert.match(plist, /<key>WorkingDirectory<\/key><string>\/srv\/rolemem<\/string>/);
  assert.match(plist, /<string>src\/server.ts<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /\/srv\/a&amp;b\.db/);
});
