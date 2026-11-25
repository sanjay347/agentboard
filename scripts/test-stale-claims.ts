// A claim that goes quiet is offered again, and nothing else is.
//   node scripts/test-stale-claims.ts
// Runs on an in-memory database so it can backdate a claim instead of waiting.
import assert from "node:assert/strict";
import { Store, STALE_CLAIM_MINUTES } from "../src/db.ts";
import { nodeSql } from "../src/sql-node.ts";

const sql = nodeSql(":memory:");
const store = await Store.open(sql);
const { workspace } = await store.createWorkspace("stale test");
const ws = workspace.id;
await store.createAgent(ws, "duet");
await store.createAgent(ws, "muse");

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const backdate = (id: string, minutes: number) => sql.run("UPDATE tasks SET updated_at = ? WHERE id = ?", ago(minutes), id);
const step = (s: string) => console.log(`  ✓ ${s}`);

// A quiet claim goes back to open, for the same agent.
const quiet = (await store.startThread(ws, "Find 3 good restaurants", "duet")).task;
await store.claimTask(ws, "duet", quiet.id);
await backdate(quiet.id, STALE_CLAIM_MINUTES + 1);
const v0 = await store.version(ws);
const inbox = await store.inbox(ws, "duet");
assert.deepEqual(inbox.map((t) => t.id), [quiet.id]);
const released = (await store.getTask(ws, quiet.id))!;
assert.equal(released.status, "open");
assert.equal(released.claimed_by, null);
assert.equal(released.assigned_to, "duet");
assert.ok((await store.version(ws)) > v0, "the app should see the change");
step(`a claim quiet for ${STALE_CLAIM_MINUTES + 1} minutes is open again, still for duet`);

const thread = (await store.getThread(ws, quiet.thread_id!))!;
const notice = thread.messages.find((m) => m.kind === "system");
assert.ok(notice && notice.author === "board" && notice.body.includes("open again"));
assert.ok((await store.recentEvents(ws)).some((e) => e.action === "task_released"));
step("the conversation and the activity log say why");

assert.deepEqual((await store.inbox(ws, "muse")).map((t) => t.id), []);
step("muse can't take work meant for duet");

// The original agent finishes late: the result still lands.
await store.updateTask(ws, "duet", quiet.id, { status: "done", result: "Three places" });
const late = (await store.getTask(ws, quiet.id))!;
assert.equal(late.status, "done");
assert.equal(late.claimed_by, "duet");
step("a late complete_task from duet still lands");

// Active work and questions are left alone.
const busy = (await store.startThread(ws, "Plan the trip", "duet")).task;
await store.claimTask(ws, "duet", busy.id);
await backdate(busy.id, STALE_CLAIM_MINUTES - 5);
const asking = (await store.startThread(ws, "Book a table", "muse")).task;
await store.claimTask(ws, "muse", asking.id);
await store.updateTask(ws, "muse", asking.id, { status: "blocked", note: "Which night?" });
await backdate(asking.id, 600);
await store.listTasks(ws);
await store.listThreads(ws);
assert.equal((await store.getTask(ws, busy.id))!.status, "in_progress");
assert.equal((await store.getTask(ws, asking.id))!.status, "blocked");
step("a recent claim and a question waiting on the user are not touched");

// Open to anyone: released for anyone.
const anyone = (await store.startThread(ws, "Summarise the week")).task;
await store.claimTask(ws, "muse", anyone.id);
await backdate(anyone.id, STALE_CLAIM_MINUTES + 10);
assert.deepEqual((await store.inbox(ws, "duet")).map((t) => t.id), [anyone.id]);
step("work open to anyone goes back to anyone");

console.log("\nstale claims: all checks passed");
