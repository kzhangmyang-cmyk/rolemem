import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HttpError } from "./db.ts";

export interface AdminAuth {
  token: string;
  /** True when this process created the token because none was configured. */
  generated: boolean;
  path?: string;
}

let cached: AdminAuth | undefined;

/**
 * One admin token for the whole server. There is no registration.
 * Prefer ROLEMEM_ADMIN_TOKEN. Otherwise persist a generated token beside the database
 * so a Docker volume keeps it across restarts.
 */
export function adminAuth(): AdminAuth {
  if (cached) return cached;
  const fromEnv = process.env.ROLEMEM_ADMIN_TOKEN?.trim();
  if (fromEnv) return (cached = { token: fromEnv, generated: false });

  const dbPath = process.env.ROLEMEM_DB ?? "data/rolemem.db";
  if (dbPath === ":memory:") return (cached = { token: "memory-admin-token", generated: true });

  const path = join(dirname(dbPath), "admin.token");
  if (existsSync(path)) {
    const token = readFileSync(path, "utf8").trim();
    if (token) return (cached = { token, generated: false, path });
  }
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(24).toString("base64url");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return (cached = { token, generated: true, path });
}

export function tokensMatch(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function authenticateAdmin(header: string | undefined): void {
  const token = header?.replace(/^Bearer\s+/i, "").trim();
  if (!token || !tokensMatch(token, adminAuth().token)) throw new HttpError(401, "Admin token required");
}
