/** @jsxImportSource react */
import { useState } from "react";
import { FolderArtwork } from "./folder-artwork.tsx";
import {
  PALETTE,
  slug,
  validateDrafts,
  type CategoryDraft,
  type CategoryErrors,
  type FolderChoice,
} from "../categories.ts";

const COLOR_NAMES = [
  "Violet",
  "Amber",
  "Blue",
  "Green",
  "Coral",
  "Pink",
  "Lime",
  "Teal",
  "Gold",
  "Brown",
] as const;

/**
 * One editable category plus UI-only state: raw domain text and whether its id follows the name.
 */
export type CategoryRow = {
  key: string;
  fresh: boolean;
  domains: string;
  draft: CategoryDraft;
};

/**
 * Wraps loaded drafts for editing.
 */
export function toRows(drafts: readonly CategoryDraft[]): CategoryRow[] {
  return drafts.map((draft) => ({
    key: crypto.randomUUID(),
    fresh: false,
    domains: draft.senderDomains.join(", "),
    draft,
  }));
}

/**
 * Drafts as they would be saved, with domain text split into a list.
 */
export function rowDrafts(rows: readonly CategoryRow[]): CategoryDraft[] {
  return rows.map(({ draft, domains }) => ({
    ...draft,
    name: draft.name.trim(),
    description: draft.description.trim(),
    senderDomains: domains
      .split(/[\s,]+/)
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean),
  }));
}

/**
 * Validation for the current rows against the known folders.
 */
export function validateRows(rows: readonly CategoryRow[], folderIds: ReadonlySet<string>) {
  return validateDrafts(rowDrafts(rows), folderIds);
}

const folderValue = (draft: CategoryDraft) =>
  draft.folder.kind === "existing" ? `existing:${draft.folder.id}` : draft.folder.kind;

// Reads the destination select's value (see `folderValue`) back into a choice.
function folderChoice(value: string, name: string): FolderChoice {
  if (value === "stay") return { kind: "stay" };

  if (value === "create") return { kind: "create", name };

  return { kind: "existing", id: value.slice("existing:".length) };
}

// Whether a draft points at a folder that no longer exists.
const missingFolder = (folder: FolderChoice, folders: readonly { readonly id: string }[]) =>
  folder.kind === "existing" && !folders.some(({ id }) => id === folder.id);

/**
 * List editor for sort targets: name, destination folder, Jev description,
 * color, flag permissions, and sender rules.
 */
export function CategoriesEditor({
  rows,
  onChange,
  folders,
  errors,
  disabled,
}: {
  rows: readonly CategoryRow[];
  onChange: (rows: CategoryRow[]) => void;
  folders: readonly { id: string; path: string }[];
  errors: readonly CategoryErrors[];
  disabled: boolean;
}) {
  const [open, setOpen] = useState<string | undefined>(undefined);

  const update = (key: string, change: (row: CategoryRow) => CategoryRow) =>
    onChange(rows.map((row) => (row.key === key ? change(row) : row)));

  const edit = (key: string, patch: Partial<CategoryDraft>) =>
    update(key, (row) => {
      const { folder, name } = row.draft;
      // A new folder named after the category follows later renames.
      const follows = patch.name !== undefined && folder.kind === "create" && folder.name === name;

      const draft: CategoryDraft = {
        ...row.draft,
        ...patch,
        folder:
          follows && patch.name !== undefined
            ? { kind: "create", name: patch.name }
            : (patch.folder ?? folder),
      };

      return { ...row, draft: row.fresh ? { ...draft, id: slug(draft.name) } : draft };
    });

  const add = () => {
    const used = new Set(rows.map(({ draft }) => draft.color));

    const row: CategoryRow = {
      key: crypto.randomUUID(),
      fresh: true,
      domains: "",
      draft: {
        id: "",
        name: "",
        folder: { kind: "create", name: "" },
        description: "",
        color: PALETTE.find((color) => !used.has(color)) ?? PALETTE[0],
        allowAction: false,
        allowUrgent: false,
        senderDomains: [],
      },
    };

    onChange([...rows, row]);
    setOpen(row.key);
  };

  const folderText = ({ folder }: CategoryDraft) => {
    switch (folder.kind) {
      case "stay":
        return "Stays in source folder";
      case "create":
        return `New folder “${folder.name || "…"}”`;
      case "existing":
        return folders.find(({ id }) => id === folder.id)?.path ?? "Missing folder";
    }
  };

  const selectedIndex = rows.findIndex((row) => row.key === open);
  const selected = rows[selectedIndex];

  return (
    <div className="category-workbench">
      <div className="folder-overview category-tiles" aria-label="Categories">
        {rows.map(({ key, draft }, index) => {
          const invalid = Object.keys(errors[index] ?? {}).length > 0;
          const name = draft.name || "Untitled category";

          return (
            <button
              key={key}
              className="folder-choice destination"
              data-category={draft.id}
              aria-pressed={open === key}
              aria-label={`Edit ${name}`}
              style={{ "--accent": draft.color }}
              onClick={() => setOpen(open === key ? undefined : key)}
            >
              <div className="folder-object">
                <FolderArtwork
                  name={name}
                  filled={false}
                  pulse={0}
                  attachments={undefined}
                  count={
                    invalid ? (
                      <span className="category-warning" title="Needs attention">
                        !
                      </span>
                    ) : undefined
                  }
                  total={
                    <span className="folder-progress folder-total">
                      <small>FOLDER</small>
                      <span className="category-target">{folderText(draft)}</span>
                    </span>
                  }
                >
                  {null}
                </FolderArtwork>
              </div>
            </button>
          );
        })}
        <button
          className="folder-choice destination category-new"
          aria-label="Add category"
          disabled={disabled}
          onClick={add}
        >
          <div className="folder-object">
            <FolderArtwork
              name="New category"
              filled={false}
              pulse={0}
              attachments={undefined}
              count={undefined}
              total={
                <span className="category-plus" aria-hidden="true">
                  +
                </span>
              }
            >
              {null}
            </FolderArtwork>
          </div>
        </button>
      </div>
      {selected ? (
        <CategoryFields
          key={selected.key}
          row={selected}
          rowErrors={errors[selectedIndex] ?? {}}
          folders={folders}
          disabled={disabled}
          edit={(patch) => edit(selected.key, patch)}
          setDomains={(domains) => update(selected.key, (row) => ({ ...row, domains }))}
          remove={() => {
            onChange(rows.filter((row) => row.key !== selected.key));
            setOpen(undefined);
          }}
          close={() => setOpen(undefined)}
        />
      ) : (
        <EmptyCategoryEditor />
      )}
    </div>
  );
}

