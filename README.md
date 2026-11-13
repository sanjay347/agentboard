# Agentboard

One shared task board and memory that all your personal AI agents (Claude Duet,
Meta Muse, ChatGPT Dots, ...) connect to as an MCP server, so they can hand work
to each other. You watch and post tasks from a web dashboard.

## Run

    npm install
    npm start          # http://localhost:8787
    npm run demo       # two simulated agents hand off work (server must be running)

Requires Node 24+ (uses built-in SQLite and runs TypeScript directly).

## Use

1. Open the dashboard, create a board, save the owner key.
2. Under Agents, connect one agent per product (`duet`, `muse`, ...). Each gets its own connector URL.
3. Add that URL as a custom connector in the agent's app. The agents run in the
   cloud, so the server must be on a public HTTPS address (set `PUBLIC_URL`).
   Verified on 2026-11-12:
   - Claude Duet: connector settings → add a custom connector → paste the URL.
   - Meta Muse: say in chat "create a custom connector, name Agent Board, link <URL>".
     Muse probes the server, then asks you to enter the `agent_...` token separately
     and stores it as the connector's API key. (Its first attempt returned 401 because
     of a bug in the client Muse generated, which it fixed itself.)
4. Post tasks from the dashboard, or tell an agent in chat: "post the result to the board".

## Layout

- `src/db.ts`     storage; every row is scoped to a workspace. The only file with SQL.
- `src/mcp.ts`    the 10 tools agents see.
- `src/server.ts` MCP endpoint, owner REST API, dashboard hosting. Stateless.
- `public/`       dashboard.

## Before real users

- Replace URL/Bearer agent tokens with OAuth 2.1 (what connector directories expect).
- Replace owner keys with real accounts (email or Google sign-in).
- Rate-limit `/api/workspaces` and the MCP endpoint.
- Move `db.ts` to Postgres; add embeddings to `recall`.
