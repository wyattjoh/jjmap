# jjmap

jjmap sorts a JMAP mailbox into user-defined categories with TypeSafe Jev. It has three front ends over one core:

- **Browser app:** `src/web/`, Bun HTML imports and React DOM.
- **Terminal UI:** `src/tui/`, OpenTUI React.
- **CLI:** `src/index.ts`.

The server and core are Effect v4.

## Commands

- Bun is the runtime, package manager, bundler and test runner. Don't use Node, npm, Vite or Jest.
- Before committing: `bun test && bun run typecheck && bun run lint && bun run format:check && bun run test:web`. Fix formatting with `bun run format`. CI (`.github/workflows/ci.yml`) runs the same checks.
- `bun run web:demo` starts the synthetic browser demo.
- `bun run dev` runs the same demo with browser HMR. Server-side changes still need a restart, because `bun --hot` would re-serve on a new port and token.

## Env and secrets

Varlock loads env (`import "varlock/auto-load"`) from `.env.schema` plus the gitignored `.env.local`. `bunfig.toml` turns off Bun's own `.env` autoload.

Never put real credentials, `op://` references, or personal names or domains in tracked files. Personal settings belong in `~/.config/jjmap/`.

## Architecture

- `src/mailbox.ts`: JMAP access.
- `src/classify.ts`: Jev.
- `src/plan.ts`: pure routing decisions.
- `src/triage.ts`: fetches, classifies and applies batches.
- `src/categories.ts`, `src/category-store.ts`: categories.
- `src/usage.ts`, `src/json-file.ts`: config and state files.
- `src/web/`:
  - `server.ts`, `api.ts`: server and API.
  - `backend.ts`, `demo.ts`: the live and demo backends.
  - `pipeline.ts`: sorting pipeline.
  - `app.tsx`: UI.
- `tools/oxlint/anti-slop/`: vendored lint plugin; see its `UPSTREAM.md`.

Path-specific conventions live in `.claude/rules/`:

- `effect.md`
- `browser-bundle.md`
- `web-api.md`
- `sorting-pipeline.md`
- `categories.md`
- `web-ui.md`
- `testing.md`

Keep them in sync when you change a pattern they describe.
