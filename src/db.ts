// Storage layer. Every row is scoped by workspace_id, so one deployment can
// serve many customers. All SQL lives in this file and runs through the Sql
// interface (sql.ts): node:sqlite locally, Cloudflare D1 in production.
import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "./sql.ts";

export type TaskStatus = "open" | "in_progress" | "blocked" | "done" | "cancelled";

export interface Workspace { id: string; name: string }
export interface Agent { id: string; workspace_id: string; name: string }
export interface Task {
  id: string;
  title: string;
  details: string;
  status: TaskStatus;
  created_by: string;
  assigned_to: string | null;
  claimed_by: string | null;
  depends_on: string | null;
  result: string | null;
  note: string | null;
  thread_id: string | null;
  /** When the task last became available to claim: posted, reassigned, or reopened by a reply. */
  opened_at: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface Memory { id: string; content: string; tags: string; created_by: string; created_at: string }
export interface Event { id: number; actor: string; action: string; subject: string; summary: string; created_at: string }

// A thread is one conversation in the app. Each request in it is a task; the
// messages are its timeline, so the app can show who did what and when.
export type MessageKind = "request" | "claimed" | "note" | "question" | "result" | "reply" | "system";
export interface Message { id: number; thread_id: string; task_id: string | null; author: string; kind: MessageKind; body: string; created_at: string }
export type ThreadState = "needs_you" | "working" | "waiting" | "done";
export interface Thread { id: string; title: string; created_at: string; updated_at: string; last_read_at: string | null }
export interface ThreadSummary extends Thread {
  state: ThreadState;
  unread: boolean;
  agents: string[];
  last_message: Pick<Message, "author" | "kind" | "body" | "created_at"> | null;
}
export interface AgentPresence {
  id: string;
  name: string;
  created_at: string;
  /** Last time this agent called any tool on the board. */
  last_seen: string | null;
  /** Median seconds from a task becoming available to this agent claiming it. */
  typical_pickup_seconds: number | null;
  pickups: number;
}
export interface ToolCall { id: number; agent: string; tool: string; args: string; ok: number; created_at: string }

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const newId = (prefix: string) => `${prefix}_${randomBytes(5).toString("hex")}`;
const newSecret = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;
const now = () => new Date().toISOString();

/** First line of a message, cut at a word boundary, for titles and list previews. */
export function headline(text: string, max: number): string {
  const line = text.trim().split("\n")[0].trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut) + "…";
}

// One statement per entry: D1 runs statements individually.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, UNIQUE (workspace_id, name))`,
  `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', created_by TEXT NOT NULL, assigned_to TEXT, claimed_by TEXT, depends_on TEXT, result TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, thread_id TEXT, opened_at TEXT, claimed_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS tasks_ws ON tasks (workspace_id, status, updated_at)`,
  `CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS memories_ws ON memories (workspace_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS events_ws ON events (workspace_id, id)`,
  // Every MCP tool call, reads included: an agent that checks the board and
  // claims nothing leaves no trace in events, and "did it look?" needs the reads.
  `CREATE TABLE IF NOT EXISTS tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), agent TEXT NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL DEFAULT '', ok INTEGER NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS tool_calls_ws ON tool_calls (workspace_id, id)`,
  `CREATE INDEX IF NOT EXISTS tool_calls_agent ON tool_calls (workspace_id, agent, created_at)`,
  `CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_read_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS threads_ws ON threads (workspace_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id), thread_id TEXT NOT NULL REFERENCES threads(id), task_id TEXT, author TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, id)`,
];
// Columns added after the first release, for boards created before them.
const MIGRATIONS = [
  "ALTER TABLE tasks ADD COLUMN thread_id TEXT",
  "ALTER TABLE tasks ADD COLUMN opened_at TEXT",
  "ALTER TABLE tasks ADD COLUMN claimed_at TEXT",
  "ALTER TABLE workspaces ADD COLUMN version INTEGER NOT NULL DEFAULT 0",
];
const LATE_INDEXES = ["CREATE INDEX IF NOT EXISTS tasks_thread ON tasks (thread_id)"];

