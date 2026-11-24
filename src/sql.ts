// The one interface the Store needs from a database. Two drivers implement it:
// node:sqlite for local development and CI (sql-node.ts), and Cloudflare D1
// in production (sql-d1.ts). Both speak SQLite, so the SQL is shared.
export type SqlValue = string | number | null;

export interface Sql {
  run(sql: string, ...args: SqlValue[]): Promise<{ changes: number }>;
  get<T>(sql: string, ...args: SqlValue[]): Promise<T | undefined>;
  all<T>(sql: string, ...args: SqlValue[]): Promise<T[]>;
}
