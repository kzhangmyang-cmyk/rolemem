import { audit } from "../audit.ts";
import { getDb, HttpError, now, withTx } from "../db.ts";
import { injectionFindings } from "../memory/guard.ts";
import { assertTransition, isWorkStatus, type WorkStatus } from "./machine.ts";
import { redactSecrets } from "./redact.ts";
import {
  newId,
  noteKey,
  parseClientId,
  parseEventId,
  parseGoal,
  parseMemoryLink,
  parseNote,
  parseProjectName,
  parseStatus,
  parseStep,
  parseSummary,
  parseTitle,
  type WorkEvent,
  type WorkItem,
  type WorkNote,
} from "./types.ts";

interface WorkRow {
  id: string;
  project: string;
  title: string;
  goal: string;
  status: string;
  progress_summary: string;
  current_step: string;
  completed_steps: string;
  failed_attempts: string;
  open_issues: string;
  next_actions: string;
  key_decisions: string;
  hypotheses: string;
  blockers: string;
  related_memory_ids: string;
  recorded_files: string;
  recorded_tests: string;
  source_client: string | null;
  client_id: string | null;
  session_id: string | null;
  flags: string | null;
  created_at: string;
  updated_at: string;
  last_active_at: string;
}

const NOTE_FIELDS = [
  "completed_steps",
  "failed_attempts",
  "open_issues",
  "next_actions",
  "key_decisions",
  "hypotheses",
  "blockers",
  "recorded_files",
  "recorded_tests",
] as const;

type NoteField = (typeof NOTE_FIELDS)[number];

const APPEND: Record<string, NoteField> = {
  append_completed_step: "completed_steps",
  append_failed_attempt: "failed_attempts",
  append_open_issue: "open_issues",
  append_next_action: "next_actions",
  append_key_decision: "key_decisions",
  append_hypothesis: "hypotheses",
  append_blocker: "blockers",
  append_file: "recorded_files",
  append_test_result: "recorded_tests",
};

function notes(raw: string): WorkNote[] {
  const parsed = JSON.parse(raw) as WorkNote[];
  return Array.isArray(parsed) ? parsed : [];
}

