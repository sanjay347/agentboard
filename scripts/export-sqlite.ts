// Exports a local SQLite board as INSERT statements for D1:
//   node scripts/export-sqlite.ts data/agentboard.db > export.sql
//   npx wrangler d1 execute agentboard --remote --file export.sql
// Tokens and owner keys are stored as hashes, so connectors keep working on the
// new host: only the address changes. The output contains those hashes and
// all board content, so treat the file as private and delete it after import.
import { DatabaseSync } from "node:sqlite";

const src = new DatabaseSync(process.argv[2] ?? "data/agentboard.db", { readOnly: true });
// Parents before children, for foreign keys.
const TABLES = ["workspaces", "agents", "threads", "tasks", "memories", "events", "tool_calls", "messages"];

const quote = (v: unknown) =>
  v === null || v === undefined ? "NULL" : typeof v === "number" || typeof v === "bigint" ? String(v) : `'${String(v).replaceAll("'", "''")}'`;

for (const table of TABLES) {
  const exists = src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) continue;
  const rows = src.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  for (const row of rows) {
    const cols = Object.keys(row);
    console.log(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => quote(row[c])).join(", ")});`);
  }
  console.error(`${table}: ${rows.length}`);
}