const TASK_COLS =
  "id, title, details, status, created_by, assigned_to, claimed_by, depends_on, result, note, thread_id, opened_at, claimed_at, created_at, updated_at";

/** A chat message as a task: the first line is the title, the full text the details. */
function taskFields(body: string): { title: string; details: string } {
  const title = headline(body, 200);
  return { title, details: body.trim() === title ? "" : body.trim() };
}

export class Store {
  private readonly sql: Sql;
  private constructor(sql: Sql) {
    this.sql = sql;
  }

  /** Opens a store, creating or upgrading the schema. Safe to run on every start. */
  static async open(sql: Sql): Promise<Store> {
    for (const statement of SCHEMA) await sql.run(statement);
    for (const statement of MIGRATIONS) {
      // SQLite has no ADD COLUMN IF NOT EXISTS; an existing column is the only expected failure.
      await sql.run(statement).catch((e: Error) => {
        if (!/duplicate column/i.test(e.message)) throw e;
      });
    }
    for (const statement of LATE_INDEXES) await sql.run(statement);
    return new Store(sql);
  }

  // ---- change counter -----------------------------------------------------
  // Bumped on every change a person would see, so the app can poll one row
  // and download the board only when something actually changed. (Downloading
  // it every few seconds would use up D1's free daily reads in hours.)

  private bump(ws: string) {
    return this.sql.run("UPDATE workspaces SET version = version + 1 WHERE id = ?", ws);
  }

  async version(ws: string): Promise<number> {
    return (await this.sql.get<{ version: number }>("SELECT version FROM workspaces WHERE id = ?", ws))?.version ?? 0;
  }

  // ---- tenants and credentials -------------------------------------------

  /** Returns the owner key once; only its hash is stored. */
  async createWorkspace(name: string): Promise<{ workspace: Workspace; ownerKey: string }> {
    const workspace = { id: newId("ws"), name };
    const ownerKey = newSecret("owner");
    await this.sql.run("INSERT INTO workspaces (id, name, owner_key_hash, created_at) VALUES (?, ?, ?, ?)", workspace.id, name, hash(ownerKey), now());
    return { workspace, ownerKey };
  }

  workspaceByOwnerKey(key: string): Promise<Workspace | undefined> {
    return this.sql.get<Workspace>("SELECT id, name FROM workspaces WHERE owner_key_hash = ?", hash(key));
  }

  /** Returns the agent token once; only its hash is stored. */
  async createAgent(workspaceId: string, name: string): Promise<{ agent: Agent; token: string }> {
    const agent = { id: newId("ag"), workspace_id: workspaceId, name };
    const token = newSecret("agent");
    await this.sql.run("INSERT INTO agents (id, workspace_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)", agent.id, workspaceId, name, hash(token), now());
    await this.log(workspaceId, "owner", "agent_added", agent.id, `Agent "${name}" connected`);
    return { agent, token };
  }

  agentByToken(token: string): Promise<Agent | undefined> {
    return this.sql.get<Agent>("SELECT id, workspace_id, name FROM agents WHERE token_hash = ?", hash(token));
  }

  listAgents(workspaceId: string): Promise<{ id: string; name: string; created_at: string }[]> {
    return this.sql.all("SELECT id, name, created_at FROM agents WHERE workspace_id = ? ORDER BY created_at", workspaceId);
  }

  async revokeAgent(workspaceId: string, agentId: string): Promise<boolean> {
    const r = await this.sql.run("DELETE FROM agents WHERE workspace_id = ? AND id = ?", workspaceId, agentId);
    if (r.changes) await this.log(workspaceId, "owner", "agent_revoked", agentId, "Agent access revoked");
    return r.changes > 0;
  }

