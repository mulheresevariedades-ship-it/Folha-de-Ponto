# [Project name]

_Replace the heading above with the project's name, and this line with one sentence describing what this app does for users._

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Recommended env: `PONTO_DATA_DIR` — absolute path to the shared data folder when running from a network share (for example `\\\\servidor\\FolhaPonto\\data` on Windows).
- Recommended env: `SESSION_SECRET` — secret used to protect encrypted SMTP credentials.
- Vercel: configure `DATABASE_URL` and `SESSION_SECRET` in the project environment variables before deploying. The root `vercel.json` exposes `api/index.ts` as the `/api` serverless API used by the frontend.
- Vercel does not provide persistent local storage for uploaded PDFs. Use a server process with `PONTO_DATA_DIR` pointing to the shared folder, or replace the filesystem archive with persistent object storage before relying on archived files in Vercel.
- Portable mode: from the shared folder, configure `PONTO_DATA_DIR` to its absolute network path and start the API with `pnpm --filter @workspace/api-server run dev`; start the frontend with `pnpm --filter @workspace/ponto-digital run dev`.

## Stack

- pnpm workspaces, Node.js 20+, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

_Populate as you build — short repo map plus pointers to the source-of-truth file for DB schema, API contracts, theme files, etc._

## Architecture decisions

_Populate as you build — non-obvious choices a reader couldn't infer from the code (3-5 bullets)._

## Product

_Describe the high-level user-facing capabilities of this app once they exist._

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
