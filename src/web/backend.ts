import { Clock, Effect, Layer, Option, Ref, Semaphore } from "effect";
import { detectCategories, toDraft, type CategoryConfig } from "../categories.ts";
import { commitDrafts, loadCategories } from "../category-store.ts";
import { countMailbox, listMailboxes, type Folder } from "../mailbox.ts";
import {
  Connector,
  fetchBatch,
  prepareApplier,
  triageEmail,
  withConnection,
  type Applier,
  type Connection,
} from "../triage.ts";
import { loadConfig, loadState, Paths, recordRun } from "../usage.ts";
import { Backend, BackendError, SILENT, type LoadReporter } from "./api.ts";
import type { Bootstrap, CategoriesState, FolderSummary } from "./model.ts";

/**
 * How long the mailbox list and folder counts are reused before JMAP is queried again.
 */
export const READ_TTL_MS = 30_000;

/**
 * A read cache that stores settled values only, so an interrupted or failed read
 * never poisons later callers. Clearing bumps the generation so a read that
 * started before a write cannot store its answer.
 */
interface TtlCache<V> {
  readonly get: <E>(key: string, load: Effect.Effect<V, E>, fresh: boolean) => Effect.Effect<V, E>;
  readonly set: (key: string, value: V) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
}

const ttlCache = Effect.fnUntraced(function* <V>() {
  const entries = yield* Ref.make<ReadonlyMap<string, { readonly at: number; readonly value: V }>>(
    new Map(),
  );

  const generation = yield* Ref.make(0);

  const cache: TtlCache<V> = {
    get: (key, load, fresh) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const hit = (yield* Ref.get(entries)).get(key);

        if (!fresh && hit && now - hit.at < READ_TTL_MS) return hit.value;
        const started = yield* Ref.get(generation);
        const value = yield* load;

        if ((yield* Ref.get(generation)) === started)
          yield* Ref.update(entries, (current) => new Map(current).set(key, { at: now, value }));

        return value;
      }),
    set: (key, value) =>
      Effect.flatMap(Clock.currentTimeMillis, (at) =>
        Ref.update(entries, (current) => new Map(current).set(key, { at, value })),
      ),
    clear: Effect.andThen(
      Ref.set(entries, new Map()),
      Ref.update(generation, (value) => value + 1),
    ),
  };

  return cache;
});

const ALL = "all";

// Do not forward JMAP/SDK errors: provider responses can contain private data.
const UNABLE_TO_LOAD =
  "Unable to load mail. Check the local connection and credentials, then retry.";

const sanitized =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.mapError(effect, (cause) => new BackendError({ message, cause }));

interface Prepared {
  readonly apply: Applier;
  readonly categories: readonly CategoryConfig[];
  readonly recipient: string | undefined;
}

/**
 * Connects JMAP/Jev lazily through `Connector`; building the layer performs no mail I/O,
 * and a failed connection is retried by the next caller. Overview reads are cached for
 * `READ_TTL_MS`; confirmed writes and explicit refreshes bypass it.
 */
