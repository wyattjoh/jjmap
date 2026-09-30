import type { ChoiceQuestion } from "@typesafe-ai/sdk";
import { Schema } from "effect";

const categoryFields = {
  /**
   * Stable slug; also the label Jev chooses between.
   */
  id: Schema.String,
  name: Schema.String,
  /**
   * What belongs here, sent to Jev as the choice criterion.
   */
  description: Schema.String,
  color: Schema.String,
  /**
   * Whether mail here may carry the orange needs-action flag.
   */
  allowAction: Schema.Boolean,
  /**
   * Whether mail here may carry the red urgent flag.
   */
  allowUrgent: Schema.Boolean,
  /**
   * Sender domains (and their subdomains) forced into this category without Jev review.
   */
  senderDomains: Schema.Array(Schema.String),
};

/**
 * One user-configured sort target. Pure data shared by the server, TUI, and
 * browser; this module must stay free of filesystem and mail imports.
 */
export const CategoryConfig = Schema.Struct({
  ...categoryFields,
  /**
   * Destination mailbox id, or `null` to leave mail in its source folder.
   */
  folderId: Schema.NullOr(Schema.String),
});

/**
 * One user-configured sort target.
 */
export type CategoryConfig = typeof CategoryConfig.Type;

/**
 * Where a draft category should route when saved.
 */
export const FolderChoice = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("stay") }),
  Schema.Struct({ kind: Schema.Literal("existing"), id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("create"), name: Schema.String }),
]);

/**
 * Where a draft category should route when saved.
 */
export type FolderChoice = typeof FolderChoice.Type;

/**
 * A category as edited in the web UI, before any folder creation.
 */
export const CategoryDraft = Schema.Struct({ ...categoryFields, folder: FolderChoice });

/**
 * A category as edited in the web UI, before any folder creation.
 */
export type CategoryDraft = typeof CategoryDraft.Type;

/**
 * Reserved Jev label meaning "leave it alone".
 */
export const OTHER = "other";

/**
 * Reserved visual bucket for low-confidence and `other` mail.
 */
export const REVIEW = { id: "review", name: "Needs review", color: "#a0a38b" } as const;

/**
 * Accent colors offered for categories, starting with the built-in ones.
 */
export const PALETTE = [
  "#9a8bd4",
  "#d7a34b",
  "#669ecc",
  "#58b39b",
  "#ce806c",
  "#c77fae",
  "#8fb35a",
  "#5fb3c4",
  "#d4c35f",
  "#b58b6a",
] as const;

const OTHER_CRITERION =
  "None of the categories fits cleanly, such as mailing list or community group discussion not addressed to the recipient personally.";

/**
 * Built-in categories used to seed first-run setup; `folderName` is only a detection hint.
 */
export const DEFAULT_CATEGORIES: readonly (Omit<CategoryConfig, "folderId"> & {
  readonly folderName: string | null;
})[] = [
  {
    id: "personal",
    name: "Personal",
    folderName: null,
    description:
      "A human writing to the recipient directly, expecting them to read or respond: friends, family, landlord, recruiters, service providers corresponding about their account. Still personal when relayed by a platform (LinkedIn message, recruiter, landlord, property manager, accountant).",
    color: PALETTE[0],
    allowAction: true,
    allowUrgent: true,
    senderDomains: [],
  },
  {
    id: "alerts",
    name: "Alerts",
    folderName: "Alerts",
    description:
      "Operational monitoring about infrastructure or software the recipient runs: uptime down/up, health check failures, backup failures, error reports, failed deploys or builds, and their recoveries. Account and security notices are not alerts.",
    color: PALETTE[1],
    allowAction: false,
    allowUrgent: true,
    senderDomains: [],
  },
  {
    id: "notifications",
    name: "Notifications",
    folderName: "Notifications",
    description:
      "Automated transactional notices about the recipient's accounts that are not purchases: sign-in and security alerts, verification or 2FA codes, password resets, package publishes, usage or quota warnings, maintenance notices, terms or policy updates.",
    color: PALETTE[2],
    allowAction: false,
    allowUrgent: true,
    senderDomains: [],
  },
  {
    id: "receipts",
    name: "Receipts",
    folderName: "Receipts",
    description:
      "Proof of a transaction or delivery: order confirmations, receipts, shipping and delivery updates, bills and statements, payment or transfer confirmations, bookings and reservations.",
    color: PALETTE[3],
    allowAction: true,
    allowUrgent: true,
    senderDomains: [],
  },
  {
    id: "promotions",
    name: "Promotions",
    folderName: "Promotions",
    description:
      "Marketing and bulk content whose purpose is to sell, promote, re-engage, or announce: sales, product launches, product newsletters, changelogs, event marketing, surveys, social network invitations and nudges, and cold outreach from strangers pitching something.",
    color: PALETTE[4],
    allowAction: false,
    allowUrgent: false,
    senderDomains: [],
  },
];

