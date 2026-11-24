// Cloudflare D1 behind the async Sql interface. The D1 types are declared
// here rather than imported from @cloudflare/workers-types, whose globals
// clash with Node's in a shared tsconfig.
import type { Sql, SqlValue } from "./sql.ts";

interface D1Statement {
  bind(...values: SqlValue[]): D1Statement;
  run(): Promise<{ meta: { changes: number } }>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
}
export interface D1Database {
  prepare(sql: string): D1Statement;
}

export function d1Sql(db: D1Database): Sql {
  return {
    async run(sql: string, ...args: SqlValue[]) {
      const r = await db.prepare(sql).bind(...args).run();
      return { changes: r.meta.changes };
    },
    async get<T>(sql: string, ...args: SqlValue[]) {
      return (await db.prepare(sql).bind(...args).first<T>()) ?? undefined;
    },
    async all<T>(sql: string, ...args: SqlValue[]) {
      return (await db.prepare(sql).bind(...args).all<T>()).results;
    },
  };
}
