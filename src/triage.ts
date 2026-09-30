import type { EmailFilterCondition } from "@wyattjoh/jmap";
import { Context, DateTime, Effect, Layer, Schema, type Config } from "effect";
import { classify, Jev, type JevError } from "./classify.ts";
import { ruleCategory, type CategoryConfig } from "./categories.ts";
import { TRIAGED_KEYWORD } from "./config.ts";
import type { Scope, Usage } from "./domain.ts";
import {
  applyPatches,
  browsePage,
  emailPatch,
  fetchBatch as queryBatch,
  JmapClient,
  listMailboxes,
  MailboxError,
  type ApplyResult,
  type BrowseFilter,
  type EmailPatch,
  type Folder,
  type Message,
  type JmapError,
} from "./mailbox.ts";
import { decide, type Judgments, type Plan } from "./plan.ts";

/**
 * A triage request or its preparation was rejected before any mail changed.
 */
export class TriageError extends Schema.TaggedError<TriageError>()("TriageError", {
  message: Schema.String,
}) {}

/**
 * One classified email and its deterministic application plan.
 */
export interface Triaged {
  readonly email: Message;
  readonly from: string;
  readonly subject: string;
  readonly judgments: Judgments;
  readonly plan: Plan;
  readonly usage: Usage;
}

/**
 * Authenticated JMAP and Jev clients, plus the account's mailboxes.
 */
export interface Connection {
  readonly jmap: JmapClient["Service"];
  readonly jev: Jev["Service"];
  readonly mailboxes: readonly Folder[];
  readonly inbox: Folder;
}

/**
 * Connection milestones, reported before each step starts.
 */
export type ConnectStage = "connect" | "mailboxes";

/**
 * Anything that can prevent a connection from opening.
 */
export type ConnectError = JmapError | JevError | MailboxError | Config.ConfigError;

/**
 * Authenticates JMAP and Jev from environment configuration, and resolves the Inbox and all mailboxes.
 */
export const connect = Effect.fn("connect")(function* (
  onStage: (stage: ConnectStage) => Effect.Effect<void> = () => Effect.void,
) {
  yield* onStage("connect");
  const jmap = yield* JmapClient.connect;
  const jev = yield* Jev.connect;
  yield* onStage("mailboxes");
  const mailboxes = yield* listMailboxes().pipe(Effect.provideService(JmapClient, jmap));
  const inbox = mailboxes.find((mailbox) => mailbox.role === "inbox");

  if (!inbox) return yield* new MailboxError({ message: "No mailbox with role=inbox" });
  const connection: Connection = { jmap, jev, mailboxes, inbox };

  return connection;
});

/**
 * Opens connections on demand; the web backend connects lazily through it, and tests replace it.
 */
export class Connector extends Context.Service<
  Connector,
  {
    readonly connect: (
      onStage: (stage: ConnectStage) => Effect.Effect<void>,
    ) => Effect.Effect<Connection, ConnectError>;
  }
>()("jjmap/triage/Connector") {
  /**
   * Connects to the configured JMAP account and TypeSafe.
   */
  static readonly layer = Layer.succeed(Connector, Connector.of({ connect }));
}

/**
 * Provides a connection's JMAP and Jev clients to an effect.
 */
export const withConnection =
  (connection: Connection) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(JmapClient, connection.jmap),
      Effect.provideService(Jev, connection.jev),
    );

const DAYS = { "24h": 1, "7d": 7, "30d": 30 } as const;

/**
 * Builds the JMAP condition for a scope relative to `now`.
 */
export function scopeFilter(scope: Scope, now: Date): EmailFilterCondition {
  const condition: EmailFilterCondition = { inMailbox: scope.mailboxId };

  if (scope.filter === "unread") condition.notKeyword = "$seen";

  if (scope.filter === "untriaged") condition.notKeyword = TRIAGED_KEYWORD;

  if (scope.since !== "any")
    condition.after = new Date(now.getTime() - DAYS[scope.since] * 86_400_000).toISOString();

  return condition;
}

const Limit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * Requires a positive integer limit without imposing an application-level maximum.
 */
export const validateLimit = Effect.fn("validateLimit")(function* (limit: number) {
  return yield* Schema.decodeUnknownEffect(Limit)(limit).pipe(
    Effect.mapError(() => new TriageError({ message: "Limit must be a positive integer" })),
  );
});