/**
 * Turns a display name into a category id Jev can use as a label.
 */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const COLOR = /^#[0-9a-f]{6}$/i;

const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/;

/**
 * Per-field problems for one category, keyed by field name.
 */
export type CategoryErrors = Partial<
  Record<"id" | "name" | "folder" | "description" | "color" | "senderDomains", string>
>;

// The folder a draft claims: an existing id, a trimmed new-folder name, or none.
function folderTarget(folder: FolderChoice): string | null {
  switch (folder.kind) {
    case "existing":
      return folder.id;
    case "create":
      return folder.name.trim();
    case "stay":
      return null;
  }
}

/**
 * Per-row and list-level problems for a set of drafts.
 */
export interface DraftValidation {
  readonly rows: CategoryErrors[];
  readonly list: string | undefined;
  readonly valid: boolean;
}

/**
 * Validates drafts; returns one error map per draft plus any list-level error.
 */
export function validateDrafts(
  drafts: readonly CategoryDraft[],
  folderIds: ReadonlySet<string>,
): DraftValidation {
  const rows = drafts.map((draft, index) => {
    const errors: CategoryErrors = {};

    if (!draft.name.trim()) errors.name = "Name is required";

    if (!/^[a-z0-9_]+$/.test(draft.id) || draft.id === OTHER || draft.id === REVIEW.id)
      errors.id = "Pick a different name";
    else if (drafts.findIndex(({ id }) => id === draft.id) !== index)
      errors.name = "Another category already uses this name";

    if (!draft.description.trim()) errors.description = "Describe what belongs here";

    if (!COLOR.test(draft.color)) errors.color = "Pick a color";

    if (draft.senderDomains.some((domain) => !DOMAIN.test(domain)))
      errors.senderDomains = "Use bare domains like example.com";

    if (draft.folder.kind === "existing" && !folderIds.has(draft.folder.id))
      errors.folder = "Folder no longer exists";

    if (draft.folder.kind === "create" && !draft.folder.name.trim())
      errors.folder = "Name the new folder";
    const target = folderTarget(draft.folder);

    if (
      target !== null &&
      drafts.findIndex(({ folder }) => folderTarget(folder) === target) !== index
    )
      errors.folder = "Another category already uses this folder";

    return errors;
  });

  const list = drafts.length === 0 ? "Add at least one category" : undefined;

  return { rows, list, valid: !list && rows.every((row) => Object.keys(row).length === 0) };
}

/**
 * The stored `categories.json` document. Decoding also runs `validateDrafts`,
 * so a decoded file is always a usable category list.
 */
export const CategoriesFile = Schema.Struct({
  version: Schema.optionalKey(Schema.Finite),
  categories: Schema.Array(CategoryConfig),
}).check(
  Schema.makeFilter(({ categories }) => {
    const folderIds = new Set(categories.flatMap(({ folderId }) => (folderId ? [folderId] : [])));

    return validateDrafts(categories.map(toDraft), folderIds).valid || "Invalid categories";
  }),
);

