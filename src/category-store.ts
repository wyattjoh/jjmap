import { Effect, Option, Schema } from "effect";
import {
  CategoriesFile,
  detectCategories,
  finalizeDrafts,
  foldersToCreate,
  validateDrafts,
  type CategoryConfig,
  type CategoryDraft,
} from "./categories.ts";
import { writeJsonFile, readJsonFile } from "./json-file.ts";
import { ensureFolders, JmapClient, type Folder } from "./mailbox.ts";
import { Paths } from "./usage.ts";

/**
 * Categories are missing or cannot be saved as requested.
 */
export class CategoriesError extends Schema.TaggedError<CategoriesError>()("CategoriesError", {
  message: Schema.String,
}) {}

/**
 * Loads saved categories, or `None` before first-run setup.
 */
export const loadCategories = Effect.fn("loadCategories")(function* () {
  const { categories } = yield* Paths;
  const file = yield* readJsonFile(categories, CategoriesFile, "categories");

  return Option.map(file, (saved) => saved.categories);
});

/**
 * Atomically writes the category list.
 */
export const saveCategories = Effect.fn("saveCategories")(function* (
  categories: readonly CategoryConfig[],
) {
  const paths = yield* Paths;
  yield* writeJsonFile(paths.categories, CategoriesFile, { version: 1, categories });
});

/**
 * Saved categories, or the built-ins when every default folder already exists.
 * Used by the terminal and CLI, which have no setup screen.
 */
export const resolveCategories = Effect.fn("resolveCategories")(function* (
  mailboxes: readonly Folder[],
) {
  const saved = yield* loadCategories();

  if (Option.isSome(saved)) return saved.value;
  const { drafts, detected, expected } = detectCategories(mailboxes);

  if (detected < expected)
    return yield* new CategoriesError({
      message: "Categories are not set up yet. Run `bun run web` to configure them.",
    });

  return finalizeDrafts(drafts, new Map());
});

/**
 * Validates drafts against live mailboxes, creates requested folders, and saves.
 */
export const commitDrafts = Effect.fn("commitDrafts")(function* (
  mailboxes: readonly Folder[],
  drafts: readonly CategoryDraft[],
) {
  const jmap = yield* JmapClient;

  if (!validateDrafts(drafts, new Set(mailboxes.map(({ id }) => id))).valid)
    return yield* new CategoriesError({ message: "Invalid categories" });
  const names = foldersToCreate(drafts);

  if (names.length > 0 && jmap.isReadOnly)
    return yield* new CategoriesError({ message: "JMAP account is read-only" });

  const created =
    names.length > 0 ? yield* ensureFolders(mailboxes, names) : new Map<string, string>();

  const categories = finalizeDrafts(drafts, created);
  yield* saveCategories(categories);

  return categories;
});
