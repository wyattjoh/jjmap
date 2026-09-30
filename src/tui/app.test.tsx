import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import type { Folder, MailboxPage, Message } from "../mailbox.ts";
import { DEFAULT_CATEGORIES } from "../categories.ts";
import type { Scope } from "../domain.ts";
import type { Triaged } from "../triage.ts";
import { App, type Deps } from "./app.tsx";
import { COLORS } from "./theme.ts";

const inbox = { id: "inbox", name: "Inbox", role: "inbox", totalEmails: 2 } satisfies Folder;

const emails = [
  {
    id: "one",
    subject: "Receipt",
    preview: "Your package is here",
    from: [{ email: "shop@example.com", name: "Shop" }],
  },
  {
    id: "two",
    subject: "Please reply",
    preview: "Can you reply?",
    from: [{ email: "friend@example.com", name: "Friend" }],
  },
] satisfies Message[];

const plans = emails.map((email, index) => ({
  email,
  from: email.from?.[0]?.email ?? "",
  subject: email.subject ?? "",
  judgments: {
    category: {
      choice: index ? "personal" : "receipts",
      probabilities: { [index ? "personal" : "receipts"]: 0.9 },
    },
    needsAction: 0,
    urgent: 0,
  },
  plan: {
    category: index ? "personal" : "receipts",
    folderId: index ? null : "receipts",
    flag: null,
    markSeen: true,
    reason: "test",
  },
  usage: { input: 10, output: 5 },
})) satisfies Triaged[];

const categories = DEFAULT_CATEGORIES.map(({ folderName, ...rest }) => ({
  ...rest,
  folderId: folderName?.toLowerCase() ?? null,
}));

const totals = { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, lastRunAt: null };

const deps: Deps = {
  mailboxes: [inbox],
  categories,
  inboxId: inbox.id,
  readOnly: false,
  totals,
  pricing: undefined,
  fetch: async () => emails,
  browse: async (_mailboxId, position, limit) => ({
    emails: emails.slice(position, position + limit),
    nextPosition: Math.min(position + limit, emails.length),
    hasMore: position + limit < emails.length,
  }),
  classify: async (_emails, onResult) => {
    for (const result of plans) onResult(result);

    return plans;
  },
  apply: async () => ({ updated: [], failed: {} }),
  refreshMailboxes: async () => [inbox],
  record: async () => ({ ...totals, runs: 1, inputTokens: 20, outputTokens: 10, costUsd: null }),
};

const focusForm = async (view: Awaited<ReturnType<typeof testRender>>) => {
  act(() => view.mockInput.pressTab());
  await view.flush();
  act(() => view.mockInput.pressTab());
  await view.flush();
};

