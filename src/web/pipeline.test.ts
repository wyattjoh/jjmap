import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Ref } from "effect";
import type { ApplyResult, Message } from "../mailbox.ts";
import { receiptTriaged } from "../test-support.ts";
import type { Triaged } from "../triage.ts";
import { runPipeline, type Failure, type Pipeline } from "./pipeline.ts";

const emails: Message[] = Array.from({ length: 20 }, (_, index) => ({ id: String(index) }));

const triaged = (email: Message): Triaged => ({
  ...receiptTriaged(email),
  usage: { input: 10, output: 2 },
});

const success = (results: readonly Triaged[]): ApplyResult => ({
  updated: results.map(({ email }) => email.id),
  failed: {},
});

// Every job takes a moment, so all workers start before any finishes (as real requests do).
const slowly = (email: Message) => Effect.as(Effect.sleep(1), triaged(email));

const defaults = (stop: Ref.Ref<boolean>): Pipeline<Failure> => ({
  emails,
  concurrency: 4,
  stop,
  classify: slowly,
  apply: (results) => Effect.succeed(success(results)),
  working: () => Effect.void,
  result: () => Effect.void,
  error: () => Effect.void,
});

const run = (options: (stop: Ref.Ref<boolean>) => Partial<Pipeline<Failure>>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const stop = yield* Ref.make(false);

      return yield* runPipeline({ ...defaults(stop), ...options(stop) });
    }),
  );

test("four workers overlap; Stop bounds paid work and ready writes coalesce without a timer", async () => {
  let started = 0;
  const groups: number[] = [];

  const summary = await Effect.runPromise(
    Effect.gen(function* () {
      const stop = yield* Ref.make(false);
      const gate = yield* Deferred.make<void>();
      const allStarted = yield* Deferred.make<void>();

      const running = yield* runPipeline({
        ...defaults(stop),
        classify: (email) =>
          Effect.gen(function* () {
            if (++started === 4) yield* Deferred.succeed(allStarted, undefined);

            return triaged(email);
          }),
        apply: (results) =>
          Effect.gen(function* () {
            groups.push(results.length);
            yield* Deferred.await(gate);

            return success(results);
          }),
      }).pipe(Effect.forkChild);

      yield* Deferred.await(allStarted);
      // Let the three later jobs queue their updates behind the blocked writer.
      yield* Effect.sleep(5);
      expect(started).toBe(4);
      yield* Ref.set(stop, true);
      yield* Deferred.succeed(gate, undefined);

      return yield* Fiber.join(running);
    }),
  );

  expect(started).toBe(4);
  expect(groups).toEqual([1, 3]);
  expect(summary).toEqual({ classified: 4, usage: { input: 40, output: 8 } });
});

test("backpressure bounds all started-but-unsettled jobs, not just active HTTP requests", async () => {
  let outstanding = 0;
  let max = 0;
  let writes = 0;
  let maxWrites = 0;

  const summary = await run(() => ({
    classify: (email) =>
      Effect.suspend(() => {
        outstanding++;
        max = Math.max(max, outstanding);

        return slowly(email);
      }),
    apply: (results) =>
      Effect.gen(function* () {
        writes++;
        maxWrites = Math.max(maxWrites, writes);
        yield* Effect.sleep(2);
        writes--;

        return success(results);
      }),
    result: () =>
      Effect.sync(() => {
        outstanding--;
      }),
  }));

  expect(max).toBe(4);
  expect(maxWrites).toBe(1);
  expect(outstanding).toBe(0);
  expect(summary.classified).toBe(20);
  expect(summary.usage).toEqual({ input: 200, output: 40 });
});

test("ambiguous write failure stops new work and prevents queued writes without losing paid usage", async () => {
  let writes = 0;
  const results: boolean[] = [];

  const summary = await run(() => ({
    apply: () =>
      Effect.suspend(() => {
        writes++;

        return Effect.fail({ message: "Unconfirmed write" });
      }),
    result: (_, applied) => Effect.sync(() => results.push(applied)),
  }));

  expect(writes).toBe(1);
  expect(results).toEqual([false, false, false, false]);
  expect(summary).toEqual({ classified: 4, usage: { input: 40, output: 8 } });
});

test("partial JMAP success animates only confirmed IDs", async () => {
  let write = 0;
  const results: boolean[] = [];

  const summary = await run(() => ({
    emails: emails.slice(0, 4),
    apply: (group) =>
      Effect.gen(function* () {
        // The first write is slow, so the other three updates queue behind it.
        if (++write === 1) return yield* Effect.as(Effect.sleep(10), success(group));

        return {
          updated: [group[0]!.email.id],
          failed: Object.fromEntries(
            group.slice(1).map(({ email }) => [email.id, { type: "forbidden" }]),
          ),
        };
      }),
    result: (_, applied) => Effect.sync(() => results.push(applied)),
  }));

  expect(results.filter(Boolean)).toHaveLength(2);
  expect(results.filter((value) => !value)).toHaveLength(2);
  expect(summary.classified).toBe(4);
});

test("inference failures stop scheduling but account for other already-started jobs", async () => {
  const errors: string[] = [];
  let updates = 0;

  const summary = await run(() => ({
    // The failure lands while the other three started jobs are still running.
    classify: (email) =>
      email.id === "2"
        ? Effect.andThen(Effect.sleep(1), Effect.fail({ message: "fixture failure" }))
        : Effect.as(Effect.sleep(10), triaged(email)),
    result: (_, applied) =>
      Effect.sync(() => {
        if (applied) updates++;
      }),
    error: (message) => Effect.sync(() => errors.push(message)),
  }));

  expect(errors).toEqual(["fixture failure"]);
  expect(updates).toBe(3);
  expect(summary).toEqual({ classified: 3, usage: { input: 30, output: 6 } });
});

test("stopped or empty runs schedule no work", async () => {
  const stopped = await Effect.runPromise(
    Effect.gen(function* () {
      const stop = yield* Ref.make(true);

      return yield* runPipeline(defaults(stop));
    }),
  );

  expect(stopped).toEqual({ classified: 0, usage: { input: 0, output: 0 } });
  expect(await run(() => ({ emails: [] }))).toEqual({
    classified: 0,
    usage: { input: 0, output: 0 },
  });
});
