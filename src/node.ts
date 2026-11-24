// Node entry point: local development and CI. Serves the dashboard from
// public/ and the database from a SQLite file.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { IncomingMessage } from "node:http";
import { createApp } from "./app.ts";
import { Store } from "./db.ts";
import { nodeSql } from "./sql-node.ts";

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/$/, "");
const store = await Store.open(nodeSql(process.env.DB_PATH ?? "data/agentboard.db"));

const app = createApp({
  store: async () => store,
  publicUrl: () => PUBLIC_URL,
  // Local only if it came straight from this machine, not through a tunnel or proxy.
  mayCreateBoard: (c) => {
    const incoming = (c.env as { incoming?: IncomingMessage })?.incoming;
    const local = !c.req.header("x-forwarded-for") && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(incoming?.socket.remoteAddress ?? "");
    return local || process.env.ALLOW_PUBLIC_SIGNUP === "true";
  },
});
app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: PORT }, () => console.log(`agentboard listening on ${PUBLIC_URL ?? `http://localhost:${PORT}`}`));
