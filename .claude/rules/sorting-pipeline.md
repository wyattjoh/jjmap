---
paths:
  - "src/web/pipeline.ts"
  - "src/triage.ts"
  - "src/classify.ts"
  - "src/plan.ts"
---

# Sorting pipeline

Classification spends real money and writes to a real mailbox, so this code is conservative on purpose.

## Concurrency

- Bound inference plus pending writes to the selected worker count: default 4, maximum 8.
- `Effect.forEach` controls concurrency, and a job holds its slot until its write settles, so slow writes can't build an unbounded paid queue.
- One writer, a one-permit `Semaphore`, coalesces ready results without timers.

## Runs

Runs fork detached with `startImmediately`, so a client disconnect never interrupts paid work mid-email.

## Folders

`prepareApplier` validates the configured target folders once per run and never creates folders. Only category Save creates them; see [categories.md](categories.md).

## Stop and failures

- Stop finishes already-started work only.
- A failed or ambiguous write prevents all later queued writes.
- Never retry a write automatically.
- Preserve partial results and record paid usage on Stop, disconnect, or failure.

## Jev requests

Keep each email's three questions (category, needs action, urgent) in one TypeSafe request, and keep the SDK's rate-limit backoff enabled.
