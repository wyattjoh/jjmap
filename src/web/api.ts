import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  SchemaIssue,
  Stream,
} from "effect";
import { DraftsRequest, normalizeDraft, type CategoryDraft } from "../categories.ts";
import type { Scope, Usage, UsageState } from "../domain.ts";
import type { ApplyResult, Message } from "../mailbox.ts";
import type { Triaged } from "../triage.ts";
import {
  Concurrency,
  DEFAULT_CONCURRENCY,
  destinationOf,
  RunRequest,
  ScopeRequest,
  type Batch,
  type Bootstrap,
  type Card,
  type CategoriesState,
  type FolderSummary,
  type LoadEvent,
  type LoadStage,
  type RunEvent,
  type RunPhase,
} from "./model.ts";
import { runPipeline } from "./pipeline.ts";

/**
 * An expected load failure whose message is safe to show; JSON responses use `status`.
 */
export class LoadError extends Schema.TaggedError<LoadError>()("LoadError", {
  status: Schema.Number,
  message: Schema.String,
}) {}

/**
 * A backend step failed. The message is safe to show in the browser; provider
 * responses, which can contain private data, stay in `cause`.
 */
export class BackendError extends Schema.TaggedError<BackendError>()("BackendError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * A request refused before any work started; answered as `{ error }` with `status`.
 */
class Rejected extends Schema.TaggedError<Rejected>()("Rejected", {
  status: Schema.Number,
  message: Schema.String,
}) {}

/**
 * Receives progress from backend loads; the API forwards it only to streaming clients.
 */
export interface LoadReporter {
  readonly stage: (
    stage: LoadStage,
    done: number | null,
    total: number | null,
  ) => Effect.Effect<void>;
  /**
   * One folder's settled counts (null when unavailable), sent as soon as it resolves.
   */
  readonly folder: (summary: FolderSummary) => Effect.Effect<void>;
}

/**
 * Reporter that discards progress, for JSON responses and callers without a UI.
 */
export const SILENT: LoadReporter = { stage: () => Effect.void, folder: () => Effect.void };

type Failed = LoadError | BackendError;

/**
 * The mail side of the local API; tests and demo replace it without credentials.
 * Interrupting a load stops its remaining reads.
 */
export class Backend extends Context.Service<
  Backend,
  {
    readonly bootstrap: (report: LoadReporter) => Effect.Effect<Bootstrap, Failed>;
    /**
     * Lists folders, then counts them, reporting each settled folder through `report.folder`.
     * `fresh` bypasses any cached list or counts (the overview's explicit refresh).
     */
    readonly folders: (
      report: LoadReporter,
      fresh: boolean,
    ) => Effect.Effect<readonly FolderSummary[], Failed>;
    readonly categories: () => Effect.Effect<CategoriesState, Failed>;
    /**
     * Validates, creates any requested folders, and persists; rejects invalid drafts.
     */
    readonly saveCategories: (drafts: readonly CategoryDraft[]) => Effect.Effect<void, Failed>;
    /**
     * Finds matching emails, then reads them in chunks, reporting `read` progress.
     */
    readonly fetch: (
      scope: Scope,
      report: LoadReporter,
    ) => Effect.Effect<readonly Message[], Failed>;
    readonly begin: (scope: Scope) => Effect.Effect<void, BackendError>;
    readonly classify: (email: Message) => Effect.Effect<Triaged, BackendError>;
    readonly apply: (results: readonly Triaged[]) => Effect.Effect<ApplyResult, BackendError>;
    readonly record: (usage: Usage) => Effect.Effect<UsageState, BackendError>;
  }
>()("jjmap/web/Backend") {}

/**
 * Random-length filler words for one card field. Keyed by a per-launch secret and the email id,
 * so repeat projections of one email match while lengths never depend on the original text.
 */
export function filler(key: string, minWords: number, maxWords: number) {
  let state = 2166136261;

  for (const char of key) state = Math.imul(state ^ char.charCodeAt(0), 16777619);

  const next = (min: number, max: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;

    return min + ((state >>> 0) % (max - min + 1));
  };

  return Array.from({ length: next(minWords, maxWords) }, () => "█".repeat(next(2, 9))).join(" ");
}

/**
 * Projects plain text only; email HTML is never sent to the browser or rendered.
 * A `redactSeed` swaps sender, subject and preview for filler before they leave the server
 * (for screen recordings).
 */
export function toCard(email: Message, redactSeed?: string): Card {
  const redacted = (field: string, minWords: number, maxWords: number) =>
    filler(`${redactSeed}:${email.id}:${field}`, minWords, maxWords);

  if (redactSeed !== undefined)
    return {
      id: email.id,
      from: redacted("from", 1, 2),
      subject: redacted("subject", 2, 7),
      preview: redacted("preview", 10, 28),
      receivedAt: email.receivedAt || "",
      redacted: true,
    };

  return {
    id: email.id,
    from: email.from?.[0]?.name || email.from?.[0]?.email || "Unknown sender",
    subject: email.subject || "(No subject)",
    preview: (email.preview || "").slice(0, 220),
    receivedAt: email.receivedAt || "",
  };
}

// Only our own LoadError messages reach the browser: provider responses can contain private data.
const UNABLE_TO_LOAD =
  "Unable to load mail. Check the local connection and credentials, then retry.";

const BUSY = "A batch is already loading or sorting";

const PRIVATE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const NDJSON_HEADERS = { ...PRIVATE_HEADERS, "Content-Type": "application/x-ndjson" };

const json = <T>(value: T, status = 200) =>
  Response.json(value, { status, headers: PRIVATE_HEADERS });

const failure = (status: number, error: string) => json({ error }, status);

const firstIssue = SchemaIssue.makeFormatterStandardSchemaV1();

// Reads and decodes a JSON body, rejecting with the first invalid field in the caller's words.
const decodeBody = Effect.fnUntraced(function* <T, E>(
  request: Request,
  schema: Schema.Codec<T, E>,
  messages: Readonly<Record<string, string>>,
  fallback: string,
) {
  const body = yield* Effect.tryPromise(() => request.json()).pipe(
    Effect.mapError(() => new Rejected({ status: 400, message: "Invalid JSON" })),
  );

  return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError((error) => {
      const [key] = firstIssue(error.issue).issues[0]?.path ?? [];
      const message = key === undefined ? undefined : messages[String(key)];

      return new Rejected({ status: 400, message: message ?? fallback });
    }),
  );
});

