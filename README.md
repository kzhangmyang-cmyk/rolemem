# rolemem

One memory store for every model you use. Claude, Cursor, and ChatGPT share it over MCP, or by importing and exporting a single JSON file. Switching models does not mean teaching them again.

[中文说明](README.zh-CN.md)

This is a single-user server. There is no sign-up. One admin token opens the archive, and connection keys let MCP clients read and write it. The old multi-user product (role agents, copy/lease transfer, signed archives) is on the `legacy-full` branch and the `v0.2-full` tag. It is not a mode switch in this tree.

```
  Cursor ────── Authorization: Bearer rmk_…
  Claude Code ─┼── MCP /mcp ── rolemem (SQLite)
  Codex ───────┘                 │
                                 ├── remember / recall / update / list / forget
                                 ├── session digest (prompt + resource + instructions)
                                 └── JSON export, including deleted markers
```

## Run it

Node.js 22.18 or newer, or Docker. Docker is the install path to prefer.

```bash
docker build -t rolemem .
docker run -p 8787:8787 -v rolemem-data:/data \
  -e NODE_ENV=production \
  -e ROLEMEM_ADMIN_TOKEN="$(openssl rand -hex 24)" \
  -e ROLEMEM_PUBLIC_URL=https://memory.example.com \
  -e ROLEMEM_TRUST_PROXY=1 \
  rolemem
```

Or with Compose, from a directory that contains this file and a `.env` with `ROLEMEM_ADMIN_TOKEN`:

```bash
docker compose up -d
```

From source, if Node is already installed:

```bash
npm install
cp .env.example .env   # set ROLEMEM_ADMIN_TOKEN
npm start              # http://127.0.0.1:8787
```

If `ROLEMEM_ADMIN_TOKEN` is unset outside production, the process writes `data/admin.token` and prints the token once. In production the token must be at least 16 characters or the process exits. Open the web UI and paste the token. The page is for viewing, editing, import, export, and connection keys. It does not chat with a model.

Health check: `GET /healthz`.

A 0.2 database file cannot be opened by this version. Keep that file with the `legacy-full` checkout.

## Connect a client

Mint a key in the web UI, or:

```bash
npm run connect -- cursor          # also: codex, claude-code, url
```

The command talks to a running server, revokes the previous key for that client, and writes a config that sends `Authorization: Bearer rmk_…`. The hash is all the server keeps.

