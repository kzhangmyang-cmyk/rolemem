# rolemem

Single-user memory server. One SQLite file, one admin token, MCP for every model.

The 0.2 multi-user product (roles, transfer, UMP signatures) is the `legacy-full` branch and the `v0.2-full` tag. Do not reintroduce `ROLEMEM_MODE`, role playbooks, or Ed25519. Those dependencies (`@universalmemoryprotocol/core`, `@noble/curves`) are gone on purpose.

## Layout

- `src/memory/store.ts` is the archive. Identity is `sha256(normalized content)`. Status is `active`, `quarantined`, or `deleted`.
- `src/archive/format.ts` is the portable JSON file (`version`, `memories`, `sha256`). Merge: newer `updated_at` wins; equal timestamps let a delete win. Native import is not injection-screened, or round-trip stops being lossless.
- `src/mcp/norms.ts` is the session text: write rules plus the digest. It is sent as MCP instructions, the `memory` prompt, and the `rolemem://digest` resource.
- `src/mcp/server.ts` tools: `remember`, `recall`, `update`, `list_memories`, `forget`. MCP writes are screened.
- `web/index.html` is view, edit, import, export, and connection keys. No chat.
- `eval/fixtures.json` and `scripts/eval.ts` are the recall eval. Lexical overlap is a stand-in. Do not describe it as the cross-model acceptance bar.

## Commands

`npm test` and `npm run check`. Node runs TypeScript directly (`erasableSyntaxOnly`, `verbatimModuleSyntax`). No build step.

## Digest

Full inject while the active set is within `ROLEMEM_DIGEST_MAX` (300) and `ROLEMEM_DIGEST_CHAR_CAP` (48000). Otherwise importance (preference, procedure, project, fact) then recency, unless the caller passed a query, in which case lexical relevance wins. FTS5 is not implemented.
