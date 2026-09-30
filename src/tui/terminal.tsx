import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Effect } from "effect";
import { resolveCategories } from "../category-store.ts";
import type { Jev } from "../classify.ts";
import { listMailboxes, type JmapClient } from "../mailbox.ts";
import {
  applyPlans,
  browseMailbox,
  classifyBatch,
  connect,
  fetchBatch,
  withConnection,
  type ConnectStage,
} from "../triage.ts";
import { loadConfig, loadState, Paths, recordRun } from "../usage.ts";
import type { Deps } from "./app.tsx";
import { Startup } from "./startup.tsx";

const STAGE_MESSAGES: Record<ConnectStage, string> = {
  connect: "Connecting to JMAP…",
  mailboxes: "Loading JMAP mailboxes…",
};

// Holds stderr output while the renderer owns the terminal, replaying it on exit.
const restoreStderr = () => {
  const stderr = process.stderr;
  const write = stderr.write;
  const buffered: (string | Uint8Array)[] = [];

  stderr.write = (chunk: string | Uint8Array) => {
    buffered.push(chunk);

    return true;
  };

  return () => {
    stderr.write = write;

    for (const chunk of buffered) write.call(stderr, chunk);
  };
};

// Connects, then exposes each terminal operation as a promise over the connection.
const loadDeps = Effect.fn("loadDeps")(function* (progress: (message: string) => void) {
  const paths = yield* Paths;

  const connection = yield* connect((stage) => Effect.sync(() => progress(STAGE_MESSAGES[stage])));

  const run = <A, E>(effect: Effect.Effect<A, E, JmapClient | Jev | Paths>) =>
    Effect.runPromise(effect.pipe(withConnection(connection), Effect.provideService(Paths, paths)));

  progress("Loading categories and spend history…");

  const [{ pricing, name }, totals, categories] = yield* Effect.all(
    [loadConfig(), loadState(), resolveCategories(connection.mailboxes)],
    { concurrency: "unbounded" },
  ).pipe(withConnection(connection));

  const deps: Deps = {
    mailboxes: connection.mailboxes,
    categories,
    inboxId: connection.inbox.id,
    readOnly: connection.jmap.isReadOnly,
    totals,
    pricing,
    fetch: (scope) => run(fetchBatch(scope)),
    browse: (mailboxId, position, limit, filter) =>
      run(browseMailbox(mailboxId, position, limit, filter)),
    classify: (emails, onResult) =>
      run(classifyBatch(emails, categories, name, (result) => Effect.sync(() => onResult(result)))),
    apply: (source, results) =>
      run(
        Effect.flatMap(listMailboxes(), (mailboxes) =>
          applyPlans(mailboxes, source, categories, results),
        ),
      ),
    refreshMailboxes: () => run(listMailboxes()),
    record: (usage) => run(recordRun(usage, pricing)),
  };

  return deps;
});

/**
 * Starts the existing interactive terminal interface after environment loading.
 */
export async function runTerminal(): Promise<void> {
  const restore = restoreStderr();
  let renderer: Awaited<ReturnType<typeof createCliRenderer>>;

  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      consoleMode: "disabled",
      onDestroy: () => {
        restore();
        process.exit(0);
      },
    });
  } catch (error) {
    restore();
    throw error;
  }

  createRoot(renderer).render(
    <Startup
      load={(progress) => Effect.runPromise(loadDeps(progress).pipe(Effect.provide(Paths.layer)))}
    />,
  );
}
