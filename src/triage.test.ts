import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { CategoryConfig } from "./categories.ts";
import { Jev, type JevResponse } from "./classify.ts";
import type { Scope } from "./domain.ts";
import { JmapClient, type EmailPatch, type Folder } from "./mailbox.ts";
import { fakeJmap, receiptTriaged } from "./test-support.ts";
import { prepareApplier, scopeFilter, triageEmail, validateLimit } from "./triage.ts";

const scope: Scope = { mailboxId: "inbox", limit: 3, filter: "untriaged", since: "any" };

const now = new Date("2026-09-23T12:00:00.000Z");

const receipts: CategoryConfig = {
  id: "receipts",
  name: "Receipts",
  folderId: "folder-receipts",
  description: "Proof of purchase",
  color: "#58b39b",
  allowAction: true,
  allowUrgent: true,
  senderDomains: [],
};

const folders: Folder[] = ["inbox", "folder-receipts"].map((id) => ({
  id,
  name: id,
  totalEmails: 0,
}));

const withJmap =
  (jmap: JmapClient["Service"]) =>
  <A, E>(effect: Effect.Effect<A, E, JmapClient>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(JmapClient, jmap)));

test("prepared mailbox writer applies multiple update groups without folder writes", async () => {
  const updates: Readonly<Record<string, EmailPatch>>[] = [];

  const run = withJmap(
    fakeJmap({
      updateEmails: (patches) => {
        updates.push(patches);

        return Effect.succeed({ updated: Object.keys(patches), failed: {} });
      },
    }),
  );

  const apply = await run(prepareApplier(folders, "inbox", [receipts]));
  const result = (id: string) => receiptTriaged({ id, keywords: {} });
  expect((await Effect.runPromise(apply([result("1")]))).updated).toEqual(["1"]);
  expect((await Effect.runPromise(apply([result("2"), result("3")]))).updated).toEqual(["2", "3"]);
  expect(updates).toHaveLength(2);
  expect(updates[0]?.["1"]).toMatchObject({
    "mailboxIds/inbox": null,
    "mailboxIds/folder-receipts": true,
    "keywords/$triaged": true,
  });
});

test("prepared mailbox writer rejects missing targets, a target used as source, and read-only accounts", async () => {
  const run = withJmap(fakeJmap());
  await expect(run(prepareApplier(folders.slice(0, 1), "inbox", [receipts]))).rejects.toThrow(
    "Folder missing for Receipts",
  );
  await expect(run(prepareApplier(folders, "folder-receipts", [receipts]))).rejects.toThrow(
    "The source folder is a sort target",
  );
  await expect(
    withJmap(fakeJmap({ isReadOnly: true }))(prepareApplier(folders, "inbox", [receipts])),
  ).rejects.toThrow("read-only");
});

test("triage asks Jev once per email and plans from its decoded answers", async () => {
  const requests: string[] = [];

  const answer: JevResponse = {
    answers: {
      category: { choice: "receipts", probabilities: { receipts: 0.9, other: 0.1 } },
      needs_action: { noul: 0.1 },
      urgent: { noul: 0.8 },
    },
    usage: { input_tokens: 30, output_tokens: 2 },
  };

  const jev = Jev.of({
    systemOne: (state, questions) => {
      requests.push(Object.keys(questions).join(","));

      return Effect.succeed(answer);
    },
  });

  const triaged = await Effect.runPromise(
    triageEmail(
      { id: "1", subject: "Your order", from: [{ name: "Shop", email: "orders@shop.example" }] },
      [receipts],
      "Ada",
    ).pipe(Effect.provideService(Jev, jev)),
  );

  expect(requests).toEqual(["category,needs_action,urgent"]);
  expect(triaged.usage).toEqual({ input: 30, output: 2 });
  expect(triaged.plan).toMatchObject({ category: "receipts", flag: "urgent", markSeen: false });
});

describe("validateLimit", () => {
  const validate = (limit: number) => Effect.runPromise(validateLimit(limit));

  test("accepts batch sizes above the former cap", async () => {
    expect(await validate(11)).toBe(11);
    expect(await validate(1000)).toBe(1000);
  });
  test("rejects non-positive, fractional, and non-finite limits", async () => {
    for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(validate(value)).rejects.toThrow("Limit must be a positive integer");
    }
  });
});

describe("scopeFilter", () => {
  test("filters untriaged mail in the selected mailbox", () => {
    expect(scopeFilter(scope, now)).toEqual({ inMailbox: "inbox", notKeyword: "$triaged" });
  });
  test("filters unread mail", () => {
    expect(scopeFilter({ ...scope, filter: "unread", mailboxId: "archive" }, now)).toEqual({
      inMailbox: "archive",
      notKeyword: "$seen",
    });
  });
  test("all mail does not add a keyword condition", () => {
    expect(scopeFilter({ ...scope, filter: "all" }, now)).toEqual({ inMailbox: "inbox" });
  });
  test.each(["24h", "7d", "30d"] as const)("uses an inclusive after date for %s", (since) => {
    const days = { "24h": 1, "7d": 7, "30d": 30 }[since];
    expect(scopeFilter({ ...scope, since }, now).after).toBe(
      new Date(now.getTime() - days * 86_400_000).toISOString(),
    );
  });
});
