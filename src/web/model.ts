import { Schema } from "effect";
import { CategoryDraft, REVIEW } from "../categories.ts";
import { Pricing, Scope, ScopeSince, Usage, UsageState } from "../domain.ts";
import { Plan } from "../plan.ts";

/**
 * Browser-safe schemas for the local web API. The server encodes responses and
 * stream events with them, and the browser decodes with the same definitions.
 * Keep this module free of server, mail, and credential imports.
 */

/**
 * Browser-safe email projection; bodies, headers, and credentials stay on the server.
 */
export const Card = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  subject: Schema.String,
  preview: Schema.String,
  receivedAt: Schema.String,
});

/**
 * Browser-safe email projection.
 */
export type Card = typeof Card.Type;

/**
 * Display fields of one sort target; `folderId: null` keeps mail in the source folder.
 */
export const DestinationInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  color: Schema.String,
  folderId: Schema.NullOr(Schema.String),
});

/**
 * Display fields of one sort target.
 */
export type DestinationInfo = typeof DestinationInfo.Type;

/**
 * Identifier for a visual destination, not necessarily a physical mailbox.
 */
export type Destination = string;

/**
 * Configured targets plus the built-in review bucket, in display order.
 */
export function destinationsOf(categories: readonly DestinationInfo[]): DestinationInfo[] {
  return [...categories, { ...REVIEW, folderId: null }];
}

/**
 * Maps the conservative routing plan to its visual destination.
 */
export function destinationOf(plan: Plan): Destination {
  return plan.category ?? REVIEW.id;
}

/**
 * Editable category state for the setup screen.
 */
export const CategoriesState = Schema.Struct({
  saved: Schema.Boolean,
  drafts: Schema.Array(CategoryDraft),
  /**
   * Built-in folders found during first-run detection, out of `expected`.
   */
  detected: Schema.Finite,
  expected: Schema.Finite,
});

/**
 * Editable category state for the setup screen.
 */
export type CategoriesState = typeof CategoriesState.Type;

/**
 * Safe startup state returned by the local server.
 */
export const Bootstrap = Schema.Struct({
  demo: Schema.Boolean,
  readOnly: Schema.Boolean,
  inboxId: Schema.String,
  mailboxes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      parentId: Schema.NullOr(Schema.String),
    }),
  ),
  /**
   * Saved sort targets; empty until first-run setup is saved.
   */
  categories: Schema.Array(DestinationInfo),
  categoriesSaved: Schema.Boolean,
  pricing: Pricing,
  totals: UsageState,
});

/**
 * Safe startup state returned by the local server.
 */
export type Bootstrap = typeof Bootstrap.Type;

/**
 * Current non-draft contents of a mailbox. Null counts mean unavailable, not empty.
 */
export const FolderSummary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  total: Schema.NullOr(Schema.Finite),
  unclassified: Schema.NullOr(Schema.Finite),
});

/**
 * Current non-draft contents of a mailbox.
 */
export type FolderSummary = typeof FolderSummary.Type;

/**
 * The folder overview's result.
 */
export const FolderSummaries = Schema.Array(FolderSummary);

/**
 * One step of a streamed load: bootstrap (connect, mailboxes, settings), folder
 * overview (list, count), or batch preview (check, search, read).
 */
export const LoadStage = Schema.Literals([
  "connect",
  "mailboxes",
  "settings",
  "list",
  "count",
  "check",
  "search",
  "read",
]);

/**
 * One step of a streamed load.
 */
export type LoadStage = typeof LoadStage.Type;

const loadProgressFields = {
  stage: LoadStage,
  done: Schema.NullOr(Schema.Finite),
  total: Schema.NullOr(Schema.Finite),
};

/**
 * Where a streamed load currently is; `done`/`total` are set only for countable stages.
 */
export const LoadProgress = Schema.Struct(loadProgressFields);

/**
 * Where a streamed load currently is.
 */
export type LoadProgress = typeof LoadProgress.Type;

/**
 * Ordered, labelled stages for each streamed load, shared by the server and the UI.
 */
export const LOAD_STAGES = {
  bootstrap: [
    { stage: "connect", label: "Connect" },
    { stage: "mailboxes", label: "Mailboxes" },
    { stage: "settings", label: "Settings" },
  ],
  folders: [
    { stage: "list", label: "Folders" },
    { stage: "count", label: "Counting" },
  ],
  preview: [
    { stage: "check", label: "Check folder" },
    { stage: "search", label: "Find matches" },
    { stage: "read", label: "Read emails" },
  ],
} as const satisfies Record<string, readonly { stage: LoadStage; label: string }[]>;

/**
 * Newline-delimited events for one streamed load, ending in `result` or `error`.
 */
export const LoadEvent = <T, E>(data: Schema.Codec<T, E>) =>
  Schema.Union([
    Schema.Struct({ type: Schema.Literal("stage"), ...loadProgressFields }),
    Schema.Struct({ type: Schema.Literal("folder"), folder: FolderSummary }),
    Schema.Struct({ type: Schema.Literal("result"), data }),
    Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
  ]);

