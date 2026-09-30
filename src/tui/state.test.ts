import { expect, test } from "bun:test";
import type { Folder, Message } from "../mailbox.ts";
import type { CategoryConfig } from "../categories.ts";
import type { Triaged } from "../triage.ts";
import { initialState, nextBatchIds, reducer, sidebarEntries, visibleRows } from "./state.ts";

const mailbox = (id: string, name: string, role: Folder["role"], totalEmails = 2): Folder => ({
  id,
  name,
  role,
  totalEmails,
});

const mailboxes = [
  mailbox("archive", "Archive", "archive"),
  mailbox("inbox", "Inbox", "inbox"),
  mailbox("promos", "Promotions", null),
];

const categories: CategoryConfig[] = [
  {
    id: "promotions",
    name: "Promotions",
    folderId: "promos",
    description: "Marketing",
    color: "#ce806c",
    allowAction: false,
    allowUrgent: false,
    senderDomains: [],
  },
];

const totals = { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, lastRunAt: null };

const email = { id: "one", subject: "Hello" } satisfies Message;

const result = {
  email,
  from: "a@example.com",
  subject: "Hello",
  plan: {
    category: "promotions",
    folderId: "promos",
    flag: "review",
    markSeen: true,
    reason: "promotions",
  },
  judgments: {
    category: { choice: "promotions", probabilities: { promotions: 0.9 } },
    needsAction: 0,
    urgent: 0,
  },
  usage: { input: 10, output: 5 },
} satisfies Triaged;

test("browsing a folder updates the scope and focus cycles", () => {
  const start = initialState(mailboxes, "inbox", totals, categories);
  expect(
    sidebarEntries(start)
      .slice(0, 2)
      .map((entry) => entry.label),
  ).toEqual(["Inbox", "Archive"]);
  const loading = reducer(start, { type: "browseStart", mailboxId: "archive" });
  expect(loading.scope.mailboxId).toBe("archive");
  expect(loading.browseLoading).toBe(true);

  const browse = reducer(loading, {
    type: "browsePage",
    append: false,
    page: { emails: [email], nextPosition: 1, hasMore: true },
  });

  expect(browse.browseEmails).toHaveLength(1);
  expect(browse.browseCursor).toBe(1);
  expect(browse.browseLoading).toBe(false);
  expect(reducer(browse, { type: "focus" }).focus).toBe("list");
  expect(reducer(browse, { type: "focusTarget", target: "form" }).focus).toBe("form");
});

test("browse filter changes independently of batch scope and survives folder changes", () => {
  const start = initialState(mailboxes, "inbox", totals, categories);
  expect(start.browseFilter).toBe("all");
  const filtered = reducer(start, { type: "browseFilter", filter: "untriaged" });
  expect(filtered.scope).toEqual(start.scope);
  expect(reducer(filtered, { type: "browseStart", mailboxId: "archive" }).browseFilter).toBe(
    "untriaged",
  );
});

test("review transitions keep the batch source selected even after a destination was selected", () => {
  const archive = reducer(initialState(mailboxes, "inbox", totals, categories), {
    type: "browseStart",
    mailboxId: "archive",
  });

  expect(sidebarEntries(archive)[archive.sidebarIndex]?.id).toBe("archive");

  const planned = reducer(reducer(archive, { type: "start", batch: [email] }), {
    type: "planned",
    totals,
  });

  expect(sidebarEntries(planned)[planned.sidebarIndex]?.id).toBe("archive");

  const destination = reducer(planned, {
    type: "sidebar",
    index: sidebarEntries(planned).findIndex((entry) => entry.section === "destination"),
  });

  const rerun = reducer(destination, { type: "start", batch: [email] });
  expect(sidebarEntries(rerun)[rerun.sidebarIndex]?.id).toBe("archive");
  const back = reducer(planned, { type: "back" });
  expect(sidebarEntries(back)[back.sidebarIndex]?.id).toBe("archive");
});

