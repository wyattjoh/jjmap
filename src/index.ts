import "varlock/auto-load";
import { parseArgs } from "node:util";
import { Console, Effect, Ref } from "effect";
import { resolveCategories } from "./category-store.ts";
import { DEFAULT_LIMIT, FLAG_COLORS } from "./config.ts";
import type { Usage } from "./domain.ts";
import {
  applyPlans,
  classifyBatch,
  connect,
  fetchBatch,
  TriageError,
  validateLimit,
  withConnection,
  type Triaged,
} from "./triage.ts";
import { loadConfig, Paths, recordRun } from "./usage.ts";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    limit: { type: "string", default: String(DEFAULT_LIMIT) },
  },
});

// Classifies untriaged Inbox mail, prints the plans, and applies them with --apply.
const main = Effect.gen(function* () {
  const limit = yield* validateLimit(Number(values.limit));
  const connection = yield* connect();
  const { jmap, mailboxes, inbox } = connection;

  if (values.apply && jmap.isReadOnly)
    return yield* new TriageError({ message: "JMAP account is read-only" });

  const categories = yield* resolveCategories(mailboxes).pipe(withConnection(connection));

  const folderName = (id: string | null) =>
    id === null ? "-" : (mailboxes.find((mailbox) => mailbox.id === id)?.name ?? id);

  const emails = yield* fetchBatch({
    mailboxId: inbox.id,
    limit,
    filter: "untriaged",
    since: "any",
  }).pipe(withConnection(connection));

  if (emails.length === 0) {
    yield* Console.log("No untriaged Inbox mail.");

    return 0;
  }

  const config = yield* loadConfig();
  const plans = yield* Ref.make<readonly Triaged[]>([]);
  const usage = yield* Ref.make<Usage>({ input: 0, output: 0 });

  // Paid usage is recorded even when a later classification fails.
  yield* classifyBatch(emails, categories, config.name, (result) =>
    Effect.andThen(
      Ref.update(plans, (current) => [...current, result]),
      Ref.update(usage, (current) => ({
        input: current.input + result.usage.input,
        output: current.output + result.usage.output,
      })),
    ),
  ).pipe(
    withConnection(connection),
    Effect.ensuring(
      Effect.gen(function* () {
        if ((yield* Ref.get(plans)).length > 0)
          yield* recordRun(yield* Ref.get(usage), config.pricing).pipe(Effect.orDie);
      }),
    ),
  );

  const triaged = yield* Ref.get(plans);
  const spent = yield* Ref.get(usage);

  yield* Console.table(
    triaged.map(({ from, subject, plan }) => ({
      from: from.slice(0, 32),
      subject: subject.slice(0, 48),
      decision: plan.reason,
      move: folderName(plan.folderId),
      flag: plan.flag ? FLAG_COLORS[plan.flag].name : "",
      seen: plan.markSeen ? "✓" : "",
    })),
  );

  yield* Console.log(`${triaged.length} emails, ${spent.input + spent.output} Jev tokens`);

  if (!values.apply) {
    yield* Console.log("Dry run. Re-run with --apply to move and tag.");

    return 0;
  }

  const { updated, failed } = yield* applyPlans(mailboxes, inbox.id, categories, triaged).pipe(
    withConnection(connection),
  );

  yield* Console.log(`Applied ${updated.length}/${triaged.length}.`);

  if (Object.keys(failed).length === 0) return 0;
  yield* Console.error("Failed:", failed);

  return 1;
});

process.exit(await Effect.runPromise(main.pipe(Effect.provide(Paths.layer))));
