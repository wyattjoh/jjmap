import {
  connectJmap,
  getEmails,
  getMailboxes,
  searchEmails,
  type Email,
  type EmailFilterCondition,
  type JmapConnection,
  type Mailbox,
} from "@wyattjoh/jmap";
import { Config, Context, Effect, Layer, Option, Redacted, Result, Schema } from "effect";
import { FLAG_COLORS, TRIAGED_KEYWORD } from "./config.ts";
import type { Plan } from "./plan.ts";

/**
 * The mailbox fields jjmap reads; full JMAP mailboxes satisfy it.
 */
export type Folder = Pick<Mailbox, "id" | "name" | "totalEmails"> &
  Partial<Pick<Mailbox, "parentId" | "role">>;

/**
 * The email properties jjmap requests from JMAP; each may be absent from a
 * response, and full JMAP emails satisfy it.
 */
export type Message = Pick<Email, "id"> &
  Partial<
    Pick<
      Email,
      | "from"
      | "to"
      | "cc"
      | "subject"
      | "receivedAt"
      | "keywords"
      | "mailboxIds"
      | "preview"
      | "textBody"
      | "bodyValues"
    >
  >;

/**
 * A JMAP request failed in transport or was rejected by the server. The
 * message is safe to show; provider details stay in `cause`.
 */