test("pages append without duplicates and retain the query cursor", () => {
  const start = reducer(initialState(mailboxes, "inbox", totals, categories), {
    type: "browseStart",
    mailboxId: "inbox",
  });

  const first = reducer(start, {
    type: "browsePage",
    append: false,
    page: { emails: [email], nextPosition: 1, hasMore: true },
  });

  const second = reducer(first, {
    type: "browsePage",
    append: true,
    page: { emails: [email, { id: "two" } satisfies Message], nextPosition: 3, hasMore: false },
  });

  expect(second.browseEmails.map((item) => item.id)).toEqual(["one", "two"]);
  expect(second.browseCursor).toBe(3);
  expect(second.browseHasMore).toBe(false);
});

test("highlights only loaded emails eligible for the next batch", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");

  const mail = (id: string, keywords: Record<string, boolean>, receivedAt: string) =>
    ({ id, keywords, receivedAt }) satisfies Message;

  const emails = [
    mail("draft", { $draft: true }, "2026-09-23T11:00:00.000Z"),
    mail("triaged", { $triaged: true }, "2026-09-23T10:00:00.000Z"),
    mail("old", {}, "2026-09-10T10:00:00.000Z"),
    mail("one", {}, "2026-09-23T09:00:00.000Z"),
    mail("two", {}, "2026-09-23T08:00:00.000Z"),
    mail("three", {}, "2026-09-23T07:00:00.000Z"),
  ];

  const start = reducer(initialState(mailboxes, "inbox", totals, categories), {
    type: "browseStart",
    mailboxId: "inbox",
  });

  const browse = reducer(start, {
    type: "browsePage",
    append: false,
    page: { emails, nextPosition: 6, hasMore: false },
  });

  const scoped = reducer(browse, {
    type: "scope",
    scope: { ...browse.scope, limit: 2, since: "7d" },
  });

  expect([...nextBatchIds(scoped, now)]).toEqual(["one", "two"]);
});

test("classification results become destination counts and filters", () => {
  const start = initialState(mailboxes, "inbox", totals, categories);
  const pending = reducer(start, { type: "start", batch: [email] });
  expect(pending.mode).toBe("classifying");
  const partial = reducer(pending, { type: "result", result });
  expect(partial.usage).toEqual({ input: 10, output: 5 });
  const planned = reducer(partial, { type: "planned", totals: { ...totals, runs: 1 } });
  expect(planned.mode).toBe("planned");
  const entries = sidebarEntries(planned);

  const selected = reducer(planned, {
    type: "sidebar",
    index: entries.findIndex((entry) => entry.id === "destination:folder:promos"),
  });

  expect(visibleRows(selected)).toEqual([result]);
  expect(
    visibleRows(
      reducer(planned, {
        type: "sidebar",
        index: entries.findIndex((entry) => entry.id === "destination:inbox"),
      }),
    ),
  ).toEqual([]);
  expect(reducer(selected, { type: "back" }).mode).toBe("browse");
});

test("applied plans show refreshed mailboxes without duplicate destination filters", () => {
  const start = reducer(initialState(mailboxes, "inbox", totals, categories), {
    type: "start",
    batch: [email],
  });

  const planned = reducer(reducer(start, { type: "result", result }), {
    type: "planned",
    totals,
  });

  expect(sidebarEntries(planned).filter((entry) => entry.label === "Promotions")).toHaveLength(2);
  const applied = reducer(reducer(planned, { type: "applyStart" }), { type: "applied" });

  const refreshed = reducer(applied, {
    type: "mailboxes",
    mailboxes: [mailboxes[0]!, mailboxes[1]!, mailbox("promos", "Promotions", null, 3)],
  });

  expect(sidebarEntries(refreshed).filter((entry) => entry.label === "Promotions")).toEqual([
    expect.objectContaining({ id: "promos", count: 3, section: "mailbox" }),
  ]);
  expect(refreshed.destination).toBeNull();
});
