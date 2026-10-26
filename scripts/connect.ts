// Point one AI client at this server: npm run connect -- cursor|codex|claude-code|url
//   --url http://127.0.0.1:8787
//   --token <admin token>     default: ROLEMEM_ADMIN_TOKEN or data/admin.token
//   --name rolemem
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { CLIENTS, claudeCodeCommand, upsertCodexToml, upsertCursorJson, type Client } from "../src/cli/clients.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    token: { type: "string" },
    name: { type: "string" },
  },
});

const client = positionals[0] as Client;
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
if (!CLIENTS.includes(client)) fail(`Usage: npm run connect -- ${CLIENTS.join(" | ")} [--url URL] [--token TOKEN] [--name rolemem]`);

function adminToken(): string {
  if (values.token?.trim()) return values.token.trim();
  if (process.env.ROLEMEM_ADMIN_TOKEN?.trim()) return process.env.ROLEMEM_ADMIN_TOKEN.trim();
  const db = process.env.ROLEMEM_DB ?? "data/rolemem.db";
  const file = join(dirname(db), "admin.token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  return fail("No admin token. Set ROLEMEM_ADMIN_TOKEN, pass --token, or start the server once so it can write data/admin.token.");
}

const base = (values.url ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`).replace(/\/$/, "");
const name = values.name ?? "rolemem";
const label = { codex: "Codex", cursor: "Cursor", "claude-code": "Claude Code", url: "URL client" }[client];
const token = adminToken();

const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const listed = await fetch(`${base}/api/connections`, { headers });
if (!listed.ok) fail(`Could not reach ${base} (${listed.status}). Start rolemem first (npm start or Docker).`);
const { connections } = (await listed.json()) as { connections: { id: string; label: string }[] };
for (const connection of connections.filter((item) => item.label === label)) {
  const removed = await fetch(`${base}/api/connections/${connection.id}`, { method: "DELETE", headers });
  if (!removed.ok) fail(`Could not rotate the previous ${label} key (${removed.status}).`);
}
const created = await fetch(`${base}/api/connections`, { method: "POST", headers, body: JSON.stringify({ label }) });
if (!created.ok) fail(`Could not mint a connection key (${created.status}).`);
const { key } = (await created.json()) as { key: string };
const url = `${base}/mcp`;

function edit(file: string, change: (text: string) => string) {
  mkdirSync(dirname(file), { recursive: true });
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (existsSync(file)) {
    const backup = existsSync(`${file}.bak`) ? `${file}.bak-${Date.now()}` : `${file}.bak`;
    copyFileSync(file, backup);
    console.log(`Backed up the previous config: ${backup}`);
  }
  writeFileSync(file, change(before));
  console.log(`Wrote ${file}`);
}

console.log(`Connecting ${label}.${connections.some((item) => item.label === label) ? " The previous key for this client was revoked." : ""}`);
if (client === "codex") {
  edit(join(homedir(), ".codex", "config.toml"), (text) => upsertCodexToml(text, name, url, { Authorization: `Bearer ${key}` }));
  console.log("Open a new Codex chat. The key is in the Authorization header, not the URL.");
} else if (client === "cursor") {
  edit(join(homedir(), ".cursor", "mcp.json"), (text) => upsertCursorJson(text, name, url, key));
  console.log("Reload MCP in Cursor settings.");
} else if (client === "claude-code") {
  console.log(`Run:\n${claudeCodeCommand(name, url, key)}`);
} else {
  console.log("For a client that cannot send headers, the key is in the URL. Treat the URL as a password. It may show up in proxy logs.\n" + `${url}/${key}`);
}
if (/127\.0\.0\.1|localhost/.test(base)) console.log("This is a local address. Cloud clients cannot reach it until you put HTTPS in front (see the README).");
console.log("Revoke the key from the web UI when you stop using that client.");
