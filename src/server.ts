// HTTP entry point: the MCP endpoint for agents, a small REST API for the
// owner, and the dashboard. Holds no in-memory state between requests.
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { fileURLToPath } from "node:url";
import { Store } from "./db.ts";
import type { Workspace } from "./db.ts";
import { buildMcpServer } from "./mcp.ts";

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/$/, "");
const store = new Store(process.env.DB_PATH ?? "data/agentboard.db");

const app = express();
// Behind a tunnel or load balancer the real client address and public host
// arrive in X-Forwarded-* headers.
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));

const baseUrl = (req: Request) => PUBLIC_URL ?? `${req.protocol}://${req.host}`;
// A request is local only if it came straight from this machine, not through a proxy.
const isLocal = (req: Request) =>
  !req.get("x-forwarded-for") && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");

// Fixed-window limit per client address. In-memory, so per instance: move to
// Redis when running more than one copy.
const hits = new Map<string, { n: number; reset: number }>();
const limit = (max: number) => (req: Request, res: Response, next: NextFunction) => {
  const key = `${max}:${req.ip}`;
  const t = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < t) hits.set(key, (h = { n: 0, reset: t + 60_000 }));
  if (++h.n > max) return void res.status(429).json({ error: "Too many requests, slow down" });
  next();
};
setInterval(() => { const t = Date.now(); for (const [k, h] of hits) if (h.reset < t) hits.delete(k); }, 60_000).unref();
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

const bearer = (req: Request) => /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "")?.[1];

// ---- MCP endpoint for agents ----------------------------------------------
// The agent token comes as a Bearer header, or in the path for agent products
// whose connector form only accepts a URL. Replace with OAuth before launch.
async function handleMcp(req: Request, res: Response) {
  const token = (req.params.token as string | undefined) ?? bearer(req);
  const agent = token ? store.agentByToken(token) : undefined;
  if (!agent) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unknown or missing agent token" }, id: null });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    return;
  }
  const server = buildMcpServer(store, agent);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
app.all("/mcp", limit(300), handleMcp);
app.all("/mcp/:token", limit(300), handleMcp);

// ---- Owner API (used by the dashboard) ------------------------------------
// New boards can only be created from this machine unless public signup is
// switched on, so exposing the server does not open it to strangers.
app.post("/api/workspaces", limit(10), (req, res) => {
  if (!isLocal(req) && process.env.ALLOW_PUBLIC_SIGNUP !== "true") {
    return void res.status(403).json({ error: "Creating boards is not open on this server" });
  }
  const name = String(req.body?.name ?? "").trim().slice(0, 80);
  if (!name) return void res.status(400).json({ error: "name is required" });
  const { workspace, ownerKey } = store.createWorkspace(name);
  res.status(201).json({ workspace, owner_key: ownerKey });
});

type Authed = Request & { workspace: Workspace };
function owner(req: Request, res: Response, next: NextFunction) {
  const key = bearer(req);
  const workspace = key ? store.workspaceByOwnerKey(key) : undefined;
  if (!workspace) return void res.status(401).json({ error: "Invalid owner key" });
  (req as Authed).workspace = workspace;
  next();
}
const api = express.Router();
api.use(limit(300), owner);
const wsOf = (req: Request) => (req as Authed).workspace;

api.get("/board", (req, res) => {
  const ws = wsOf(req);
  res.json({
    workspace: ws,
    agents: store.listAgents(ws.id),
    tasks: store.listTasks(ws.id, { limit: 100 }),
    memories: store.recall(ws.id, String(req.query.q ?? ""), 50),
    events: store.recentEvents(ws.id, 50),
  });
});

api.post("/agents", (req, res) => {
  const name = String(req.body?.name ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(name) || name === "owner") {
    return void res.status(400).json({ error: "name must be letters, digits, - or _ (max 31), and not 'owner'" });
  }
  try {
    const { agent, token } = store.createAgent(wsOf(req).id, name);
    res.status(201).json({ agent: { id: agent.id, name }, token, mcp_url: `${baseUrl(req)}/mcp`, mcp_url_with_token: `${baseUrl(req)}/mcp/${token}` });
  } catch {
    res.status(409).json({ error: `an agent named "${name}" already exists` });
  }
});

api.delete("/agents/:id", (req, res) => {
  res.status(store.revokeAgent(wsOf(req).id, req.params.id) ? 204 : 404).end();
});

api.post("/tasks", (req, res) => {
  const title = String(req.body?.title ?? "").trim().slice(0, 200);
  if (!title) return void res.status(400).json({ error: "title is required" });
  try {
    const task = store.postTask(wsOf(req).id, "owner", {
      title,
      details: req.body.details ? String(req.body.details).slice(0, 8000) : undefined,
      assigned_to: req.body.assigned_to ? String(req.body.assigned_to) : undefined,
      depends_on: req.body.depends_on ? String(req.body.depends_on) : undefined,
    });
    res.status(201).json(task);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

api.post("/memories", (req, res) => {
  const content = String(req.body?.content ?? "").trim().slice(0, 4000);
  if (!content) return void res.status(400).json({ error: "content is required" });
  res.status(201).json(store.remember(wsOf(req).id, "owner", content, []));
});

api.delete("/memories/:id", (req, res) => {
  res.status(store.forget(wsOf(req).id, req.params.id) ? 204 : 404).end();
});

app.use("/api", api);
app.get("/healthz", (_req, res) => void res.json({ ok: true }));

app.listen(PORT, () => console.log(`agentboard listening on ${PUBLIC_URL ?? `http://localhost:${PORT}`}`));
