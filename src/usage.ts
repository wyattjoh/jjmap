import { join } from "node:path";
import { Config, Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import {
  costOf,
  DEFAULT_PRICING,
  EMPTY_USAGE_STATE,
  Pricing,
  UsageState,
  type Usage,
} from "./domain.ts";
import { readJsonFile, writeJsonFile } from "./json-file.ts";

/**
 * Where jjmap keeps its settings, categories, and usage totals.
 */
export class Paths extends Context.Service<
  Paths,
  { readonly config: string; readonly categories: string; readonly state: string }
>()("jjmap/usage/Paths") {
  /**
   * Resolves locations from `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `HOME`.
   */
  static readonly layer = Layer.effect(
    Paths,
    Effect.gen(function* () {
      const home = yield* Config.String("HOME").pipe(Config.withDefault(""));

      const configHome = yield* Config.String("XDG_CONFIG_HOME").pipe(
        Config.withDefault(join(home, ".config")),
      );

      const stateHome = yield* Config.String("XDG_STATE_HOME").pipe(
        Config.withDefault(join(home, ".local", "state")),
      );

      return Paths.of({
        config: join(configHome, "jjmap", "config.json"),
        categories: join(configHome, "jjmap", "categories.json"),
        state: join(stateHome, "jjmap", "state.json"),
      });
    }),
  );
}

/**
 * The `config.json` document; unknown keys are ignored.
 */
const SettingsFile = Schema.Struct({
  /**
   * Mailbox owner's name, given to Jev so it can tell mail addressed to them.
   */
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  pricing: Schema.optionalKey(Schema.NullOr(Pricing)),
});

/**
 * User settings from `config.json`.
 */
export type Settings = {
  readonly pricing: Pricing;
  /**
   * Mailbox owner's name, given to Jev so it can tell mail addressed to them.
   */
  readonly name: string | undefined;
};

/**
 * Loads configured rates and name, falling back to Jev's published early-access list price.
 */
export const loadConfig = Effect.fn("loadConfig")(function* () {
  const { config } = yield* Paths;
  const file = yield* readJsonFile(config, SettingsFile, "config");

  return Option.match(file, {
    onNone: (): Settings => ({ pricing: DEFAULT_PRICING, name: undefined }),
    onSome: ({ name, pricing }): Settings => ({
      pricing: pricing ?? DEFAULT_PRICING,
      name: name?.trim() || undefined,
    }),
  });
});

/**
 * Loads persisted usage totals, or zero totals before the first run.
 */
export const loadState = Effect.fn("loadState")(function* () {
  const { state } = yield* Paths;
  const file = yield* readJsonFile(state, UsageState, "state");

  return Option.getOrElse(file, () => EMPTY_USAGE_STATE);
});

/**
 * Atomically records a completed classification run and returns updated totals.
 */
export const recordRun = Effect.fn("recordRun")(function* (
  usage: Usage,
  pricing: Pricing | undefined,
) {
  const { state: path } = yield* Paths;
  const previous = yield* loadState();
  const cost = costOf(usage, pricing);
  const now = yield* DateTime.now;

  const state: UsageState = {
    runs: previous.runs + 1,
    inputTokens: previous.inputTokens + usage.input,
    outputTokens: previous.outputTokens + usage.output,
    costUsd: previous.costUsd === null || cost === undefined ? null : previous.costUsd + cost,
    lastRunAt: DateTime.formatIso(now),
  };

  yield* writeJsonFile(path, UsageState, state);

  return state;
});
