# Baseline and result

Audited before the continuity work, on main at the published 0.3.0 tree (Node v22.23.4).

## Before

- `npm test`: 16 passed, 0 failed.
- `npm run typecheck`: passed.
- No lint script and no build step. `npm run check` is typecheck plus test.
- `node:sqlite` FTS5 works in this Node (`create virtual table … using fts5` succeeded).
- `docker` is not installed in this environment.
- Schema was `memories` and `connections` only. Recall was lexical overlap. MCP tools were `remember`, `recall`, `update`, `list_memories`, `forget`.

## After (0.4.0)

- `npm test`: 32 passed, 0 failed. No test was deleted.
- `npm run typecheck`: passed.
- `npm run eval`: the four lexical fixture questions still hit. “What is their home city?” still misses, as that script already expected.
- `npm run eval:recall` with FTS5 on, 10 scored questions and 1 excluded paraphrase gap: Recall@5 0.700 → 1.000, MRR 0.650 → 1.000, 0 regressions. The new hits are memory id, project label, work id, and the preference beating a newer partial SQLite note. The paraphrase gap is unchanged.
- Docker image was not built here because the `docker` binary is absent.

## Compatibility

- Old MCP tool names and the version 1 memory export stay. New memory columns (`importance`, `project`, `work_id`) are nullable. New tables are created with `IF NOT EXISTS` and recorded in `schema_migrations`.
- Rollback of a bad migration is a file restore from backup. The migration only adds tables and nullable columns. A 0.3.0 process inserts memories by column name, so those new columns can stay null, and its row mapper ignores columns it does not read. Work tables sit unused until 0.4.0 is running again. Prefer a backup anyway: this was not tested by booting the 0.3.0 sources against a migrated file in this environment.
