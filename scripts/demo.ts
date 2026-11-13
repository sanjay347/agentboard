// End-to-end check: two simulated agents ("muse" and "duet") hand work to each
// other through the board over real MCP, plus tenant-isolation checks.
// Usage: start the server, then `npm run demo` (BASE_URL defaults to :8787).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import assert from "node:assert/strict";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";

async function rest(path: string, body?: unknown, key?: string) {
  const r = await fetch(BASE + path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: (await r.json()) as any };
}

async function connect(name: string, token: string, inPath = false) {
  const client = new Client({ name: `${name}-sim`, version: "0.0.1" });
  const url = new URL(inPath ? `${BASE}/mcp/${token}` : `${BASE}/mcp`);
  await client.connect(new StreamableHTTPClientTransport(url, inPath ? {} : { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name: tool, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content[0].text;
    return res.isError ? { error: text } : { data: JSON.parse(text).data };
  };
  return { client, call };
}

const step = (msg: string) => console.log("✓ " + msg);

// Owner sets up a board and connects two agents.
const ws = (await rest("/api/workspaces", { name: "Demo board" })).json;
const museReg = (await rest("/api/agents", { name: "muse" }, ws.owner_key)).json;
const duetReg = (await rest("/api/agents", { name: "duet" }, ws.owner_key)).json;
const muse = await connect("muse", museReg.token); // Bearer header
const duet = await connect("duet", duetReg.token, true); // token in URL
step("workspace created, muse and duet connected over MCP");

const tools = (await muse.client.listTools()).tools.map((t) => t.name);
assert.equal(tools.length, 10);
step(`tools exposed: ${tools.join(", ")}`);

// Owner gives Muse a task, and Duet a follow-up that depends on it.
const t1 = (await rest("/api/tasks", { title: "Find 3 flights to Tokyo in March", assigned_to: "muse" }, ws.owner_key)).json;
const t2 = (await rest("/api/tasks", { title: "Draft an itinerary around the best flight", assigned_to: "duet", depends_on: t1.id }, ws.owner_key)).json;

// Duet looks first: its task is not ready, and it cannot take Muse's task.
assert.equal((await duet.call("get_task", { id: t2.id })).data.ready, false);
assert.match((await duet.call("claim_task", { id: t1.id })).error!, /assigned to muse/);
step("duet sees its task is waiting on muse, and cannot claim muse's task");

// Muse does its work.
const mine = (await muse.call("list_tasks", { mine: true, status: "open" })).data;
assert.deepEqual(mine.map((t: any) => t.id), [t1.id]);
await muse.call("claim_task", { id: t1.id });
assert.match((await muse.call("claim_task", { id: t1.id })).error!, /in_progress/);
await muse.call("complete_task", { id: t1.id, result: "Best: ANA NH7, Mar 14, $940 nonstop." });
await muse.call("remember", { content: "User prefers nonstop flights and window seats", tags: ["travel"] });
step("muse claimed, completed its task, and saved a memory");

// Duet picks up where Muse left off, using Muse's result and memory.
const ready = (await duet.call("get_task", { id: t2.id })).data;
assert.equal(ready.ready, true);
assert.match(ready.dependency.result, /NH7/);
assert.equal(ready.dependency.done_by, "muse");
const recalled = (await duet.call("recall", { query: "flight seat preferences" })).data;
assert.match(recalled[0].content, /window seats/);
await duet.call("claim_task", { id: t2.id });
await duet.call("complete_task", { id: t2.id, result: "Itinerary drafted around NH7." });
step("duet read muse's result and memory, then finished the follow-up");

const activity = (await duet.call("recent_activity", { limit: 50 })).data;
assert.ok(activity.some((e: any) => e.actor === "muse" && e.action === "task_done"));
step(`activity log has ${activity.length} events from owner, muse and duet`);

// Isolation: a different workspace sees none of this.
const other = (await rest("/api/workspaces", { name: "Someone else" })).json;
const spyReg = (await rest("/api/agents", { name: "spy" }, other.owner_key)).json;
const spy = await connect("spy", spyReg.token);
assert.deepEqual((await spy.call("list_tasks")).data, []);
assert.match((await spy.call("get_task", { id: t1.id })).error!, /not found/);
assert.deepEqual((await spy.call("recall", { query: "flight" })).data, []);
assert.equal((await rest("/api/board", undefined, other.owner_key)).json.tasks.length, 0);
step("a second workspace cannot see the first one's tasks or memories");

// Bad credentials are rejected.
assert.equal((await rest("/api/board", undefined, "owner_wrong")).status, 401);
const bad = await fetch(`${BASE}/mcp/agent_wrong`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
assert.equal(bad.status, 401);
step("wrong owner key and wrong agent token are rejected");

console.log("\nAll checks passed.");
process.exit(0);
