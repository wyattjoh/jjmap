import type { NoulQuestion } from "@typesafe-ai/sdk";
import { Schema } from "effect";

/**
 * Invisible marker keyword so reruns skip already-processed mail.
 */
export const TRIAGED_KEYWORD = "$triaged";

/**
 * Signals the triage surfaces as a colored flag, highest priority first.
 */
export const Flag = Schema.Literals(["urgent", "action", "review"]);

/**
 * One of the triage signals in {@link Flag}.
 */
export type Flag = typeof Flag.Type;

/**
 * Color flag per signal, encoded as `$flagged` plus `$MailFlagBit0-2`
 * (the Apple Mail scheme Fastmail follows): red 000, orange 100, yellow 010,
 * green 110, blue 001, purple 101, gray 011.
 */
export const FLAG_COLORS: Record<
  Flag,
  {
    readonly name: string;
    readonly bits: readonly [boolean, boolean, boolean];
    /**
     * Keyword Fastmail shows as a label alongside the color, if any.
     */
    readonly label: string | undefined;
  }
> = {
  urgent: { name: "red", bits: [false, false, false], label: "$urgent" },
  action: { name: "orange", bits: [true, false, false], label: undefined },
  review: { name: "gray", bits: [false, true, true], label: undefined },
};

/**
 * Probability and runner-up gap required before acting on a judgment.
 */
export const THRESHOLDS = {
  minProbability: 0.7,
  minGap: 0.15,
  flag: 0.7,
} as const;

/**
 * Default number of emails to browse or classify in one request.
 */
export const DEFAULT_LIMIT = 10;

const needsAction = {
  type: "noul",
  instructions:
    "Does `recipient` personally need to reply to `email` or complete a specific task it asks of them (schedule, pay, sign, provide information)? Marketing calls to action, routine verification codes, and informational notices do not count.",
} as const satisfies NoulQuestion;

const urgent = {
  type: "noul",
  instructions:
    "Does `email` need the attention of `recipient` within 24 hours? Yes when someone is blocked on them, a real deadline is within a day, a system they run is currently down, or there is a genuine unexpected security event on their account. Recoveries, routine sign-ins they likely made themselves, and marketing deadlines are no.",
} as const satisfies NoulQuestion;

/**
 * Flag questions sent to Jev alongside the configured category question.
 */
export const FLAG_QUESTIONS = { needs_action: needsAction, urgent } as const;
