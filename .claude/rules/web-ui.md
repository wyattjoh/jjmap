---
paths:
  - "src/web/app.tsx"
  - "src/web/style.css"
  - "src/web/folder-artwork.tsx"
  - "src/web/animation.ts"
---

# Web UI

The bundle boundary is covered in [browser-bundle.md](browser-bundle.md) and the category editor in [categories.md](categories.md).

## Navigation

- The steps run (first-run setup →) folder overview → scope configuration → sorting.
- The chosen folder is the source. Scope configuration offers only count, date range and workers.
- Options → Next opens a read-only stack preview. Only the separate Start sorting button on that screen can begin a run.
- Next waits only for the new DOM, never for animation to finish.
- Preserve the Next/Start re-entry guards, and Stop handling before and during preflight.

## Folder tiles

- The overview hides mailboxes that are category targets.
- Overview fronts show two same-sized, accent-colored counts of current non-draft contents (not historical totals): EMAILS at bottom-left and UNCLASSIFIED (no `$triaged`) at bottom-right.
- Each count shows — when unknown and None when zero.
- No text renders below overview folders; nested paths live only in the title and aria-label.
- Folders with zero unclassified mail are disabled and muted. Folders whose counts are unknown stay selectable.
- Overview tiles and sorting destinations share `.folder-rows`: fixed-width, step-1-sized tiles centered in a flex wrap capped at `--columns` (half the tiles, rounded up). They form two balanced rows with the shorter row centered.
- Sorting tiles reuse the overview stat layout: EMAILS, plus SORTED as the share of mail sorted so far.
- Only move targets get their own tile. Categories that keep mail in place, plus `review`, share one tile named after the source folder, each shown as a sticky note that bumps when its mail lands.
- Folder faces and tabs use subtle `--accent` color mixes.

## Layout and controls

- Every step is full width and fills the viewport height on desktop.
- The shared bottom `.controls` bar is pinned with `margin-top: auto`. It is a grid with `.controls-start`, `.controls-center` and `.controls-end` slots, so actions stay left and right even when one side is empty.
- Back actions go on the left:
  - Folders on options.
  - Options on sorting, replaced by Load fresh batch once a run is done.
- Next, Start and Stop go on the right.
- Step 1 has Refresh folders on the left and Categories on the right, with its settled status line in the center slot.
- The categories step has Folders on the left (hidden on first run, where a status shows instead) and Save on the right.

## Loading states

- Show real server progress, never fake progress.
- `StageList` always renders in `.controls-center`: ✓ done, pulsing current, dim pending, and a count plus bar when the total is known.
- The classification progress bar is a run meter, not a loader, and stays beside the CLASSIFIED stats.
- `GhostFolder`/`Shimmer` hold the layout before data arrives. Shimmers show only while a fetch is in flight; settled nulls stay —.
- Reduced motion disables all loading motion.

## Motion

- Wizard transitions use native View Transitions with a CSS entry fallback. The wizard group never morphs geometry, so snapshots crossfade unscaled in place.
- Animate confirmed mail updates only. Flights follow a continuous 480 ms arc with no upright hold.
- The pile drops in on Next, not again on Start. The first confirmed result settles any unfinished entrance immediately.
- Neither the entrance nor the crossfade may delay or obscure flights. The sorting scene has its own View Transition name, and only its static chrome fades in.
- Entering sorting:
  - The outgoing step clears first (120 ms).
  - The scene starts after 90 ms.
  - The stage stays transparent so the old step fades rather than being cut off.
- Reduced motion skips the drop and the flights, but never the results.

## Timer and cost

- The elapsed timer sits at zero in the preview, starts at accepted Start, and freezes on the terminal run event or on a failure, not after animations settle.
- Keep the running, complete, stopped and error states distinct in both text and color.
- Timer ticks stay inside the memoized timer component and never rerender the card tree.
- EST. COST updates live from per-result usage and `boot.pricing`.