/**
 * Converts a stored category into its editable form.
 */
export function toDraft({ folderId, ...rest }: CategoryConfig): CategoryDraft {
  return {
    ...rest,
    folder: folderId === null ? { kind: "stay" } : { kind: "existing", id: folderId },
  };
}

/**
 * The identity and nesting of one mailbox, as category detection needs it.
 */
export interface FolderRef {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string | null | undefined;
}

/**
 * First-run drafts, and how many built-in folders were found out of those expected.
 */
export interface DetectedCategories {
  readonly drafts: CategoryDraft[];
  readonly detected: number;
  readonly expected: number;
}

/**
 * Seeds drafts from the built-ins, linking top-level folders whose names match.
 */
export function detectCategories(mailboxes: readonly FolderRef[]): DetectedCategories {
  const topLevel = new Map(
    mailboxes.flatMap((mailbox) => (mailbox.parentId ? [] : [[mailbox.name, mailbox.id] as const])),
  );

  const drafts = DEFAULT_CATEGORIES.map(({ folderName, ...rest }): CategoryDraft => {
    if (folderName === null) return { ...rest, folder: { kind: "stay" } };
    const id = topLevel.get(folderName);

    return {
      ...rest,
      folder: id ? { kind: "existing", id } : { kind: "create", name: folderName },
    };
  });

  return {
    drafts,
    detected: drafts.filter(({ folder }) => folder.kind === "existing").length,
    expected: DEFAULT_CATEGORIES.filter(({ folderName }) => folderName !== null).length,
  };
}

/**
 * Builds Jev's category question from the configured targets plus the built-in `other`.
 */
export function buildQuestion(
  categories: readonly CategoryConfig[],
): ChoiceQuestion<Record<string, string>> {
  return {
    type: "choice",
    instructions:
      "Which folder does `email` belong in for `recipient`'s mailbox? Judge the message type, not just the sender.",
    criteria: {
      ...Object.fromEntries(categories.map(({ id, description }) => [id, description])),
      [OTHER]: OTHER_CRITERION,
    },
  };
}

/**
 * Returns the category forced by a sender rule, if any.
 */
export function ruleCategory(
  fromEmail: string,
  categories: readonly CategoryConfig[],
): CategoryConfig | undefined {
  const domain = fromEmail.split("@")[1]?.toLowerCase();

  if (!domain) return undefined;

  return categories.find((category) =>
    category.senderDomains.some((d) => domain === d || domain.endsWith(`.${d}`)),
  );
}

/**
 * Folder names that saving these drafts would create.
 */
export function foldersToCreate(drafts: readonly CategoryDraft[]): string[] {
  return drafts.flatMap(({ folder }) => (folder.kind === "create" ? [folder.name.trim()] : []));
}

/**
 * Resolves drafts to stored categories once any new folders have ids.
 */
export function finalizeDrafts(
  drafts: readonly CategoryDraft[],
  created: ReadonlyMap<string, string>,
): CategoryConfig[] {
  return drafts.map(({ folder, ...rest }) => {
    if (folder.kind === "stay") return { ...rest, folderId: null };

    if (folder.kind === "existing") return { ...rest, folderId: folder.id };
    const id = created.get(folder.name.trim());

    if (!id) throw new Error(`Folder ${folder.name} was not created`);

    return { ...rest, folderId: id };
  });
}

/**
 * Untrusted `POST /api/categories` body; `normalizeDraft` then `validateDrafts` check the values.
 */
export const DraftsRequest = Schema.Struct({ categories: Schema.Array(CategoryDraft) });

/**
 * Trims editable text and lowercases sender domains before validation.
 */
export function normalizeDraft(draft: CategoryDraft): CategoryDraft {
  return {
    ...draft,
    name: draft.name.trim(),
    description: draft.description.trim(),
    senderDomains: draft.senderDomains.map((domain) => domain.trim().toLowerCase()),
  };
}
