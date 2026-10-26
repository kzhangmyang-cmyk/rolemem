/**
 * Pure string edits for AI client MCP config, plus the macOS launchd plist.
 * File IO lives in scripts/connect.ts and scripts/service.ts.
 */

export const CLIENTS = ["codex", "cursor", "claude-code", "url"] as const;
export type Client = (typeof CLIENTS)[number];

export function upsertCodexToml(toml: string, name: string, url: string, headers?: Record<string, string>): string {
  const header = `[mcp_servers.${name}]`;
  const lines = toml.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) skipping = trimmed === header || trimmed.startsWith(`[mcp_servers.${name}.`);
    if (!skipping) out.push(line);
  }
  const kept = out.join("\n").trimEnd();
  const headerLines = Object.entries(headers ?? {}).map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
  const block = headerLines.length
    ? `${header}\nurl = ${JSON.stringify(url)}\n\n[mcp_servers.${name}.http_headers]\n${headerLines.join("\n")}\n`
    : `${header}\nurl = ${JSON.stringify(url)}\n`;
  return `${kept ? `${kept}\n\n` : ""}${block}`;
}

export function upsertCursorJson(json: string, name: string, url: string, key: string): string {
  const config = json.trim() ? (JSON.parse(json) as { mcpServers?: Record<string, unknown> }) : {};
  config.mcpServers = { ...(config.mcpServers ?? {}), [name]: { url, headers: { Authorization: `Bearer ${key}` } } };
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function claudeCodeCommand(name: string, url: string, key: string): string {
  return `claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer ${key}"`;
}

export function cursorSnippet(url: string, key: string, name = "rolemem"): string {
  return JSON.stringify({ mcpServers: { [name]: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
}

export function codexSnippet(url: string, key: string, name = "rolemem"): string {
  return upsertCodexToml("", name, url, { Authorization: `Bearer ${key}` }).trimEnd();
}

export const LAUNCHD_LABEL = "dev.rolemem.server";

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist(opts: { node: string; projectDir: string; env: Record<string, string>; log: string }): string {
  const args = [opts.node, "--no-warnings", "--env-file-if-exists=.env", "src/server.ts"];
  const env = Object.entries(opts.env)
    .map(([key, value]) => `      <key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args.map((arg) => `      <string>${xml(arg)}</string>`).join("\n")}
    </array>
    <key>WorkingDirectory</key><string>${xml(opts.projectDir)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${xml(opts.log)}</string>
    <key>StandardErrorPath</key><string>${xml(opts.log)}</string>
  </dict>
</plist>
`;
}
