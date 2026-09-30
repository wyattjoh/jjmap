import { Schema } from "effect";

/**
 * Browser-safe schemas shared by the server, terminal, and browser. This module
 * must stay free of filesystem, mail, and credential imports.
 */

const TokenCount = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Jev token usage split by billing direction.
 */
export const Usage = Schema.Struct({ input: TokenCount, output: TokenCount });

/**
 * Jev token usage split by billing direction.
 */
export type Usage = typeof Usage.Type;

/**
 * Dollar prices per million tokens.
 */
export const Pricing = Schema.Struct({ inputPerMTok: TokenCount, outputPerMTok: TokenCount });

/**
 * Dollar prices per million tokens, when configured.
 */
export type Pricing = typeof Pricing.Type;

/**
 * TypeSafe Jev early-access list price; overrides in config take precedence.
 * https://typesafe.ai/blog/introducing-system-one-models-and-jev
 */
export const DEFAULT_PRICING: Pricing = { inputPerMTok: 0.042, outputPerMTok: 0 };

/**
 * Persisted totals across completed classification runs (`state.json`).
 */
export const UsageState = Schema.Struct({
  runs: TokenCount,
  inputTokens: TokenCount,
  outputTokens: TokenCount,
  costUsd: Schema.NullOr(Schema.Finite),
  lastRunAt: Schema.NullOr(Schema.String),
});

/**
 * Persisted totals across completed classification runs.
 */
export type UsageState = typeof UsageState.Type;

/**
 * Zero totals before the first recorded run.
 */
export const EMPTY_USAGE_STATE: UsageState = {
  runs: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  lastRunAt: null,
};

/**
 * Computes dollar cost when a rate is available.
 */
export function costOf(usage: Usage, pricing: Pricing | undefined): number | undefined {
  if (!pricing) return undefined;

  return (usage.input * pricing.inputPerMTok + usage.output * pricing.outputPerMTok) / 1_000_000;
}

/**
 * Which mail a scope selects within its mailbox.
 */
export const ScopeFilter = Schema.Literals(["untriaged", "unread", "all"]);

/**
 * How far back a scope reaches.
 */
export const ScopeSince = Schema.Literals(["24h", "7d", "30d", "any"]);

/**
 * Settings for one bounded email query.
 */
export const Scope = Schema.Struct({
  mailboxId: Schema.String,
  limit: Schema.Number,
  filter: ScopeFilter,
  since: ScopeSince,
});

/**
 * Settings for one bounded email query.
 */
export type Scope = typeof Scope.Type;
