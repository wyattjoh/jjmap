import { Schema } from "effect";
import { OTHER, type CategoryConfig } from "./categories.ts";
import { Flag, THRESHOLDS } from "./config.ts";

/**
 * Jev's raw judgments for one email.
 */
export const Judgments = Schema.Struct({
  category: Schema.Struct({
    choice: Schema.String,
    probabilities: Schema.Record(Schema.String, Schema.Finite),
  }),
  needsAction: Schema.Finite,
  urgent: Schema.Finite,
});

/**
 * Jev's raw judgments for one email.
 */
export type Judgments = typeof Judgments.Type;

/**
 * What the triage will do to one email.
 */
export const Plan = Schema.Struct({
  /**
   * The applied category id, or `null` when routed to review.
   */
  category: Schema.NullOr(Schema.String),
  /**
   * Destination mailbox id, or `null` to stay put.
   */
  folderId: Schema.NullOr(Schema.String),
  /**
   * Color flag to set, or `null` for none.
   */
  flag: Schema.NullOr(Flag),
  markSeen: Schema.Boolean,
  reason: Schema.String,
});

/**
 * What the triage will do to one email.
 */
export type Plan = typeof Plan.Type;

/**
 * Whether the top choice clears the probability and runner-up gap thresholds.
 */
export function isConfident(probabilities: Readonly<Record<string, number>>): boolean {
  const [top = 0, second = 0] = Object.values(probabilities).toSorted((a, b) => b - a);

  return top >= THRESHOLDS.minProbability && top - second >= THRESHOLDS.minGap;
}

/**
 * Turns judgments (and any sender rule) into a deterministic plan.
 */
export function decide(
  judgments: Judgments,
  forced: CategoryConfig | undefined,
  categories: readonly CategoryConfig[],
): Plan {
  const choice = judgments.category.choice;
  const p = (judgments.category.probabilities[choice] ?? 0).toFixed(2);
  const category = forced ?? categories.find(({ id }) => id === choice);

  if (!category || (!forced && !isConfident(judgments.category.probabilities))) {
    return {
      category: null,
      folderId: null,
      flag: "review",
      markSeen: false,
      reason:
        choice === OTHER
          ? `other (${p})`
          : category
            ? `low confidence ${choice} (${p})`
            : `unknown ${choice} (${p})`,
    };
  }

  const action = category.allowAction && judgments.needsAction >= THRESHOLDS.flag;
  const urgent = category.allowUrgent && judgments.urgent >= THRESHOLDS.flag;
  const { folderId } = category;

  return {
    category: category.id,
    folderId,
    flag: urgent ? "urgent" : action ? "action" : null,
    markSeen: folderId !== null && !action && !urgent,
    reason: forced ? `sender rule → ${category.id}` : `${category.id} (${p})`,
  };
}
