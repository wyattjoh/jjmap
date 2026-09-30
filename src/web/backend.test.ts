import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmailFilterCondition } from "@wyattjoh/jmap";
import { Deferred, Effect, Exit, Fiber, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { detectCategories } from "../categories.ts";
import { loadCategories } from "../category-store.ts";
import { Jev } from "../classify.ts";
import type { Folder } from "../mailbox.ts";
import { fakeJmap } from "../test-support.ts";
import { Connector } from "../triage.ts";
import { Paths } from "../usage.ts";
import { Backend, SILENT } from "./api.ts";
import { LiveBackend, READ_TTL_MS } from "./backend.ts";

const dir = await mkdtemp(join(tmpdir(), "jjmap-backend-"));

afterAll(async () => {
  await rm(dir, { recursive: true });
});

type Count = (conditions: readonly EmailFilterCondition[]) => Effect.Effect<number | undefined>;

const mailboxOf = (conditions: readonly EmailFilterCondition[]) => conditions[0]?.inMailbox;

// A live backend over synthetic JMAP; Jev must never be called by these reads and writes.
function setup(
  count: Count,
  categories: string = join(dir, "unused.json"),
  names: readonly string[] = Array.from({ length: 6 }, (_, index) => `Folder ${index}`),
) {
  const mailboxes: Folder[] = names.map((name, index) => ({
    id: String(index),
    name,
    parentId: null,
    totalEmails: 0,
  }));

  const created: string[] = [];

  const jmap = fakeJmap({
    getMailboxes: () =>
      Effect.sync(() => ({ mailboxes: [...mailboxes], total: mailboxes.length, hasMore: false })),
    countEmails: count,
    createMailboxes: (requested) =>
      Effect.sync(() => {
        for (const name of requested) {
          created.push(name);
          mailboxes.push({ id: `new-${name}`, name, parentId: null, totalEmails: 0 });
        }

        return {
          created: new Map(requested.map((name) => [name, `new-${name}`])),
          notCreated: new Map(),
        };
      }),
  });

  const jev = Jev.of({ systemOne: () => Effect.die("Jev must not be called") });

  const connector = Layer.succeed(
    Connector,
    Connector.of({
      connect: () =>
        Effect.sync(() => ({ jmap, jev, mailboxes: [...mailboxes], inbox: mailboxes[0]! })),
    }),
  );

  const paths = Layer.succeed(
    Paths,
    Paths.of({ config: join(dir, "none.json"), categories, state: join(dir, "state.json") }),
  );

  const layer = LiveBackend.pipe(Layer.provide(Layer.mergeAll(connector, paths)));

  const backend = Effect.runPromise(Effect.provide(Backend, Layer.fresh(layer)));

  return { backend, created };
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const saved = (categories: string) =>
  run(
    loadCategories().pipe(
      Effect.provideService(Paths, Paths.of({ config: "", categories, state: "" })),
    ),
  );

test("first-run categories are detected, then saved with any new folders created", async () => {
  const path = join(dir, "categories.json");

  const { backend: ready, created } = setup(() => Effect.succeed(0), path, [
    "Inbox",
    "Alerts",
    "Receipts",
    "Archive/Receipts",
  ]);

  const backend = await ready;
  expect((await run(backend.bootstrap(SILENT))).categoriesSaved).toBe(false);
  const state = await run(backend.categories());
  expect(state).toMatchObject({ saved: false, detected: 2, expected: 4 });
  await run(backend.saveCategories(state.drafts));
  expect(created.toSorted()).toEqual(["Notifications", "Promotions"]);
  const stored = Option.getOrElse(await saved(path), () => []);
  expect(stored.find(({ id }) => id === "receipts")?.folderId).toBe("2");
  expect(stored.find(({ id }) => id === "promotions")?.folderId).toBe("new-Promotions");
  const boot = await run(backend.bootstrap(SILENT));
  expect(boot.categoriesSaved).toBe(true);
  expect(boot.categories.map(({ id }) => id)).toEqual(state.drafts.map(({ id }) => id));
  expect((await run(backend.categories())).saved).toBe(true);
});

test("saving rejects drafts pointing at folders that no longer exist", async () => {
  const path = join(dir, "invalid.json");
  const { backend: ready, created } = setup(() => Effect.succeed(0), path, ["Inbox"]);
  const backend = await ready;
  const { drafts } = detectCategories([{ id: "gone", name: "Alerts" }]);
  await expect(run(backend.saveCategories(drafts))).rejects.toThrow("Could not save categories");
  expect(created).toEqual([]);
  expect(Option.isNone(await saved(path))).toBe(true);
});

test("overview bounds count queries and interruption prevents queued reads", async () => {
  let started = 0;

  await run(
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();

      const backend = yield* Effect.promise(
        () =>
          setup(() =>
            Effect.gen(function* () {
              if (++started === 8) yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(gate);

              return 0;
            }),
          ).backend,
      );

      const fiber = yield* Effect.forkChild(backend.folders(SILENT, false));

      yield* Deferred.await(entered).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.die(`Only ${started} count queries started`),
        }),
      );

      expect(started).toBe(8);
      const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)));
      yield* Deferred.succeed(gate, undefined);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  expect(started).toBe(8);
});

test("one unavailable count does not hide other folders or masquerade as empty", async () => {
  const backend = await setup((conditions) =>
    Effect.succeed(mailboxOf(conditions) === "1" ? undefined : conditions.length > 1 ? 4 : 10),
  ).backend;

  const folders = await run(backend.folders(SILENT, false));
  expect(folders).toHaveLength(6);
  expect(folders[1]).toMatchObject({ id: "1", total: null, unclassified: null });
  expect(folders[0]).toMatchObject({ total: 10, unclassified: 4 });
});

test("overview reads are reused within the TTL; refresh, expiry, and writes query again", async () => {
  const path = join(dir, "cached.json");
  let queries = 0;

  const backend = await setup(
    () =>
      Effect.sync(() => {
        queries++;

        return 0;
      }),
    path,
    ["Inbox", "Alerts", "Receipts"],
  ).backend;

  await run(
    Effect.gen(function* () {
      const folders = (fresh = false) => backend.folders(SILENT, fresh);
      yield* backend.bootstrap(SILENT);
      yield* folders();
      expect(queries).toBe(6);
      yield* folders();
      expect(queries).toBe(6);
      yield* folders(true);
      expect(queries).toBe(12);
      yield* TestClock.adjust(READ_TTL_MS);
      yield* folders();
      expect(queries).toBe(18);

      yield* backend.saveCategories((yield* backend.categories()).drafts);
      yield* folders();
      expect(queries).toBe(28);
      yield* backend.begin({ mailboxId: "0", limit: 1, filter: "untriaged", since: "any" });
      yield* backend.apply([]);
      yield* folders();
      expect(queries).toBe(38);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
