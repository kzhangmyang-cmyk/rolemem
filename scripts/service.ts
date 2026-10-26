// macOS login item: npm run service -- install | uninstall | status
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LAUNCHD_LABEL, launchdPlist } from "../src/cli/clients.ts";

const cmd = process.argv[2] ?? "status";
const projectDir = resolve(import.meta.dirname, "..");
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const port = process.env.PORT ?? "8787";
const domain = `gui/${process.getuid?.() ?? 501}`;

const launchctl = (...args: string[]) => {
  try {
    return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
};

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
  } catch {
    return false;
  }
}

if (process.platform !== "darwin") {
  console.error("This command is macOS only. On Linux use Docker or systemd. See the README.");
  process.exit(1);
}

if (cmd === "install") {
  const env: Record<string, string> = { PORT: port, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  if (process.env.ROLEMEM_DB) env.ROLEMEM_DB = resolve(process.env.ROLEMEM_DB);
  if (process.env.ROLEMEM_ADMIN_TOKEN) env.ROLEMEM_ADMIN_TOKEN = process.env.ROLEMEM_ADMIN_TOKEN;
  const log = join(projectDir, "data", "server.log");
  mkdirSync(join(projectDir, "data"), { recursive: true });
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  launchctl("bootout", `${domain}/${LAUNCHD_LABEL}`);
  writeFileSync(plistPath, launchdPlist({ node: process.execPath, projectDir, env, log }));
  if (launchctl("bootstrap", domain, plistPath) === null && launchctl("load", "-w", plistPath) === null) {
    console.error(`launchd rejected the plist at ${plistPath}.`);
    process.exit(1);
  }
  for (let i = 0; i < 20 && !(await healthy()); i++) await new Promise((resolveTimer) => setTimeout(resolveTimer, 250));
  if (!(await healthy())) {
    console.error(`The service was registered but is not answering. Log: ${log}`);
    process.exit(1);
  }
  console.log(`rolemem is running at http://localhost:${port}`);
  console.log(`It starts at login and restarts if it exits. Log: ${log}`);
  console.log("Remove it with: npm run service -- uninstall");
} else if (cmd === "uninstall") {
  launchctl("bootout", `${domain}/${LAUNCHD_LABEL}`) ?? launchctl("unload", plistPath);
  if (existsSync(plistPath)) rmSync(plistPath);
  console.log("Stopped and removed the rolemem login item. The database is still on disk.");
} else if (cmd === "status") {
  const loaded = launchctl("print", `${domain}/${LAUNCHD_LABEL}`) !== null;
  console.log(loaded ? "Login item: installed" : "Login item: not installed (npm run service -- install)");
  console.log((await healthy()) ? `Running: http://localhost:${port}` : `Nothing is answering on port ${port}`);
} else {
  console.error("Usage: npm run service -- install | uninstall | status");
  process.exit(1);
}
