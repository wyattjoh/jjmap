import { expect, test } from "bun:test";
import type { EmailFilterCondition } from "@wyattjoh/jmap";
import { Deferred, Effect, Fiber } from "effect";
import {
  countMailbox,
  fetchBatch,
  JmapClient,
  JmapError,
  listMailboxes,
  READ_CHUNK,
  type Folder,
  type Message,
} from "./mailbox.ts";
import { fakeJmap } from "./test-support.ts";

const run = <A, E>(jmap: JmapClient["Service"], effect: Effect.Effect<A, E, JmapClient>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(JmapClient, jmap)));

const folder = (id: string): Folder => ({ id, name: `Folder ${id}`, totalEmails: 0 });

test("mailbox overview paginates beyond the former 200-folder limit", async () => {
  const folders = Array.from({ length: 205 }, (_, index) => folder(String(index)));
  const positions: number[] = [];

  const jmap = fakeJmap({
    getMailboxes: (position, limit) => {
      positions.push(position);
      const mailboxes = folders.slice(position, position + limit);

      return Effect.succeed({
        mailboxes,
        total: folders.length,
        hasMore: position + mailboxes.length < folders.length,
      });
    },
  });

  expect(await run(jmap, listMailboxes())).toHaveLength(205);
  expect(positions).toEqual([0, 200]);
});

test("interrupting a mailbox listing abandons the page in flight", async () => {
  const positions: number[] = [];

  const jmap = fakeJmap({
    getMailboxes: (position) => {
      positions.push(position);

      return position === 0
        ? Effect.succeed({ mailboxes: [folder("a")], total: 2, hasMore: true })
        : Effect.never;
    },
  });

  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* listMailboxes().pipe(
        Effect.provideService(JmapClient, jmap),
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
    }),
  );

  expect(positions).toEqual([0, 1]);
});

test("mailbox pagination handles unknown totals and server-limited pages", async () => {
  const folders = ["a", "b", "c"].map(folder);
  const positions: number[] = [];

  const jmap = fakeJmap({
    getMailboxes: (position) => {
      positions.push(position);

      return Effect.succeed({
        mailboxes: folders.slice(position, position + 2),
        total: undefined,
        hasMore: false,
      });
    },
  });

  expect(await run(jmap, listMailboxes())).toHaveLength(3);
  expect(positions).toEqual([0, 2, 3]);
});

test("a failed count retains its slot until its companion query settles", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();

      const jmap = fakeJmap({
        countEmails: (conditions) =>
          conditions.length > 1
            ? Effect.fail(new JmapError({ message: "Synthetic query failure", cause: undefined }))
            : Effect.as(Deferred.await(gate), 10),
      });

      const fiber = yield* countMailbox("inbox").pipe(
        Effect.provideService(JmapClient, jmap),
        Effect.flip,
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(gate, undefined);
      const failure = yield* Fiber.join(fiber);
      expect(failure.message).toContain("counts are unavailable");
    }),
  );
});

test("counts use current non-draft contents and $triaged without fetching bodies", async () => {
  const queries: (readonly EmailFilterCondition[])[] = [];

  const jmap = fakeJmap({
    countEmails: (conditions) => {
      queries.push(conditions);

      return Effect.succeed(conditions.length > 1 ? 6 : 10);
    },
  });

  expect(await run(jmap, countMailbox("inbox"))).toEqual({ total: 10, unclassified: 6 });
  expect(queries).toEqual([
    [{ inMailbox: "inbox", notKeyword: "$draft" }],
    [{ inMailbox: "inbox", notKeyword: "$draft" }, { notKeyword: "$triaged" }],
  ]);
});

test.each([
  [undefined, 0],
  [10, undefined],
  [1, 2],
  [-1, 0],
  [10, 0.5],
])(
  "unavailable or inconsistent totals (%s, %s) are never fabricated",
  async (total, unclassified) => {
    const jmap = fakeJmap({
      countEmails: (conditions) => Effect.succeed(conditions.length > 1 ? unclassified : total),
    });

    await expect(run(jmap, countMailbox("inbox"))).rejects.toThrow("counts are unavailable");
  },
);

test("batch reads fetch details in chunks, keep order, drop drafts, and report progress", async () => {
  const ids = Array.from({ length: READ_CHUNK * 2 + 3 }, (_, index) => `m${index}`);
  const chunks: number[] = [];

  const jmap = fakeJmap({
    searchEmails: () => Effect.succeed({ ids, nextPosition: ids.length, hasMore: false }),
    getEmails: (requested) => {
      chunks.push(requested.length);

      return Effect.succeed(
        requested.map((id): Message => ({ id, keywords: id === "m1" ? { $draft: true } : {} })),
      );
    },
  });

  const progress: [number, number][] = [];

  const emails = await run(
    jmap,
    fetchBatch({ inMailbox: "inbox" }, ids.length, (done, total) =>
      Effect.sync(() => progress.push([done, total])),
    ),
  );

  expect(chunks).toEqual([READ_CHUNK, READ_CHUNK, 3]);
  expect(emails.map(({ id }) => id)).toEqual(ids.filter((id) => id !== "m1"));
  expect(progress).toEqual([
    [0, ids.length],
    [READ_CHUNK, ids.length],
    [READ_CHUNK * 2, ids.length],
    [ids.length, ids.length],
  ]);
});