/**
 * Loads the requested number of scoped emails; drafts are excluded.
 */
export const fetchBatch = Effect.fn("fetchBatch")(function* (
  scope: Scope,
  onRead: (done: number, total: number) => Effect.Effect<void> = () => Effect.void,
) {
  const limit = yield* validateLimit(scope.limit);
  const now = yield* DateTime.now;

  return yield* queryBatch(scopeFilter(scope, DateTime.toDateUtc(now)), limit, onRead);
});

/**
 * Reads one lightweight mailbox page for browsing, including drafts.
 */
export const browseMailbox = Effect.fn("browseMailbox")(function* (
  mailboxId: string,
  position: number,
  limit: number,
  filter: BrowseFilter,
) {
  return yield* browsePage(mailboxId, position, yield* validateLimit(limit), filter);
});

/**
 * Classifies one email and plans what to do with it.
 */
export const triageEmail = Effect.fn("triageEmail")(function* (
  email: Message,
  categories: readonly CategoryConfig[],
  recipient: string | undefined,
) {
  const from = email.from?.[0]?.email ?? "";
  const { judgments, usage } = yield* classify(email, categories, recipient);

  const triaged: Triaged = {
    email,
    from,
    subject: email.subject ?? "",
    judgments,
    plan: decide(judgments, ruleCategory(from, categories), categories),
    usage,
  };

  return triaged;
});

/**
 * Classifies emails sequentially and reports each plan when ready.
 */
export const classifyBatch = Effect.fn("classifyBatch")(function* (
  emails: readonly Message[],
  categories: readonly CategoryConfig[],
  recipient: string | undefined,
  onResult: (result: Triaged) => Effect.Effect<void> = () => Effect.void,
) {
  return yield* Effect.forEach(emails, (email) =>
    triageEmail(email, categories, recipient).pipe(Effect.tap(onResult)),
  );
});

/**
 * Applies one group of plans; the web writer calls it once per coalesced group.
 */
export type Applier = (triaged: readonly Triaged[]) => Effect.Effect<ApplyResult, JmapError>;

/**
 * Checks destination folders once, then applies bounded groups without mailbox re-fetches.
 * Used by both the one-shot terminal operation and the streaming browser writer.
 */
export const prepareApplier = Effect.fn("prepareApplier")(function* (
  mailboxes: readonly Folder[],
  sourceMailboxId: string,
  categories: readonly CategoryConfig[],
) {
  const jmap = yield* JmapClient;

  if (jmap.isReadOnly) return yield* new TriageError({ message: "JMAP account is read-only" });
  const ids = new Set(mailboxes.map(({ id }) => id));
  const missing = categories.filter(({ folderId }) => folderId !== null && !ids.has(folderId));

  if (missing.length > 0)
    return yield* new TriageError({
      message: `Folder missing for ${missing.map(({ name }) => name).join(", ")}; update categories`,
    });

  if (categories.some(({ folderId }) => folderId === sourceMailboxId))
    return yield* new TriageError({
      message: "The source folder is a sort target; choose another folder",
    });

  const apply: Applier = (triaged) => {
    if (triaged.length === 0) return Effect.succeed({ updated: [], failed: {} });

    const patches: Record<string, EmailPatch> = Object.fromEntries(
      triaged.map(({ email, plan }) => [
        email.id,
        emailPatch(plan, sourceMailboxId, email.keywords ?? {}),
      ]),
    );

    return applyPatches(patches).pipe(Effect.provideService(JmapClient, jmap));
  };

  return apply;
});

/**
 * Applies a completed batch against its selected source mailbox.
 */
export const applyPlans = Effect.fn("applyPlans")(function* (
  mailboxes: readonly Folder[],
  sourceMailboxId: string,
  categories: readonly CategoryConfig[],
  triaged: readonly Triaged[],
) {
  const jmap = yield* JmapClient;

  if (jmap.isReadOnly) return yield* new TriageError({ message: "JMAP account is read-only" });

  if (triaged.length === 0) {
    const nothing: ApplyResult = { updated: [], failed: {} };

    return nothing;
  }

  const apply = yield* prepareApplier(mailboxes, sourceMailboxId, categories);

  return yield* apply(triaged);
});
