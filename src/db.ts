// Storage layer. Every row is scoped by workspace_id, so one deployment can
// serve many customers. All SQL lives in this file: moving from SQLite to
// Postgres means rewriting this file only.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type TaskStatus = "open" | "in_progress" | "blocked" | "done";

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
  created_at: string;
  updated_at: string;
}
export interface Memory { id: string; content: string; tags: string; created_by: string; created_at: string }
export interface Event { id: number; actor: string; action: string; subject: string; summary: string; created_at: string }

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const newId = (prefix: string) => `${prefix}_${randomBytes(5).toString("hex")}`;
const newSecret = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;
const now = () => new Date().toISOString();

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
    `);
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

  // ---- tasks --------------------------------------------------------------

  postTask(ws: string, actor: string, t: { title: string; details?: string; assigned_to?: string; depends_on?: string }): Task {
    if (t.depends_on && !this.getTask(ws, t.depends_on)) throw new Error(`depends_on task ${t.depends_on} not found`);
    if (t.assigned_to) {
      const names = this.listAgents(ws).map((a) => a.name);
      if (!names.includes(t.assigned_to)) throw new Error(`no agent named "${t.assigned_to}" (agents: ${names.join(", ") || "none"})`);
    }
    const id = newId("t");
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO tasks (id, workspace_id, title, details, created_by, assigned_to, depends_on, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ws, t.title, t.details ?? "", actor, t.assigned_to ?? null, t.depends_on ?? null, ts, ts);
    this.log(ws, actor, "task_posted", id, `${t.title}${t.assigned_to ? ` (for ${t.assigned_to})` : ""}`);
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
    const r = this.db
      .prepare(
        `UPDATE tasks SET status = 'in_progress', claimed_by = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ? AND status = 'open' AND (assigned_to IS NULL OR assigned_to = ?)`,
      )
      .run(actor, now(), ws, id, actor);
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
    return task;
  }

  updateTask(ws: string, actor: string, id: string, u: { status?: TaskStatus; note?: string; result?: string }): Task {
    const task = this.getTask(ws, id);
    if (!task) throw new Error(`task ${id} not found`);
    if (actor !== "owner" && task.claimed_by && task.claimed_by !== actor) {
      throw new Error(`task ${id} is claimed by ${task.claimed_by}`);
    }
    const status = u.status ?? task.status;
    this.db
      .prepare("UPDATE tasks SET status = ?, note = ?, result = ?, claimed_by = COALESCE(claimed_by, ?), updated_at = ? WHERE workspace_id = ? AND id = ?")
      .run(status, u.note ?? task.note, u.result ?? task.result, actor === "owner" ? null : actor, now(), ws, id);
    this.log(ws, actor, status === "done" ? "task_done" : "task_updated", id, `${task.title} → ${status}${u.note ? `: ${u.note}` : ""}`);
    return this.getTask(ws, id)!;
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
}

const TASK_COLS = "id, title, details, status, created_by, assigned_to, claimed_by, depends_on, result, note, created_at, updated_at";
