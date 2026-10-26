# Contributing

Issues and small patches are welcome. The product is a single-user memory server: MCP, a portable JSON file, and a page for editing that file's contents.

Run `npm test` before sending a change. `npm run check` also typechecks.

Please leave these alone unless the change is the point of the patch:

- Content-hash ids and the merge rules in `src/memory/store.ts` (newer `updated_at` wins, equal time means delete wins).
- The decision that native JSON import is not put through the injection quarantine. Paste and MCP writes are.
- The session digest in `src/mcp/norms.ts`. Models that never call `recall` still need the archive.

The 0.2 tree (roles, cross-user transfer, signed archives) stays on `legacy-full`. New work lands on this slim line.

Do not commit real memory exports, admin tokens, or connection keys.
