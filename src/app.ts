import { readFileSync } from "node:fs";
import { Hono, type Context } from "hono";
import { HttpError } from "./db.ts";
import { authenticateAdmin } from "./auth.ts";
import { clearAuthFailures, noteAuthFailure, rateLimit, requestLimit } from "./ratelimit.ts";
import { claudeCodeCommand, codexSnippet, cursorSnippet } from "./cli/clients.ts";
import { connectionByLabel, createConnection, listConnections, revokeConnection } from "./connections.ts";
import { handleMcp } from "./mcp/server.ts";
import { exportMarkdown, exportPortable, importMarkdown, importPaste, importPortable } from "./archive/exchange.ts";
import { listAudit } from "./audit.ts";
import { approveMemory, createMemory, decideQuarantine, digest, forgetMemory, listConflicts, listMemories, updateMemory } from "./memory/store.ts";
import { isStatus, isType, parseSpace, type MemoryStatus, type MemoryType } from "./memory/types.ts";
import { isWorkStatus } from "./work/machine.ts";
import { resumeWork } from "./work/resume.ts";
import { completeWork, getWork, listWork, listWorkEvents, startWork, updateWork } from "./work/store.ts";
import { workSummary } from "./work/summary.ts";
import { VERSION } from "./version.ts";

export const app = new Hono();

function clientIp(c: Context): string {
  if (process.env.ROLEMEM_TRUST_PROXY === "1") {
    return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  }
  return "local";
}

function publicBase(c: Context): string {
  const configured = process.env.ROLEMEM_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const proto = c.req.header("x-forwarded-proto") ?? "http";
  const host = c.req.header("host") ?? `127.0.0.1:${process.env.PORT ?? 8787}`;
  return `${proto}://${host}`;
}

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
}

