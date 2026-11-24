// node:sqlite behind the async Sql interface. Only imported by the Node entry
// point and scripts, never by the Worker.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Sql, SqlValue } from "./sql.ts";

export function nodeSql(path: string): Sql {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return {
    async run(sql: string, ...args: SqlValue[]) {
      const r = db.prepare(sql).run(...args);
      return { changes: Number(r.changes) };
    },
    async get<T>(sql: string, ...args: SqlValue[]) {
      return db.prepare(sql).get(...args) as T | undefined;
    },
    async all<T>(sql: string, ...args: SqlValue[]) {
      return db.prepare(sql).all(...args) as T[];
    },
  };
}
