import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { HttpError } from "../db.ts";
import { WORK_STATUSES } from "../work/machine.ts";
import { resumeWork } from "../work/resume.ts";
import { completeWork, getWork, listWork, listWorkEvents, startWork, updateWork } from "../work/store.ts";
import { workSummary } from "../work/summary.ts";

const statusSchema = z.enum(WORK_STATUSES);
const eventId = z.string().min(8).max(80).optional();

function toolError(err: unknown) {
  const message = err instanceof HttpError ? err.message : "Request failed.";
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

function ok(text: string, structuredContent: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], structuredContent };
}

export function registerWorkTools(server: McpServer, label: string): void {
  server.registerTool(
    "start_work",
    {
      title: "Start work",
      description:
        "Open one shared work item for the task in progress. The same project and title returns the open item instead of inserting a duplicate. This does not read the chat transcript.",
      inputSchema: {
        project: z.string().min(1).max(80),
        title: z.string().min(1).max(200),
        goal: z.string().min(1).max(4000),
        event_id: eventId,
        client_id: z.string().max(64).optional().describe("Identity of the client doing the work, such as codex or claude-code"),
        session_id: z.string().max(64).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const saved = startWork({ ...input, source_client: label, client_id: input.client_id ?? label });
        return ok(`${saved.action} ${saved.item.id} (${saved.item.status}).`, {
          id: saved.item.id,
          action: saved.action,
          status: saved.item.status,
          redacted: saved.redacted,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "update_work",
    {
      title: "Update work",
      description:
        "Replace a summary field or append one recorded note. progress_summary and current_step replace. append_* fields add a note and skip exact duplicates. Pass event_id to make a retry a no-op. Do not invent test results or files.",
      inputSchema: {
        id: z.string().min(1),
        event_id: eventId,
        status: statusSchema.optional(),
        progress_summary: z.string().max(8000).optional(),
        current_step: z.string().max(2000).optional(),
        goal: z.string().max(4000).optional(),
        title: z.string().max(200).optional(),
        project: z.string().max(80).optional(),
        append_completed_step: z.string().max(2000).optional(),
        append_failed_attempt: z.string().max(2000).optional(),
        append_open_issue: z.string().max(2000).optional(),
        append_next_action: z.string().max(2000).optional(),
        append_key_decision: z.string().max(2000).optional(),
        append_hypothesis: z.string().max(2000).optional(),
        append_blocker: z.string().max(2000).optional(),
        append_file: z.string().max(2000).optional().describe("A path the client actually touched. Do not guess."),
        append_test_result: z.string().max(2000).optional().describe("A test result the client actually observed. Do not guess."),
        resolve_issue: z.string().max(200).optional(),
        resolve_blocker: z.string().max(200).optional(),
        related_memory_id: z.string().length(64).optional(),
        client_id: z.string().max(64).optional(),
        session_id: z.string().max(64).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      try {
        const saved = updateWork(input.id, { ...input, client_id: input.client_id ?? label, actor: input.client_id ?? label });
        return ok(`${saved.action} ${saved.item.id} (${saved.item.status}).`, {
          id: saved.item.id,
          action: saved.action,
          status: saved.item.status,
          redacted: saved.redacted,
          updated_at: saved.item.updated_at,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "get_work",
    {
      title: "Get work",
      description: "Read one work item, its recent events, and the deterministic summary.",
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      try {
        const item = getWork(id);
        if (!item) return toolError(new HttpError(404, "Work item not found"));
        return ok(`${item.id} ${item.status} ${item.title}`, {
          work: item,
          events: listWorkEvents(id, 30),
          summary: workSummary(item),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "list_work",
    {
      title: "List work",
      description: "List work items by project, status, or a keyword in the title, goal, or progress. Without a status filter, open items are listed before completed ones so a long completed history does not hide the task in progress. Archived items are omitted unless status is archived.",
      inputSchema: {
        project: z.string().max(80).optional(),
        status: statusSchema.optional(),
        q: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ project, status, q, limit }) => {
      try {
        const items = listWork({
          ...(project ? { project } : {}),
          ...(status ? { status } : {}),
          ...(q ? { q } : {}),
          ...(limit ? { limit } : {}),
          preferOpen: !status,
        });
        const text = items.length
          ? items.map((item) => `- [${item.id}] (${item.status}/${item.project}) ${item.title}`).join("\n")
          : "No work items.";
        return ok(text, {
          work: items.map((item) => ({
            id: item.id,
            project: item.project,
            title: item.title,
            status: item.status,
            current_step: item.current_step,
            updated_at: item.updated_at,
            last_active_at: item.last_active_at,
            client_id: item.client_id,
          })),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "resume_work",
    {
      title: "Resume work",
      description:
        "One call returns the shared handoff: recorded facts, completed steps, failed attempts, unverified hypotheses, blockers, next actions, related memories, and sources. If nothing is open, returns related memories and recent titles instead of an error. Hypotheses are not facts. Connecting MCP does not capture chat.",
      inputSchema: {
        work_id: z.string().optional(),
        project: z.string().max(80).optional(),
        query: z.string().max(500).optional(),
        limit_chars: z.number().int().min(500).max(48000).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const handoff = resumeWork(input);
        return ok(handoff.text, {
          mode: handoff.mode,
          found: handoff.found,
          note: handoff.note,
          truncated: handoff.truncated,
          caution: handoff.caution,
          work_id: handoff.work?.id ?? null,
          status: handoff.work?.status ?? null,
          handoff: handoff.handoff,
          summary: handoff.summary,
          related_memories: handoff.related_memories,
          recent: handoff.recent,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "complete_work",
    {
      title: "Complete work",
      description: "Mark a work item completed, or archived when archive is true. The summary is built from recorded fields and does not call a model.",
      inputSchema: {
        id: z.string().min(1),
        event_id: eventId,
        progress_summary: z.string().max(8000).optional(),
        archive: z.boolean().optional(),
        client_id: z.string().max(64).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        const saved = completeWork(input.id, { ...input, client_id: input.client_id ?? label, actor: input.client_id ?? label });
        return ok(`${saved.action} ${saved.item.id} (${saved.item.status}).`, {
          id: saved.item.id,
          action: saved.action,
          status: saved.item.status,
          summary: workSummary(saved.item),
          redacted: saved.redacted,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