app.onError((err, c) => {
  if (err instanceof HttpError) {
    if (err.retryAfter) c.header("retry-after", String(err.retryAfter));
    return c.json({ error: err.message }, err.status);
  }
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.use("*", async (c, next) => {
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  c.header("access-control-allow-origin", "*");
  c.header("access-control-allow-headers", "Authorization, Content-Type, Accept, Mcp-Protocol-Version");
  c.header("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  const path = c.req.path;
  if (path !== "/healthz" && path !== "/") {
    const kind = path.startsWith("/mcp") ? "mcp" : "api";
    rateLimit(`${kind}:${clientIp(c)}`, requestLimit(kind));
  }
  await next();
  if (path.startsWith("/api/")) c.header("cache-control", "no-store");
});

app.get("/", (c) => c.html(readFileSync(new URL("../web/index.html", import.meta.url), "utf8")));

app.get("/healthz", (c) => c.json({ ok: true, version: VERSION }));

app.all("/mcp", (c) => handleMcp(c.req.raw, undefined, clientIp(c)));
app.all("/mcp/:key", (c) => handleMcp(c.req.raw, c.req.param("key"), clientIp(c)));

function guard(c: Context) {
  const ip = clientIp(c);
  try {
    authenticateAdmin(c.req.header("authorization"));
    if (process.env.ROLEMEM_TRUST_PROXY === "1") clearAuthFailures(ip);
  } catch (err) {
    if (process.env.ROLEMEM_TRUST_PROXY === "1" && err instanceof HttpError && err.status === 401) noteAuthFailure(ip);
    throw err;
  }
}

app.get("/api/memories", (c) => {
  guard(c);
  const space = c.req.query("space");
  const type = c.req.query("type");
  const status = c.req.query("status");
  const q = c.req.query("q");
  if (type && !isType(type)) throw new HttpError(400, "type must be preference, fact, project, or procedure");
  if (status && !isStatus(status)) throw new HttpError(400, "status must be active, quarantined, or deleted");
  const filter = {
    ...(space ? { space: parseSpace(space) } : {}),
    ...(type ? { type: type as MemoryType } : {}),
    ...(status ? { status: status as MemoryStatus } : {}),
    ...(q ? { q } : {}),
  };
  const memories = listMemories(filter);
  return c.json({
    memories: status ? memories : memories.filter((memory) => memory.status !== "deleted"),
    deleted: listMemories({ ...filter, status: "deleted" }).length,
  });
});

app.post("/api/memories", async (c) => {
  guard(c);
  const input = await body<{ content: string; type?: string; space?: string; source_model?: string }>(c);
  const saved = createMemory({ ...input, screen: false });
  return c.json({ memory: saved.memory, action: saved.action }, saved.action === "added" ? 201 : 200);
});

app.patch("/api/memories/:id", async (c) => {
  guard(c);
  const patch = await body<{ content?: string; type?: string; space?: string; source_model?: string | null }>(c);
  const saved = updateMemory(c.req.param("id"), { ...patch, screen: false });
  return c.json({ memory: saved.memory, previousId: saved.previousId });
});

app.delete("/api/memories/:id", (c) => {
  guard(c);
  return c.json(forgetMemory(c.req.param("id")));
});

app.post("/api/memories/:id/approve", (c) => {
  guard(c);
  return c.json({ memory: approveMemory(c.req.param("id")) });
});

app.post("/api/quarantine", async (c) => {
  guard(c);
  const { action } = await body<{ action: "approve" | "delete" }>(c);
  return c.json(decideQuarantine(action));
});

app.get("/api/digest", (c) => {
  guard(c);
  return c.json(digest(c.req.query("q") ?? undefined));
});

app.get("/api/export", (c) => {
  guard(c);
  const maskPii = c.req.query("maskPii") === "1";
  const format = c.req.query("format") ?? "json";
  if (format === "markdown" || format === "md") {
    c.header("content-disposition", 'attachment; filename="rolemem-memories.md"');
    return c.text(exportMarkdown({ maskPii }));
  }
  if (format === "paste") {
    const lines = exportPortable({ maskPii }).memories.filter((memory) => !memory.deleted).map((memory) => `[${memory.updated_at.slice(0, 10)}] - ${memory.content}`);
    c.header("content-disposition", 'attachment; filename="rolemem-memories.txt"');
    return c.text(lines.length ? `${lines.join("\n")}\n` : "");
  }
  c.header("content-disposition", 'attachment; filename="rolemem-memories.json"');
  return c.json(exportPortable({ maskPii }));
});

app.post("/api/import", async (c) => {
  guard(c);
  const raw = await c.req.text();
  if (raw.length > 2_000_000) throw new HttpError(413, "Import is larger than 2MB");
  let payload: {
    document?: unknown;
    text?: string;
    source?: string;
    space?: string;
    type?: string;
    source_model?: string;
    screen?: boolean;
  };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
  if (payload.document) return c.json(importPortable(payload.document, { screen: payload.screen === true }));
  const text = payload.text ?? "";
  if (payload.source === "markdown" || text.startsWith("# rolemem memories")) return c.json(importMarkdown(text, { screen: payload.screen === true }));
  return c.json(importPaste(text, { source: payload.source ?? "other", space: payload.space, type: payload.type, source_model: payload.source_model }));
});

app.get("/api/work", (c) => {
  guard(c);
  const project = c.req.query("project");
  const status = c.req.query("status");
  const q = c.req.query("q");
  const includeArchived = c.req.query("include_archived") === "1";
  if (status && !isWorkStatus(status)) throw new HttpError(400, "status must be active, paused, blocked, completed, or archived");
  const workStatus = status && isWorkStatus(status) ? status : undefined;
  return c.json({
    work: listWork({
      ...(project ? { project } : {}),
      ...(workStatus ? { status: workStatus } : {}),
      ...(q ? { q } : {}),
      includeArchived,
    }),
  });
});

app.post("/api/work", async (c) => {
  guard(c);
  const input = await body<{ project: string; title: string; goal: string; event_id?: string; client_id?: string; session_id?: string; separate?: boolean }>(c);
  const saved = startWork({ ...input, source_client: "admin" });
  return c.json(saved, saved.action === "created" ? 201 : 200);
});

app.get("/api/work/resume", (c) => {
  guard(c);
  const limit = c.req.query("limit_chars");
  return c.json(
    resumeWork({
      ...(c.req.query("work_id") ? { work_id: c.req.query("work_id") } : {}),
      ...(c.req.query("project") ? { project: c.req.query("project") } : {}),
      ...(c.req.query("q") ? { query: c.req.query("q") } : {}),
      ...(limit ? { limit_chars: Number(limit) } : {}),
    }),
  );
});

app.get("/api/work/:id", (c) => {
  guard(c);
  const item = getWork(c.req.param("id"));
  if (!item) throw new HttpError(404, "Work item not found");
  return c.json({ work: item, events: listWorkEvents(item.id, 50), summary: workSummary(item) });
});

app.patch("/api/work/:id", async (c) => {
  guard(c);
  const patch = await body<Record<string, unknown>>(c);
  return c.json(updateWork(c.req.param("id"), { ...patch, actor: "admin" }));
});

app.post("/api/work/:id/complete", async (c) => {
  guard(c);
  const input = await body<{ event_id?: string; progress_summary?: string; archive?: boolean; client_id?: string }>(c);
  const saved = completeWork(c.req.param("id"), { ...input, actor: "admin" });
  return c.json({ ...saved, summary: workSummary(saved.item) });
});

app.get("/api/audit", (c) => {
  guard(c);
  const limit = Number(c.req.query("limit") ?? 50);
  return c.json({ audit: listAudit(Number.isFinite(limit) ? limit : 50) });
});

app.get("/api/conflicts", (c) => {
  guard(c);
  return c.json({ conflicts: listConflicts(50) });
});

app.get("/api/connections", (c) => {
  guard(c);
  return c.json({ connections: listConnections() });
});

app.post("/api/connections", async (c) => {
  guard(c);
  const { label, rotate } = await body<{ label?: string; rotate?: boolean }>(c);
  const name = label?.trim() || "MCP client";
  if (rotate) {
    const existing = connectionByLabel(name);
    if (existing) revokeConnection(existing.id);
  }
  const created = createConnection(name);
  const base = publicBase(c);
  const url = `${base}/mcp`;
  return c.json(
    {
      connection: created.connection,
      key: created.key,
      snippets: {
        cursor: cursorSnippet(url, created.key),
        codex: codexSnippet(url, created.key),
        claudeCode: claudeCodeCommand("rolemem", url, created.key),
        url: `${url}/${created.key}`,
      },
    },
    201,
  );
});

app.delete("/api/connections/:id", (c) => {
  guard(c);
  revokeConnection(c.req.param("id"));
  return c.json({ ok: true });
});
