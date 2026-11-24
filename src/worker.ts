// Cloudflare Workers entry point: the production deployment. The dashboard is
// served from public/ as static assets (see wrangler.jsonc); everything else
// comes here. The database is D1, bound as DB.
import { createApp } from "./app.ts";
import { Store } from "./db.ts";
import { d1Sql } from "./sql-d1.ts";
import type { D1Database } from "./sql-d1.ts";

interface Env {
  DB: D1Database;
  PUBLIC_URL?: string;
  /** Secret (wrangler secret put ADMIN_KEY): sent as X-Admin-Key to create a board. */
  ADMIN_KEY?: string;
  ALLOW_PUBLIC_SIGNUP?: string;
}

// The schema check runs once per isolate, not once per request.
let ready: Promise<Store> | undefined;

const app = createApp({
  store: (c) => (ready ??= Store.open(d1Sql((c.env as Env).DB)).catch((e) => { ready = undefined; throw e; })),
  publicUrl: (c) => (c.env as Env).PUBLIC_URL,
  mayCreateBoard: (c) => {
    const env = c.env as Env;
    if (env.ALLOW_PUBLIC_SIGNUP === "true") return true;
    const given = c.req.header("x-admin-key");
    return !!env.ADMIN_KEY && !!given && given === env.ADMIN_KEY;
  },
});

export default app;
