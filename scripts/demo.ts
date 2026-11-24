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
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      // A deployed server only lets the admin create boards.
      ...(process.env.ADMIN_KEY ? { "x-admin-key": process.env.ADMIN_KEY } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await r.text(); // 204 responses have no body
  return { status: r.status, json: (raw ? JSON.parse(raw) : null) as any };
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
assert.equal(tools.length, 12);
step(`tools exposed: ${tools.join(", ")}`);

// The scheduled check agents run: nearly free when there's nothing to do.
const inboxText = async (agent: { client: Client }) =>
  ((await agent.client.callTool({ name: "check_inbox", arguments: {} })) as { content: { text: string }[] }).content[0].text;
assert.equal(await inboxText(muse), "Nothing waiting.");
const v0 = (await rest("/api/version", undefined, ws.owner_key)).json.version;
step(`check_inbox answers an empty board in ${"Nothing waiting.".length} characters`);

// Owner gives Muse a task, and Duet a follow-up that depends on it.
const t1 = (await rest("/api/tasks", { title: "Find 3 flights to Tokyo in March", assigned_to: "muse" }, ws.owner_key)).json;
const t2 = (await rest("/api/tasks", { title: "Draft an itinerary around the best flight", assigned_to: "duet", depends_on: t1.id }, ws.owner_key)).json;

assert.match(await inboxText(muse), new RegExp(`1 waiting: ${t1.id}`));
assert.equal(await inboxText(duet), "Nothing waiting."); // its task waits on muse's, so it isn't ready yet
assert.ok((await rest("/api/version", undefined, ws.owner_key)).json.version > v0);
step("check_inbox lists only work that's ready, and the board's version moved so the app knows to refresh");

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

// ---- Conversations from the app ---------------------------------------------
// A chat message is a task; the agent's result is the reply.
const started = (await rest("/api/threads", { body: "Find three ramen places open late near downtown", to: "muse" }, ws.owner_key)).json;
const th = started.thread.id;
const q1 = started.task.id;
assert.equal(started.thread.state, "waiting");
const inbox = (await muse.call("list_tasks", { mine: true, status: "open" })).data;
assert.equal(inbox.find((t: any) => t.id === q1)?.thread_id, th);
step("a chat message from the app arrives as an open task in muse's list");

await muse.call("claim_task", { id: q1 });
assert.equal((await rest(`/api/threads/${th}`, undefined, ws.owner_key)).json.state, "working");
await muse.call("update_task", { id: q1, status: "blocked", note: "Which neighbourhood counts as downtown for you?" });
let thread = (await rest(`/api/threads/${th}`, undefined, ws.owner_key)).json;
assert.equal(thread.state, "needs_you");
assert.equal(thread.messages.at(-1).kind, "question");
step("muse asks a question and the conversation moves to needs you");

const replied = (await rest(`/api/tasks/${q1}/reply`, { body: "Mission or SoMa" }, ws.owner_key)).json;
assert.equal(replied.status, "open");
assert.equal(replied.assigned_to, "muse");
assert.match((await duet.call("claim_task", { id: q1 })).error!, /assigned to muse/);
await muse.call("claim_task", { id: q1 });
const context = (await muse.call("get_task", { id: q1 })).data;
assert.deepEqual(context.conversation.map((m: any) => m.kind), ["request", "claimed", "question", "reply", "claimed"]);
assert.equal(context.conversation[3].text, "Mission or SoMa");
await muse.call("complete_task", { id: q1, result: "1. Ramen Shop (Mission, till 1am)\n2. Iza (SoMa)\n3. Mensho (till midnight)" });
thread = (await rest(`/api/threads/${th}`, undefined, ws.owner_key)).json;
assert.equal(thread.state, "needs_you");
assert.equal(thread.unread, true);
assert.equal((await rest(`/api/threads/${th}/read`, {}, ws.owner_key)).status, 204);
assert.equal((await rest(`/api/threads/${th}`, undefined, ws.owner_key)).json.state, "done");
step("the answer goes back to muse as open work, muse reads it in the conversation and replies");

// A hand-off in the same conversation: Duet gets Muse's result attached.
const q2 = (await rest(`/api/threads/${th}/messages`, { body: "Book a table at the first one for Friday 8pm", to: "duet", depends_on: q1 }, ws.owner_key)).json;
const handoff = (await duet.call("get_task", { id: q2.id })).data;
assert.equal(handoff.ready, true);
assert.match(handoff.dependency.result, /Ramen Shop/);
assert.equal(handoff.thread_id, th);
assert.equal(handoff.created_by, "owner");
step("a hand-off to duet carries muse's result, and duet can see the request came from the user");

// Owner actions on work nobody has picked up yet.
assert.equal((await rest(`/api/tasks/${q2.id}/reassign`, { to: "muse" }, ws.owner_key)).json.assigned_to, "muse");
assert.equal((await rest(`/api/tasks/${q2.id}/reassign`, { to: "nobody" }, ws.owner_key)).status, 400);
assert.equal((await rest(`/api/tasks/${q2.id}/cancel`, {}, ws.owner_key)).json.status, "cancelled");
assert.match((await muse.call("claim_task", { id: q2.id })).error!, /cancelled/);
assert.equal((await rest(`/api/tasks/${q1}/reply`, { body: "thanks" }, ws.owner_key)).status, 400);
step("unclaimed work can be reassigned or cancelled, and cancelled work can't be claimed");

const musePresence = (await rest("/api/agents", undefined, ws.owner_key)).json.find((a: any) => a.name === "muse");
assert.ok(musePresence.last_seen);
assert.equal(typeof musePresence.typical_pickup_seconds, "number");
const threads = (await rest("/api/threads", undefined, ws.owner_key)).json;
assert.equal(threads[0].id, th);
assert.equal(threads[0].state, "done");
step(`presence from the call log: muse last seen ${musePresence.last_seen}, picks up in ~${musePresence.typical_pickup_seconds}s`);

// Isolation: a different workspace sees none of this.
const other = (await rest("/api/workspaces", { name: "Someone else" })).json;
const spyReg = (await rest("/api/agents", { name: "spy" }, other.owner_key)).json;
const spy = await connect("spy", spyReg.token);
assert.deepEqual((await spy.call("list_tasks")).data, []);
assert.match((await spy.call("get_task", { id: t1.id })).error!, /not found/);
assert.deepEqual((await spy.call("recall", { query: "flight" })).data, []);
assert.equal((await rest("/api/board", undefined, other.owner_key)).json.tasks.length, 0);
assert.match((await spy.call("get_thread", { id: th })).error!, /not found/);
assert.equal((await rest(`/api/threads/${th}`, undefined, other.owner_key)).status, 404);
step("a second workspace cannot see the first one's tasks, memories or conversations");

// Bad credentials are rejected.
assert.equal((await rest("/api/board", undefined, "owner_wrong")).status, 401);
const bad = await fetch(`${BASE}/mcp/agent_wrong`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
assert.equal(bad.status, 401);
step("wrong owner key and wrong agent token are rejected");

console.log("\nAll checks passed.");
process.exit(0);