  private async requireAgent(ws: string, name: string): Promise<void> {
    const names = (await this.listAgents(ws)).map((a) => a.name);
    if (!names.includes(name)) throw new Error(`no agent named "${name}" (agents: ${names.join(", ") || "none"})`);
  }

  /** Who is around and how quickly each agent usually picks work up, from the board's own records. */
  async agentPresence(ws: string): Promise<AgentPresence[]> {
    const agents = await this.listAgents(ws);
    return Promise.all(
      agents.map(async (a) => {
        const seen = await this.sql.get<{ t: string | null }>("SELECT MAX(created_at) AS t FROM tool_calls WHERE workspace_id = ? AND agent = ?", ws, a.name);
        // Tasks that wait on another task are left out: their wait includes the
        // other agent's work, which says nothing about how fast this one responds.
        const rows = await this.sql.all<{ opened_at: string; claimed_at: string }>(
          `SELECT opened_at, claimed_at FROM tasks
           WHERE workspace_id = ? AND claimed_by = ? AND claimed_at IS NOT NULL AND opened_at IS NOT NULL AND depends_on IS NULL
           ORDER BY claimed_at DESC LIMIT 20`,
          ws,
          a.name,
        );
        const waits = rows.map((r) => (Date.parse(r.claimed_at) - Date.parse(r.opened_at)) / 1000).filter((s) => s >= 0).sort((x, y) => x - y);
        const mid = waits.length >> 1;
        const median = !waits.length ? null : waits.length % 2 ? waits[mid] : (waits[mid - 1] + waits[mid]) / 2;
        return { ...a, last_seen: seen?.t ?? null, typical_pickup_seconds: median === null ? null : Math.round(median), pickups: waits.length };
      }),
    );
  }

  // ---- tasks --------------------------------------------------------------

