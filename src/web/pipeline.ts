import { Effect, Ref, Result, Semaphore } from "effect";
import type { Usage } from "../domain.ts";
import type { ApplyResult, Message } from "../mailbox.ts";
import type { Triaged } from "../triage.ts";

/**
 * A failed step whose message is safe to show in the browser.
 */
export interface Failure {
  readonly message: string;
}

/**
 * Bounded concurrent inference and a single batching mail writer.
 */
export interface Pipeline<E extends Failure> {
  readonly emails: readonly Message[];
  /**
   * Paid jobs in flight, including jobs waiting on writes; decoded as `Concurrency` (1–8).
   */
  readonly concurrency: number;
  /**
   * Set to stop scheduling new emails; already-started jobs still finish.
   */
  readonly stop: Ref.Ref<boolean>;
  readonly classify: (email: Message) => Effect.Effect<Triaged, E>;
  readonly apply: (results: readonly Triaged[]) => Effect.Effect<ApplyResult, E>;
  readonly working: (email: Message) => Effect.Effect<void>;
  readonly result: (
    result: Triaged,
    applied: boolean,
    error: string | undefined,
  ) => Effect.Effect<void>;
  readonly error: (message: string) => Effect.Effect<void>;
}

/**
 * Paid work finished by a run, including jobs whose updates failed.
 */
export interface PipelineSummary {
  readonly usage: Usage;
  readonly classified: number;
}

const NOT_APPLIED =
  "Not applied because an earlier mailbox update failed. Load a fresh batch before retrying.";

const UNCONFIRMED =
  "The mail server did not confirm this update. Check your mailbox before retrying.";

/**
 * Runs at most `concurrency` paid jobs at once, including jobs waiting on writes.
 * Ready updates coalesce behind one writer without a batching timer. Stop finishes
 * only jobs already started; failed/ambiguous writes prevent any further writes.
 */
export const runPipeline = Effect.fn("runPipeline")(function* <E extends Failure>(
  pipeline: Pipeline<E>,
) {
  const { emails, concurrency, stop, classify, apply, working, result, error } = pipeline;
  const writer = yield* Semaphore.make(1);
  const ready = yield* Ref.make<readonly Triaged[]>([]);
  const writeFailed = yield* Ref.make(false);

  const summary = yield* Ref.make<PipelineSummary>({
    usage: { input: 0, output: 0 },
    classified: 0,
  });

  // Whoever holds the writer drains every update that became ready meanwhile.
  const writeOne = Effect.gen(function* () {
    const group = yield* Ref.getAndSet(ready, []);

    if (group.length === 0) return false;
    let response: ApplyResult = { updated: [], failed: {} };
    let failure = NOT_APPLIED;

    if (!(yield* Ref.get(writeFailed))) {
      const written = yield* Effect.result(apply(group));

      if (Result.isSuccess(written)) {
        response = written.success;
        failure = UNCONFIRMED;
      } else {
        failure = written.failure.message || "Could not confirm mailbox updates.";
      }
    }

    for (const job of group) {
      const id = job.email.id;
      const applied = response.updated.includes(id) && !(id in response.failed);

      if (!applied) {
        yield* Ref.set(writeFailed, true);
        yield* Ref.set(stop, true);
      }

      yield* result(job, applied, applied ? undefined : failure);
    }

    return true;
  });

  const flush = writer.withPermits(1)(
    Effect.gen(function* () {
      let more = true;

      while (more) more = yield* writeOne;
    }),
  );

  // A job keeps its slot until its update settles, bounding the entire
  // pipeline and the amount of paid work that can remain when Stop is pressed.
  const job = Effect.fnUntraced(function* (email: Message) {
    if (yield* Ref.get(stop)) return;
    yield* working(email);
    const classified = yield* Effect.result(classify(email));

    if (Result.isFailure(classified)) {
      yield* Ref.set(stop, true);
      yield* error(classified.failure.message || "Classification failed.");

      return;
    }

    const value = classified.success;

    yield* Ref.update(summary, ({ usage, classified: count }) => ({
      usage: { input: usage.input + value.usage.input, output: usage.output + value.usage.output },
      classified: count + 1,
    }));

    yield* Ref.update(ready, (queued) => [...queued, value]);
    yield* flush;
  });

  yield* Effect.forEach(emails, job, { concurrency, discard: true });

  return yield* Ref.get(summary);
});
