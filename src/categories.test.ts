import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Option, Schema } from "effect";
import {
  buildQuestion,
  CategoriesFile,
  detectCategories,
  DraftsRequest,
  finalizeDrafts,
  normalizeDraft,
  slug,
  validateDrafts,
  type CategoryDraft,
} from "./categories.ts";
import { loadCategories, resolveCategories, saveCategories } from "./category-store.ts";
import type { Folder } from "./mailbox.ts";
import { Paths } from "./usage.ts";

const dir = await mkdtemp(join(tmpdir(), "jjmap-categories-"));

afterAll(async () => {
  await rm(dir, { recursive: true });
});

const draft = (overrides: Partial<CategoryDraft> = {}): CategoryDraft => ({
  id: "travel",
  name: "Travel",
  folder: { kind: "existing", id: "trips" },
  description: "Flights and hotels",
  color: "#5fb3c4",
  allowAction: false,
  allowUrgent: false,
  senderDomains: [],
  ...overrides,
});

const folders = new Set(["trips", "bills"]);

describe("detectCategories", () => {
  test("links only top-level folders whose names match the built-ins", () => {
    const { drafts, detected, expected } = detectCategories([
      { id: "a", name: "Alerts", parentId: null },
      { id: "r", name: "Receipts", parentId: "archive" },
    ]);

    expect({ detected, expected }).toEqual({ detected: 1, expected: 4 });
    expect(drafts.find(({ id }) => id === "alerts")?.folder).toEqual({ kind: "existing", id: "a" });
    expect(drafts.find(({ id }) => id === "receipts")?.folder).toEqual({
      kind: "create",
      name: "Receipts",
    });
    expect(drafts.find(({ id }) => id === "personal")?.folder).toEqual({ kind: "stay" });
  });
});

describe("validateDrafts", () => {
  test("accepts a complete list", () => {
    expect(validateDrafts([draft()], folders).valid).toBe(true);
  });
  test("reports per-field problems", () => {
    const { rows, valid } = validateDrafts(
      [
        draft({ name: " ", description: "", color: "red", senderDomains: ["not a domain"] }),
        draft({ id: "other", folder: { kind: "existing", id: "gone" } }),
      ],
      folders,
    );

    expect(valid).toBe(false);
    expect(Object.keys(rows[0]!).toSorted()).toEqual([
      "color",
      "description",
      "name",
      "senderDomains",
    ]);
    expect(rows[1]).toMatchObject({ id: expect.any(String), folder: "Folder no longer exists" });
  });
  test("rejects duplicate ids, shared folders, and an empty list", () => {
    const { rows } = validateDrafts(
      [draft(), draft({ name: "Travel again" }), draft({ id: "bills", name: "Bills" })],
      folders,
    );

    expect(rows[1]?.name).toBe("Another category already uses this name");
    expect(rows[2]?.folder).toBe("Another category already uses this folder");
    expect(validateDrafts([], folders).list).toBe("Add at least one category");
  });
});

describe("parsing", () => {
  const decodeDrafts = <T>(value: T) =>
    Schema.decodeUnknownSync(DraftsRequest)(value).categories.map(normalizeDraft);

  const decodeFile = Schema.decodeUnknownExit(CategoriesFile);

  test("drafts normalize whitespace and domain case", () => {
    const [parsed] = decodeDrafts({
      categories: [{ ...draft(), name: " Travel ", senderDomains: [" Airline.EXAMPLE "] }],
    });

    expect(parsed).toMatchObject({ name: "Travel", senderDomains: ["airline.example"] });
  });
  test("drafts reject unknown folder choices", () => {
    expect(() =>
      decodeDrafts({ categories: [{ ...draft(), folder: { kind: "move" } }] }),
    ).toThrow();
    expect(() => decodeDrafts({})).toThrow();
  });
  test("stored categories must be complete and valid", () => {
    const stored = finalizeDrafts([draft()], new Map());
    expect(Schema.decodeUnknownSync(CategoriesFile)({ version: 1, categories: stored })).toEqual({
      version: 1,
      categories: stored,
    });
    expect(Exit.isFailure(decodeFile({ categories: [{ ...stored[0], allowAction: "yes" }] }))).toBe(
      true,
    );
    expect(Exit.isFailure(decodeFile({ categories: [{ ...stored[0], id: "other" }] }))).toBe(true);
    expect(Exit.isFailure(decodeFile({ categories: [] }))).toBe(true);
  });
});

test("slug turns names into Jev labels", () => {
  expect(slug("Bills & Statements!")).toBe("bills_statements");
});

test("the category question lists each description plus the built-in other", () => {
  const question = buildQuestion(finalizeDrafts([draft()], new Map()));
  expect(Object.keys(question.criteria)).toEqual(["travel", "other"]);
  expect(question.criteria.travel).toBe("Flights and hotels");
});

test("finalizing resolves created folders by name", () => {
  const [category] = finalizeDrafts(
    [draft({ folder: { kind: "create", name: " Trips " } })],
    new Map([["Trips", "new-trips"]]),
  );

  expect(category?.folderId).toBe("new-trips");
});

describe("category store", () => {
  const paths = { config: "", categories: join(dir, "config", "categories.json"), state: "" };

  const run = <A, E>(effect: Effect.Effect<A, E, Paths>, categories = paths.categories) =>
    Effect.runPromise(effect.pipe(Effect.provideService(Paths, { ...paths, categories })));

  test("round-trips atomically", async () => {
    expect(Option.isNone(await run(loadCategories()))).toBe(true);
    const categories = finalizeDrafts([draft()], new Map());
    await run(saveCategories(categories));
    expect(await run(loadCategories())).toEqual(Option.some(categories));
    expect(await Bun.file(paths.categories).json()).toMatchObject({ version: 1 });
  });
  test("rejects an invalid file by name", async () => {
    const corrupt = join(dir, "corrupt.json");
    await Bun.write(corrupt, JSON.stringify({ categories: [{ id: "x" }] }));
    await expect(run(loadCategories(), corrupt)).rejects.toThrow(
      `Invalid categories in ${corrupt}`,
    );
  });
  test("terminal use falls back to built-ins only when every folder exists", async () => {
    const mailboxes: Folder[] = ["Alerts", "Notifications", "Receipts", "Promotions"].map(
      (name) => ({ id: name.toLowerCase(), name, parentId: null, totalEmails: 0 }),
    );

    const missing = join(dir, "missing.json");

    expect(
      (await run(resolveCategories(mailboxes), missing)).map(({ folderId }) => folderId),
    ).toEqual([null, "alerts", "notifications", "receipts", "promotions"]);
    await expect(run(resolveCategories(mailboxes.slice(1)), missing)).rejects.toThrow(
      "Categories are not set up yet",
    );
  });
});
