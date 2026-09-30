---
paths:
  - "src/categories.ts"
  - "src/category-store.ts"
  - "src/web/categories-editor.tsx"
  - "src/web/demo.ts"
---

# Categories

Categories are runtime configuration stored in `categories.json`, never hardcoded.

## Modules

`src/categories.ts` is pure and browser-safe. `src/category-store.ts` owns reading and writing `categories.json`, and it is the only code that creates folders.

## Built-in ids

Only `other` (leave the mail alone) and `review` (the UI bucket) are built in. Never reintroduce hardcoded category ids outside the `DEFAULT_CATEGORIES` seeds and demo fixtures.

## Routing

Categories point at mailbox ids, not names. A category with `folderId: null` keeps mail in the source folder.

## Default text

`DEFAULT_CATEGORIES` descriptions stay neutral ("the recipient"), and `senderDomains` start empty. The owner's name comes from `config.json` `name`, so don't put personal names or domains in source.

## First-run setup

When `boot.categoriesSaved === false`, the app opens the required `categories` setup step. After that, the editor is reachable from the overview's Categories button.

## Editor UI

- The editor reuses the overview's folder tiles (`FolderArtwork` from `src/web/folder-artwork.tsx`), plus a dashed + tile to add a category.
- The side panel column is always present. Nothing is selected by default, and it shows a "No category selected" empty state, or only its header while loading.
- Selecting a tile fills the panel without shifting the layout, and the Done button must not change the header height. On phones the panel stacks.
