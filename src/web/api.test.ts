import { describe, expect, test } from "bun:test";
import { Effect, Layer, type Schema } from "effect";
import type { CategoryDraft } from "../categories.ts";
import { DEFAULT_PRICING, type Usage } from "../domain.ts";
import type { Message } from "../mailbox.ts";
import { receiptTriaged } from "../test-support.ts";
import type { Triaged } from "../triage.ts";
import { Api, Backend, BackendError, toCard } from "./api.ts";
import {
  Batch,
  FolderSummaries,
  readEvents,
  readLoad,
  type FolderSummary,
  type LoadEvent,
  type RunEvent,
} from "./model.ts";

const origin = "http://127.0.0.1:9876";

const token = "test-only-token";

const scope = { mailboxId: "inbox", limit: 100, filter: "untriaged", since: "any" } as const;

const totals = { runs: 1, inputTokens: 12, outputTokens: 4, costUsd: 0, lastRunAt: null };

const emails: Message[] = [0, 1, 2].map((n) => ({
  id: String(n),
  subject: `Synthetic ${n}`,
  preview: "Plain text",
  from: [{ name: "Fixture", email: "fixture@example.test" }],
  keywords: {},
  bodyValues: {
    secret: { value: "BODY NOT FOR BROWSER", isEncodingProblem: false, isTruncated: false },
  },
}));

const triaged = receiptTriaged;

const draft: CategoryDraft = {
  id: "travel",
  name: "Travel",
  folder: { kind: "create", name: "Travel" },
  description: "Flights and hotels",
  color: "#5fb3c4",
  allowAction: false,
  allowUrgent: false,
  senderDomains: ["airline.example"],
};

const applied = (results: readonly Triaged[]) => ({
  updated: results.map((result) => result.email.id),
  failed: {},
});

const failed = (message: string) => Effect.fail(new BackendError({ message, cause: undefined }));

// Waits on a test-controlled promise inside a fake backend step.
const after = <A>(gate: Promise<void>, value: () => A) =>
  Effect.promise(async () => {
    await gate;

    return value();
  });

type Overrides = Partial<Backend["Service"]>;

type Body = Readonly<
  Record<
    string,
    string | number | boolean | null | readonly CategoryDraft[] | readonly { readonly id: string }[]
  >
>;

const boot = (flags: Flags) =>
  Effect.sync(() => ({
    demo: true,
    readOnly: flags.readOnly,
    inboxId: "inbox",
    mailboxes: [{ id: "inbox", name: "Inbox", parentId: null }],
    categories: [{ id: "receipts", name: "Receipts", color: "#58b39b", folderId: "r" }],
    categoriesSaved: flags.categoriesSaved,
    pricing: DEFAULT_PRICING,
    totals,
  }));