export class JmapError extends Schema.TaggedError<JmapError>()("JmapError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * The server answered, but not in a way jjmap can act on safely.
 */
export class MailboxError extends Schema.TaggedError<MailboxError>()("MailboxError", {
  message: Schema.String,
}) {}

/**
 * One rejected create or update from a JMAP `/set` response (RFC 8620 §5.3).
 */
export const SetError = Schema.Struct({
  type: Schema.String,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/**
 * One rejected create or update from a JMAP `/set` response.
 */
export type SetError = typeof SetError.Type;

const SetErrors = Schema.NullOr(Schema.Record(Schema.String, SetError));

const MailboxSetResponse = Schema.Struct({
  created: Schema.optionalKey(
    Schema.NullOr(Schema.Record(Schema.String, Schema.Struct({ id: Schema.String }))),
  ),
  notCreated: Schema.optionalKey(SetErrors),
});

const EmailSetResponse = Schema.Struct({
  updated: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  notUpdated: Schema.optionalKey(SetErrors),
});

/**
 * A JSON-pointer patch for one email: `true` sets a key, `null` removes it.
 */
export const EmailPatch = Schema.Record(Schema.String, Schema.NullOr(Schema.Literal(true)));

/**
 * A JSON-pointer patch for one email.
 */
export type EmailPatch = typeof EmailPatch.Type;

/**
 * Confirmed and rejected email updates returned by JMAP.
 */
export type ApplyResult = {
  readonly updated: readonly string[];
  readonly failed: Readonly<Record<string, SetError>>;
};

/**
 * The JMAP operations jjmap uses, over one authenticated connection. Tests
 * provide synthetic implementations; `fromConnection` wraps a real one.
 */
export class JmapClient extends Context.Service<
  JmapClient,
  {
    readonly isReadOnly: boolean;
    readonly getMailboxes: (
      position: number,
      limit: number,
    ) => Effect.Effect<
      {
        readonly mailboxes: readonly Folder[];
        readonly total: number | undefined;
        readonly hasMore: boolean;
      },
      JmapError
    >;
    readonly searchEmails: (
      filter: EmailFilterCondition,
      position: number,
      limit: number,
    ) => Effect.Effect<
      { readonly ids: readonly string[]; readonly nextPosition: number; readonly hasMore: boolean },
      JmapError
    >;
    /**
     * Server-side total of emails matching every condition, without fetching any.
     */
    readonly countEmails: (
      conditions: readonly EmailFilterCondition[],
    ) => Effect.Effect<number | undefined, JmapError>;
    readonly getEmails: (
      ids: readonly string[],
      properties: readonly (keyof Email)[],
    ) => Effect.Effect<readonly Message[], JmapError>;
    /**
     * Creates top-level mailboxes, keyed by name in both result maps.
     */
    readonly createMailboxes: (names: readonly string[]) => Effect.Effect<
      {
        readonly created: ReadonlyMap<string, string>;
        readonly notCreated: ReadonlyMap<string, SetError>;
      },
      JmapError
    >;
    readonly updateEmails: (
      patches: Readonly<Record<string, EmailPatch>>,
    ) => Effect.Effect<ApplyResult, JmapError>;
  }
>()("jjmap/mailbox/JmapClient") {
  /**
   * Wraps an authenticated `@wyattjoh/jmap` connection. Mailbox and keyword
   * writes call jmap-jam directly because the wrapper has no Mailbox/set and
   * patches mailboxes and `$seen`/`$flagged` separately (no color bits).
   */
  static fromConnection(conn: JmapConnection): JmapClient["Service"] {
    const request = <A>(message: string, run: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: (cause) => new JmapError({ message, cause }) });

    const decodeWith = <T, E, V>(schema: Schema.Codec<T, E>, message: string, value: V) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError((cause) => new JmapError({ message, cause })),
      );

    return JmapClient.of({
      isReadOnly: conn.isReadOnly,
      getMailboxes: (position, limit) =>
        request("Could not list mailboxes", () =>
          getMailboxes(conn, { parentId: undefined, limit, position }),
        ),
      searchEmails: (filter, position, limit) =>
        request("Could not search mail", () => searchEmails(conn, { filter, limit, position })),
      countEmails: (conditions) =>
        request("Could not count mail", async () => {
          const [single] = conditions;

          const filter =
            conditions.length === 1 && single
              ? single
              : { operator: "AND" as const, conditions: [...conditions] };

          const [result] = await conn.client.api.Email.query({
            accountId: conn.accountId,
            filter,
            limit: 0,
            calculateTotal: true,
          });

          return result.total;
        }),
      getEmails: (ids, properties) =>
        request("Could not read mail", () => getEmails(conn, { ids, properties })).pipe(
          Effect.map(({ emails }) => emails),
        ),
      createMailboxes: (names) =>
        Effect.gen(function* () {
          const [response] = yield* request("Could not create folders", () =>
            conn.client.api.Mailbox.set({
              accountId: conn.accountId,
              create: Object.fromEntries(names.map((name) => [name, { name, parentId: null }])),
            }),
          );

          const { created, notCreated } = yield* decodeWith(
            MailboxSetResponse,
            "Unexpected Mailbox/set response",
            response,
          );

          return {
            created: new Map(Object.entries(created ?? {}).map(([name, { id }]) => [name, id])),
            notCreated: new Map(Object.entries(notCreated ?? {})),
          };
        }),
      updateEmails: (patches) =>
        Effect.gen(function* () {
          const [response] = yield* request("Could not update mail", () =>
            conn.client.api.Email.set({ accountId: conn.accountId, update: patches }),
          );

          const { updated, notUpdated } = yield* decodeWith(
            EmailSetResponse,
            "Unexpected Email/set response",
            response,
          );

          return { updated: Object.keys(updated ?? {}), failed: notUpdated ?? {} };
        }),
    });
  }

  /**
   * Authenticates with `JMAP_SESSION_URL`, `JMAP_BEARER_TOKEN`, and optional `JMAP_ACCOUNT_ID`.
   */
  static readonly connect = Effect.gen(function* () {
    const sessionUrl = yield* Config.String("JMAP_SESSION_URL");
    const bearerToken = yield* Config.Redacted("JMAP_BEARER_TOKEN");
    const accountId = yield* Config.option(Config.String("JMAP_ACCOUNT_ID"));

    const conn = yield* Effect.tryPromise({
      try: () =>
        connectJmap({
          sessionUrl,
          bearerToken: Redacted.value(bearerToken),
          accountId: Option.getOrUndefined(accountId),
        }),
      catch: (cause) => new JmapError({ message: "Could not connect to JMAP", cause }),
    });

    return JmapClient.fromConnection(conn);
  });

  /**
   * Connects once from environment configuration.
   */
  static readonly layer = Layer.effect(JmapClient, JmapClient.connect);
}

// RFC 8621 §4.1.3 `header:*` properties are valid Email/get properties, but
// jmap-rfc-types types `properties` as `keyof Email`, which omits them.
const HEADER_PROPERTIES: readonly string[] = ["header:List-Id:asText", "header:List-Unsubscribe"];

const EMAIL_PROPERTIES: readonly (keyof Email)[] = [
  "id",
  "from",
  "to",
  "cc",
  "subject",
  "receivedAt",
  "keywords",
  "mailboxIds",
  "preview",
  "textBody",
  "bodyValues",
  // SAFETY: the server returns these RFC 8621 header properties verbatim; `emailHeaders` decodes them.
  ...(HEADER_PROPERTIES as readonly (keyof Email)[]),
];

const BROWSE_PROPERTIES = ["id", "from", "subject", "receivedAt", "keywords", "preview"] as const;

const Headers = Schema.Struct({
  "header:List-Id:asText": Schema.optionalKey(Schema.NullOr(Schema.String)),
  "header:List-Unsubscribe": Schema.optionalKey(Schema.NullOr(Schema.String)),
});

/**
 * Bulk-mail signals from an email's list headers.
 */
export interface EmailHeaders {
  readonly listId: string | null;
  readonly hasListUnsubscribe: boolean;
}

/**
 * The bulk-mail headers requested alongside each email, decoded from the JMAP response.
 */
export function emailHeaders(email: Message): EmailHeaders {
  const headers = Option.getOrUndefined(Schema.decodeUnknownOption(Headers)(email));

  return {
    listId: headers?.["header:List-Id:asText"] ?? null,
    hasListUnsubscribe: Boolean(headers?.["header:List-Unsubscribe"]),
  };
}

/**
 * A mailbox page and the query position for the next page.
 */
export type MailboxPage = {
  readonly emails: readonly Message[];
  readonly nextPosition: number;
  readonly hasMore: boolean;
};

/**
 * Visibility options for browsing a mailbox independently of the next batch.
 */
export type BrowseFilter = "all" | "untriaged";

/**
 * Lists every mailbox in the account, 200 per page; interruption stops between pages.
 */
export const listMailboxes = Effect.fn("listMailboxes")(function* () {
  const jmap = yield* JmapClient;
  const mailboxes: Folder[] = [];
  let position = 0;

  while (true) {
    const page = yield* jmap.getMailboxes(position, 200);
    mailboxes.push(...page.mailboxes);

    if (!page.mailboxes.length || (!page.hasMore && page.total !== undefined)) break;
    position += page.mailboxes.length;
  }

  return mailboxes;
});

const COUNTS_UNAVAILABLE = "Mailbox counts are unavailable; refresh to retry";

/**
 * Counts current non-draft mail and its unclassified subset without fetching bodies.
 * Rejects unavailable or inconsistent totals rather than presenting invented percentages.
 */
export const countMailbox = Effect.fn("countMailbox")(function* (mailboxId: string) {
  const jmap = yield* JmapClient;
  const eligible = { inMailbox: mailboxId, notKeyword: "$draft" };

  // Keep both requests in their worker slot even when one fails immediately.
  const [all, pending] = yield* Effect.all(
    [
      Effect.result(jmap.countEmails([eligible])),
      Effect.result(jmap.countEmails([eligible, { notKeyword: TRIAGED_KEYWORD }])),
    ],
    { concurrency: 2 },
  );

  if (Result.isFailure(all) || Result.isFailure(pending))
    return yield* new MailboxError({ message: COUNTS_UNAVAILABLE });
  const total = all.success;
  const unclassified = pending.success;

  if (
    total === undefined ||
    unclassified === undefined ||
    !Number.isSafeInteger(total) ||
    !Number.isSafeInteger(unclassified) ||
    total < 0 ||
    unclassified < 0 ||
    unclassified > total
  )
    return yield* new MailboxError({ message: COUNTS_UNAVAILABLE });

  return { total, unclassified };
});

/**
 * Emails read per Email/get call, so large batches can report progress between chunks.
 */
export const READ_CHUNK = 50;

/**
 * Fetches the newest emails matching a mailbox filter, excluding drafts for triage.
 * Reads details in `READ_CHUNK`-sized requests, reporting emails read so far after each.
 */
export const fetchBatch = Effect.fn("fetchBatch")(function* (
  filter: EmailFilterCondition,
  limit: number,
  onRead: (done: number, total: number) => Effect.Effect<void> = () => Effect.void,
) {
  const jmap = yield* JmapClient;
  const { ids } = yield* jmap.searchEmails(filter, 0, limit);
  const emails: Message[] = [];
  yield* onRead(0, ids.length);

  for (let start = 0; start < ids.length; start += READ_CHUNK) {
    const chunk = ids.slice(start, start + READ_CHUNK);
    emails.push(...(yield* jmap.getEmails(chunk, EMAIL_PROPERTIES)));
    yield* onRead(start + chunk.length, ids.length);
  }

  return emails.filter((email) => !email.keywords?.["$draft"]);
});

/**
 * Fetches a lightweight page for browsing, including drafts.
 */
export const browsePage = Effect.fn("browsePage")(function* (
  mailboxId: string,
  position: number,
  limit: number,
  filter: BrowseFilter,
) {
  const jmap = yield* JmapClient;
  const condition: EmailFilterCondition = { inMailbox: mailboxId };

  if (filter === "untriaged") condition.notKeyword = TRIAGED_KEYWORD;
  const { ids, nextPosition, hasMore } = yield* jmap.searchEmails(condition, position, limit);

  if (ids.length === 0) return { emails: [], nextPosition, hasMore: false } satisfies MailboxPage;
  const emails = yield* jmap.getEmails(ids, BROWSE_PROPERTIES);

  return { emails, nextPosition, hasMore } satisfies MailboxPage;
});

/**
 * Creates any missing top-level folders and returns name → id for all of them.
 */
export const ensureFolders = Effect.fn("ensureFolders")(function* (
  mailboxes: readonly Folder[],
  names: readonly string[],
) {
  const jmap = yield* JmapClient;

  const existing = new Map(
    mailboxes.flatMap((mailbox) => (mailbox.parentId ? [] : [[mailbox.name, mailbox.id] as const])),
  );

  const missing = names.filter((name) => !existing.has(name));

  if (missing.length === 0) return existing;
  const { created, notCreated } = yield* jmap.createMailboxes(missing);

  for (const name of missing) {
    const id = created.get(name);

    if (!id) {
      const reason = notCreated.get(name);

      return yield* new MailboxError({
        message: `Failed to create folder ${name}: ${reason ? reason.type : "no id returned"}`,
      });
    }

    existing.set(name, id);
  }

  return existing;
});

const pointer = (segment: string) => segment.replaceAll("~", "~0").replaceAll("/", "~1");

type PatchEntry = [path: string, value: true | null];

function flagEntries(
  plan: Plan,
  existingKeywords: Readonly<Record<string, boolean>>,
): PatchEntry[] {
  const entries: PatchEntry[] = [];

  if (!plan.flag) return entries;
  const { bits, label } = FLAG_COLORS[plan.flag];

  if (label) entries.push([`keywords/${pointer(label)}`, true]);

  if (existingKeywords["$flagged"]) return entries;
  entries.push(["keywords/$flagged", true]);

  for (const [index, on] of bits.entries())
    entries.push([`keywords/$MailFlagBit${index}`, on || null]);

  return entries;
}

/**
 * Keyword patch that sets a color flag plus any label keyword. The label is
 * always added; the color is skipped on mail the user already flagged.
 */
export function flagPatch(
  plan: Plan,
  existingKeywords: Readonly<Record<string, boolean>>,
): EmailPatch {
  return Object.fromEntries(flagEntries(plan, existingKeywords));
}

/**
 * Builds a single Email/set patch that moves, flags, and marks one email.
 */
export function emailPatch(
  plan: Plan,
  sourceMailboxId: string,
  existingKeywords: Readonly<Record<string, boolean>>,
): EmailPatch {
  const entries: PatchEntry[] = [];
  const { folderId } = plan;

  if (folderId && folderId !== sourceMailboxId) {
    entries.push([`mailboxIds/${pointer(sourceMailboxId)}`, null]);
    entries.push([`mailboxIds/${pointer(folderId)}`, true]);
  }

  entries.push(...flagEntries(plan, existingKeywords));
  entries.push([`keywords/${pointer(TRIAGED_KEYWORD)}`, true]);

  if (plan.markSeen) entries.push(["keywords/$seen", true]);

  return Object.fromEntries(entries);
}

/**
 * Applies all patches in one Email/set call so each email's move and keywords stay atomic.
 */
export const applyPatches = Effect.fn("applyPatches")(function* (
  patches: Readonly<Record<string, EmailPatch>>,
) {
  const jmap = yield* JmapClient;

  return yield* jmap.updateEmails(patches);
});
