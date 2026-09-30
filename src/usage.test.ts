import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect } from "effect";
import { costOf, DEFAULT_PRICING } from "./domain.ts";
import { loadConfig, loadState, Paths, recordRun } from "./usage.ts";

const dir = await mkdtemp(join(tmpdir(), "jjmap-usage-"));

afterAll(async () => {
  await rm(dir, { recursive: true });
});

const env = { HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state") };

const resolve = (variables: Record<string, string>) =>
  Effect.runPromise(
    Effect.provide(Paths, Paths.layer).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: variables }),
      ),
    ),
  );

const location = await resolve(env);

const at =
  (overrides: Partial<Paths["Service"]>) =>
  <A, E>(effect: Effect.Effect<A, E, Paths>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(Paths, { ...location, ...overrides })));

const here = at({});

describe("usage persistence", () => {
  test("resolves XDG locations and handles missing files", async () => {
    expect(location.config).toBe(join(dir, "config", "jjmap", "config.json"));
    expect(location.state).toBe(join(dir, "state", "jjmap", "state.json"));
    expect(await here(loadConfig())).toEqual({ pricing: DEFAULT_PRICING, name: undefined });
    expect(await here(loadState())).toMatchObject({ runs: 0, inputTokens: 0, costUsd: 0 });
  });
  test("falls back to HOME when XDG variables are unset", async () => {
    const fallback = await resolve({ HOME: dir, XDG_CONFIG_HOME: "" });

    expect(fallback.config).toBe(join(dir, ".config", "jjmap", "config.json"));
    expect(fallback.state).toBe(join(dir, ".local", "state", "jjmap", "state.json"));
  });
  test("uses Jev list rates by default and lets configured rates override them", async () => {
    expect(DEFAULT_PRICING).toEqual({ inputPerMTok: 0.042, outputPerMTok: 0 });
    const config = join(dir, "configured.json");
    await Bun.write(config, JSON.stringify({ pricing: { inputPerMTok: 1, outputPerMTok: 2 } }));
    expect(await at({ config })(loadConfig())).toEqual({
      pricing: { inputPerMTok: 1, outputPerMTok: 2 },
      name: undefined,
    });
    await Bun.write(config, JSON.stringify({ pricing: { inputPerMTok: -1, outputPerMTok: 2 } }));
    await expect(at({ config })(loadConfig())).rejects.toThrow(`Invalid pricing in ${config}`);
  });
  test("reads an optional mailbox owner name", async () => {
    const config = join(dir, "named.json");
    await Bun.write(config, JSON.stringify({ name: "  Ada Lovelace " }));
    expect(await at({ config })(loadConfig())).toEqual({
      pricing: DEFAULT_PRICING,
      name: "Ada Lovelace",
    });
    await Bun.write(config, JSON.stringify({ name: "" }));
    expect((await at({ config })(loadConfig())).name).toBeUndefined();
    await Bun.write(config, JSON.stringify({ name: 42 }));
    await expect(at({ config })(loadConfig())).rejects.toThrow("Invalid name");
  });
  test("rejects corrupt state instead of trusting it", async () => {
    const state = join(dir, "corrupt.json");
    await Bun.write(state, JSON.stringify({ runs: "many" }));
    await expect(at({ state })(loadState())).rejects.toThrow(`Invalid runs in ${state}`);
  });
  test("prices input and output separately, or leaves cost unknown", () => {
    expect(costOf({ input: 1000, output: 2000 }, { inputPerMTok: 1, outputPerMTok: 3 })).toBe(
      0.007,
    );
    expect(costOf({ input: 1, output: 1 }, undefined)).toBeUndefined();
  });
  test("adds runs and tokens across atomic writes", async () => {
    const pricing = { inputPerMTok: 1, outputPerMTok: 3 };
    expect(await here(recordRun({ input: 1000, output: 2000 }, pricing))).toMatchObject({
      runs: 1,
      inputTokens: 1000,
      outputTokens: 2000,
      costUsd: 0.007,
    });
    expect(await here(recordRun({ input: 2000, output: 1000 }, pricing))).toMatchObject({
      runs: 2,
      inputTokens: 3000,
      outputTokens: 3000,
      costUsd: 0.012,
    });
    expect(await here(loadState())).toMatchObject({ runs: 2, costUsd: 0.012 });
  });
  test("does not invent a total when any run was unpriced", async () => {
    const state = join(dir, "other.json");
    await Bun.write(
      state,
      JSON.stringify({ runs: 1, inputTokens: 1, outputTokens: 2, costUsd: null, lastRunAt: null }),
    );
    expect(
      (
        await at({ state })(
          recordRun({ input: 1, output: 2 }, { inputPerMTok: 1, outputPerMTok: 1 }),
        )
      ).costUsd,
    ).toBeNull();
  });
});