function setup(overrides: Overrides = {}, serverOrigin = origin) {
  const flags: Flags = { categoriesSaved: true, readOnly: false };

  const calls: Calls = { fetch: 0, classify: 0, apply: 0, record: [], saved: [] };

  const backend: Backend["Service"] = {
    bootstrap: () => boot(flags),
    folders: () =>
      Effect.succeed([{ id: "inbox", name: "Inbox", parentId: null, total: 3, unclassified: 3 }]),
    categories: () => Effect.succeed({ saved: true, drafts: [draft], detected: 0, expected: 0 }),
    saveCategories: (drafts) =>
      Effect.sync(() => {
        calls.saved.push([...drafts]);
      }),
    fetch: () =>
      Effect.sync(() => {
        calls.fetch++;

        return emails;
      }),
    begin: () => Effect.void,
    classify: (email) =>
      Effect.sync(() => {
        calls.classify++;

        return triaged(email);
      }),
    apply: (results) =>
      Effect.sync(() => {
        calls.apply += results.length;

        return applied(results);
      }),
    record: (usage) =>
      Effect.sync(() => {
        calls.record.push(usage);

        return totals;
      }),
    ...overrides,
  };

  const api = Effect.runSync(
    Effect.provide(
      Api,
      Api.layer(token, () => serverOrigin).pipe(Layer.provide(Layer.succeed(Backend, backend))),
    ),
  );

  const request = (
    path: string,
    body: Body | undefined = undefined,
    headers: Record<string, string> = {},
    signal: AbortSignal | undefined = undefined,
  ) => {
    const sent = new Headers({ host: new URL(serverOrigin).host, "x-jjmap-token": token });

    if (body !== undefined) {
      sent.set("origin", serverOrigin);
      sent.set("content-type", "application/json");
    }

    for (const [name, value] of Object.entries(headers)) sent.set(name, value);

    return Effect.runPromise(
      api.handle(
        new Request(`${serverOrigin}/api/${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: sent,
          body:
            body === undefined
              ? undefined
              : JSON.stringify(path === "run" ? { concurrency: 1, ...body } : body),
          signal,
        }),
      ),
    );
  };

  const preview = async () =>
    readLoad(await request("preview", scope, { accept: "application/x-ndjson" }), Batch, () => {});

  const run = async (batch: Batch) => {
    const response = await request("run", { batchId: batch.id, confirm: true });
    const events: RunEvent[] = [];
    await readEvents(response, (event) => events.push(event));

    return events;
  };

  return { calls, flags, request, preview, run, api };
}

interface Calls {
  fetch: number;
  classify: number;
  apply: number;
  record: Usage[];
  saved: CategoryDraft[][];
}

interface Flags {
  categoriesSaved: boolean;
  readOnly: boolean;
}

describe("web API — synthetic dependencies only", () => {
  test("bootstrap and preview do not classify, write mail, or record spending", async () => {
    const { request, preview, calls } = setup();
    expect((await request("bootstrap")).status).toBe(200);
    const batch = await preview();
    expect(batch.cards).toHaveLength(3);
    expect(JSON.stringify(batch)).not.toContain("BODY NOT FOR BROWSER");
    expect(calls).toEqual({ fetch: 1, classify: 0, apply: 0, record: [], saved: [] });
  });
  test("rejects missing tokens, wrong origins, rebinding hosts, and non-JSON posts", async () => {
    const { request, calls } = setup();
    expect((await request("bootstrap", undefined, { "x-jjmap-token": "" })).status).toBe(401);
    expect((await request("preview", scope, { origin: "https://attacker.example" })).status).toBe(
      403,
    );
    expect((await request("preview", scope, { origin: "" })).status).toBe(403);
    expect((await request("bootstrap", undefined, { host: "attacker.example" })).status).toBe(403);
    expect((await request("preview", scope, { "content-type": "text/plain" })).status).toBe(415);
    expect(calls.fetch).toBe(0);
  });
  test("an explicit Tailscale origin retains token, host, and same-origin protections", async () => {
    const { request, preview, calls } = setup({}, "http://100.64.0.1:9876");
    expect((await request("bootstrap")).status).toBe(200);
    expect((await preview()).cards).toHaveLength(3);
    expect((await request("bootstrap", undefined, { "x-jjmap-token": "" })).status).toBe(401);

    for (const host of ["127.0.0.1:9876", "100.64.0.2:9876", "attacker.example"]) {
      expect((await request("bootstrap", undefined, { host })).status).toBe(403);
    }

    for (const origin of ["", "http://127.0.0.1:9876", "http://100.64.0.2:9876"]) {
      expect((await request("preview", scope, { origin })).status).toBe(403);
    }

    expect(calls).toEqual({ fetch: 1, classify: 0, apply: 0, record: [], saved: [] });
  });
  test("folder overview is authenticated and never prepares or classifies mail", async () => {
    let preparations = 0;

    const { request, calls } = setup({
      begin: () =>
        Effect.sync(() => {
          preparations++;
        }),
    });

    expect((await request("folders", undefined, { "x-jjmap-token": "" })).status).toBe(401);
    expect(await (await request("folders")).json()).toEqual([
      { id: "inbox", name: "Inbox", parentId: null, total: 3, unclassified: 3 },
    ]);
    expect(preparations).toBe(0);
    expect(calls).toEqual({ fetch: 0, classify: 0, apply: 0, record: [], saved: [] });
  });
  test("preparation streams immediate progress and Stop prevents paid work", async () => {
    const gate = Promise.withResolvers<void>();
    const preparing = Promise.withResolvers<void>();
    const { request, preview, calls } = setup({ begin: () => after(gate.promise, () => {}) });
    const batch = await preview();
    const response = await request("run", { batchId: batch.id, confirm: true });
    const events: RunEvent[] = [];

    const reading = readEvents(response, (event) => {
      events.push(event);

      if (event.type === "phase" && event.phase === "preparing") preparing.resolve();
    });

    try {
      await preparing.promise;
      expect(events[0]).toMatchObject({ type: "phase", phase: "preparing" });
      expect(calls.classify).toBe(0);
      await request("stop", {});
    } finally {
      gate.resolve();
      await reading;
    }

    expect(calls.classify).toBe(0);
    expect(calls.apply).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "done", stopped: true });
  });
  test("Stop arriving before Start cancels only that prepared batch", async () => {
    const { preview, request, run, calls } = setup();
    const batch = await preview();
    await request("stop", {});
    expect((await run(batch)).at(-1)).toMatchObject({ type: "done", stopped: true });
    expect(calls.classify).toBe(0);
    expect((await run(await preview())).filter((event) => event.type === "result")).toHaveLength(3);
  });
  test("Stop during the read-only preflight prevents classification", async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const flags: Flags = { categoriesSaved: true, readOnly: false };
    let checks = 0;

    const { preview, request, calls } = setup({
      bootstrap: () =>
        Effect.suspend(() => {
          if (++checks !== 2) return boot(flags);
          entered.resolve();

          return Effect.andThen(
            Effect.promise(() => gate.promise),
            boot(flags),
          );
        }),
    });

    const batch = await preview();
    const starting = request("run", { batchId: batch.id, confirm: true });
    await entered.promise;
    await request("stop", {});
    gate.resolve();
    const events: RunEvent[] = [];
    await readEvents(await starting, (event) => events.push(event));
    expect(events.at(-1)).toMatchObject({ type: "done", stopped: true });
    expect(calls.classify).toBe(0);
  });
  test("startup milestones expose nonnegative ordered timings", async () => {
    const { preview, run } = setup();
    const events = await run(await preview());
    const phases = events.flatMap((event) => (event.type === "phase" ? [event] : []));
    expect(phases.map((event) => event.phase)).toEqual([
      "preparing",
      "classifying",
      "updating",
      "sorting",
    ]);

    for (let index = 0; index < phases.length; index++) {
      expect(phases[index]!.elapsedMs).toBeGreaterThanOrEqual(phases[index - 1]?.elapsedMs ?? 0);
    }
  });
  test("requires explicit confirmation and consumes each prepared batch once", async () => {
    const { preview, request, run, calls } = setup();
    const batch = await preview();
    expect((await request("run", { batchId: batch.id })).status).toBe(400);
    expect((await request("run", { batchId: batch.id, confirm: "yes" })).status).toBe(400);
    expect(calls.classify).toBe(0);
    const events = await run(batch);
    const results = events.flatMap((event) => (event.type === "result" ? [event] : []));
    expect(results).toHaveLength(3);

    // Each result carries its own paid usage so the browser can estimate cost live.
    for (const result of results) expect(result.usage).toEqual({ input: 12, output: 4 });
    expect(calls).toEqual({
      fetch: 1,
      classify: 3,
      apply: 3,
      record: [{ input: 36, output: 12 }],
      saved: [],
    });
    expect((await request("run", { batchId: batch.id, confirm: true })).status).toBe(409);
  });
  test("rejects stale previews and unknown mailbox ids", async () => {
    const { preview, request } = setup();
    const old = await preview();
    await preview();
    expect((await request("run", { batchId: old.id, confirm: true })).status).toBe(409);
    expect((await request("preview", { ...scope, mailboxId: "missing" })).status).toBe(400);
  });
  test("rejects invalid scopes before fetching, naming the invalid field", async () => {
    const { request, calls } = setup();

    for (const limit of [0, -1, 1.5, "100"]) {
      const response = await request("preview", { ...scope, limit });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Email count must be a positive integer" });
    }

    expect((await request("preview", { ...scope, filter: "all" })).status).toBe(400);
    expect((await request("preview", { ...scope, since: "yesterday" })).status).toBe(400);
    expect(calls.fetch).toBe(0);
  });
  test("invalid worker count cannot spend tokens or consume the prepared batch", async () => {
    const { preview, request, calls, run } = setup();
    const batch = await preview();

    for (const concurrency of [0, 9, 1.5, "4", null])
      expect((await request("run", { batchId: batch.id, confirm: true, concurrency })).status).toBe(
        400,
      );
    expect(calls.classify).toBe(0);
    expect((await run(batch)).at(-1)?.type).toBe("done");
  });
  test("read-only accounts cannot start", async () => {
    const { preview, request, calls, flags } = setup();
    const batch = await preview();
    flags.readOnly = true;
    expect((await request("run", { batchId: batch.id, confirm: true })).status).toBe(403);
    expect(calls.classify).toBe(0);
  });
  test("independent classifications are not serialized behind mailbox writes", async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();

    const { request, preview, calls } = setup({
      apply: (results) =>
        Effect.suspend(() => {
          entered.resolve();

          return after(gate.promise, () => applied(results));
        }),
    });

    const batch = await preview();
    const response = await request("run", { batchId: batch.id, confirm: true, concurrency: 4 });
    const consuming = readEvents(response, () => {});
    await entered.promise;

    try {
      expect(calls.classify).toBe(3);
    } finally {
      gate.resolve();
      await consuming;
    }
  });
  test("a slow old preview cannot overwrite the latest scope", async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let fetches = 0;

    const { request, preview, run } = setup({
      fetch: () =>
        Effect.suspend(() => {
          if (++fetches !== 1) return Effect.succeed(emails);
          entered.resolve();

          return after(gate.promise, () => emails);
        }),
    });

    const first = request("preview", scope);
    await entered.promise;
    const latest = await preview();
    gate.resolve();
    expect((await first).status).toBe(409);
    expect((await run(latest)).at(-1)?.type).toBe("done");
  });
  test("no result is emitted before the mailbox update is confirmed", async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();

    const { preview, request } = setup({
      apply: (results) =>
        Effect.suspend(() => {
          entered.resolve();

          return after(gate.promise, () => applied(results));
        }),
    });

    const batch = await preview();
    const response = await request("run", { batchId: batch.id, confirm: true });
    const events: RunEvent[] = [];
    const consuming = readEvents(response, (event) => events.push(event));
    await entered.promise;
    expect(events.some((event) => event.type === "result")).toBe(false);
    gate.resolve();
    await consuming;
    expect(events.filter((event) => event.type === "result")).toHaveLength(3);
  });
  test("category saves are guarded, validated, and invalidate the prepared batch", async () => {
    const { request, preview, calls } = setup();
    expect(await (await request("categories")).json()).toMatchObject({ saved: true });
    expect(
      (await request("categories", { categories: [draft] }, { origin: "https://attacker.example" }))
        .status,
    ).toBe(403);
    expect((await request("categories", { categories: [{ id: "x" }] })).status).toBe(400);
    const batch = await preview();
    expect((await request("categories", { categories: [draft] })).status).toBe(200);
    expect(calls.saved).toEqual([[draft]]);
    expect((await request("run", { batchId: batch.id, confirm: true })).status).toBe(409);
  });
  test("previews require saved categories", async () => {
    const { request, flags } = setup();
    flags.categoriesSaved = false;
    expect((await request("preview", scope)).status).toBe(409);
  });
  test("concurrent starts and previews are locked; Stop finishes only the current email", async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();

    const { preview, request, calls } = setup({
      classify: (email) =>
        Effect.suspend(() => {
          entered.resolve();
          calls.classify++;

          return after(gate.promise, () => triaged(email));
        }),
    });

    const batch = await preview();
    const response = await request("run", { batchId: batch.id, confirm: true });
    await entered.promise;
    expect((await request("run", { batchId: batch.id, confirm: true })).status).toBe(409);
    expect((await request("preview", scope)).status).toBe(409);
    expect((await request("categories", { categories: [draft] })).status).toBe(409);
    expect((await request("stop", {})).status).toBe(200);
    gate.resolve();
    const events: RunEvent[] = [];
    await readEvents(response, (event) => events.push(event));
    expect(calls.apply).toBe(1);
    expect(calls.record).toEqual([{ input: 12, output: 4 }]);
    expect(events.at(-1)).toMatchObject({ type: "done", stopped: true });
  });
  test("disconnect finishes the current paid email and accounts for it, without continuing", async () => {
    const gate = Promise.withResolvers<void>();
    const recorded = Promise.withResolvers<void>();

    const { preview, request, calls } = setup({
      classify: (email) => after(gate.promise, () => triaged(email)),
      record: () =>
        Effect.sync(() => {
          recorded.resolve();

          return totals;
        }),
    });

    const batch = await preview();
    const response = await request("run", { batchId: batch.id, confirm: true });
    await response.body!.cancel();
    gate.resolve();
    await recorded.promise;
    expect(calls.apply).toBe(1);
  });
  test("an aborted request stops scheduling like a disconnect", async () => {
    const gate = Promise.withResolvers<void>();
    const recorded = Promise.withResolvers<void>();
    const controller = new AbortController();

    const { preview, request, calls } = setup({
      classify: (email) => after(gate.promise, () => triaged(email)),
      record: () =>
        Effect.sync(() => {
          recorded.resolve();

          return totals;
        }),
    });

    const batch = await preview();
    await request("run", { batchId: batch.id, confirm: true }, {}, controller.signal);
    controller.abort();
    gate.resolve();
    await recorded.promise;
    expect(calls.apply).toBe(1);
  });
  test("graceful shutdown waits for the current email and prevents new work", async () => {
    const gate = Promise.withResolvers<void>();

    const { preview, request, api, calls } = setup({
      classify: (email) => after(gate.promise, () => triaged(email)),
    });

    const batch = await preview();
    const response = await request("run", { batchId: batch.id, confirm: true });
    const shutdown = Effect.runPromise(api.shutdown);
    expect((await request("preview", scope)).status).toBe(503);
    gate.resolve();
    await shutdown;
    await readEvents(response, () => {});
    expect(calls.apply).toBe(1);
    expect(calls.record).toEqual([{ input: 12, output: 4 }]);
  });
  test("failed updates never count as successes and are not retried; paid usage is retained", async () => {
    const { preview, run, calls } = setup({
      classify: (email) =>
        Effect.sync(() => {
          calls.classify++;

          return triaged(email);
        }),
      apply: () => failed("Unconfirmed update"),
    });

    const events = await run(await preview());
    const results = events.filter((event) => event.type === "result");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ outcome: { applied: false, error: "Unconfirmed update" } });
    expect(calls.classify).toBe(1);
    expect(calls.record).toEqual([{ input: 12, output: 4 }]);
  });
  test("classification failure preserves prior successes and their usage", async () => {
    const { preview, run, calls } = setup({
      classify: (email) =>
        email.id === "1" ? failed("Synthetic failure") : Effect.succeed(triaged(email)),
    });

    const events = await run(await preview());
    expect(events).toContainEqual({ type: "error", message: "Synthetic failure" });
    expect(calls.apply).toBe(1);
    expect(calls.record).toEqual([{ input: 12, output: 4 }]);
  });
  test("preparation failures end the run with their safe message and spend nothing", async () => {
    const { preview, run, calls } = setup({ begin: () => failed("Could not prepare folders") });
    const events = await run(await preview());
    expect(events).toContainEqual({ type: "error", message: "Could not prepare folders" });
    expect(events.at(-1)).toMatchObject({ type: "done", stopped: false });
    expect(calls.classify).toBe(0);
    expect(calls.record).toEqual([]);
  });
  test("accounting failure still terminates the stream and releases the writer", async () => {
    const { preview, run } = setup({ record: () => failed("disk full") });
    const events = await run(await preview());
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some((event) => event.type === "error")).toBe(true);
    expect((await preview()).cards).toHaveLength(3);
  });
  test("empty batches do not call classifier, mail writer, or usage recorder", async () => {
    const { preview, run, calls } = setup({ fetch: () => Effect.succeed([]) });
    const events = await run(await preview());
    expect(events).toHaveLength(1);
    expect(calls.apply).toBe(0);
    expect(calls.classify).toBe(0);
    expect(calls.record).toHaveLength(0);
  });
});

test("card projection excludes full bodies and treats HTML as plain text", () => {
  const card = toCard({
    ...emails[0]!,
    subject: "<script>never execute</script>",
    preview: "x".repeat(1000),
  });

  expect(Object.keys(card).sort()).toEqual(["from", "id", "preview", "receivedAt", "subject"]);
  expect(card.preview.length).toBe(220);
  expect(card.subject).toBe("<script>never execute</script>");
});

describe("streamed loads", () => {
  const stream = { accept: "application/x-ndjson" };

  const collect = async <T, E>(response: Response, schema: Schema.Codec<T, E>) => {
    const events: LoadEvent<T>[] = [];
    const data = await readLoad(response, schema, (event) => events.push(event));

    return { data, events };
  };

  test("folders stream each settled folder before the result; JSON stays unchanged", async () => {
    const inbox: FolderSummary = {
      id: "inbox",
      name: "Inbox",
      parentId: null,
      total: 3,
      unclassified: 3,
    };

    const { request } = setup({
      folders: (report) =>
        Effect.gen(function* () {
          yield* report.stage("list", null, null);
          yield* report.stage("count", 0, 1);
          yield* report.folder(inbox);
          yield* report.stage("count", 1, 1);

          return [inbox];
        }),
    });

    const response = await request("folders", undefined, stream);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const { data, events } = await collect(response, FolderSummaries);
    expect(data).toEqual([inbox]);
    expect(events).toEqual([
      { type: "stage", stage: "list", done: null, total: null },
      { type: "stage", stage: "count", done: 0, total: 1 },
      { type: "folder", folder: inbox },
      { type: "stage", stage: "count", done: 1, total: 1 },
    ]);
    expect(await (await request("folders")).json()).toEqual([inbox]);
  });

  test("preview streams check, search, and read progress, then a usable batch", async () => {
    const { request, run } = setup({
      fetch: (_scope, report) =>
        Effect.gen(function* () {
          yield* report.stage("search", null, null);
          yield* report.stage("read", 3, 3);

          return emails;
        }),
    });

    const { data, events } = await collect(await request("preview", scope, stream), Batch);
    expect(events.map((event) => (event.type === "stage" ? event.stage : event.type))).toEqual([
      "check",
      "search",
      "read",
    ]);
    expect(data.cards).toHaveLength(3);
    expect((await run(data)).at(-1)?.type).toBe("done");
  });

  test("known failures keep their message; unknown ones stay sanitized", async () => {
    let failure: Effect.Effect<readonly Message[], BackendError> = Effect.succeed(emails);
    const { request, flags } = setup({ fetch: () => failure });
    flags.categoriesSaved = false;
    await expect(collect(await request("preview", scope, stream), Batch)).rejects.toThrow(
      "Set up categories first",
    );
    flags.categoriesSaved = true;
    failure = failed("provider said: secret@example.com");

    const rejected = collect(await request("preview", scope, stream), Batch);
    await expect(rejected).rejects.toThrow("Unable to load mail");
    await expect(rejected).rejects.not.toThrow("secret");
    expect((await request("preview", scope)).status).toBe(400);
    failure = Effect.die(new Error("provider said: secret@example.com"));
    const died = await request("preview", scope);
    expect(await died.json()).toEqual({ error: expect.stringContaining("Unable to load mail") });
  });

  test("a stale streamed preview ends in an error event, not a batch", async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let fetches = 0;

    const { request, preview } = setup({
      fetch: () =>
        Effect.suspend(() => {
          if (++fetches !== 1) return Effect.succeed(emails);
          entered.resolve();

          return after(gate.promise, () => emails);
        }),
    });

    const first = request("preview", scope, stream);
    await entered.promise;
    await preview();
    gate.resolve();
    await expect(collect(await first, Batch)).rejects.toThrow(
      "A newer preview replaced this request",
    );
  });

  test("leaving a streamed load interrupts its remaining reads", async () => {
    const started = Promise.withResolvers<void>();
    let finished = false;

    const { request } = setup({
      folders: (report) =>
        Effect.gen(function* () {
          yield* report.stage("list", null, null);
          started.resolve();
          yield* Effect.sleep("1 minute");
          finished = true;

          return [];
        }),
    });

    const response = await request("folders", undefined, stream);
    const reader = response.body!.getReader();
    await reader.read();
    await started.promise;
    await reader.cancel();
    await Bun.sleep(5);
    expect(finished).toBe(false);
  });
});
