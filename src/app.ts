// HTTP surface: the MCP endpoint for agents, a REST API for the owner and the
// iOS app, and health. Built on Hono so the same code runs under Node (local
// development, CI) and on Cloudflare Workers (production). It keeps nothing in
// memory between requests except a best-effort rate limiter.
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Store, Workspace } from "./db.ts";
import { buildMcpServer } from "./mcp.ts";

export interface Runtime {
  /** The store for this request. Workers bind the database per request, so this is a function. */
  store(c: Context): Promise<Store>;
  /** Public base URL for connector links; falls back to the request's own origin. */
  publicUrl(c: Context): string | undefined;
  /** Who may create a board: a request from this machine, the admin key, or anyone if public sign-up is on. */
  mayCreateBoard(c: Context): boolean;
}

type Vars = { workspace: Workspace; store: Store };

export function createApp(rt: Runtime) {
  const app = new Hono<{ Variables: Vars }>();

  // Fixed-window limit per client address. In memory, so per instance (per
  // isolate on Workers): a brake on runaway clients, not a security boundary.
  const hits = new Map<string, { n: number; reset: number }>();
  const limit = (max: number) => async (c: Context, next: Next) => {
    const ip = c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "local";
    const key = `${max}:${ip}`;
    const t = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < t) {
      if (hits.size > 10_000) hits.clear();
      hits.set(key, (h = { n: 0, reset: t + 60_000 }));
    }
    if (++h.n > max) return c.json({ error: "Too many requests, slow down" }, 429);
    await next();
  };

  const bearer = (c: Context) => /^Bearer\s+(.+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
  const baseUrl = (c: Context) => (rt.publicUrl(c) ?? new URL(c.req.url).origin).replace(/\/$/, "");

  app.get("/healthz", (c) => c.json({ ok: true }));

  // ---- MCP endpoint for agents ------------------------------------------
  // The agent token comes as a Bearer header, or in the path for agent products
  // whose connector form only accepts a URL.
  const handleMcp = async (c: Context) => {
    const store = await rt.store(c);
    const token = c.req.param("token") ?? bearer(c);
    const agent = token ? await store.agentByToken(token) : undefined;
    if (!agent) return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "Unknown or missing agent token" }, id: null }, 401);
    if (c.req.method !== "POST") return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, 405);
    const server = buildMcpServer(store, agent);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  };
  app.all("/mcp", limit(300), handleMcp);
  app.all("/mcp/:token", limit(300), handleMcp);

  // ---- Owner API ---------------------------------------------------------
  // New boards can only be created from this machine, with the admin key, or
  // when public sign-up is on, so a public deployment isn't open to strangers.
  app.post("/api/workspaces", limit(10), async (c) => {
    if (!rt.mayCreateBoard(c)) return c.json({ error: "Creating boards is not open on this server" }, 403);
    const body = await c.req.json().catch(() => ({}));
    const name = String(body?.name ?? "").trim().slice(0, 80);
    if (!name) return c.json({ error: "name is required" }, 400);
    const { workspace, ownerKey } = await (await rt.store(c)).createWorkspace(name);
    return c.json({ workspace, owner_key: ownerKey }, 201);
  });

  const api = new Hono<{ Variables: Vars }>();
  api.use("*", limit(300), async (c, next) => {
    const store = await rt.store(c);
    const key = bearer(c);
    const workspace = key ? await store.workspaceByOwnerKey(key) : undefined;
    if (!workspace) return c.json({ error: "Invalid owner key" }, 401);
    c.set("workspace", workspace);
    c.set("store", store);
    await next();
  });
  const ws = (c: Context<{ Variables: Vars }>) => c.get("workspace").id;
  const st = (c: Context<{ Variables: Vars }>) => c.get("store");
  const json = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
  const name = (v: unknown) => (v ? String(v).trim().toLowerCase() : undefined);
  /** Store methods throw plain Errors with a reason the user can read; 404 when nothing matched. */
  const fail = (c: Context, e: unknown) => {
    const message = (e as Error).message;
    return c.json({ error: message }, /not found/.test(message) ? 404 : 400);
  };

  /** One row read: the app polls this and downloads the board only when it changes. */
  api.get("/version", async (c) => c.json({ version: await st(c).version(ws(c)) }));

  api.get("/board", async (c) => {
    const s = st(c);
    const id = ws(c);
    const [agents, tasks, memories, events, version] = await Promise.all([
      s.agentPresence(id),
      s.listTasks(id, { limit: 100 }),
      s.recall(id, c.req.query("q") ?? "", 50),
      s.recentEvents(id, 50),
      s.version(id),
    ]);
    return c.json({ workspace: c.get("workspace"), agents, tasks, memories, events, version });
  });

  api.post("/agents", async (c) => {
    const n = text((await json(c)).name, 31).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(n) || n === "owner") {
      return c.json({ error: "name must be letters, digits, - or _ (max 31), and not 'owner'" }, 400);
    }
    try {
      const { agent, token } = await st(c).createAgent(ws(c), n);
      const base = baseUrl(c);
      return c.json({ agent: { id: agent.id, name: n }, token, mcp_url: `${base}/mcp`, mcp_url_with_token: `${base}/mcp/${token}` }, 201);
    } catch {
      return c.json({ error: `an agent named "${n}" already exists` }, 409);
    }
  });

  api.delete("/agents/:id", async (c) => c.body(null, (await st(c).revokeAgent(ws(c), c.req.param("id"))) ? 204 : 404));

  api.post("/tasks", async (c) => {
    const b = await json(c);
    const title = text(b.title, 200);
    if (!title) return c.json({ error: "title is required" }, 400);
    try {
      return c.json(
        await st(c).postTask(ws(c), "owner", {
          title,
          details: b.details ? text(b.details, 8000) : undefined,
          assigned_to: b.assigned_to ? String(b.assigned_to) : undefined,
          depends_on: b.depends_on ? String(b.depends_on) : undefined,
        }),
        201,
      );
    } catch (e) {
      return fail(c, e);
    }
  });

  api.post("/memories", async (c) => {
    const content = text((await json(c)).content, 4000);
    if (!content) return c.json({ error: "content is required" }, 400);
    return c.json(await st(c).remember(ws(c), "owner", content, []), 201);
  });

  api.delete("/memories/:id", async (c) => c.body(null, (await st(c).forget(ws(c), c.req.param("id"))) ? 204 : 404));

  // ---- Conversations -----------------------------------------------------
  // The app's chat. Each message the user sends is a task; the agent's result
  // is the reply. Agents find the work the same way they always do.

  api.get("/agents", async (c) => c.json(await st(c).agentPresence(ws(c))));
  api.get("/threads", async (c) => c.json(await st(c).listThreads(ws(c))));

  api.post("/threads", async (c) => {
    const b = await json(c);
    const body = text(b.body, 8000);
    if (!body) return c.json({ error: "body is required" }, 400);
    try {
      return c.json(await st(c).startThread(ws(c), body, name(b.to)), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  api.get("/threads/:id", async (c) => {
    const thread = await st(c).getThread(ws(c), c.req.param("id"));
    return thread ? c.json(thread) : c.json({ error: "thread not found" }, 404);
  });

  api.post("/threads/:id/messages", async (c) => {
    const b = await json(c);
    const body = text(b.body, 8000);
    if (!body) return c.json({ error: "body is required" }, 400);
    try {
      return c.json(await st(c).addToThread(ws(c), c.req.param("id"), body, name(b.to), b.depends_on ? String(b.depends_on) : undefined), 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  api.post("/threads/:id/read", async (c) => c.body(null, (await st(c).markRead(ws(c), c.req.param("id"))) ? 204 : 404));

  api.post("/tasks/:id/reply", async (c) => {
    const body = text((await json(c)).body, 8000);
    if (!body) return c.json({ error: "body is required" }, 400);
    try {
      return c.json(await st(c).replyToTask(ws(c), c.req.param("id"), body));
    } catch (e) {
      return fail(c, e);
    }
  });

  api.post("/tasks/:id/reassign", async (c) => {
    try {
      return c.json(await st(c).reassignTask(ws(c), c.req.param("id"), name((await json(c)).to) ?? null));
    } catch (e) {
      return fail(c, e);
    }
  });

  api.post("/tasks/:id/cancel", async (c) => {
    try {
      return c.json(await st(c).cancelTask(ws(c), c.req.param("id")));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.route("/api", api);
  return app;
}