function parse(row: WorkRow): WorkItem {
  return {
    id: row.id,
    project: row.project,
    title: row.title,
    goal: row.goal,
    status: isWorkStatus(row.status) ? row.status : "active",
    progress_summary: row.progress_summary,
    current_step: row.current_step,
    completed_steps: notes(row.completed_steps),
    failed_attempts: notes(row.failed_attempts),
    open_issues: notes(row.open_issues),
    next_actions: notes(row.next_actions),
    key_decisions: notes(row.key_decisions),
    hypotheses: notes(row.hypotheses),
    blockers: notes(row.blockers),
    related_memory_ids: JSON.parse(row.related_memory_ids) as string[],
    recorded_files: notes(row.recorded_files),
    recorded_tests: notes(row.recorded_tests),
    source_client: row.source_client,
    client_id: row.client_id,
    session_id: row.session_id,
    flags: row.flags ? (JSON.parse(row.flags) as string[]) : [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_active_at: row.last_active_at,
  };
}

function save(item: WorkItem): void {
  getDb()
    .prepare(
      `update work_items set project = ?, title = ?, goal = ?, status = ?, progress_summary = ?, current_step = ?,
        completed_steps = ?, failed_attempts = ?, open_issues = ?, next_actions = ?, key_decisions = ?,
        hypotheses = ?, blockers = ?, related_memory_ids = ?, recorded_files = ?, recorded_tests = ?,
        source_client = ?, client_id = ?, session_id = ?, flags = ?, updated_at = ?, last_active_at = ?
       where id = ?`,
    )
    .run(
      item.project,
      item.title,
      item.goal,
      item.status,
      item.progress_summary,
      item.current_step,
      JSON.stringify(item.completed_steps),
      JSON.stringify(item.failed_attempts),
      JSON.stringify(item.open_issues),
      JSON.stringify(item.next_actions),
      JSON.stringify(item.key_decisions),
      JSON.stringify(item.hypotheses),
      JSON.stringify(item.blockers),
      JSON.stringify(item.related_memory_ids),
      JSON.stringify(item.recorded_files),
      JSON.stringify(item.recorded_tests),
      item.source_client,
      item.client_id,
      item.session_id,
      item.flags.length ? JSON.stringify(item.flags) : null,
      item.updated_at,
      item.last_active_at,
      item.id,
    );
}

function blob(item: WorkItem): string {
  return [
    item.project,
    item.title,
    item.goal,
    item.progress_summary,
    item.current_step,
    ...NOTE_FIELDS.flatMap((field) => item[field].map((note) => note.text)),
  ].join("\n");
}

function refreshFlags(item: WorkItem): void {
  item.flags = injectionFindings(blob(item));
}

function eventById(id: string): WorkEvent | undefined {
  return getDb().prepare("select * from work_events where id = ?").get(id) as WorkEvent | undefined;
}

function insertEvent(event: WorkEvent): void {
  getDb()
    .prepare("insert into work_events(id, work_id, kind, payload, client_id, created_at) values (?, ?, ?, ?, ?, ?)")
    .run(event.id, event.work_id, event.kind, event.payload, event.client_id, event.created_at);
}

export function getWork(id: string): WorkItem | undefined {
  const row = getDb().prepare("select * from work_items where id = ?").get(id) as WorkRow | undefined;
  return row && parse(row);
}

export function requireWork(id: string): WorkItem {
  const item = getWork(id);
  if (!item) throw new HttpError(404, "Work item not found");
  return item;
}

export function listWorkEvents(workId: string, limit = 50): WorkEvent[] {
  const size = Math.min(Math.max(limit, 1), 200);
  return getDb()
    .prepare("select * from work_events where work_id = ? order by created_at desc, id desc limit ?")
    .all(workId, size) as unknown as WorkEvent[];
}

export interface WorkListFilter {
  project?: string;
  status?: WorkStatus;
  q?: string;
  includeArchived?: boolean;
  /** When set, open items are kept ahead of completed and archived ones before the limit is applied. */
  preferOpen?: boolean;
  limit?: number;
}

function isOpenStatus(status: WorkStatus): boolean {
  return status === "active" || status === "paused" || status === "blocked";
}

function loadOpen(): WorkItem[] {
  const rows = getDb()
    .prepare("select * from work_items where status in ('active', 'paused', 'blocked') order by last_active_at desc, id")
    .all() as unknown as WorkRow[];
  return rows.map(parse);
}

export function listWork(filter: WorkListFilter = {}): WorkItem[] {
  const rows = getDb().prepare("select * from work_items order by last_active_at desc, id").all() as unknown as WorkRow[];
  const project = filter.project?.trim().toLowerCase();
  const q = filter.q?.trim().toLowerCase();
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const matched = rows
    .map(parse)
    .filter((item) => {
      if (filter.status && item.status !== filter.status) return false;
      if (!filter.status && !filter.includeArchived && item.status === "archived") return false;
      if (project && item.project.toLowerCase() !== project) return false;
      if (q) {
        const hay = `${item.project}\n${item.title}\n${item.goal}\n${item.progress_summary}\n${item.current_step}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  if (filter.preferOpen && !filter.status) {
    matched.sort((a, b) => {
      const ao = isOpenStatus(a.status) ? 0 : 1;
      const bo = isOpenStatus(b.status) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return b.last_active_at.localeCompare(a.last_active_at) || a.id.localeCompare(b.id);
    });
  }
  return matched.slice(0, limit);
}

export interface StartWorkInput {
  project: unknown;
  title: unknown;
  goal: unknown;
  event_id?: unknown;
  client_id?: unknown;
  session_id?: unknown;
  source_client?: unknown;
  separate?: boolean;
}

export interface WorkWriteResult {
  item: WorkItem;
  action: "created" | "existing" | "updated" | "duplicate";
  redacted: boolean;
}

function stablePayload(fields: Record<string, unknown>): string {
  const keys = Object.keys(fields)
    .filter((key) => fields[key] !== undefined)
    .sort();
  const body: Record<string, unknown> = {};
  for (const key of keys) body[key] = fields[key];
  return JSON.stringify(body);
}

function guardText(text: string): { text: string; redacted: boolean } {
  const cleaned = redactSecrets(text);
  if (!cleaned.text.trim() || cleaned.text.trim() === "[redacted]") {
    throw new HttpError(400, "The text was only a credential and was not stored");
  }
  return { text: cleaned.text, redacted: cleaned.redacted };
}

export function startWork(input: StartWorkInput): WorkWriteResult {
  const project = parseProjectName(input.project);
  const title = parseTitle(input.title);
  const goalRaw = parseGoal(input.goal);
  const goalClean = guardText(goalRaw);
  const eventId = parseEventId(input.event_id);
  const client = parseClientId(input.client_id);
  const session = parseClientId(input.session_id);
  const source = parseClientId(input.source_client);
  const payload = stablePayload({ project, title, goal: goalClean.text, client_id: client, session_id: session });

  return withTx(() => {
    if (eventId) {
      const prior = eventById(eventId);
      if (prior) {
        if (prior.kind !== "start" || prior.payload !== payload) {
          throw new HttpError(409, "event_id was already used with a different payload");
        }
        const item = requireWork(prior.work_id);
        return { item, action: "duplicate" as const, redacted: goalClean.redacted };
      }
    }
    if (!input.separate) {
      const open = loadOpen().find(
        (item) => item.project.toLowerCase() === project.toLowerCase() && item.title.toLowerCase() === title.toLowerCase(),
      );
      if (open) {
        if (eventId && !eventById(eventId)) {
          insertEvent({ id: eventId, work_id: open.id, kind: "start", payload, client_id: client, created_at: now() });
        }
        return { item: open, action: "existing" as const, redacted: false };
      }
    }
    const at = now();
    const item: WorkItem = {
      id: newId("wrk"),
      project,
      title,
      goal: goalClean.text,
      status: "active",
      progress_summary: "",
      current_step: "",
      completed_steps: [],
      failed_attempts: [],
      open_issues: [],
      next_actions: [],
      key_decisions: [],
      hypotheses: [],
      blockers: [],
      related_memory_ids: [],
      recorded_files: [],
      recorded_tests: [],
      source_client: source,
      client_id: client,
      session_id: session,
      flags: [],
      created_at: at,
      updated_at: at,
      last_active_at: at,
    };
    refreshFlags(item);
    getDb()
      .prepare(
        `insert into work_items(id, project, title, goal, status, progress_summary, current_step,
          completed_steps, failed_attempts, open_issues, next_actions, key_decisions, hypotheses, blockers,
          related_memory_ids, recorded_files, recorded_tests, source_client, client_id, session_id, flags,
          created_at, updated_at, last_active_at)
         values (?, ?, ?, ?, ?, '', '', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', '[]', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.project,
        item.title,
        item.goal,
        item.status,
        item.source_client,
        item.client_id,
        item.session_id,
        item.flags.length ? JSON.stringify(item.flags) : null,
        item.created_at,
        item.updated_at,
        item.last_active_at,
      );
    insertEvent({
      id: eventId ?? newId("evt"),
      work_id: item.id,
      kind: "start",
      payload,
      client_id: client,
      created_at: at,
    });
    audit("work.start", item.id, item.status, client ?? source);
    return { item: requireWork(item.id), action: "created" as const, redacted: goalClean.redacted };
  });
}

export interface UpdateWorkInput {
  event_id?: unknown;
  status?: unknown;
  progress_summary?: unknown;
  current_step?: unknown;
  goal?: unknown;
  title?: unknown;
  project?: unknown;
  append_completed_step?: unknown;
  append_failed_attempt?: unknown;
  append_open_issue?: unknown;
  append_next_action?: unknown;
  append_key_decision?: unknown;
  append_hypothesis?: unknown;
  append_blocker?: unknown;
  append_file?: unknown;
  append_test_result?: unknown;
  resolve_issue?: unknown;
  resolve_blocker?: unknown;
  related_memory_id?: unknown;
  client_id?: unknown;
  session_id?: unknown;
  actor?: string | null;
}

function hasChange(input: UpdateWorkInput): boolean {
  return Object.entries(input).some(([key, value]) => key !== "event_id" && key !== "actor" && key !== "client_id" && key !== "session_id" && value !== undefined);
}

function pushNote(list: WorkNote[], text: string, at: string, client: string | null): { list: WorkNote[]; added: boolean } {
  if (list.some((note) => noteKey(note.text) === noteKey(text))) return { list, added: false };
  return { list: [...list, { id: newId("nte"), text, at, client_id: client }], added: true };
}

function dropNote(list: WorkNote[], needle: string): { list: WorkNote[]; removed: boolean } {
  const key = noteKey(needle);
  const next = list.filter((note) => note.id !== needle && noteKey(note.text) !== key);
  return { list: next, removed: next.length !== list.length };
}

export function updateWork(id: string, input: UpdateWorkInput): WorkWriteResult {
  const eventId = parseEventId(input.event_id);
  const client = parseClientId(input.client_id);
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && key !== "actor" && key !== "event_id") defined[key] = value;
  }
  const payload = stablePayload(defined);

  return withTx(() => {
    const current = requireWork(id);
    if (eventId) {
      const prior = eventById(eventId);
      if (prior) {
        if (prior.work_id !== id || prior.payload !== payload) {
          throw new HttpError(409, "event_id was already used with a different payload");
        }
        return { item: current, action: "duplicate" as const, redacted: false };
      }
    }
    if (!hasChange(input)) throw new HttpError(400, "No work fields to update");

    let redacted = false;
    const take = (value: unknown, parse: (value: unknown) => string) => {
      const cleaned = guardText(parse(value));
      redacted = redacted || cleaned.redacted;
      return cleaned.text;
    };

    const next: WorkItem = { ...current };
    let changed = false;
    if (input.status !== undefined) {
      const status = parseStatus(input.status);
      assertTransition(current.status, status);
      if (status !== next.status) changed = true;
      next.status = status;
    }
    if (input.project !== undefined) {
      next.project = parseProjectName(input.project);
      changed = true;
    }
    if (input.title !== undefined) {
      next.title = take(input.title, parseTitle);
      changed = true;
    }
    if (input.goal !== undefined) {
      next.goal = take(input.goal, parseGoal);
      changed = true;
    }
    if (input.progress_summary !== undefined) {
      next.progress_summary = take(input.progress_summary, parseSummary);
      changed = true;
    }
    if (input.current_step !== undefined) {
      next.current_step = take(input.current_step, parseStep);
      changed = true;
    }
    if (input.session_id !== undefined) next.session_id = parseClientId(input.session_id);
    if (client) next.client_id = client;

    for (const [key, field] of Object.entries(APPEND)) {
      const value = input[key as keyof UpdateWorkInput];
      if (value === undefined) continue;
      const text = take(value, (raw) => parseNote(raw, key));
      const pushed = pushNote(next[field], text, now(), client);
      next[field] = pushed.list;
      if (pushed.added) changed = true;
    }
    if (input.resolve_issue !== undefined) {
      const resolved = dropNote(next.open_issues, String(input.resolve_issue));
      if (!resolved.removed) throw new HttpError(404, "Open issue not found");
      next.open_issues = resolved.list;
      changed = true;
    }
    if (input.resolve_blocker !== undefined) {
      const resolved = dropNote(next.blockers, String(input.resolve_blocker));
      if (!resolved.removed) throw new HttpError(404, "Blocker not found");
      next.blockers = resolved.list;
      changed = true;
    }
    if (input.related_memory_id !== undefined) {
      const memoryId = parseMemoryLink(input.related_memory_id);
      if (!next.related_memory_ids.includes(memoryId)) {
        next.related_memory_ids = [...next.related_memory_ids, memoryId];
        changed = true;
      }
    }

    if (!changed) {
      if (eventId) {
        insertEvent({ id: eventId, work_id: id, kind: "update", payload, client_id: client, created_at: now() });
      }
      return { item: current, action: "duplicate" as const, redacted };
    }

    const at = now();
    next.updated_at = at;
    next.last_active_at = at;
    refreshFlags(next);
    save(next);
    insertEvent({
      id: eventId ?? newId("evt"),
      work_id: id,
      kind: "update",
      payload,
      client_id: client,
      created_at: at,
    });
    audit("work.update", id, next.status, input.actor ?? client);
    return { item: requireWork(id), action: "updated" as const, redacted };
  });
}

export function completeWork(
  id: string,
  input: { event_id?: unknown; progress_summary?: unknown; archive?: boolean; client_id?: unknown; actor?: string | null } = {},
): WorkWriteResult {
  return updateWork(id, {
    event_id: input.event_id,
    status: input.archive ? "archived" : "completed",
    ...(input.progress_summary !== undefined ? { progress_summary: input.progress_summary } : {}),
    client_id: input.client_id,
    actor: input.actor,
  });
}

/** Most recently active open item, optionally inside one project. Completed history is not a cap. */
export function latestOpenWork(project?: string): WorkItem | undefined {
  const projectKey = project?.trim().toLowerCase();
  return loadOpen().find((item) => !projectKey || item.project.toLowerCase() === projectKey);
}
