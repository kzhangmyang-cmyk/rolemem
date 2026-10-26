import { HttpError } from "./db.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Used by `npm run eval` only. The server never calls a model. */
export const llmConfigured = () => Boolean(process.env.LLM_API_KEY && process.env.LLM_MODEL);

export async function complete(messages: ChatMessage[]): Promise<string> {
  if (!llmConfigured()) throw new HttpError(502, "LLM_API_KEY and LLM_MODEL are not set");
  const base = (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.LLM_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.LLM_MODEL, messages, temperature: 0 }),
  });
  if (!res.ok) throw new HttpError(502, `Model request failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}