const SCOPE_MESSAGES = {
  mailboxId: "Choose a source folder",
  limit: "Email count must be a positive integer",
  filter: "Web triage only sorts untriaged email",
  since: "Invalid date range",
};

const ndjson = <A, E>(events: Stream.Stream<A, E>) =>
  new Response(
    events.pipe(
      Stream.map((event) => `${JSON.stringify(event)}\n`),
      Stream.encodeText,
      Stream.toReadableStream(),
    ),
    { headers: NDJSON_HEADERS },
  );

interface Prepared {
  readonly id: string;
  readonly scope: Scope;
  readonly emails: readonly Message[];
}

interface ApiState {
  readonly prepared: Prepared | undefined;
  readonly cancelledPreviewId: string | undefined;
  readonly busy: boolean;
  readonly previewVersion: number;
  readonly shuttingDown: boolean;
  /**
   * The running batch's stop switch, while a run is streaming.
   */
  readonly active: Ref.Ref<boolean> | undefined;
  /**
   * Completes when the latest run has recorded usage and released the writer.
   */
  readonly finished: Deferred.Deferred<void>;
}

// Creates the API for one server launch. Disconnects and Stop finish only the
// bounded set of in-flight emails.
const make = Effect.fnUntraced(function* (token: string, origin: () => string, redact: boolean) {
  const backend = yield* Backend;
  const redactSeed = redact ? crypto.randomUUID() : undefined;
  const idle = yield* Deferred.make<void>();
  yield* Deferred.succeed(idle, undefined);

  const state = yield* Ref.make<ApiState>({
    prepared: undefined,
    cancelledPreviewId: undefined,
    busy: false,
    previewVersion: 0,
    shuttingDown: false,
    active: undefined,
    finished: idle,
  });

  // Streams progress only to clients that ask for NDJSON; others get the plain JSON result.
  const load = <T>(request: Request, work: (report: LoadReporter) => Effect.Effect<T, Failed>) => {
    if (!request.headers.get("accept")?.includes("application/x-ndjson"))
      return work(SILENT).pipe(
        Effect.map((data) => json(data)),
        Effect.catchTag("LoadError", (error) =>
          Effect.succeed(failure(error.status, error.message)),
        ),
        Effect.catchCause(() => Effect.succeed(failure(400, UNABLE_TO_LOAD))),
      );

    const events = Stream.callback<LoadEvent<T>>((queue) => {
      const emit = (event: LoadEvent<T>) => Queue.offer(queue, event);

      return work({
        stage: (stage, done, total) => emit({ type: "stage", stage, done, total }),
        folder: (folder) => emit({ type: "folder", folder }),
      }).pipe(
        Effect.flatMap((data) => emit({ type: "result", data })),
        Effect.catchTag("LoadError", (error) => emit({ type: "error", message: error.message })),
        Effect.catchCause(() => emit({ type: "error", message: UNABLE_TO_LOAD })),
        Effect.andThen(Queue.end(queue)),
      );
    });

    return Effect.succeed(ndjson(events));
  };

  const saveCategories = Effect.fnUntraced(function* (request: Request) {
    if ((yield* Ref.get(state)).busy) return yield* new Rejected({ status: 409, message: BUSY });
    const body = yield* decodeBody(request, DraftsRequest, {}, "Invalid category");

    // New targets change routing, so any prepared batch must be reloaded.
    const acquired = yield* Ref.modify(state, (current) =>
      current.busy
        ? [false, current]
        : [
            true,
            {
              ...current,
              busy: true,
              previewVersion: current.previewVersion + 1,
              prepared: undefined,
            },
          ],
    );

    if (!acquired) return yield* new Rejected({ status: 409, message: BUSY });

    return yield* backend.saveCategories(body.categories.map(normalizeDraft)).pipe(
      Effect.as(json({ saved: true })),
      Effect.catchCause(() =>
        Effect.succeed(failure(400, "Could not save categories. Check the folders and retry.")),
      ),
      Effect.ensuring(Ref.update(state, (current) => ({ ...current, busy: false }))),
    );
  });

  const stop = Effect.fnUntraced(function* () {
    const { active, prepared } = yield* Ref.get(state);

    if (active) yield* Ref.set(active, true);
    else if (prepared)
      yield* Ref.update(state, (current) => ({ ...current, cancelledPreviewId: prepared.id }));

    return json({ stopping: active !== undefined });
  });

  const preview = Effect.fnUntraced(function* (request: Request) {
    if ((yield* Ref.get(state)).busy) return yield* new Rejected({ status: 409, message: BUSY });

    const version = yield* Ref.modify(state, (current) => [
      current.previewVersion + 1,
      { ...current, previewVersion: current.previewVersion + 1, prepared: undefined },
    ]);

    const scope: Scope = yield* decodeBody(
      request,
      ScopeRequest,
      SCOPE_MESSAGES,
      "A batch scope is required",
    );

    return yield* load(request, (report) =>
      Effect.gen(function* () {
        yield* report.stage("check", null, null);
        const config = yield* backend.bootstrap(SILENT);

        if (!config.categoriesSaved)
          return yield* new LoadError({ status: 409, message: "Set up categories first" });

        if (!config.mailboxes.some((mailbox) => mailbox.id === scope.mailboxId))
          return yield* new LoadError({ status: 400, message: "Unknown source folder" });
        const emails = yield* backend.fetch(scope, report);
        const id = crypto.randomUUID();

        // Rapid scope changes may overlap reads, but stale responses never replace
        // the newest prepared batch (or invalidate a run already using it).
        const current = yield* Ref.modify(state, (latest) =>
          latest.previewVersion === version
            ? [true, { ...latest, prepared: { id, scope, emails } }]
            : [false, latest],
        );

        if (!current)
          return yield* new LoadError({
            status: 409,
            message: "A newer preview replaced this request",
          });
        const batch: Batch = { id, scope, cards: emails.map((email) => toCard(email, redactSeed)) };

        return batch;
      }),
    );
  });

  // Streams one prepared batch. Runs detached so a disconnect cannot interrupt
  // paid work mid-email; `stop` finishes only what already started.
  const runBatch = Effect.fnUntraced(function* (
    batch: Prepared,
    concurrency: number,
    stopping: Ref.Ref<boolean>,
    startedAt: number,
    events: Queue.Queue<RunEvent, Cause.Done>,
    release: Effect.Effect<void>,
  ) {
    const emit = (event: RunEvent) => Queue.offer(events, event);

    const phase = (phase: RunPhase) =>
      Effect.flatMap(Clock.currentTimeMillis, (now) =>
        emit({ type: "phase", phase, elapsedMs: Math.max(0, Math.round(now - startedAt)) }),
      );

    const summary = yield* Ref.make({ usage: { input: 0, output: 0 }, classified: 0 });
    const updating = yield* Ref.make(false);
    const sorting = yield* Ref.make(false);

    const sort = Effect.gen(function* () {
      if ((yield* Ref.get(stopping)) || batch.emails.length === 0) return;
      yield* phase("preparing");
      yield* backend.begin(batch.scope);

      if (!(yield* Ref.get(stopping))) yield* phase("classifying");

      const done = yield* runPipeline({
        emails: batch.emails,
        concurrency,
        stop: stopping,
        classify: backend.classify,
        apply: (results) =>
          Effect.gen(function* () {
            if (!(yield* Ref.getAndSet(updating, true))) yield* phase("updating");

            return yield* backend.apply(results);
          }),
        working: (email) => emit({ type: "working", id: email.id }),
        result: (result, applied, error) =>
          Effect.gen(function* () {
            if (applied && !(yield* Ref.getAndSet(sorting, true))) yield* phase("sorting");

            yield* emit({
              type: "result",
              outcome: {
                card: toCard(result.email, redactSeed),
                destination: destinationOf(result.plan),
                plan: result.plan,
                applied,
                error,
              },
              usage: result.usage,
            });
          }),
        error: (message) => emit({ type: "error", message }),
      });

      yield* Ref.set(summary, done);
    });

    // Backend messages are safe to show; anything unexpected is not.
    yield* sort.pipe(
      Effect.catchTag("BackendError", (error) => emit({ type: "error", message: error.message })),
      Effect.catchCause(() =>
        emit({
          type: "error",
          message: "Sorting stopped unexpectedly. Check your mailbox before retrying.",
        }),
      ),
    );

    const { usage, classified } = yield* Ref.get(summary);
    let totals: UsageState | undefined;

    if (classified > 0) {
      const recorded = yield* Effect.option(backend.record(usage));

      if (Option.isSome(recorded)) totals = recorded.value;
      else
        yield* emit({
          type: "error",
          message:
            "Mail changes completed, but saving usage failed. Token counts below include this run.",
        });
    }

    yield* emit({ type: "done", stopped: yield* Ref.get(stopping), usage, totals });
    yield* release;
    yield* Queue.end(events);
  });

  const run = Effect.fnUntraced(function* (request: Request) {
    // Acquire before reading JSON or bootstrap: concurrent starts cannot both write.
    const stopping = yield* Ref.make(false);

    const acquired = yield* Ref.modify(state, (current) =>
      current.busy ? [undefined, current] : [current, { ...current, busy: true, active: stopping }],
    );

    if (!acquired) return yield* new Rejected({ status: 409, message: BUSY });
    const startedAt = yield* Clock.currentTimeMillis;
    const finished = yield* Deferred.make<void>();

    if (
      request.signal.aborted ||
      (acquired.cancelledPreviewId !== undefined &&
        acquired.cancelledPreviewId === acquired.prepared?.id)
    )
      yield* Ref.set(stopping, true);
    const onAbort = () => Effect.runSync(Ref.set(stopping, true));
    request.signal.addEventListener("abort", onAbort, { once: true });

    const release = Effect.gen(function* () {
      request.signal.removeEventListener("abort", onAbort);
      yield* Ref.update(state, (current) => ({ ...current, busy: false, active: undefined }));
      yield* Deferred.succeed(finished, undefined);
    });

    const handedOff = yield* Ref.make(false);

    const start = Effect.gen(function* () {
      const fields = yield* decodeBody(
        request,
        RunRequest,
        {},
        "Explicit Start confirmation is required",
      );

      if (fields.confirm !== true)
        return yield* new Rejected({
          status: 400,
          message: "Explicit Start confirmation is required",
        });

      const { prepared } = yield* Ref.get(state);

      if (!prepared || fields.batchId !== prepared.id)
        return yield* new Rejected({
          status: 409,
          message: "This batch expired or already ran. Load a fresh batch.",
        });

      if ((yield* backend.bootstrap(SILENT)).readOnly)
        return yield* new Rejected({ status: 403, message: "This account is read-only" });

      if ((yield* Ref.get(state)).shuttingDown)
        return yield* new Rejected({ status: 503, message: "Server is stopping" });

      const concurrency = yield* Schema.decodeUnknownEffect(Concurrency)(
        // JSON cannot carry `undefined`, so only an absent key selects the default.
        fields.concurrency === undefined ? DEFAULT_CONCURRENCY : fields.concurrency,
      ).pipe(
        Effect.mapError(
          () => new Rejected({ status: 400, message: "Choose between one and eight workers" }),
        ),
      );

      const events = yield* Queue.unbounded<RunEvent, Cause.Done>();
      yield* Ref.update(state, (current) => ({ ...current, prepared: undefined, finished }));

      // Start synchronously so an accepted Start has begun its first emails before
      // the response returns; a later Stop or shutdown then finishes only those.
      yield* Effect.forkDetach(
        runBatch(prepared, concurrency, stopping, startedAt, events, release),
        { startImmediately: true },
      );

      yield* Ref.set(handedOff, true);

      // A closed or cancelled response stops scheduling; started emails still finish.
      return ndjson(
        Stream.fromQueue(events).pipe(
          Stream.ensuring(Effect.andThen(Ref.set(stopping, true), Queue.shutdown(events))),
        ),
      );
    });

    return yield* start.pipe(
      Effect.onExit(() =>
        Effect.flatMap(Ref.get(handedOff), (handed) => (handed ? Effect.void : release)),
      ),
    );
  });

  const route = Effect.fnUntraced(function* (request: Request, url: URL) {
    if (url.pathname === "/api/bootstrap" && request.method === "GET")
      return yield* load(request, (report) => backend.bootstrap(report));

    if (url.pathname === "/api/folders" && request.method === "GET")
      return yield* load(request, (report) =>
        backend.folders(report, url.searchParams.get("fresh") === "1"),
      );

    if (url.pathname === "/api/categories" && request.method === "GET")
      return json(yield* backend.categories());

    if (url.pathname === "/api/categories" && request.method === "POST")
      return yield* saveCategories(request);

    if (url.pathname === "/api/stop" && request.method === "POST") return yield* stop();

    if (url.pathname === "/api/preview" && request.method === "POST")
      return yield* preview(request);

    if (url.pathname === "/api/run" && request.method === "POST") return yield* run(request);

    return failure(404, "Not found");
  });

  const guard = Effect.fnUntraced(function* (request: Request) {
    if ((yield* Ref.get(state)).shuttingDown) return failure(503, "Server is stopping");
    const url = new URL(request.url);
    const allowed = origin();

    if (url.origin !== allowed || request.headers.get("host") !== new URL(allowed).host)
      return failure(403, "Invalid host");

    if (request.headers.get("x-jjmap-token") !== token)
      return failure(401, "Open the private link printed by jjmap in your terminal");
    const requestOrigin = request.headers.get("origin");

    if (
      (requestOrigin && requestOrigin !== allowed) ||
      (request.method === "POST" && requestOrigin !== allowed)
    )
      return failure(403, "Invalid origin");

    if (
      request.method === "POST" &&
      !request.headers.get("content-type")?.startsWith("application/json")
    )
      return failure(415, "Expected JSON");

    return yield* route(request, url);
  });

  const handle = (request: Request) =>
    guard(request).pipe(
      Effect.catchTag("Rejected", (rejected) =>
        Effect.succeed(failure(rejected.status, rejected.message)),
      ),
      Effect.catchCause(() => Effect.succeed(failure(400, UNABLE_TO_LOAD))),
    );

  const shutdown = Effect.gen(function* () {
    const { active, finished } = yield* Ref.updateAndGet(state, (current) => ({
      ...current,
      shuttingDown: true,
    }));

    if (active) yield* Ref.set(active, true);
    yield* Deferred.await(finished);
  });

  return Api.of({ handle, shutdown });
});

/**
 * A token- and origin-protected API with one prepared batch and one writer.
 */
export class Api extends Context.Service<
  Api,
  {
    readonly handle: (request: Request) => Effect.Effect<Response>;
    /**
     * Refuses new requests, stops scheduling, and waits for in-flight emails.
     */
    readonly shutdown: Effect.Effect<void>;
  }
>()("jjmap/web/Api") {
  /**
   * One launch's API: `token` is the private link secret and `origin` the bound server origin.
   * `redact` hides senders, subjects and previews on every card sent to the browser.
   */
  static layer(token: string, origin: () => string, redact = false) {
    return Layer.effect(Api, make(token, origin, redact));
  }
}
