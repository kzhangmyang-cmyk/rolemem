import { serve } from "@hono/node-server";
import { adminAuth } from "./auth.ts";
import { app } from "./app.ts";
import { VERSION } from "./version.ts";

const auth = adminAuth();
if (process.env.NODE_ENV === "production" && auth.token.length < 16) {
  console.error("ROLEMEM_ADMIN_TOKEN must be at least 16 characters in production.");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, hostname: "0.0.0.0", port }, () => {
  console.log(`rolemem ${VERSION} listening on http://0.0.0.0:${port}`);
  if (auth.generated) {
    const where = auth.path ? ` Saved to ${auth.path}.` : "";
    console.log(`Generated admin token.${where} This is the only login:\n${auth.token}`);
  }
});