  async postTask(
    ws: string,
    actor: string,
    t: { title: string; details?: string; assigned_to?: string; depends_on?: string; thread_id?: string; message?: string },
  ): Promise<Task> {
    const dependency = t.depends_on ? await this.getTask(ws, t.depends_on) : undefined;
    if (t.depends_on && !dependency) throw new Error(`depends_on task ${t.depends_on} not found`);
    if (t.assigned_to) await this.requireAgent(ws, t.assigned_to);
    if (t.thread_id && !(await this.getThreadRow(ws, t.thread_id))) throw new Error(`thread ${t.thread_id} not found`);
    // Follow-up work stays in the conversation it came from.
    const threadId = t.thread_id ?? dependency?.thread_id ?? null;
    const id = newId("t");
    const ts = now();
    await this.sql.run(
      `INSERT INTO tasks (id, workspace_id, title, details, created_by, assigned_to, depends_on, thread_id, opened_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, ws, t.title, t.details ?? "", actor, t.assigned_to ?? null, t.depends_on ?? null, threadId, ts, ts, ts,
    );
    await this.log(ws, actor, "task_posted", id, `${t.title}${t.assigned_to ? ` (for ${t.assigned_to})` : ""}`);
    if (threadId) await this.addMessage(ws, threadId, id, actor, "request", t.message ?? (t.details ? `${t.title}\n\n${t.details}` : t.title));
    return (await this.getTask(ws, id))!;
  }

  getTask(ws: string, id: string): Promise<Task | undefined> {
    return this.sql.get<Task>(`SELECT ${TASK_COLS} FROM tasks WHERE workspace_id = ? AND id = ?`, ws, id);
  }

  listTasks(ws: string, f: { status?: TaskStatus; assigned_to?: string; limit?: number } = {}): Promise<Task[]> {
    const where = ["workspace_id = ?"];
    const args: (string | number)[] = [ws];
    if (f.status) { where.push("status = ?"); args.push(f.status); }
    if (f.assigned_to) { where.push("(assigned_to = ? OR assigned_to IS NULL)"); args.push(f.assigned_to); }
    args.push(Math.min(f.limit ?? 50, 200));
    return this.sql.all<Task>(`SELECT ${TASK_COLS} FROM tasks WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`, ...args);
  }

  /**
   * Open work this agent could start right now: assigned to it or to anyone,
   * and not waiting on an unfinished task. The cheap question an agent asks on
   * a schedule, so it reads as few rows as possible.
   */
  inbox(ws: string, agent: string): Promise<{ id: string; title: string }[]> {
    return this.sql.all(
      `SELECT id, title FROM tasks
       WHERE workspace_id = ? AND status = 'open' AND (assigned_to = ? OR assigned_to IS NULL)
         AND (depends_on IS NULL OR depends_on IN (SELECT id FROM tasks WHERE workspace_id = ? AND status = 'done'))
       ORDER BY created_at LIMIT 10`,
      ws, agent, ws,
    );
  }

  /** Atomic: only one agent can win a claim, and only on a task open to it. */
  async claimTask(ws: string, actor: string, id: string): Promise<Task> {
    const ts = now();
    const r = await this.sql.run(
      `UPDATE tasks SET status = 'in_progress', claimed_by = ?, claimed_at = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ? AND status = 'open' AND (assigned_to IS NULL OR assigned_to = ?)`,
      actor, ts, ts, ws, id, actor,
    );
    const task = await this.getTask(ws, id);
    if (!task) throw new Error(`task ${id} not found`);
    if (!r.changes) {
      throw new Error(
        task.status !== "open"
          ? `task ${id} is ${task.status}${task.claimed_by ? ` (claimed by ${task.claimed_by})` : ""}`
          : `task ${id} is assigned to ${task.assigned_to}`,
      );
    }
    await this.log(ws, actor, "task_claimed", id, task.title);
    if (task.thread_id) await this.addMessage(ws, task.thread_id, id, actor, "claimed", "");
    return task;
  }

  async updateTask(ws: string, actor: string, id: string, u: { status?: TaskStatus; note?: string; result?: string }): Promise<Task> {
    const task = await this.getTask(ws, id);
    if (!task) throw new Error(`task ${id} not found`);
    if (task.status === "cancelled") throw new Error(`task ${id} was cancelled by the user`);
    if (actor !== "owner" && task.claimed_by && task.claimed_by !== actor) throw new Error(`task ${id} is claimed by ${task.claimed_by}`);
    const status = u.status ?? task.status;
    await this.sql.run(
      "UPDATE tasks SET status = ?, note = ?, result = ?, claimed_by = COALESCE(claimed_by, ?), updated_at = ? WHERE workspace_id = ? AND id = ?",
      status, u.note ?? task.note, u.result ?? task.result, actor === "owner" ? null : actor, now(), ws, id,
    );
    await this.log(ws, actor, status === "done" ? "task_done" : "task_updated", id, `${task.title} → ${status}${u.note ? `: ${u.note}` : ""}`);
    if (task.thread_id) {
      if (u.result) await this.addMessage(ws, task.thread_id, id, actor, "result", u.result);
      if (u.note) await this.addMessage(ws, task.thread_id, id, actor, status === "blocked" ? "question" : "note", u.note);
      else if (status === "blocked" && task.status !== "blocked") await this.addMessage(ws, task.thread_id, id, actor, "question", "Needs your input to continue.");
    }
    return (await this.getTask(ws, id))!;
  }

  // ---- owner actions on a task ---------------------------------------------
  // D1 has no multi-statement transactions, so each action validates before
  // its first write. What follows the main UPDATE is the timeline and the log.

  /**
   * The user answers an agent. A blocked task goes back to the agent that asked,
   * as an open task assigned to it, so the agent's usual loop (list, claim, read)
   * picks the answer up without learning anything new.
   */
  async replyToTask(ws: string, id: string, body: string): Promise<Task> {
    const task = await this.getTask(ws, id);
    if (!task) throw new Error(`task ${id} not found`);
    if (!task.thread_id) throw new Error(`task ${id} is not part of a conversation`);
    if (task.status === "done" || task.status === "cancelled") throw new Error(`task ${id} is ${task.status}`);
    if (task.status === "blocked") {
      const ts = now();
      await this.sql.run(
        `UPDATE tasks SET status = 'open', assigned_to = COALESCE(claimed_by, assigned_to), claimed_by = NULL,
         claimed_at = NULL, opened_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
        ts, ts, ws, id,
      );
    }
    await this.addMessage(ws, task.thread_id, id, "owner", "reply", body);
    await this.log(ws, "owner", "task_reply", id, body);
    await this.markRead(ws, task.thread_id);
    return (await this.getTask(ws, id))!;
  }

  /** Hand a task nobody is working on to a different agent, or open it to any agent (to = null). */
  async reassignTask(ws: string, id: string, to: string | null): Promise<Task> {
    const task = await this.getTask(ws, id);
    if (!task) throw new Error(`task ${id} not found`);
    if (task.status !== "open" && task.status !== "blocked") throw new Error(`task ${id} is ${task.status}: only open or blocked tasks can be reassigned`);
    if (to) await this.requireAgent(ws, to);
    const ts = now();
    await this.sql.run(
      `UPDATE tasks SET status = 'open', assigned_to = ?, claimed_by = NULL, claimed_at = NULL, opened_at = ?, updated_at = ?
       WHERE workspace_id = ? AND id = ?`,
      to, ts, ts, ws, id,
    );
    const summary = to ? `Reassigned to ${to}` : "Opened to any agent";
    await this.log(ws, "owner", "task_reassigned", id, `${task.title}: ${summary}`);
    if (task.thread_id) await this.addMessage(ws, task.thread_id, id, "owner", "system", summary);
    return (await this.getTask(ws, id))!;
  }

  async cancelTask(ws: string, id: string): Promise<Task> {
    const task = await this.getTask(ws, id);
    if (!task) throw new Error(`task ${id} not found`);
    if (task.status === "done") throw new Error(`task ${id} is already done`);
    if (task.status === "cancelled") return task;
    await this.sql.run("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE workspace_id = ? AND id = ?", now(), ws, id);
    await this.log(ws, "owner", "task_cancelled", id, task.title);
    if (task.thread_id) await this.addMessage(ws, task.thread_id, id, "owner", "system", "Cancelled");
    return (await this.getTask(ws, id))!;
  }

  // ---- threads -------------------------------------------------------------

  /** A new conversation: the first message becomes the first task. */
  async startThread(ws: string, body: string, to?: string): Promise<{ thread: ThreadSummary; task: Task }> {
    if (to) await this.requireAgent(ws, to); // before any write, so a bad name leaves nothing behind
    const id = newId("th");
    const ts = now();
    await this.sql.run(
      "INSERT INTO threads (id, workspace_id, title, created_at, updated_at, last_read_at) VALUES (?, ?, ?, ?, ?, ?)",
      id, ws, headline(body, 60), ts, ts, ts,
    );
    const task = await this.postTask(ws, "owner", { ...taskFields(body), assigned_to: to, thread_id: id, message: body });
    return { thread: await this.summarise(ws, (await this.getThreadRow(ws, id))!), task };
  }

  /** Another request in an existing conversation. depends_on hands a previous result to this task. */
  async addToThread(ws: string, threadId: string, body: string, to?: string, dependsOn?: string): Promise<Task> {
    if (!(await this.getThreadRow(ws, threadId))) throw new Error(`thread ${threadId} not found`);
    const task = await this.postTask(ws, "owner", { ...taskFields(body), assigned_to: to, depends_on: dependsOn, thread_id: threadId, message: body });
    await this.markRead(ws, threadId);
    return task;
  }

  async listThreads(ws: string, limit = 100): Promise<ThreadSummary[]> {
    const rows = await this.sql.all<Thread>(
      "SELECT id, title, created_at, updated_at, last_read_at FROM threads WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ?",
      ws, Math.min(limit, 200),
    );
    // A few small queries per thread. Fine for a person's board; batch them
    // if a board ever holds thousands of conversations.
    return Promise.all(rows.map((t) => this.summarise(ws, t)));
  }

  async getThread(ws: string, id: string): Promise<(ThreadSummary & { messages: Message[]; tasks: Task[] }) | undefined> {
    const row = await this.getThreadRow(ws, id);
    if (!row) return undefined;
    return {
      ...(await this.summarise(ws, row)),
      messages: await this.threadMessages(ws, id),
      tasks: await this.sql.all<Task>(`SELECT ${TASK_COLS} FROM tasks WHERE workspace_id = ? AND thread_id = ? ORDER BY created_at`, ws, id),
    };
  }

  /** The last `limit` messages of a conversation, oldest first. */
  async threadMessages(ws: string, threadId: string, limit = 200): Promise<Message[]> {
    const rows = await this.sql.all<Message>(
      "SELECT id, thread_id, task_id, author, kind, body, created_at FROM messages WHERE workspace_id = ? AND thread_id = ? ORDER BY id DESC LIMIT ?",
      ws, threadId, limit,
    );
    return rows.reverse();
  }

  async markRead(ws: string, threadId: string): Promise<boolean> {
    const r = await this.sql.run("UPDATE threads SET last_read_at = ? WHERE workspace_id = ? AND id = ?", now(), ws, threadId);
    if (r.changes) await this.bump(ws);
    return r.changes > 0;
  }

  private getThreadRow(ws: string, id: string): Promise<Thread | undefined> {
    return this.sql.get<Thread>("SELECT id, title, created_at, updated_at, last_read_at FROM threads WHERE workspace_id = ? AND id = ?", ws, id);
  }

  private async addMessage(ws: string, threadId: string, taskId: string | null, author: string, kind: MessageKind, body: string): Promise<void> {
    const ts = now();
    await this.sql.run(
      "INSERT INTO messages (workspace_id, thread_id, task_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ws, threadId, taskId, author, kind, body, ts,
    );
    await this.sql.run("UPDATE threads SET updated_at = ? WHERE workspace_id = ? AND id = ?", ts, ws, threadId);
    await this.bump(ws);
  }

  /**
   * What the conversation needs from the user, in priority order: an agent is
   * asking something or has replied unread (needs_you), an agent is working,
   * a request is waiting to be picked up, or it is all finished.
   */
  private async summarise(ws: string, t: Thread): Promise<ThreadSummary> {
    const tasks = await this.sql.all<{ status: TaskStatus; assigned_to: string | null; claimed_by: string | null }>(
      "SELECT status, assigned_to, claimed_by FROM tasks WHERE workspace_id = ? AND thread_id = ? ORDER BY created_at",
      ws, t.id,
    );
    const unread = !!(await this.sql.get(
      "SELECT 1 AS x FROM messages WHERE workspace_id = ? AND thread_id = ? AND kind IN ('result', 'question') AND created_at > ? LIMIT 1",
      ws, t.id, t.last_read_at ?? "",
    ));
    const has = (s: TaskStatus) => tasks.some((x) => x.status === s);
    const state: ThreadState = has("blocked") || unread ? "needs_you" : has("in_progress") ? "working" : has("open") ? "waiting" : "done";
    const last = await this.sql.get<ThreadSummary["last_message"]>(
      "SELECT author, kind, body, created_at FROM messages WHERE workspace_id = ? AND thread_id = ? AND kind != 'claimed' ORDER BY id DESC LIMIT 1",
      ws, t.id,
    );
    // Oldest first, so the last entry is the agent the conversation is with now.
    const agents = [...new Set(tasks.flatMap((x) => [x.claimed_by, x.assigned_to]).filter((a): a is string => !!a))];
    return { ...t, state, unread, agents, last_message: last ?? null };
  }

  // ---- shared memory ------------------------------------------------------

  async remember(ws: string, actor: string, content: string, tags: string[] = []): Promise<Memory> {
    const id = newId("m");
    await this.sql.run("INSERT INTO memories (id, workspace_id, content, tags, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, ws, content, tags.join(","), actor, now());
    await this.log(ws, actor, "memory_saved", id, content.slice(0, 120));
    return (await this.sql.get<Memory>("SELECT id, content, tags, created_by, created_at FROM memories WHERE id = ?", id))!;
  }

  /** Keyword recall ranked by how many query terms match, then recency.
   *  Swap for embeddings behind this same method when it matters. */
  recall(ws: string, query: string, limit = 10): Promise<Memory[]> {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1).slice(0, 8);
    if (!terms.length) {
      return this.sql.all<Memory>("SELECT id, content, tags, created_by, created_at FROM memories WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?", ws, limit);
    }
    const match = "(instr(lower(content || ' ' || tags), ?) > 0)";
    const score = terms.map(() => match).join(" + ");
    return this.sql.all<Memory>(
      `SELECT id, content, tags, created_by, created_at FROM (
         SELECT *, ${score} AS score FROM memories WHERE workspace_id = ?
       ) WHERE score > 0 ORDER BY score DESC, created_at DESC LIMIT ?`,
      ...terms, ws, limit,
    );
  }

  async forget(ws: string, id: string): Promise<boolean> {
    const r = await this.sql.run("DELETE FROM memories WHERE workspace_id = ? AND id = ?", ws, id);
    if (r.changes) await this.bump(ws);
    return r.changes > 0;
  }

  // ---- activity log -------------------------------------------------------

  async log(ws: string, actor: string, action: string, subject: string, summary: string): Promise<void> {
    await this.sql.run(
      "INSERT INTO events (workspace_id, actor, action, subject, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ws, actor, action, subject, summary.slice(0, 300), now(),
    );
    await this.bump(ws);
  }

  recentEvents(ws: string, limit = 30): Promise<Event[]> {
    return this.sql.all<Event>("SELECT id, actor, action, subject, summary, created_at FROM events WHERE workspace_id = ? ORDER BY id DESC LIMIT ?", ws, Math.min(limit, 200));
  }

  // ---- tool call log ------------------------------------------------------
  // Separate from events on purpose: this is instrumentation, not the activity
  // feed a person reads. It answers when an agent contacted the board at all.

  async logCall(ws: string, agent: string, tool: string, args: unknown, ok: boolean): Promise<void> {
    let summary = "";
    try {
      summary = typeof args === "object" && args ? JSON.stringify(args).slice(0, 300) : "";
    } catch {
      summary = "<unserialisable>";
    }
    await this.sql.run("INSERT INTO tool_calls (workspace_id, agent, tool, args, ok, created_at) VALUES (?, ?, ?, ?, ?, ?)", ws, agent, tool, summary, ok ? 1 : 0, now());
  }

  toolCalls(ws: string, since?: string): Promise<ToolCall[]> {
    return since
      ? this.sql.all<ToolCall>("SELECT id, agent, tool, args, ok, created_at FROM tool_calls WHERE workspace_id = ? AND created_at >= ? ORDER BY id", ws, since)
      : this.sql.all<ToolCall>("SELECT id, agent, tool, args, ok, created_at FROM tool_calls WHERE workspace_id = ? ORDER BY id", ws);
  }

  /** Every workspace with its agents, newest first. */
  listWorkspaces(): Promise<{ id: string; name: string; agents: string; created_at: string }[]> {
    return this.sql.all(
      `SELECT w.id, w.name, w.created_at, COALESCE(GROUP_CONCAT(a.name, ', '), '') AS agents
       FROM workspaces w LEFT JOIN agents a ON a.workspace_id = w.id
       GROUP BY w.id ORDER BY w.created_at DESC`,
    );
  }
}
