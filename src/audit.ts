import { getDb, now } from "./db.ts";

export interface AuditRow {
  id: number;
  at: string;
  actor: string | null;
  action: string;
  target: string | null;
  detail: string | null;
}

/** Minimal operator trail. Detail is a short label, not memory or secret text. */
export function audit(action: string, target: string | null, detail: string | null, actor: string | null = null): void {
  getDb()
    .prepare("insert into audit_log(at, actor, action, target, detail) values (?, ?, ?, ?, ?)")
    .run(now(), actor, action, target, detail === null ? null : detail.slice(0, 300));
}

export function listAudit(limit = 50): AuditRow[] {
  const size = Math.min(Math.max(limit, 1), 200);
  return getDb()
    .prepare("select id, at, actor, action, target, detail from audit_log order by id desc limit ?")
    .all(size) as unknown as AuditRow[];
}