/**
 * One event of a streamed load whose result is `T`.
 */
export type LoadEvent<T> = ReturnType<typeof LoadEvent<T, T>>["Type"];

/**
 * Startup milestones, measured from the server receiving Start (milliseconds).
 */
export const RunPhase = Schema.Literals(["preparing", "classifying", "updating", "sorting"]);

/**
 * Startup milestones.
 */
export type RunPhase = typeof RunPhase.Type;

/**
 * A prepared, server-owned batch. Its id can be consumed only once.
 */
export const Batch = Schema.Struct({ id: Schema.String, cards: Schema.Array(Card), scope: Scope });

/**
 * A prepared, server-owned batch.
 */
export type Batch = typeof Batch.Type;

/**
 * A confirmed application or a failed attempt. Only confirmed results take flight.
 */
export const Outcome = Schema.Struct({
  card: Card,
  destination: Schema.String,
  plan: Plan,
  applied: Schema.Boolean,
  error: Schema.optional(Schema.String),
});

/**
 * A confirmed application or a failed attempt.
 */
export type Outcome = typeof Outcome.Type;

/**
 * Newline-delimited events for one bounded run.
 */
export const RunEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("phase"), phase: RunPhase, elapsedMs: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("working"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("result"), outcome: Outcome, usage: Usage }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("done"),
    stopped: Schema.Boolean,
    usage: Usage,
    totals: Schema.optional(UsageState),
  }),
]);

/**
 * Newline-delimited events for one bounded run.
 */
export type RunEvent = typeof RunEvent.Type;

/**
 * Bounded default inference parallelism; the API accepts one through eight workers.
 */
export const DEFAULT_CONCURRENCY = 4;

/**
 * The paid work-in-flight limit, independent of the batch size.
 */
export const Concurrency = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }));

/**
 * Untrusted `POST /api/preview` body. Web runs always sort untriaged mail.
 */
export const ScopeRequest = Schema.Struct({
  mailboxId: Schema.NonEmptyString,
  limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  filter: Schema.Literal("untriaged"),
  since: ScopeSince,
});

/**
 * Untrusted `POST /api/run` body; only an explicit `confirm: true` may spend tokens.
 */
export const RunRequest = Schema.Struct({
  confirm: Schema.optionalKey(Schema.Unknown),
  batchId: Schema.optionalKey(Schema.Unknown),
  concurrency: Schema.optionalKey(Schema.Unknown),
});

/**
 * Error body of a failed API request.
 */
export const ErrorBody = Schema.Struct({ error: Schema.String });

/**
 * Confirmed share of the selected batch, bounded to 0–100 for percentage displays.
 */
export function percentage(count: number, total: number): number {
  return total > 0 ? (Math.min(total, Math.max(0, count)) / total) * 100 : 0;
}

/**
 * Formats elapsed milliseconds as minutes:seconds.tenths, clamping negative clock skew to zero.
 */
export function formatElapsed(milliseconds: number): string {
  const tenths = Math.floor(Math.max(0, milliseconds) / 100);
  const seconds = `${Math.floor(tenths / 10) % 60}.${tenths % 10}s`;

  return tenths < 600 ? seconds : `${Math.floor(tenths / 600)}m ${seconds.padStart(5, "0")}`;
}

/**
 * Parses arbitrarily split NDJSON chunks, decoding each complete line with `schema`.
 */
async function readLines<T, E>(
  response: Response,
  schema: Schema.Codec<T, E>,
  onEvent: (event: T) => void,
): Promise<void> {
  if (!response.body) throw new Error("No response stream");
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(schema));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  const consume = (line: string) => {
    if (line.trim()) onEvent(decode(line));
  };

  try {
    while (true) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";

      for (const line of lines) consume(line);

      if (chunk.done) break;
    }

    consume(pending);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Reads arbitrarily split NDJSON chunks and rejects a truncated run.
 */
export async function readEvents(
  response: Response,
  onEvent: (event: RunEvent) => void,
): Promise<void> {
  let done = false;

  await readLines(response, RunEvent, (event) => {
    if (event.type === "done") done = true;
    onEvent(event);
  });

  if (!done)
    throw new Error(
      "Connection interrupted. The last move may have completed; reload the batch before retrying.",
    );
}

/**
 * Reads a streamed load, forwarding progress and resolving with its decoded result.
 * Rejects on an `error` event or a stream that ends without a result.
 */
export async function readLoad<T, E>(
  response: Response,
  data: Schema.Codec<T, E>,
  onEvent: (event: LoadEvent<T>) => void,
): Promise<T> {
  let result: { readonly data: T } | undefined;
  let failure: string | undefined;

  await readLines(response, LoadEvent(data), (event) => {
    if (event.type === "result") result = { data: event.data };
    else if (event.type === "error") failure = event.message;
    else onEvent(event);
  });

  if (failure !== undefined) throw new Error(failure);

  if (!result) throw new Error("Connection interrupted while loading. Retry to continue.");

  return result.data;
}