function CategoryFields({
  row: { draft, domains },
  rowErrors,
  folders,
  disabled,
  edit,
  setDomains,
  remove,
  close,
}: {
  row: CategoryRow;
  rowErrors: CategoryErrors;
  folders: readonly { id: string; path: string }[];
  disabled: boolean;
  edit: (patch: Partial<CategoryDraft>) => void;
  setDomains: (domains: string) => void;
  remove: () => void;
  close: () => void;
}) {
  const nameError = rowErrors.name ?? rowErrors.id;

  return (
    <section
      className="category-editor"
      aria-label={`Edit ${draft.name || "Untitled category"}`}
      style={{ "--accent": draft.color }}
    >
      <div className="section-label">
        EDIT CATEGORY
        <button className="text-button" onClick={close}>
          Done
        </button>
      </div>
      <div className="category-fields">
        <label>
          NAME
          <input
            aria-label="Category name"
            value={draft.name}
            aria-invalid={Boolean(nameError)}
            disabled={disabled}
            onChange={(event) => edit({ name: event.target.value })}
          />
          {nameError && <small className="field-error">{nameError}</small>}
        </label>
        <label>
          FOLDER
          <select
            aria-label="Destination folder"
            value={folderValue(draft)}
            aria-invalid={Boolean(rowErrors.folder)}
            disabled={disabled}
            onChange={(event) => {
              edit({ folder: folderChoice(event.target.value, draft.name) });
            }}
          >
            <option value="stay">Stay in source folder</option>
            {missingFolder(draft.folder, folders) && (
              <option value={folderValue(draft)}>Missing folder</option>
            )}
            {folders.map((folder) => (
              <option key={folder.id} value={`existing:${folder.id}`}>
                {folder.path}
              </option>
            ))}
            <option value="create">Create new folder…</option>
          </select>
          {rowErrors.folder && <small className="field-error">{rowErrors.folder}</small>}
        </label>
        {draft.folder.kind === "create" && (
          <label>
            NEW FOLDER
            <input
              aria-label="New folder name"
              value={draft.folder.name}
              disabled={disabled}
              onChange={(event) => edit({ folder: { kind: "create", name: event.target.value } })}
            />
          </label>
        )}
        <label>
          COLOR
          <select
            aria-label="Color"
            value={draft.color}
            disabled={disabled}
            onChange={(event) => edit({ color: event.target.value })}
          >
            {!PALETTE.some((color) => color === draft.color) && (
              <option value={draft.color}>Custom</option>
            )}
            {PALETTE.map((color, colorIndex) => (
              <option key={color} value={color}>
                {COLOR_NAMES[colorIndex]}
              </option>
            ))}
          </select>
        </label>
        <label className="category-description">
          WHAT BELONGS HERE
          <textarea
            aria-label="Description"
            rows={3}
            value={draft.description}
            aria-invalid={Boolean(rowErrors.description)}
            disabled={disabled}
            onChange={(event) => edit({ description: event.target.value })}
          />
          {rowErrors.description && <small className="field-error">{rowErrors.description}</small>}
        </label>
        <label className="category-description">
          ALWAYS FROM DOMAINS
          <input
            aria-label="Sender domains"
            value={domains}
            aria-invalid={Boolean(rowErrors.senderDomains)}
            disabled={disabled}
            onChange={(event) => setDomains(event.target.value)}
          />
          {rowErrors.senderDomains && (
            <small className="field-error">{rowErrors.senderDomains}</small>
          )}
        </label>
        <label className="category-check">
          <input
            type="checkbox"
            aria-label="Allow action flag"
            checked={draft.allowAction}
            disabled={disabled}
            onChange={(event) => edit({ allowAction: event.target.checked })}
          />
          ACTION FLAG
        </label>
        <label className="category-check">
          <input
            type="checkbox"
            aria-label="Allow urgent flag"
            checked={draft.allowUrgent}
            disabled={disabled}
            onChange={(event) => edit({ allowUrgent: event.target.checked })}
          />
          URGENT FLAG
        </label>
        <button className="text-button category-remove" disabled={disabled} onClick={remove}>
          Remove category
        </button>
      </div>
    </section>
  );
}

/** Keeps the editor column in place while loading or with no category selected. */
export function EmptyCategoryEditor({ loading = false }: { loading?: boolean }) {
  return (
    <section className="category-editor" aria-label="No category selected">
      <div className="section-label">EDIT CATEGORY</div>
      {!loading && (
        <div className="empty-stack category-empty">
          <span>No category selected.</span>
          <small>Choose a folder to edit it, or + to add one.</small>
        </div>
      )}
    </section>
  );
}