**Cursor** (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "rolemem": {
      "url": "https://memory.example.com/mcp",
      "headers": { "Authorization": "Bearer rmk_…" }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.rolemem]
url = "https://memory.example.com/mcp"

[mcp_servers.rolemem.http_headers]
Authorization = "Bearer rmk_…"
```

**Claude Code**:

```bash
claude mcp add --transport http rolemem https://memory.example.com/mcp --header "Authorization: Bearer rmk_…"
```

A client that cannot send headers can use `https://memory.example.com/mcp/rmk_…`. That URL is a password. It may be written into proxy logs. Prefer the header.

On macOS, `npm run service -- install` keeps a source checkout running at login. Linux hosts should use Docker.

### What the model sees at session start

Every MCP initialize includes a **memory digest** and the write rules: when to remember, how to phrase a memory, when to update, when to forget. The same text is a prompt named `memory` and a resource at `rolemem://digest`. Models that never call `recall` still have the archive in front of them.

Under a few hundred memories the digest is the full archive. Past the count or character cap it keeps the most important and recent memories (preferences and procedures first). A prompt that includes a question ranks by lexical relevance instead. Call `recall` for anything the digest says it left out.

Tools: `remember`, `recall`, `update`, `list_memories`, `forget`.

## Portable export

`examples/sample-export.json` is a complete file. `id` is the SHA-256 of the normalized content (trimmed, internal whitespace collapsed), so importing the same text twice does not create a second row.

```json
{
  "version": 1,
  "memories": [
    {
      "id": "12cfc61005d9a89ce8e907ed10ab0051a330d75814f0a6cae990033e3f93bc43",
      "content": "The user lives in Lisbon and commutes by tram.",
      "type": "fact",
      "space": "life",
      "source_model": "claude",
      "updated_at": "2026-10-26T12:00:00.000Z",
      "deleted": false
    }
  ],
  "sha256": "…"
}
```

`type` is `preference`, `fact`, `project`, or `procedure`. `space` is a short label such as `work` or `life`. `source_model` is which model wrote it, or null. `sha256` covers the version and the memories, with ids sorted.

Merge rules, for the same id:

1. The newer `updated_at` wins, including whether it is a delete.
2. If the timestamps are equal, a delete wins.
3. An older export therefore cannot revive a memory this server has already deleted. Remembering the same sentence again is a new timestamp, so it can return on purpose.

Markdown export (`GET /api/export?format=markdown`) carries the same fields and round-trips. Paste text (`format=paste`, or a ChatGPT / Claude / Gemini dump) is one memory per line, optional `[date] -`. Paste is not lossless: it has no deleted markers, and suspicious lines go to quarantine instead of the digest. JSON import is not screened, so a round-trip of your own archive stays exact. `maskPii=1` on export is off unless you ask. Masking rewrites phone numbers, emails, and id-like numbers, which changes ids. It is for handing a copy to someone, not for backup.

`npm run demo` prints a round-trip against an in-memory database.

## HTTPS

Put TLS in front of the server. Do not publish port 8787.

**Caddy** on the same machine (`Caddyfile.example`):

```
memory.example.com {
	reverse_proxy 127.0.0.1:8787
}
```

Set `ROLEMEM_TRUST_PROXY=1` and `ROLEMEM_PUBLIC_URL=https://memory.example.com`.

**Cloudflare Tunnel**, if you do not want to open an inbound port:

```bash
cloudflared tunnel --url http://127.0.0.1:8787
```

Use a named tunnel and a hostname for anything you keep. The quick command above prints a temporary URL.

## HTTP API

`/api/*` requires `Authorization: Bearer <admin token>`. `/mcp` requires a connection key, also as a bearer token. There is no `/api/users`.

| Route | |
|---|---|
| `GET /api/memories` | Active and quarantined memories. Filters: `space`, `type`, `status`, `q` |
| `POST /api/memories` | `{ content, type, space, source_model }` |
| `PATCH /api/memories/:id` | Edit. A new sentence gets a new id and leaves a deleted marker on the old one |
| `DELETE /api/memories/:id` | Forget. The row stays as `deleted: true` |
| `POST /api/memories/:id/approve` | Release one quarantined memory |
| `POST /api/quarantine` | `{ "action": "approve" \| "delete" }` |
| `GET /api/digest` | The text models are given at session start |
| `GET /api/export?format=json\|markdown\|paste&maskPii=1` | Download |
| `POST /api/import` | `{ document }` or `{ source, text, space, type }` |
| `POST /api/connections` | `{ label }` returns the key once, plus client snippets |
| `GET /api/connections` · `DELETE /api/connections/:id` | List and revoke |

Basic rate limits apply (240 HTTP requests and 120 MCP requests per minute in one process). They reset on restart and are not shared across replicas. Behind a proxy, set `ROLEMEM_TRUST_PROXY=1` or every client shares one bucket.

## Recall quality

`npm test` covers lossless round-trip, duplicate import, deletes that do not come back, and an MCP smoke test. `npm run eval` teaches `eval/fixtures.json`, checks that the digest contains every fact, and checks that lexical recall hits questions which share words with the fact.

That is not the bar this project is aiming at, which is near-perfect recall of taught facts across models. The gaps are listed at the end of `npm run eval`:

- Overlap ranking misses paraphrases with no shared words (“What is their home city?” does not retrieve Lisbon). The digest still contains the fact, which is why session injection exists.
- Nothing here drives Claude, Cursor, and ChatGPT through MCP and scores their answers against one fixture.
- Above the digest cap, selection is importance and recency, or relevance when a question was passed. It is not a learned ranker. FTS5 is the next step if a real log shows the paraphrase misses matter.
- Set `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` to have `npm run eval` ask one model those questions with the digest as the system prompt. One judge is not a cross-model harness.

## Where 0.2 went

| Removed from this tree | Still available as |
|---|---|
| Role playbooks, cross-user copy/lease, capability grants, inbox, batch rollback, hash-chain audit, Ed25519 archives, `ROLEMEM_MODE` | Branch `legacy-full`, tag `v0.2-full` |

```bash
git checkout legacy-full
# or
git checkout v0.2-full
```

## Development

```bash
npm test
npm run check          # typecheck and test
npm run dev            # reload on change
```

See [SECURITY.md](SECURITY.md) and [AGENTS.md](AGENTS.md). MIT licensed.
