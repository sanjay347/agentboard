// Did an agent contact the board on its own?
//
// The server cannot see you chatting with Duet in the Duet app, so it can never
// prove a contact was unprompted. What it can do is show exactly when each agent
// touched the board. Combine that with a window in which you did not open the
// agents at all, and any contact inside that window was the agent's own doing.
//
//   node scripts/poll-report.ts                      list boards
//   node scripts/poll-report.ts ws_6ce03575ba        full history for one board
//   node scripts/poll-report.ts ws_6ce03575ba --quiet-from 2026-11-23T20:00
//
import { Store } from "../src/db.ts";
import { nodeSql } from "../src/sql-node.ts";

const store = await Store.open(nodeSql(process.env.DB_PATH ?? "data/agentboard.db"));
const args = process.argv.slice(2);
const ws = args.find((a) => a.startsWith("ws_"));
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
// The window is written to .quiet-from when the test starts, so a bare
// `npm run poll-report ws_...` reports against it with nothing to remember.
let fromFile: string | undefined;
try {
  fromFile = (await import("node:fs")).readFileSync(".quiet-from", "utf8").trim() || undefined;
} catch { /* no window recorded yet */ }
const quietFromRaw = flag("quiet-from") ?? fromFile;
const quietFrom = quietFromRaw ? new Date(quietFromRaw) : undefined;
if (quietFromRaw && Number.isNaN(quietFrom!.getTime())) {
  console.error(`Could not read --quiet-from "${quietFromRaw}". Use an ISO time like 2026-11-23T20:00`);
  process.exit(1);
}

if (!ws) {
  console.log("Boards on this server:\n");
  for (const w of await store.listWorkspaces()) {
    console.log(`  ${w.id}  ${w.name.padEnd(24)} agents: ${w.agents || "(none)"}`);
  }
  console.log("\nRun again with a board id to see its tool calls.");
  process.exit(0);
}

const calls = await store.toolCalls(ws);
const when = (iso: string) => new Date(iso).toLocaleString();
const mins = (a: Date, b: Date) => Math.round(Math.abs(+a - +b) / 60000);

// ---- per agent ---------------------------------------------------------------
// No calls at all is the expected state at the start of a window, and it is
// also what a dead tunnel looks like, so the quiet-window section below still
// runs: it is the part that can tell those two apart.
if (!calls.length) {
  console.log(`\nNo tool calls recorded for ${ws} yet.`);
} else {
  const agents = [...new Set(calls.map((c) => c.agent))].sort();
  console.log(`\n${calls.length} tool calls on ${ws}, ${agents.length} agent(s)\n`);
  console.log("AGENT       CALLS  FIRST CONTACT         LAST CONTACT          LONGEST GAP  TOOLS USED");
  for (const a of agents) {
    const mine = calls.filter((c) => c.agent === a);
    let gap = 0;
    for (let i = 1; i < mine.length; i++) {
      gap = Math.max(gap, mins(new Date(mine[i].created_at), new Date(mine[i - 1].created_at)));
    }
    const tools = [...new Set(mine.map((c) => c.tool))].join(" ");
    console.log(
      `${a.padEnd(11)} ${String(mine.length).padStart(5)}  ${when(mine[0].created_at).padEnd(21)} ` +
        `${when(mine[mine.length - 1].created_at).padEnd(21)} ${(gap ? gap + "m" : "-").padStart(11)}  ${tools}`,
    );
  }
}

// ---- the verdict -------------------------------------------------------------
if (quietFrom) {
  const quiet = calls.filter((c) => new Date(c.created_at) >= quietFrom);
  console.log(`\n── Quiet window: nothing opened by you since ${when(quietFrom.toISOString())} ──\n`);
  // A quick tunnel's hostname changes when Cloudflare reaps it, which kills the
  // connectors silently. Silence after that is a broken link, not a finding.
  let rotated: string[] = [];
  try {
    rotated = (await import("node:fs"))
      .readFileSync(".tunnel-history", "utf8")
      .trim().split("\n").filter(Boolean)
      .filter((line) => new Date(line.slice(0, 20)) > quietFrom);
  } catch { /* no tunnel history kept */ }

  if (!quiet.length) {
    const since = mins(new Date(), quietFrom);
    if (rotated.length) {
      console.log(`  NO CONTACT in ${since} minutes — but the public URL changed ${rotated.length} time(s) since:`);
      for (const r of rotated) console.log(`    ${r}`);
      console.log("\n  THIS IS NOT A RESULT. The connectors pointed at a dead hostname, so the");
      console.log("  agents could not reach the board even if they tried. Repoint them from");
      console.log("  CONNECT.md, run `npm run quiet:start`, and begin the window again.");
    } else {
      console.log(`  NO CONTACT in ${since} minutes.`);
      console.log("  On this evidence the agents do not poll the board unprompted.");
      console.log("  Leave it longer before concluding: some agents only check on a daily cycle.");
      console.log("  Confirm the public URL answers /healthz before trusting this.");
    }
  } else {
    console.log(`  ${quiet.length} call(s) arrived with you not touching the agents:\n`);
    for (const c of quiet) {
      console.log(`    ${when(c.created_at)}  ${c.agent.padEnd(8)} ${c.tool.padEnd(15)} ${c.ok ? "" : "FAILED "}${c.args.slice(0, 60)}`);
    }
    const claimed = quiet.filter((c) => c.tool === "claim_task" && c.ok);
    console.log(
      claimed.length
        ? `\n  ${claimed.length} unprompted CLAIM. Agents pick up work on their own: the app's core premise holds.`
        : "\n  The agents looked but claimed nothing. They poll, but do not act unasked.",
    );
  }
}

// ---- timeline ----------------------------------------------------------------
if (!calls.length) process.exit(0);
console.log("\n── Full timeline ──\n");
let day = "";
for (const c of calls) {
  const d = c.created_at.slice(0, 10);
  if (d !== day) { console.log(`  ${d}`); day = d; }
  console.log(`    ${c.created_at.slice(11, 19)}  ${c.agent.padEnd(8)} ${c.tool.padEnd(15)} ${c.ok ? "" : "FAILED "}${c.args.slice(0, 70)}`);
}
console.log();
