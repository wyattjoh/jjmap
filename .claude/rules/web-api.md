---
paths:
  - "src/web/server.ts"
  - "src/web/api.ts"
  - "src/web/backend.ts"
  - "src/web/demo.ts"
  - "src/web/model.ts"
  - "src/tui/main.tsx"
---

# Web server and API

## Launch and security

- `src/tui/main.tsx` is a lightweight dispatcher. Load Varlock, the terminal renderer and the live backend only through dynamic imports. `--web --demo` must never load credentials or the live backend.
- The server binds to loopback by default. `--host IP` accepts exactly one specific IPv4 interface (for example, a Tailscale address) and never `0.0.0.0`.
- Every API route requires the per-launch token, the exact bound Host, and same-origin JSON POSTs. `POST /api/categories` uses the same guards, returns 409 while a run is busy, and discards any prepared batch.
- Only an explicit Start (the run request) authorizes paid classification and mailbox writes. Bootstrap, folders and preview are read-only.

## Load protocol

- `/api/bootstrap`, `/api/folders` and `/api/preview` stream NDJSON `LoadEvent`s only when the client sends `Accept: application/x-ndjson`. The events are `stage` (with optional done/total), `folder`, then `result` or `error`. Without that header, the routes return plain JSON.
- Backends receive a `LoadReporter` whose methods return Effects; JSON callers get `SILENT`.
- Expected failures fail with `LoadError`, which carries a status for JSON and a message for streams. Everything else, including `BackendError` and defects, is sanitized in both modes.
- Interruption replaces abort signals. Leaving a load interrupts its remaining reads.
- Stage order and labels live in `LOAD_STAGES` (`src/web/model.ts`).
- Report real progress only:
  - Folder counting reports done/total and emits each folder as it settles.
  - Preview reads details in `READ_CHUNK` (50) chunks through `mailbox.fetchBatch`.

## Reads and caching

- Web runs only sort untriaged mail; the `ScopeRequest` schema rejects other filters.
- `/api/folders` is read-only. Count queries are bounded to four folders at a time (eight queries), and totals that are unknown stay `null`.
- Folder listing must paginate past 200 entries.
- The live backend reuses the mailbox list and per-folder counts for `READ_TTL_MS` (30 s, settled values only):
  - `?fresh=1` (Refresh folders) bypasses the cache.
  - Category Save clears it.
  - Every `apply` clears counts, even when the update is unconfirmed.
- `begin` and category Save always validate against a fresh mailbox list.
- Result events carry per-email usage for the live cost estimate. The `done` event's usage stays authoritative.

## Demo

Demo folder contents and categories are in-memory synthetic fixtures. Only confirmed mock moves change their counts. The demo adds small synthetic delays so load stages are visible. `--demo-unconfigured` starts at category setup.

The sorting pipeline has its own rules in [sorting-pipeline.md](sorting-pipeline.md).