export const LiveBackend = Layer.effect(
  Backend,
  Effect.gen(function* () {
    const connector = yield* Connector;
    const paths = yield* Paths;
    const connecting = yield* Semaphore.make(1);
    const connection = yield* Ref.make(Option.none<Connection>());
    const prepared = yield* Ref.make(Option.none<Prepared>());
    const mailboxCache = yield* ttlCache<readonly Folder[]>();
    const countCache = yield* ttlCache<{ readonly total: number; readonly unclassified: number }>();
    const withPaths = Effect.provideService(Paths, paths);

    // Only the caller that opens the connection sees its connect/mailboxes stages.
    const getConnection = (report: LoadReporter) =>
      connecting.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* Ref.get(connection);

          if (Option.isSome(existing)) return existing.value;

          const connected = yield* connector
            .connect((stage) => report.stage(stage, null, null))
            .pipe(sanitized(UNABLE_TO_LOAD));

          yield* mailboxCache.set(ALL, connected.mailboxes);
          yield* Ref.set(connection, Option.some(connected));

          return connected;
        }),
      );

    const mailboxes = (fresh: boolean) =>
      Effect.gen(function* () {
        const connected = yield* getConnection(SILENT);

        const listed = yield* mailboxCache.get(
          ALL,
          listMailboxes().pipe(withConnection(connected), sanitized(UNABLE_TO_LOAD)),
          fresh,
        );

        yield* Ref.set(connection, Option.some({ ...connected, mailboxes: listed }));

        return listed;
      });

    return Backend.of({
      bootstrap: (report) =>
        Effect.gen(function* () {
          yield* report.stage("connect", null, null);

          const [{ jmap, mailboxes, inbox }, [{ pricing }, totals, categories]] = yield* Effect.all(
            [
              getConnection(report),
              Effect.all([loadConfig(), loadState(), loadCategories()]).pipe(
                withPaths,
                sanitized(UNABLE_TO_LOAD),
              ),
            ],
            { concurrency: 2 },
          );

          yield* report.stage("settings", null, null);
          const saved = Option.getOrElse(categories, () => []);

          const bootstrap: Bootstrap = {
            demo: false,
            readOnly: jmap.isReadOnly,
            inboxId: inbox.id,
            mailboxes: mailboxes.map(({ id, name, parentId }) => ({
              id,
              name,
              parentId: parentId ?? null,
            })),
            categories: saved.map(({ id, name, color, folderId }) => ({
              id,
              name,
              color,
              folderId,
            })),
            categoriesSaved: Option.isSome(categories),
            pricing,
            totals,
          };

          return bootstrap;
        }),
      folders: (report, fresh) =>
        Effect.gen(function* () {
          const connected = yield* getConnection(SILENT);
          yield* report.stage("list", null, null);
          const listed = yield* mailboxes(fresh);
          const counted = yield* Ref.make(0);
          yield* report.stage("count", 0, listed.length);

          return yield* Effect.forEach(
            listed,
            ({ id, name, parentId }) =>
              Effect.gen(function* () {
                // One unavailable count must not hide the remaining folders or claim 0%.
                const counts = yield* countCache
                  .get(id, countMailbox(id).pipe(withConnection(connected)), fresh)
                  .pipe(Effect.option);

                const summary: FolderSummary = {
                  id,
                  name,
                  parentId: parentId ?? null,
                  total: Option.isSome(counts) ? counts.value.total : null,
                  unclassified: Option.isSome(counts) ? counts.value.unclassified : null,
                };

                yield* report.folder(summary);
                const done = yield* Ref.updateAndGet(counted, (value) => value + 1);
                yield* report.stage("count", done, listed.length);

                return summary;
              }),
            { concurrency: 4 },
          );
        }),
      categories: () =>
        Effect.gen(function* () {
          yield* getConnection(SILENT);
          const saved = yield* loadCategories().pipe(withPaths, sanitized(UNABLE_TO_LOAD));

          if (Option.isSome(saved)) {
            const state: CategoriesState = {
              saved: true,
              drafts: saved.value.map(toDraft),
              detected: 0,
              expected: 0,
            };

            return state;
          }

          const state: CategoriesState = {
            saved: false,
            ...detectCategories(yield* mailboxes(false)),
          };

          return state;
        }),
      saveCategories: (drafts) =>
        Effect.gen(function* () {
          const connected = yield* getConnection(SILENT);

          // Validate against the live list; saving may create folders, so drop cached reads after.
          yield* Effect.gen(function* () {
            const listed = yield* mailboxes(true);

            yield* commitDrafts(listed, drafts).pipe(
              withConnection(connected),
              withPaths,
              sanitized("Could not save categories"),
            );
          }).pipe(Effect.ensuring(Effect.andThen(mailboxCache.clear, countCache.clear)));

          yield* mailboxes(true);
        }),
      fetch: (scope, report) =>
        Effect.gen(function* () {
          const connected = yield* getConnection(SILENT);
          yield* report.stage("search", null, null);

          return yield* fetchBatch(scope, (done, total) => report.stage("read", done, total)).pipe(
            withConnection(connected),
            sanitized(UNABLE_TO_LOAD),
          );
        }),
      begin: (scope) =>
        Effect.gen(function* () {
          yield* Ref.set(prepared, Option.none());
          const connected = yield* getConnection(SILENT);
          const { name } = yield* loadConfig().pipe(withPaths);

          const categories = Option.getOrElse(yield* loadCategories().pipe(withPaths), () => []);

          if (categories.length === 0)
            return yield* new BackendError({
              message: "Categories are not set up",
              cause: undefined,
            });

          const apply = yield* prepareApplier(
            yield* mailboxes(true),
            scope.mailboxId,
            categories,
          ).pipe(withConnection(connected));

          yield* Ref.set(prepared, Option.some({ apply, categories, recipient: name }));
        }).pipe(
          sanitized("Could not prepare destination folders. No emails were classified or moved."),
        ),
      classify: (email) =>
        Effect.gen(function* () {
          const connected = yield* getConnection(SILENT);
          const current = yield* Ref.get(prepared);

          if (Option.isNone(current))
            return yield* new BackendError({ message: "No prepared batch", cause: undefined });

          return yield* triageEmail(email, current.value.categories, current.value.recipient).pipe(
            withConnection(connected),
          );
        }).pipe(
          sanitized(
            "Classification failed. This email was not moved; load a fresh batch to retry.",
          ),
        ),
      apply: (results) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(prepared);

          if (Option.isNone(current))
            return yield* new BackendError({
              message: "No prepared mailbox writer",
              cause: undefined,
            });

          return yield* current.value
            .apply(results)
            .pipe(
              sanitized(
                "Could not confirm the mail update. It may have completed; refresh your mailbox before retrying.",
              ),
            );
          // Even an unconfirmed write may have moved mail, so every cached count is suspect.
        }).pipe(Effect.ensuring(countCache.clear)),
      record: (usage) =>
        Effect.gen(function* () {
          const { pricing } = yield* loadConfig();

          return yield* recordRun(usage, pricing);
        }).pipe(withPaths, sanitized("Could not save usage")),
    });
  }),
);
