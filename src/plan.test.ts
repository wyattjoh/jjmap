import { describe, expect, test } from "bun:test";
import { DEFAULT_CATEGORIES, ruleCategory } from "./categories.ts";
import { decide, isConfident, type Judgments } from "./plan.ts";
import { emailPatch, flagPatch } from "./mailbox.ts";

// Folder ids equal the built-in folder names so expectations stay readable.
const categories = DEFAULT_CATEGORIES.map(({ folderName, ...rest }) => ({
  ...rest,
  folderId: folderName,
}));

const alerts = categories.find(({ id }) => id === "alerts");

const judgments = (
  choice: string,
  p: number,
  rest: Partial<Omit<Judgments, "category">> = {},
): Judgments => ({
  category: {
    choice,
    probabilities: Object.fromEntries([
      ...["personal", "alerts", "notifications", "receipts", "promotions", "other"].map(
        (id) => [id, 0] as const,
      ),
      [choice, p] as const,
      ...(choice === "other" ? [] : [["other", 1 - p] as const]),
    ]),
  },
  needsAction: rest.needsAction ?? 0,
  urgent: rest.urgent ?? 0,
});

describe("isConfident", () => {
  test("requires probability and gap", () => {
    expect(isConfident({ a: 0.9, b: 0.1 })).toBe(true);
    expect(isConfident({ a: 0.65, b: 0.35 })).toBe(false);
    expect(isConfident({ a: 0.72, b: 0.6 })).toBe(false);
  });
});

describe("ruleCategory", () => {
  test("matches domain and subdomains", () => {
    const routed = categories.map((category) =>
      category.id === "alerts" ? { ...category, senderDomains: ["status.example"] } : category,
    );

    expect(ruleCategory("uptime@status.example", routed)?.id).toBe("alerts");
    expect(ruleCategory("x@hc.status.example", routed)?.id).toBe("alerts");
    expect(ruleCategory("x@notstatus.example", routed)).toBeUndefined();
  });
});

describe("decide", () => {
  test("a label missing from the configured categories goes to review", () => {
    const plan = decide(judgments("travel", 0.95), undefined, categories);
    expect(plan).toMatchObject({ category: null, folderId: null, flag: "review" });
    expect(plan.reason).toBe("unknown travel (0.95)");
  });

  test("flag permissions come from the category", () => {
    const strict = categories.map((category) => ({ ...category, allowUrgent: false }));
    expect(decide(judgments("alerts", 0.9, { urgent: 0.9 }), undefined, strict).flag).toBeNull();
  });

  test("low confidence only adds review", () => {
    const plan = decide(judgments("promotions", 0.55), undefined, categories);
    expect(plan).toMatchObject({ category: null, folderId: null, markSeen: false });
    expect(plan.flag).toBe("review");
  });

  test("other goes to review", () => {
    expect(decide(judgments("other", 0.95), undefined, categories).category).toBeNull();
  });

  test("personal stays in inbox unread and can carry action", () => {
    const plan = decide(judgments("personal", 0.9, { needsAction: 0.8 }), undefined, categories);
    expect(plan).toMatchObject({ folderId: null, markSeen: false });
    expect(plan.flag).toBe("action");
  });

  test("promotions move, are marked seen, and never get action or urgent", () => {
    const plan = decide(
      judgments("promotions", 0.9, { needsAction: 0.9, urgent: 0.9 }),
      undefined,
      categories,
    );

    expect(plan).toMatchObject({ folderId: "Promotions", markSeen: true });
    expect(plan.flag).toBeNull();
  });

  test("urgent alert moves but stays unread", () => {
    const plan = decide(judgments("alerts", 0.9, { urgent: 0.9 }), undefined, categories);
    expect(plan).toMatchObject({ folderId: "Alerts", markSeen: false });
    expect(plan.flag).toBe("urgent");
  });

  test("sender rule overrides low confidence", () => {
    const plan = decide(judgments("notifications", 0.5), alerts, categories);
    expect(plan).toMatchObject({ category: "alerts", folderId: "Alerts" });
  });
});

describe("emailPatch", () => {
  test("moves out of the selected source and sets keywords", () => {
    const plan = decide(judgments("receipts", 0.9), undefined, categories);
    expect(emailPatch(plan, "archive", {})).toEqual({
      "mailboxIds/archive": null,
      "mailboxIds/Receipts": true,
      "keywords/$triaged": true,
      "keywords/$seen": true,
    });
  });
});

describe("flagPatch", () => {
  test("urgent is red plus the Urgent label", () => {
    const plan = decide(judgments("alerts", 0.9, { urgent: 0.9 }), undefined, categories);
    expect(flagPatch(plan, {})).toEqual({
      "keywords/$urgent": true,
      "keywords/$flagged": true,
      "keywords/$MailFlagBit0": null,
      "keywords/$MailFlagBit1": null,
      "keywords/$MailFlagBit2": null,
    });
  });

  test("review is gray", () => {
    const plan = decide(judgments("other", 0.9), undefined, categories);
    expect(flagPatch(plan, {})).toMatchObject({
      "keywords/$MailFlagBit0": null,
      "keywords/$MailFlagBit1": true,
      "keywords/$MailFlagBit2": true,
    });
  });

  test("never recolors mail the user already flagged", () => {
    const plan = decide(judgments("other", 0.9), undefined, categories);
    expect(flagPatch(plan, { $flagged: true })).toEqual({});
  });

  test("already-flagged urgent mail still gets the Urgent label", () => {
    const plan = decide(judgments("alerts", 0.9, { urgent: 0.9 }), undefined, categories);
    expect(flagPatch(plan, { $flagged: true })).toEqual({ "keywords/$urgent": true });
  });
});
