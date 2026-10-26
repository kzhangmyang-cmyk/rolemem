# Changelog

## 0.4.0

Additive. Existing MCP tools `remember`, `recall`, `update`, `list_memories`, and `forget` keep their names and behavior. JSON export stays version 1 and memories-only. `package.json` remains `private`; this version is not an npm release.

- Work continuity lives in `work_items` and `work_events`, separate from memories. Status moves are `active`, `paused`, `blocked`, `completed`, and `archived`.
- MCP tools `start_work`, `update_work`, `get_work`, `list_work`, `resume_work`, and `complete_work`. `resume_work` returns recorded facts, completed steps, failed attempts, unverified hypotheses, blockers, next actions, and sources. No open task returns related memories instead of an error.
- Appended notes are idempotent by `event_id` and by identical text. Replacing `progress_summary` is a different field from appending a step.
- Recall adds FTS5 when Node's SQLite has it, plus project, work id, and exact memory id. The 0.3 lexical ranker remains available for comparison via `npm run eval:recall`. Recency is a tie-break after type and explicit importance.
- Credential-shaped text is refused by `remember` and redacted in work notes. A content edit keeps the previous wording in `memory_conflicts` while the newer row stays active. Deleted markers still block an older import.
- The admin page has a Work tab. Copy the SQLite file to move both stores. New tables and nullable memory columns are added on startup; the migration is safe to run twice.

## 0.3.0

Single-user SQLite memory server: digest, quarantine, portable export, connection keys, and the five memory tools.
