// Storage layer. Every row is scoped by workspace_id, so one deployment can
// serve many customers. All SQL lives in this file: moving from SQLite to
// Postgres means rewriting this file only.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

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

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
        UNIQUE (workspace_id, name)
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
        created_by TEXT NOT NULL, assigned_to TEXT, claimed_by TEXT, depends_on TEXT,
        result TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_ws ON tasks (workspace_id, status, updated_at);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        content TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_ws ON memories (workspace_id, created_at);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        actor TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_ws ON events (workspace_id, id);
      -- Every MCP tool call, reads included. The events table above records only
      -- changes, so an agent that checks the board and claims nothing leaves no
      -- trace there. Answering "did this agent look on its own?" needs the reads.
      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        agent TEXT NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL DEFAULT '',
        ok INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tool_calls_ws ON tool_calls (workspace_id, id);
      CREATE INDEX IF NOT EXISTS tool_calls_agent ON tool_calls (workspace_id, agent, created_at);
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_read_at TEXT
      );
      CREATE INDEX IF NOT EXISTS threads_ws ON threads (workspace_id, updated_at);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        thread_id TEXT NOT NULL REFERENCES threads(id), task_id TEXT, author TEXT NOT NULL,
        kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, id);
    `);
    // Columns added after the first release. SQLite has no ADD COLUMN IF NOT
    // EXISTS, so check first: existing boards keep their data.
    const cols = (this.db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name);
    for (const col of ["thread_id", "opened_at", "claimed_at"]) {
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS tasks_thread ON tasks (thread_id)");
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- tenants and credentials -------------------------------------------

  /** Returns the owner key once; only its hash is stored. */
  createWorkspace(name: string): { workspace: Workspace; ownerKey: string } {
    const workspace = { id: newId("ws"), name };
    const ownerKey = newSecret("owner");
    this.db.prepare("INSERT INTO workspaces VALUES (?, ?, ?, ?)").run(workspace.id, name, hash(ownerKey), now());
    return { workspace, ownerKey };
  }

  workspaceByOwnerKey(key: string): Workspace | undefined {
    return this.db.prepare("SELECT id, name FROM workspaces WHERE owner_key_hash = ?").get(hash(key)) as Workspace | undefined;
  }

  /** Returns the agent token once; only its hash is stored. */
  createAgent(workspaceId: string, name: string): { agent: Agent; token: string } {
    const agent = { id: newId("ag"), workspace_id: workspaceId, name };
    const token = newSecret("agent");
    this.db.prepare("INSERT INTO agents VALUES (?, ?, ?, ?, ?)").run(agent.id, workspaceId, name, hash(token), now());
    this.log(workspaceId, "owner", "agent_added", agent.id, `Agent "${name}" connected`);
    return { agent, token };
  }

  agentByToken(token: string): Agent | undefined {
    return this.db.prepare("SELECT id, workspace_id, name FROM agents WHERE token_hash = ?").get(hash(token)) as Agent | undefined;
  }

  listAgents(workspaceId: string): { id: string; name: string; created_at: string }[] {
    return this.db.prepare("SELECT id, name, created_at FROM agents WHERE workspace_id = ? ORDER BY created_at").all(workspaceId) as never;
  }

  revokeAgent(workspaceId: string, agentId: string): boolean {
    const r = this.db.prepare("DELETE FROM agents WHERE workspace_id = ? AND id = ?").run(workspaceId, agentId);
    if (r.changes) this.log(workspaceId, "owner", "agent_revoked", agentId, "Agent access revoked");
    return r.changes > 0;
  }

  private requireAgent(ws: string, name: string): void {
    const names = this.listAgents(ws).map((a) => a.name);
    if (!names.includes(name)) throw new Error(`no agent named "${name}" (agents: ${names.join(", ") || "none"})`);
  }

  /** Who is around and how quickly each agent usually picks work up, from the board's own records. */
  agentPresence(ws: string): AgentPresence[] {
    const seen = this.db.prepare("SELECT MAX(created_at) AS t FROM tool_calls WHERE workspace_id = ? AND agent = ?");
    // Tasks that wait on another task are left out: their wait includes the
    // other agent's work, which says nothing about how fast this one responds.
    const claims = this.db.prepare(
      `SELECT opened_at, claimed_at FROM tasks
       WHERE workspace_id = ? AND claimed_by = ? AND claimed_at IS NOT NULL AND opened_at IS NOT NULL AND depends_on IS NULL
       ORDER BY claimed_at DESC LIMIT 20`,
    );
    return this.listAgents(ws).map((a) => {
      const waits = (claims.all(ws, a.name) as { opened_at: string; claimed_at: string }[])
        .map((r) => (Date.parse(r.claimed_at) - Date.parse(r.opened_at)) / 1000)
        .filter((s) => s >= 0)
        .sort((x, y) => x - y);
      const mid = waits.length >> 1;
      const median = !waits.length ? null : waits.length % 2 ? waits[mid] : (waits[mid - 1] + waits[mid]) / 2;
      return {
        ...a,
        last_seen: (seen.get(ws, a.name) as { t: string | null }).t,
        typical_pickup_seconds: median === null ? null : Math.round(median),
        pickups: waits.length,
      };
    });
  }

  // ---- tasks --------------------------------------------------------------

  postTask(
    ws: string,
    actor: string,
    t: { title: string; details?: string; assigned_to?: string; depends_on?: string; thread_id?: string; message?: string },
  ): Task {
    const dependency = t.depends_on ? this.getTask(ws, t.depends_on) : undefined;
    if (t.depends_on && !dependency) throw new Error(`depends_on task ${t.depends_on} not found`);
    if (t.assigned_to) this.requireAgent(ws, t.assigned_to);
    if (t.thread_id && !this.getThreadRow(ws, t.thread_id)) throw new Error(`thread ${t.thread_id} not found`);
    // Follow-up work stays in the conversation it came from.
    const threadId = t.thread_id ?? dependency?.thread_id ?? null;
    const id = newId("t");
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, workspace_id, title, details, created_by, assigned_to, depends_on, thread_id, opened_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ws, t.title, t.details ?? "", actor, t.assigned_to ?? null, t.depends_on ?? null, threadId, ts, ts, ts);
    this.log(ws, actor, "task_posted", id, `${t.title}${t.assigned_to ? ` (for ${t.assigned_to})` : ""}`);
    if (threadId) this.addMessage(ws, threadId, id, actor, "request", t.message ?? (t.details ? `${t.title}\n\n${t.details}` : t.title));
    return this.getTask(ws, id)!;
  }

  getTask(ws: string, id: string): Task | undefined {
    return this.db.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE workspace_id = ? AND id = ?`).get(ws, id) as Task | undefined;
  }

  listTasks(ws: string, f: { status?: TaskStatus; assigned_to?: string; limit?: number } = {}): Task[] {
    const where = ["workspace_id = ?"];
    const args: (string | number)[] = [ws];
    if (f.status) { where.push("status = ?"); args.push(f.status); }
    if (f.assigned_to) { where.push("(assigned_to = ? OR assigned_to IS NULL)"); args.push(f.assigned_to); }
    args.push(Math.min(f.limit ?? 50, 200));
    return this.db
      .prepare(`SELECT ${TASK_COLS} FROM tasks WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`)
      .all(...args) as unknown as Task[];
  }

  /** Atomic: only one agent can win a claim, and only on a task open to it. */
  claimTask(ws: string, actor: string, id: string): Task {
    const ts = now();
    const r = this.db
      .prepare(
        `UPDATE tasks SET status = 'in_progress', claimed_by = ?, claimed_at = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND status = 'open' AND (assigned_to IS NULL OR assigned_to = ?)`,
      )
      .run(actor, ts, ts, ws, id, actor);
    const task = this.getTask(ws, id);
    if (!task) throw new Error(`task ${id} not found`);
    if (!r.changes) {
      throw new Error(
        task.status !== "open"
          ? `task ${id} is ${task.status}${task.claimed_by ? ` (claimed by ${task.claimed_by})` : ""}`
          : `task ${id} is assigned to ${task.assigned_to}`,
      );
    }
    this.log(ws, actor, "task_claimed", id, task.title);
    if (task.thread_id) this.addMessage(ws, task.thread_id, id, actor, "claimed", "");
    return task;
  }

  updateTask(ws: string, actor: string, id: string, u: { status?: TaskStatus; note?: string; result?: string }): Task {
    const task = this.getTask(ws, id);
    if (!task) throw new Error(`task ${id} not found`);
    if (task.status === "cancelled") throw new Error(`task ${id} was cancelled by the user`);
    if (actor !== "owner" && task.claimed_by && task.claimed_by !== actor) {
      throw new Error(`task ${id} is claimed by ${task.claimed_by}`);
    }
    const status = u.status ?? task.status;
    this.db
      .prepare("UPDATE tasks SET status = ?, note = ?, result = ?, claimed_by = COALESCE(claimed_by, ?), updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(status, u.note ?? task.note, u.result ?? task.result, actor === "owner" ? null : actor, now(), ws, id);
    this.log(ws, actor, status === "done" ? "task_done" : "task_updated", id, `${task.title} → ${status}${u.note ? `: ${u.note}` : ""}`);
    if (task.thread_id) {
      if (u.result) this.addMessage(ws, task.thread_id, id, actor, "result", u.result);
      if (u.note) this.addMessage(ws, task.thread_id, id, actor, status === "blocked" ? "question" : "note", u.note);
      else if (status === "blocked" && task.status !== "blocked") this.addMessage(ws, task.thread_id, id, actor, "question", "Needs your input to continue.");
    }
    return this.getTask(ws, id)!;
  }

  // ---- owner actions on a task ---------------------------------------------

  /**
   * The user answers an agent. A blocked task goes back to the agent that asked,
   * as an open task assigned to it, so the agent's usual loop (list, claim, read)
   * picks the answer up without learning anything new.
   */
  replyToTask(ws: string, id: string, body: string): Task {
    return this.tx(() => {
      const task = this.getTask(ws, id);
      if (!task) throw new Error(`task ${id} not found`);
      if (!task.thread_id) throw new Error(`task ${id} is not part of a conversation`);
      if (task.status === "done" || task.status === "cancelled") throw new Error(`task ${id} is ${task.status}`);
      if (task.status === "blocked") {
        const ts = now();
        this.db
          .prepare(
            `UPDATE tasks SET status = 'open', assigned_to = COALESCE(claimed_by, assigned_to), claimed_by = NULL,
             claimed_at = NULL, opened_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`,
          )
          .run(ts, ts, ws, id);
      }
      this.addMessage(ws, task.thread_id, id, "owner", "reply", body);
      this.log(ws, "owner", "task_reply", id, body);
      this.markRead(ws, task.thread_id);
      return this.getTask(ws, id)!;
    });
  }

  /** Hand a task nobody is working on to a different agent, or open it to any agent (to = null). */
  reassignTask(ws: string, id: string, to: string | null): Task {
    return this.tx(() => {
      const task = this.getTask(ws, id);
      if (!task) throw new Error(`task ${id} not found`);
      if (task.status !== "open" && task.status !== "blocked") {
        throw new Error(`task ${id} is ${task.status}: only open or blocked tasks can be reassigned`);
      }
      if (to) this.requireAgent(ws, to);
      const ts = now();
      this.db
        .prepare(
          `UPDATE tasks SET status = 'open', assigned_to = ?, claimed_by = NULL, claimed_at = NULL, opened_at = ?, updated_at = ?
           WHERE workspace_id = ? AND id = ?`,
        )
        .run(to, ts, ts, ws, id);
      const summary = to ? `Reassigned to ${to}` : "Opened to any agent";
      this.log(ws, "owner", "task_reassigned", id, `${task.title}: ${summary}`);
      if (task.thread_id) this.addMessage(ws, task.thread_id, id, "owner", "system", summary);
      return this.getTask(ws, id)!;
    });
  }

  cancelTask(ws: string, id: string): Task {
    return this.tx(() => {
      const task = this.getTask(ws, id);
      if (!task) throw new Error(`task ${id} not found`);
      if (task.status === "done") throw new Error(`task ${id} is already done`);
      if (task.status === "cancelled") return task;
      this.db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE workspace_id = ? AND id = ?").run(now(), ws, id);
      this.log(ws, "owner", "task_cancelled", id, task.title);
      if (task.thread_id) this.addMessage(ws, task.thread_id, id, "owner", "system", "Cancelled");
      return this.getTask(ws, id)!;
    });
  }

  // ---- threads -------------------------------------------------------------

  /** A new conversation: the first message becomes the first task. */
  startThread(ws: string, body: string, to?: string): { thread: ThreadSummary; task: Task } {
    return this.tx(() => {
      if (to) this.requireAgent(ws, to);
      const id = newId("th");
      const ts = now();
      this.db
        .prepare("INSERT INTO threads (id, workspace_id, title, created_at, updated_at, last_read_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, ws, headline(body, 60), ts, ts, ts);
      const task = this.postTask(ws, "owner", { ...taskFields(body), assigned_to: to, thread_id: id, message: body });
      return { thread: this.summarise(ws, this.getThreadRow(ws, id)!), task };
    });
  }

  /** Another request in an existing conversation. depends_on hands a previous result to this task. */
  addToThread(ws: string, threadId: string, body: string, to?: string, dependsOn?: string): Task {
    return this.tx(() => {
      if (!this.getThreadRow(ws, threadId)) throw new Error(`thread ${threadId} not found`);
      const task = this.postTask(ws, "owner", { ...taskFields(body), assigned_to: to, depends_on: dependsOn, thread_id: threadId, message: body });
      this.markRead(ws, threadId);
      return task;
    });
  }

  listThreads(ws: string, limit = 100): ThreadSummary[] {
    const rows = this.db
      .prepare("SELECT id, title, created_at, updated_at, last_read_at FROM threads WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(ws, Math.min(limit, 200)) as unknown as Thread[];
    // One small query per thread. Fine for a person's board; batch it if a
    // board ever holds thousands of conversations.
    return rows.map((t) => this.summarise(ws, t));
  }

  getThread(ws: string, id: string): (ThreadSummary & { messages: Message[]; tasks: Task[] }) | undefined {
    const row = this.getThreadRow(ws, id);
    if (!row) return undefined;
    return {
      ...this.summarise(ws, row),
      messages: this.threadMessages(ws, id),
      tasks: this.db.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE workspace_id = ? AND thread_id = ? ORDER BY created_at`).all(ws, id) as unknown as Task[],
    };
  }

  /** The last `limit` messages of a conversation, oldest first. */
  threadMessages(ws: string, threadId: string, limit = 200): Message[] {
    const rows = this.db
      .prepare(
        "SELECT id, thread_id, task_id, author, kind, body, created_at FROM messages WHERE workspace_id = ? AND thread_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(ws, threadId, limit) as unknown as Message[];
    return rows.reverse();
  }

  markRead(ws: string, threadId: string): boolean {
    return this.db.prepare("UPDATE threads SET last_read_at = ? WHERE workspace_id = ? AND id = ?").run(now(), ws, threadId).changes > 0;
  }

  private getThreadRow(ws: string, id: string): Thread | undefined {
    return this.db.prepare("SELECT id, title, created_at, updated_at, last_read_at FROM threads WHERE workspace_id = ? AND id = ?").get(ws, id) as
      | Thread
      | undefined;
  }

  private addMessage(ws: string, threadId: string, taskId: string | null, author: string, kind: MessageKind, body: string): void {
    const ts = now();
    this.db
      .prepare("INSERT INTO messages (workspace_id, thread_id, task_id, author, kind, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(ws, threadId, taskId, author, kind, body, ts);
    this.db.prepare("UPDATE threads SET updated_at = ? WHERE workspace_id = ? AND id = ?").run(ts, ws, threadId);
  }

  /**
   * What the conversation needs from the user, in priority order: an agent is
   * asking something or has replied unread (needs_you), an agent is working,
   * a request is waiting to be picked up, or it is all finished.
   */
  private summarise(ws: string, t: Thread): ThreadSummary {
    const tasks = this.db.prepare("SELECT status, assigned_to, claimed_by FROM tasks WHERE workspace_id = ? AND thread_id = ? ORDER BY created_at").all(ws, t.id) as {
      status: TaskStatus;
      assigned_to: string | null;
      claimed_by: string | null;
    }[];
    const unread = !!this.db
      .prepare("SELECT 1 FROM messages WHERE workspace_id = ? AND thread_id = ? AND kind IN ('result', 'question') AND created_at > ? LIMIT 1")
      .get(ws, t.id, t.last_read_at ?? "");
    const has = (s: TaskStatus) => tasks.some((x) => x.status === s);
    const state: ThreadState =
      has("blocked") || unread ? "needs_you" : has("in_progress") ? "working" : has("open") ? "waiting" : "done";
    const last = this.db
      .prepare("SELECT author, kind, body, created_at FROM messages WHERE workspace_id = ? AND thread_id = ? AND kind != 'claimed' ORDER BY id DESC LIMIT 1")
      .get(ws, t.id) as ThreadSummary["last_message"] | undefined;
    // Oldest first, so the last entry is the agent the conversation is with now.
    const agents = [...new Set(tasks.flatMap((x) => [x.claimed_by, x.assigned_to]).filter((a): a is string => !!a))];
    return { ...t, state, unread, agents, last_message: last ?? null };
  }

  // ---- shared memory ------------------------------------------------------

  remember(ws: string, actor: string, content: string, tags: string[] = []): Memory {
    const id = newId("m");
    this.db.prepare("INSERT INTO memories VALUES (?, ?, ?, ?, ?, ?)").run(id, ws, content, tags.join(","), actor, now());
    this.log(ws, actor, "memory_saved", id, content.slice(0, 120));
    return this.db.prepare("SELECT id, content, tags, created_by, created_at FROM memories WHERE id = ?").get(id) as unknown as Memory;
  }

  /** Keyword recall ranked by how many query terms match, then recency.
   *  Swap for embeddings/pgvector behind this same method when it matters. */
  recall(ws: string, query: string, limit = 10): Memory[] {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1).slice(0, 8);
    if (!terms.length) {
      return this.db
        .prepare("SELECT id, content, tags, created_by, created_at FROM memories WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?")
        .all(ws, limit) as unknown as Memory[];
    }
    const match = "(instr(lower(content || ' ' || tags), ?) > 0)";
    const score = terms.map(() => match).join(" + ");
    return this.db
      .prepare(
        `SELECT id, content, tags, created_by, created_at FROM (
           SELECT *, ${score} AS score FROM memories WHERE workspace_id = ?
         ) WHERE score > 0 ORDER BY score DESC, created_at DESC LIMIT ?`,
      )
      .all(...terms, ws, limit) as unknown as Memory[];
  }

  forget(ws: string, id: string): boolean {
    return this.db.prepare("DELETE FROM memories WHERE workspace_id = ? AND id = ?").run(ws, id).changes > 0;
  }

  // ---- activity log -------------------------------------------------------

  log(ws: string, actor: string, action: string, subject: string, summary: string): void {
    this.db
      .prepare("INSERT INTO events (workspace_id, actor, action, subject, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ws, actor, action, subject, summary.slice(0, 300), now());
  }

  recentEvents(ws: string, limit = 30): Event[] {
    return this.db
      .prepare("SELECT id, actor, action, subject, summary, created_at FROM events WHERE workspace_id = ? ORDER BY id DESC LIMIT ?")
      .all(ws, Math.min(limit, 200)) as unknown as Event[];
  }

  // ---- tool call log ------------------------------------------------------
  // Separate from events on purpose: this is instrumentation, not the activity
  // feed a person reads. It answers when an agent contacted the board at all.

  logCall(ws: string, agent: string, tool: string, args: unknown, ok: boolean): void {
    let summary = "";
    try {
      summary = typeof args === "object" && args ? JSON.stringify(args).slice(0, 300) : "";
    } catch {
      summary = "<unserialisable>";
    }
    this.db
      .prepare("INSERT INTO tool_calls (workspace_id, agent, tool, args, ok, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ws, agent, tool, summary, ok ? 1 : 0, now());
  }

  toolCalls(ws: string, since?: string): ToolCall[] {
    const rows = since
      ? this.db
          .prepare("SELECT id, agent, tool, args, ok, created_at FROM tool_calls WHERE workspace_id = ? AND created_at >= ? ORDER BY id")
          .all(ws, since)
      : this.db.prepare("SELECT id, agent, tool, args, ok, created_at FROM tool_calls WHERE workspace_id = ? ORDER BY id").all(ws);
    return rows as unknown as ToolCall[];
  }

  /** Every workspace that has at least one agent, newest first. */
  listWorkspaces(): { id: string; name: string; agents: string; created_at: string }[] {
    return this.db
      .prepare(
        `SELECT w.id, w.name, w.created_at, COALESCE(GROUP_CONCAT(a.name, ', '), '') AS agents
         FROM workspaces w LEFT JOIN agents a ON a.workspace_id = w.id
         GROUP BY w.id ORDER BY w.created_at DESC`,
      )
      .all() as never;
  }
}

export interface ToolCall { id: number; agent: string; tool: string; args: string; ok: number; created_at: string }

/** A chat message as a task: the first line is the title, the full text the details. */
function taskFields(body: string): { title: string; details: string } {
  const title = headline(body, 200);
  return { title, details: body.trim() === title ? "" : body.trim() };
}

const TASK_COLS =
  "id, title, details, status, created_by, assigned_to, claimed_by, depends_on, result, note, thread_id, opened_at, claimed_at, created_at, updated_at";