const pressRun = async (view: Awaited<ReturnType<typeof testRender>>) => {
  await act(async () => {
    view.mockInput.pressEnter();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

test("shows batch progress while classifying and estimates cost with default Jev rates", async () => {
  let finishFirst: ((result: Triaged) => void) | undefined;
  let finishLast: (() => void) | undefined;

  const paced: Deps = {
    ...deps,
    pricing: { inputPerMTok: 0.042, outputPerMTok: 0 },
    classify: async (_emails, onResult) => {
      const first = await new Promise<Triaged>((resolve) => {
        finishFirst = resolve;
      });

      onResult(first);
      await new Promise<void>((resolve) => {
        finishLast = resolve;
      });
      onResult(plans[1]!);

      return plans;
    },
  };

  const view = await testRender(<App deps={paced} />, { width: 105, height: 30 });
  act(() => view.renderer.start());

  try {
    await view.waitForFrame((frame) => frame.includes("Shop Receipt"));
    await act(async () => view.mockMouse.click(8, 26));
    await view.waitForFrame((frame) => frame.includes("Classifying 0/2") && frame.includes("0%"));
    await act(async () => finishFirst?.(plans[0]!));
    await view.waitForFrame((frame) => frame.includes("Classifying 1/2") && frame.includes("50%"));
    expect(view.captureCharFrame()).toContain("$0.00000042");
    await act(async () => finishLast?.());
    await view.waitForFrame((frame) => frame.includes("[ Apply plans ]"));
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("estimates historic costs from tokens even when old runs were unpriced", async () => {
  const view = await testRender(
    <App
      deps={{
        ...deps,
        pricing: { inputPerMTok: 0.042, outputPerMTok: 0 },
        totals: {
          ...totals,
          runs: 2,
          inputTokens: 1_000_000,
          outputTokens: 2_000_000,
          costUsd: null,
        },
      }}
    />,
    { width: 105, height: 30 },
  );

  act(() => view.renderer.start());

  try {
    await view.waitForFrame((frame) => frame.includes("$0.0420 est."));
    expect(view.captureCharFrame()).toContain("3000000 tokens");
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("renders browsing rows and spend, then a planned destination filter", async () => {
  const view = await testRender(<App deps={deps} />, { width: 105, height: 30 });
  act(() => view.renderer.start());

  try {
    await act(async () => {
      await Promise.resolve();
    });
    await view.waitForFrame((frame) => frame.includes("Your package is here"));
    const browse = view.captureCharFrame();
    expect(browse).toContain("Next batch");
    expect(browse).toContain("Spend");
    expect(browse).toContain("◆ Shop Receipt");

    const marker = view
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.startsWith("◆ "));

    expect(marker?.fg.equals(RGBA.fromHex(COLORS.nextBatch))).toBe(true);

    await focusForm(view);
    act(() => view.mockInput.pressArrow("down"));
    await view.flush();
    act(() => view.mockInput.pressArrow("right"));
    await view.flush();
    expect(view.captureCharFrame()).toMatch(/Limit\s+‹ 11\s+›/);
    act(() => view.mockInput.pressArrow("down"));
    await view.flush();
    await pressRun(view);
    await view.waitForFrame((frame) => frame.includes("30 tokens") && frame.includes("90%"));
    expect(view.captureCharFrame()).toContain("1 runs");

    act(() => view.mockInput.pressTab());
    await view.flush();
    // Inbox is the only mailbox; one step down selects "↳ Inbox (stays)".
    act(() => view.mockInput.pressArrow("down"));
    await view.flush();
    await view.waitForFrame(
      (frame) => frame.includes("Batch · 1") && frame.includes("Please reply"),
    );
    expect(view.captureCharFrame()).not.toContain("Shop Receipt");
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("toggles the browse-only untriaged query and pages its matching results", async () => {
  const mailboxEmails = Array.from({ length: 14 }, (_, index): Message => ({
    id: `mail-${index}`,
    subject: `Message-${index.toString().padStart(2, "0")}`,
    keywords: index === 0 || index === 10 ? { $triaged: true } : {},
  })) satisfies Message[];

  const requests: Array<{ position: number; filter: string }> = [];

  const paged: Deps = {
    ...deps,
    browse: async (_mailboxId, position, limit, filter) => {
      requests.push({ position, filter });

      const matches = mailboxEmails.filter(
        (email) => filter === "all" || !email.keywords?.["$triaged"],
      );

      const page = matches.slice(position, position + limit);

      return {
        emails: page,
        nextPosition: position + page.length,
        hasMore: position + page.length < matches.length,
      };
    },
  };

  const view = await testRender(<App deps={paged} />, { width: 105, height: 30 });
  act(() => view.renderer.start());

  try {
    await view.waitForFrame((frame) => frame.includes("Emails · 9+ · all"));
    expect(view.captureCharFrame()).toContain("Message-00");
    act(() => view.mockInput.pressKey("u"));
    await view.waitForFrame((frame) => frame.includes("Emails · 9+ · untriaged"));
    expect(view.captureCharFrame()).not.toContain("Message-00");
    expect(view.captureCharFrame()).toContain("Message-01");
    expect(requests.slice(0, 2)).toEqual([
      { position: 0, filter: "all" },
      { position: 0, filter: "untriaged" },
    ]);
    act(() => view.mockInput.pressTab());
    await view.flush();

    for (let index = 0; index < 7; index++) {
      act(() => view.mockInput.pressArrow("down"));
      await view.flush();
    }

    await view.waitForFrame((frame) => frame.includes("Emails · 12 · untriaged"));
    expect(requests.at(-1)).toEqual({ position: 9, filter: "untriaged" });
    act(() => view.mockInput.pressKey("u"));
    await view.waitForFrame((frame) => frame.includes("Emails · 9+ · all"));
    expect(requests.at(-1)).toEqual({ position: 0, filter: "all" });
    expect(view.captureCharFrame()).toContain("Message-00");
    expect(view.captureCharFrame()).toContain("Filter   ‹ untriaged ›");
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("uses available row width before truncating subjects and previews, including after resize", async () => {
  const subject = "Subject " + "s".repeat(120);
  const preview = "Preview " + "p".repeat(120);

  const wide: Deps = {
    ...deps,
    browse: async () => ({
      emails: [
        {
          id: "long",
          subject,
          preview,
          from: [{ name: "界界", email: "sender@example.com" }],
        } satisfies Message,
      ],
      nextPosition: 1,
      hasMore: false,
    }),
  };

  const view = await testRender(<App deps={wide} />, { width: 105, height: 30 });
  act(() => view.renderer.start());

  try {
    await view.waitForFrame((frame) => frame.includes("Subject ") && frame.includes("Preview "));
    const narrow = view.captureCharFrame().split("\n");
    const narrowSubject = narrow.find((line) => line.includes("Subject "))!;
    const narrowPreview = narrow.find((line) => line.includes("Preview "))!;
    expect(narrowSubject).toContain("s".repeat(50));
    expect(narrowPreview).toContain("p".repeat(60));
    expect(narrowSubject).toMatch(/… │$/);
    expect(narrowPreview).toMatch(/… │$/);

    act(() => view.resize(170, 30));
    await view.waitForFrame((frame) => frame.includes(subject) && frame.includes(preview));
    const wider = view.captureCharFrame().split("\n");
    expect(wider.find((line) => line.includes("Subject "))).toContain(subject);
    expect(wider.find((line) => line.includes("Preview "))).toContain(preview);
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("mouse clicks browse folders, cycle form fields, type a limit, and run the batch", async () => {
  const archive = {
    id: "archive",
    name: "Archive",
    role: "archive",
    totalEmails: 1,
  } satisfies Folder;

  const archived = { id: "archive-mail", subject: "Archived item" } satisfies Message;
  let fetched: Scope | undefined;

  const interactive: Deps = {
    ...deps,
    mailboxes: [inbox, archive],
    browse: async (mailboxId) => ({
      emails: mailboxId === archive.id ? [archived] : emails,
      nextPosition: 1,
      hasMore: false,
    }),
    fetch: async (scope) => {
      fetched = scope;

      return [];
    },
  };

  const view = await testRender(<App deps={interactive} />, { width: 105, height: 30 });
  act(() => view.renderer.start());

  try {
    await view.waitForFrame((frame) => frame.includes("Shop Receipt"));
    await act(async () => view.mockMouse.click(7, 2));
    await view.waitForFrame((frame) => frame.includes("Archived item"));
    expect(view.captureCharFrame()).toContain("Source   ‹ Archive ›");
    await act(async () => view.mockMouse.click(7, 22));
    await view.waitForFrame((frame) => frame.includes("Source   ‹ Inbox ›"));
    await act(async () => view.mockMouse.click(7, 22));
    await view.waitForFrame((frame) => frame.includes("Source   ‹ Archive ›"));

    await act(async () => view.mockMouse.click(7, 24));
    await view.waitForFrame((frame) => frame.includes("Filter   ‹ unread ›"));
    await act(async () => view.mockMouse.click(7, 25));
    await view.waitForFrame((frame) => frame.includes("Since    ‹ 24h ›"));
    await act(async () => view.mockMouse.click(17, 23));
    await act(async () => view.mockInput.typeText("25"));
    await view.flush();
    act(() => view.mockInput.pressEnter());
    await view.flush();
    await view.waitForFrame((frame) => /Limit\s+‹ 25\s+›/.test(frame));
    expect(fetched).toBeUndefined();

    await act(async () => view.mockMouse.click(8, 26));
    await view.waitForFrame((frame) => frame.includes("Batch · 0"));
    expect(fetched).toEqual({ mailboxId: "archive", limit: 25, filter: "unread", since: "24h" });
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("an empty archive batch keeps Archive selected and explains why nothing ran", async () => {
  const archive = {
    id: "archive",
    name: "Archive",
    role: "archive",
    totalEmails: 1,
  } satisfies Folder;

  const archived = {
    ...emails[0]!,
    id: "archived",
    subject: "Already triaged",
    keywords: { $triaged: true },
  };

  let fetched: Scope | undefined;

  const interactive: Deps = {
    ...deps,
    mailboxes: [inbox, archive],
    browse: async (mailboxId) => ({
      emails: mailboxId === archive.id ? [archived] : emails,
      nextPosition: 1,
      hasMore: false,
    }),
    fetch: async (scope) => {
      fetched = scope;

      return [];
    },
  };

  const view = await testRender(<App deps={interactive} />, { width: 105, height: 30 });
  act(() => view.renderer.start());

  try {
    await view.waitForFrame((frame) => frame.includes("Shop Receipt"));
    await act(async () => view.mockMouse.click(7, 2));
    await view.waitForFrame((frame) => frame.includes("Already triaged"));
    await act(async () => view.mockMouse.click(8, 26));
    await view.waitForFrame((frame) => frame.includes("Batch · 0"));
    expect(fetched?.mailboxId).toBe("archive");
    expect(view.captureCharFrame()).toMatch(/▶ Archive\s+1/);
    expect(view.captureCharFrame()).toContain("No untriaged emails in Archive");
    await act(async () => view.mockMouse.click(7, 24));
    await view.waitForFrame((frame) => frame.includes("Filter   ‹ unread ›"));
    expect(view.captureCharFrame()).toContain("No untriaged emails in Archive");
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("running an archive batch from the Source field shows progress without switching folders", async () => {
  const archive = {
    id: "archive",
    name: "Archive",
    role: "archive",
    totalEmails: 1,
  } satisfies Folder;

  const archived = { id: "archived", subject: "Pending archive email" } satisfies Message;
  let fetched: Scope | undefined;
  let finish: (() => void) | undefined;

  const interactive: Deps = {
    ...deps,
    mailboxes: [inbox, archive],
    browse: async (mailboxId) => ({
      emails: mailboxId === archive.id ? [archived] : emails,
      nextPosition: 1,
      hasMore: false,
    }),
    fetch: async (scope) => {
      fetched = scope;

      return [archived];
    },
    classify: async (_emails, onResult) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      const result = { ...plans[0]!, email: archived };
      onResult(result);

      return [result];
    },
  };

  const view = await testRender(<App deps={interactive} />, { width: 105, height: 30 });
  act(() => view.renderer.start());

  try {
    await view.waitForFrame((frame) => frame.includes("Shop Receipt"));
    await act(async () => view.mockMouse.click(7, 22));
    await view.waitForFrame((frame) => frame.includes("Pending archive email"));
    await act(async () => view.mockMouse.click(8, 26));
    await view.waitForFrame((frame) => frame.includes("Classifying 0/1"));
    expect(fetched?.mailboxId).toBe("archive");
    expect(view.captureCharFrame()).toMatch(/▶ Archive\s+1/);
    await act(async () => finish?.());
    await view.waitForFrame((frame) => frame.includes("[ Apply plans ]"));
    expect(view.captureCharFrame()).toMatch(/▶ Archive\s+1/);
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("limit input rejects invalid values without running and allows typing q", async () => {
  let fetched: Scope | undefined;

  const interactive: Deps = {
    ...deps,
    fetch: async (scope) => {
      fetched = scope;

      return [];
    },
  };

  const view = await testRender(<App deps={interactive} />, { width: 105, height: 30 });
  act(() => view.renderer.start());

  try {
    await view.waitForFrame((frame) => frame.includes("Shop Receipt"));
    await act(async () => view.mockMouse.click(17, 23));
    await act(async () => view.mockInput.typeText("0q"));
    await view.flush();
    expect(view.captureCharFrame()).toContain("0q");
    act(() => view.mockInput.pressEnter());
    await view.waitForFrame((frame) => frame.includes("Limit must be a positive integer"));
    await act(async () => view.mockMouse.click(8, 26));
    expect(fetched).toBeUndefined();

    await act(async () => view.mockMouse.click(17, 23));
    await act(async () => view.mockInput.typeText("3"));
    await view.flush();
    act(() => view.mockInput.pressEnter());
    await view.waitForFrame((frame) => /Limit\s+‹ 3\s+›/.test(frame));
    await act(async () => view.mockMouse.click(8, 26));
    await view.waitForFrame((frame) => frame.includes("Batch · 0"));
    expect(fetched?.limit).toBe(3);
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("clicking an email and destination selects them; Apply requires two clicks", async () => {
  let applied = false;

  const interactive: Deps = {
    ...deps,
    apply: async () => {
      applied = true;

      return { updated: [], failed: {} };
    },
    refreshMailboxes: async () => [
      inbox,
      { id: "receipts", name: "Receipts", role: null, totalEmails: 3 } satisfies Folder,
    ],
  };

  const view = await testRender(<App deps={interactive} />, { width: 105, height: 30 });
  act(() => view.renderer.start());

  try {
    await view.waitForFrame((frame) => frame.includes("Shop Receipt"));
    await act(async () => view.mockMouse.click(40, 3));
    await view.flush();

    const selected = view
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text.includes("Friend Please reply"));

    expect(selected).toBeDefined();
    expect(selected?.fg.equals(RGBA.fromHex(COLORS.accent))).toBe(true);

    await act(async () => view.mockMouse.click(8, 26));
    await view.waitForFrame((frame) => frame.includes("[ Apply plans ]"));
    const sidebar = view.captureCharFrame().split("\n");
    const destinationRow = sidebar.findIndex((line) => /Receipts\s+1\s*│/.test(line.slice(0, 27)));
    expect(destinationRow).toBeGreaterThan(0);
    expect(sidebar[destinationRow]).toContain("↳ Receipts");
    await act(async () => view.mockMouse.click(8, destinationRow));
    await view.waitForFrame((frame) => frame.includes("Batch · 1"));
    expect(view.captureCharFrame()).not.toContain("Friend Please reply");

    await act(async () => view.mockMouse.click(25, 26));
    await view.waitForFrame((frame) => frame.includes("[ Confirm apply ]"));
    expect(applied).toBe(false);
    await act(async () => view.mockMouse.click(25, 26));
    await view.waitForFrame(
      (frame) => frame.includes("Plans applied.") && /Receipts\s+3/.test(frame),
    );
    expect(applied).toBe(true);
    expect(
      view
        .captureCharFrame()
        .split("\n")
        .filter((line) => /Receipts\s+\d+/.test(line.slice(0, 27))),
    ).toHaveLength(1);
    expect(view.captureCharFrame()).not.toContain("↳ Receipts");
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("fills the viewport, pages on keyboard navigation, and fills after resize", async () => {
  const mailboxEmails = Array.from({ length: 40 }, (_, index): Message => ({
    id: `mail-${index}`,
    subject: `Message ${index}`,
    from: [{ email: "sender@example.com" }],
  })) satisfies Message[];

  const requests: Array<{ position: number; limit: number }> = [];
  let classified = false;

  const paged: Deps = {
    ...deps,
    browse: async (_mailboxId, position, limit) => {
      requests.push({ position, limit });
      const page = mailboxEmails.slice(position, position + limit);

      return {
        emails: page,
        nextPosition: position + page.length,
        hasMore: position + page.length < mailboxEmails.length,
      };
    },
    classify: async () => {
      classified = true;

      return [];
    },
  };

  const view = await testRender(<App deps={paged} />, { width: 105, height: 30 });
  act(() => view.renderer.start());

  try {
    await view.waitForFrame((frame) => frame.includes("Emails · 9+"));
    expect(requests).toEqual([{ position: 0, limit: 9 }]);
    act(() => view.mockInput.pressTab());
    await view.flush();

    for (let index = 0; index < 7; index++) {
      act(() => view.mockInput.pressArrow("down"));
      await view.flush();
    }

    await view.waitForFrame((frame) => frame.includes("Emails · 18+"));
    expect(requests[1]).toEqual({ position: 9, limit: 9 });
    act(() => view.resize(105, 60));
    await view.waitForFrame((frame) => frame.includes("Emails · 24+"));
    expect(requests[2]).toEqual({ position: 18, limit: 6 });
    expect(classified).toBe(false);
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("scrolling long rows does not leave text from previous rows behind", async () => {
  const longEmails = Array.from({ length: 80 }, (_, index): Message => ({
    id: `mail-${index}`,
    subject: `Subject-${index.toString().padStart(2, "0")} ${"s".repeat(30 + index * 3)}`,
    preview: `Preview-${index.toString().padStart(2, "0")} ${"p".repeat(15 + index * 5)}${index === 0 ? "\nExtra-00" : ""}`,
    from: [{ name: "Sender", email: "sender@example.com" }],
  })) satisfies Message[];

  const paged: Deps = {
    ...deps,
    browse: async (_mailboxId, position, limit) => {
      const page = longEmails.slice(position, position + limit);

      return {
        emails: page,
        nextPosition: position + page.length,
        hasMore: position + page.length < longEmails.length,
      };
    },
  };

  const view = await testRender(<App deps={paged} />, { width: 105, height: 30 });
  act(() => view.renderer.start());

  try {
    await view.waitForFrame(
      (frame) => frame.includes("Subject-00") && frame.includes("ppppppppppppppp Extra-00"),
    );

    for (let step = 0; step < 18; step++) {
      await act(async () => {
        await view.mockMouse.scroll(40, 7, step < 14 ? "down" : "up");
      });
      await view.flush();
      const lines = view.captureCharFrame().split("\n");
      const rows = lines.filter((line) => /Subject-\d\d|Preview-\d\d/.test(line));
      expect(rows).toHaveLength(19);

      for (const line of rows) {
        expect((line.match(/(?:Subject|Preview)-\d\d/g) ?? []).length).toBe(1);
        expect(line).toMatch(/(?:◆|●) Sender Subject-\d\d|  Preview-\d\d/);

        if (line.includes("Extra-")) expect(line).toContain("Preview-00");
      }
    }
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("keeps sender and preview on separate lines while scrolling a narrow pane", async () => {
  const narrowEmails = Array.from({ length: 30 }, (_, index): Message => ({
    id: `narrow-${index}`,
    subject: `Subject-${index}`,
    preview: `Preview-${index}`,
    from: [{ name: "VeryLongSenderNameForThisRow", email: "sender@example.com" }],
  })) satisfies Message[];

  const paged: Deps = {
    ...deps,
    browse: async () => ({ emails: narrowEmails, nextPosition: 30, hasMore: false }),
  };

  const view = await testRender(<App deps={paged} />, { width: 56, height: 30 });
  act(() => view.renderer.start());

  try {
    await view.waitForFrame((frame) => frame.includes("Preview-0"));

    for (let step = 0; step < 3; step++) {
      const lines = view.captureCharFrame().split("\n");
      const previews = lines.filter((line) => line.includes("Preview-"));
      expect(previews.length).toBeGreaterThan(0);

      for (const line of previews) expect(line).toMatch(/││   Preview-\d+/);
      await act(async () => {
        await view.mockMouse.scroll(35, 7, "down");
      });
      await view.flush();
    }
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("mouse wheel near the bottom fetches the next page", async () => {
  const mailboxEmails = Array.from({ length: 20 }, (_, index): Message => ({
    id: `mail-${index}`,
    subject: `Message ${index}`,
  })) satisfies Message[];

  const requests: number[] = [];

  const paged: Deps = {
    ...deps,
    browse: async (_mailboxId, position, limit) => {
      requests.push(position);
      const page = mailboxEmails.slice(position, position + limit);

      return {
        emails: page,
        nextPosition: position + page.length,
        hasMore: position + page.length < mailboxEmails.length,
      };
    },
  };

  const view = await testRender(<App deps={paged} />, { width: 105, height: 30 });
  act(() => view.renderer.start());

  try {
    await view.waitForFrame((frame) => frame.includes("Emails · 9+"));
    await act(async () => {
      await view.mockMouse.scroll(40, 7, "down");
    });
    await view.waitForFrame((frame) => frame.includes("Emails · 18+"));
    expect(requests).toEqual([0, 9]);
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("ignores a late page from the previous browse filter", async () => {
  let finishAll: ((page: MailboxPage) => void) | undefined;

  const paged: Deps = {
    ...deps,
    browse: async (_mailboxId, _position, _limit, filter) =>
      filter === "all"
        ? new Promise((resolve) => {
            finishAll = resolve;
          })
        : {
            emails: [{ id: "pending", subject: "Pending item" } satisfies Message],
            nextPosition: 1,
            hasMore: false,
          },
  };

  const view = await testRender(<App deps={paged} />, { width: 105, height: 30 });
  act(() => view.renderer.start());

  try {
    await view.waitForFrame((frame) => frame.includes("Loading emails"));
    act(() => view.mockInput.pressKey("u"));
    await view.waitForFrame((frame) => frame.includes("Pending item"));
    await act(async () => {
      finishAll?.({
        emails: [{ id: "old", subject: "Old item" } satisfies Message],
        nextPosition: 1,
        hasMore: false,
      });
      await Promise.resolve();
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain("Pending item");
    expect(view.captureCharFrame()).not.toContain("Old item");
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("ignores a late page from a previously selected folder", async () => {
  let finishArchive: ((page: MailboxPage) => void) | undefined;

  const archived = { id: "archived", subject: "Archived item" } satisfies Message;
  const inboxMail = { id: "inbox-mail", subject: "Inbox item" } satisfies Message;

  const paged: Deps = {
    ...deps,
    mailboxes: [
      inbox,
      { id: "archive", name: "Archive", role: "archive", totalEmails: 1 } satisfies Folder,
    ],
    browse: async (mailboxId) =>
      mailboxId === "archive"
        ? new Promise((resolve) => {
            finishArchive = resolve;
          })
        : { emails: [inboxMail], nextPosition: 1, hasMore: false },
  };

  const view = await testRender(<App deps={paged} />, { width: 105, height: 30 });
  act(() => view.renderer.start());

  try {
    await view.waitForFrame((frame) => frame.includes("Inbox item"));
    act(() => view.mockInput.pressArrow("down"));
    await view.waitForFrame((frame) => frame.includes("Source   ‹ Archive ›"));
    act(() => view.mockInput.pressArrow("up"));
    await view.waitForFrame((frame) => frame.includes("Inbox item"));
    await act(async () => {
      finishArchive?.({ emails: [archived], nextPosition: 1, hasMore: false });
      await Promise.resolve();
    });
    await view.flush();
    expect(view.captureCharFrame()).toContain("Inbox item");
    expect(view.captureCharFrame()).not.toContain("Archived item");
  } finally {
    act(() => view.renderer.destroy());
  }
});

test("records partial usage but refuses to apply an incomplete batch", async () => {
  let recorded = false;
  let applied = false;

  const failing: Deps = {
    ...deps,
    classify: async (_emails, onResult) => {
      onResult(plans[0]!);
      throw new Error("Classification stopped");
    },
    record: async () => {
      recorded = true;

      return { ...totals, runs: 1 };
    },
    apply: async () => {
      applied = true;

      return { updated: [], failed: {} };
    },
  };

  const view = await testRender(<App deps={failing} />, { width: 105, height: 30 });
  act(() => view.renderer.start());

  try {
    await act(async () => {
      await Promise.resolve();
    });
    await view.waitForFrame((frame) => frame.includes("Your package is here"));
    await focusForm(view);
    await pressRun(view);
    await view.waitForFrame((frame) => frame.includes("Classification stopped"));
    expect(recorded).toBe(true);
    act(() => view.mockInput.pressKey("a"));
    await view.flush();
    expect(applied).toBe(false);
    expect(view.captureCharFrame()).toContain("Cannot apply an incomplete or failed batch");
  } finally {
    act(() => view.renderer.destroy());
  }
});
