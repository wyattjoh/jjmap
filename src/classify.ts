import { TypeSafeClient, type JsonValue, type Questions } from "@typesafe-ai/sdk";
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";
import { buildQuestion, type CategoryConfig } from "./categories.ts";
import { FLAG_QUESTIONS } from "./config.ts";
import type { Usage } from "./domain.ts";
import { emailHeaders, type Message } from "./mailbox.ts";
import type { Judgments } from "./plan.ts";

const BODY_LIMIT = 3000;

/**
 * Names the mailbox owner in prompts when no name is configured.
 */
export const DEFAULT_RECIPIENT = "the mailbox owner";

/**
 * TypeSafe could not be configured or did not answer usably. The message is
 * safe to show; SDK details stay in `cause`.
 */
export class JevError extends Schema.TaggedError<JevError>()("JevError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * The part of a TypeSafe `systemOne` response jjmap relies on, decoded from the SDK.
 */
export const JevResponse = Schema.Struct({
  answers: Schema.Struct({
    category: Schema.Struct({
      choice: Schema.String,
      probabilities: Schema.Record(Schema.String, Schema.Finite),
    }),
    needs_action: Schema.Struct({ noul: Schema.Finite }),
    urgent: Schema.Struct({ noul: Schema.Finite }),
  }),
  usage: Schema.Struct({ input_tokens: Schema.Finite, output_tokens: Schema.Finite }),
});

/**
 * The part of a TypeSafe `systemOne` response jjmap relies on.
 */
export type JevResponse = typeof JevResponse.Type;

/**
 * TypeSafe Jev. Tests provide synthetic answers; `fromClient` wraps the SDK,
 * keeping its rate-limit backoff and retries.
 */
export class Jev extends Context.Service<
  Jev,
  {
    readonly systemOne: (
      state: Record<string, JsonValue>,
      questions: Questions,
    ) => Effect.Effect<JevResponse, JevError>;
  }
>()("jjmap/classify/Jev") {
  /**
   * Answers through an SDK client, decoding each response before use.
   */
  static fromClient(client: TypeSafeClient): Jev["Service"] {
    return Jev.of({
      systemOne: (state, questions) =>
        Effect.tryPromise({
          try: (signal) => client.systemOne({ state, questions }, { signal }),
          catch: (cause) => new JevError({ message: "Jev request failed", cause }),
        }).pipe(
          Effect.flatMap((response) =>
            Schema.decodeUnknownEffect(JevResponse)(response).pipe(
              Effect.mapError(
                (cause) => new JevError({ message: "Jev returned an unexpected answer", cause }),
              ),
            ),
          ),
        ),
    });
  }

  /**
   * Creates an SDK client from `TYPESAFE_API_KEY`.
   */
  static readonly connect = Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("TYPESAFE_API_KEY");

    const client = yield* Effect.try({
      try: () => new TypeSafeClient({ apiKey: Redacted.value(apiKey) }),
      catch: (cause) => new JevError({ message: "Could not configure TypeSafe", cause }),
    });

    return Jev.fromClient(client);
  });

  /**
   * Configures the SDK once from environment configuration.
   */
  static readonly layer = Layer.effect(Jev, Jev.connect);
}

/**
 * Builds the Jev state for one email: headers that signal bulk mail plus a trimmed body.
 */
export function emailState(email: Message, recipient: string | undefined = undefined) {
  const text = email.textBody
    ?.flatMap((part) => {
      const value = part.partId ? email.bodyValues?.[part.partId]?.value : undefined;

      return value ? [value] : [];
    })
    .join("\n");

  const body = (text || email.preview || "").replace(/\n{3,}/g, "\n\n").trim();

  const addresses = (list: typeof email.from) =>
    (list ?? []).map((a) => (a.name ? `${a.name} <${a.email}>` : a.email));

  const { listId, hasListUnsubscribe } = emailHeaders(email);

  return {
    recipient: recipient ?? DEFAULT_RECIPIENT,
    email: {
      from: addresses(email.from),
      to: addresses(email.to),
      cc: addresses(email.cc),
      subject: email.subject ?? "",
      received_at: email.receivedAt ?? "",
      list_id: listId,
      has_list_unsubscribe: hasListUnsubscribe,
      body: body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT)}…` : body,
    },
  };
}

/**
 * Jev's judgments for one email and the tokens they cost.
 */
export interface Classification {
  readonly judgments: Judgments;
  readonly usage: Usage;
}

/**
 * Asks Jev all triage questions about one email in a single request.
 */
export const classify = Effect.fn("classify")(function* (
  email: Message,
  categories: readonly CategoryConfig[],
  recipient: string | undefined,
) {
  const jev = yield* Jev;

  const { answers, usage } = yield* jev.systemOne(emailState(email, recipient), {
    category: buildQuestion(categories),
    ...FLAG_QUESTIONS,
  });

  const classification: Classification = {
    judgments: {
      category: answers.category,
      needsAction: answers.needs_action.noul,
      urgent: answers.urgent.noul,
    },
    usage: { input: usage.input_tokens, output: usage.output_tokens },
  };

  return classification;
});
