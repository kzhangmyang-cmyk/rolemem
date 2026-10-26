import { createHash, randomBytes } from "node:crypto";
import { getDb, HttpError, now } from "./db.ts";

export interface Connection {
  id: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const PREFIX = "rmk_";
const hash = (key: string) => createHash("sha256").update(key).digest("hex");

export function createConnection(label?: string): { connection: Connection; key: string } {
  const key = PREFIX + randomBytes(24).toString("base64url");
  const connection: Connection = {
    id: `con_${randomBytes(8).toString("hex")}`,
    label: label?.trim().slice(0, 40) || "MCP client",
    created_at: now(),
    last_used_at: null,
    revoked_at: null,
  };
  getDb()
    .prepare("insert into connections(id, label, key_hash, created_at, last_used_at, revoked_at) values (?, ?, ?, ?, ?, ?)")
    .run(connection.id, connection.label, hash(key), connection.created_at, null, null);
  return { connection, key };
}

export function listConnections(): Connection[] {
  return getDb()
    .prepare("select id, label, created_at, last_used_at, revoked_at from connections where revoked_at is null order by created_at desc")
    .all() as unknown as Connection[];
}

export function revokeConnection(id: string): void {
  const row = getDb().prepare("select revoked_at from connections where id = ?").get(id) as { revoked_at: string | null } | undefined;
  if (!row) throw new HttpError(404, "Connection not found");
  if (row.revoked_at) throw new HttpError(409, "Connection is already revoked");
  getDb().prepare("update connections set revoked_at = ? where id = ?").run(now(), id);
}

export function connectionByLabel(label: string): Connection | undefined {
  return listConnections().find((connection) => connection.label === label);
}

/** MCP auth. Only the hash is stored. A revoked key fails immediately. */
export function authenticateConnection(key: string | undefined): Connection {
  if (!key?.startsWith(PREFIX)) throw new HttpError(401, "Connection key required");
  const connection = getDb()
    .prepare("select id, label, created_at, last_used_at, revoked_at from connections where key_hash = ?")
    .get(hash(key)) as Connection | undefined;
  if (!connection || connection.revoked_at) throw new HttpError(401, "Connection key is invalid or revoked");
  getDb().prepare("update connections set last_used_at = ? where id = ?").run(now(), connection.id);
  return { ...connection, last_used_at: now() };
}
