import { app } from "../src/app.ts";

export const ADMIN = process.env.ROLEMEM_ADMIN_TOKEN ?? "test-admin-token-please";

export async function request(method: string, path: string, body?: unknown, token: string | null = ADMIN) {
  const res = await app.request(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = text;
    }
  }
  return { status: res.status, data };
}

export async function call(method: string, path: string, body?: unknown, token: string | null = ADMIN) {
  const { status, data } = await request(method, path, body, token);
  if (status >= 400) {
    const message = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : String(data);
    throw new Error(`${method} ${path} -> ${status} ${message}`);
  }
  return data as any;
}
