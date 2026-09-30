# jjmap

Sort a JMAP mailbox into categories using [TypeSafe](https://typesafe.ai)'s Jev classifier. jjmap asks Jev which of your categories each email belongs to, whether it needs your action, and whether it is urgent. It then moves the email, sets a color flag, and marks it with a `$triaged` keyword so later runs skip it.

There are three front ends that share the same rules and configuration:

- **Browser app** (`jjmap --web`): a local sorting wizard with live progress and animated cards.
- **Terminal UI** (`jjmap`): browse folders, dry-run a batch, review the plan, then apply it.
- **CLI** (`bun run triage`): classify a batch of Inbox mail, print the plan, and optionally `--apply` it.

Try the browser app without an account or any spending:

```bash
bun install
bun run web:demo
```

## Requirements

- [Bun](https://bun.com) 1.4.2 or newer.
- A JMAP mail account with an API token. jjmap is built and tested against [Fastmail](https://www.fastmail.com). Its color flags use the Apple Mail `$MailFlagBit` scheme that Fastmail displays; other JMAP servers can sort mail, but the colors may not show.
- A TypeSafe API key for Jev. **Classification is paid.** Dry runs spend tokens too, and every screen shows estimated spend.

## Setup

```bash
bun install
bun link   # optional: installs the `jjmap` command (needs ~/.bun/bin on your PATH)
```

Credentials load through [Varlock](https://varlock.dev) using `.env.schema`. Put them in a gitignored `.env.local`, or export them in your shell:

```bash
JMAP_BEARER_TOKEN=...   # Fastmail: Settings → Privacy & Security → API tokens, Mail scope, read/write
TYPESAFE_API_KEY=...
# JMAP_SESSION_URL=https://api.fastmail.com/jmap/session   # the default; change it for other providers
# JMAP_ACCOUNT_ID=...                                      # optional; defaults to the primary mail account
```

1Password users can reference items instead of pasting secrets, for example `JMAP_BEARER_TOKEN=op(op://Vault/Item/credential)`.

Optional settings live in `~/.config/jjmap/config.json` (or `$XDG_CONFIG_HOME/jjmap/config.json`):

```json
{ "name": "Ada Lovelace", "pricing": { "inputPerMTok": 0.042, "outputPerMTok": 0 } }
```

- `name` tells Jev who you are, so it can judge whether mail is addressed to you and needs your action. Without it, Jev refers to "the mailbox owner".
- `pricing` overrides the dollar rates used for spend estimates. The default is [TypeSafe's published early-access Jev price](https://typesafe.ai/blog/introducing-system-one-models-and-jev): $0.042 per million input tokens, and output tokens are free.

All-time usage is stored in `~/.local/state/jjmap/state.json` (or `$XDG_STATE_HOME/jjmap/state.json`). Dollar figures are estimates at the configured rates, including estimates for older runs that were recorded without pricing.

## Usage

```bash
jjmap --web             # browser app on live mail; nothing is classified until you press Start sorting
jjmap --web --demo      # synthetic preview; no credentials, spending, or mail changes
jjmap                   # terminal UI
bun run triage          # CLI dry run of untriaged Inbox mail; prints the plan
bun run triage --apply  # CLI: classify, then move and flag the batch
```

Without `bun link`, use `bun run web`, `bun run web:demo` and `bun run tui` instead. Categories are set up in the browser on first launch (see [Categories](#categories)); the terminal UI and CLI read the same file.

## Interactive triage

`bun run tui` opens immediately with JMAP connection and mailbox loading status, then shows a folder sidebar, email list, next-batch form, and spend panel. Browsing loads enough messages to fill the visible list, then loads more as you scroll; cyan diamonds mark loaded messages eligible for the next batch. Press `u` while browsing to toggle between all emails and untriaged-only emails (`$triaged` absent). This view filter is independent of the next-batch filter and applies to every loaded page. Scrolling does not classify or spend Jev tokens. Tab changes focus; arrows navigate and adjust the form; Enter runs a dry batch with per-email progress in the batch panel. Plan filters are marked with ↳ while reviewing; after applying, they disappear and mailbox counts refresh. From the plan view, press `A` twice to confirm applying every plan. Escape returns to browsing; `q` quits. Applying never happens as part of a dry run. The account must be writable to apply.

The scope form selects a source folder, a positive integer limit (default 10, no application cap), a filter (untriaged, unread, or all), and a time range. Larger batches spend more Jev tokens. Both the CLI and TUI count Jev tokens on dry runs, and the TUI shows estimated spend at the configured rates.

## Browser sorting

```bash
jjmap --web --host "$(tailscale ip -4)"  # live mail on this machine's Tailscale IP
```

The local browser app uses Bun's HTML bundler/server (the repository's frontend tooling), not Vite. Keep the terminal running while using it. It defaults to `127.0.0.1` on an available port and opens a private, per-launch browser link. Use `--host IP` to bind to a specific IPv4 interface, such as the machine's Tailscale address; wildcard binding is not allowed. The token and exact Host/origin checks remain required on that address. Tailscale access is subject to your tailnet's access rules; no Tailscale Serve routes or public sharing are configured. Credentials and full email bodies stay server-side; treat the printed link as access to your mailbox.

### Categories

Sort targets are configured from the browser and saved to `~/.config/jjmap/categories.json` (or `$XDG_CONFIG_HOME/jjmap/categories.json`). The first visit opens a required setup step seeded with the built-in Personal, Alerts, Notifications, Receipts, and Promotions categories, linked to matching top-level folders when they exist. Each category has a name, a destination folder (an existing folder, a new top-level folder, or "stay in source folder"), a description Jev uses to decide what belongs there, a color, whether it may carry the action/urgent flags, and optional sender domains that always route there. Saving creates any new folders you asked for. Reopen the editor later with **Categories** on the folder overview; saving discards any loaded batch because routing changed. The CLI and TUI read the same file. Until it exists, they fall back to the built-in categories, but only when the Alerts, Notifications, Receipts and Promotions folders already exist.

The wizard starts with your actual mail folders, not the sorting destinations; folders used as sort targets are hidden there because they only receive mail. Each lightly color-tinted folder shows two counts: **EMAILS** (the total) and **UNCLASSIFIED** (mail without the `$triaged` marker). Folders with nothing left to classify are muted and can't be selected. Counts describe **current non-draft contents** using the existing `$triaged` marker, not lifetime processing history; moving mail changes the totals. Missing counts display **—**, never an invented zero. Folder listing is paginated, and count reads are bounded to four folders at a time without downloading email bodies.

Click a folder to configure the email count (default **100**) and date range; the browser always sorts unclassified mail. **Workers** controls inference concurrency: 1, 2, 4 (default), or 8. This step loads a read-only preview; it does not classify mail or prepare writable destinations. **Next** opens the stack screen and plays its falling entrance, then waits for you. Only **Start sorting** on that screen begins processing; the timer stays at zero until then. Back navigation returns to the folder overview and refreshes its counts. Forward and backward steps have short fade/slide transitions with reduced-motion support; classification does not wait for a transition to finish.

Loading a stack only reads mail. **Start sorting spends Jev tokens and immediately applies each email's move, flags, and read state using the same rules as the terminal interface.** A card only flies after the mail server confirms its update. Categories set to stay in the source folder, and the review bucket, do not move mail. Read-only accounts cannot start sorting.

The viewport-filling workspace scales across wide desktops instead of staying in a fixed top-centered box. The card stack falls in from above on Next. After you click Start sorting, cards flip into a grid of your categories plus Needs review without pausing upright. Each destination shows its batch email count and live share of the emails sorted so far. Flights follow a continuous arc, launch at the rate results arrive, overlap for 480 ms, and never impose a classification cadence. Fast results finish the stack entrance immediately rather than waiting for it. Folder shares, overall progress, and remaining uncategorized mail are shown to one decimal place, relative to the selected batch. On phones, the stack sits above a two-column folder grid with touch-sized controls and an accessible Stop button. Reduced-motion preferences skip the drop and flights without skipping results.

Start immediately shows preparation progress, followed by first classification, first mail update, and sorting. An elapsed timer above the classification bar counts from Start until processing finishes, excluding the final visual flights. It freezes green on completion, amber when stopped, or in the error color on failure; its text also identifies the state. Startup timings below the workspace distinguish these phases; the first-result time includes server-side preflight. Flights still wait for confirmed mailbox updates, so progress feedback does not disguise pending writes as successes. These timings can diagnose a slow live start without assuming demo speed represents JMAP latency.

Classification uses a bounded worker pool. Each email's three independent questions share one TypeSafe request; separate emails can run concurrently. Destination folders are prepared once per run, and ready updates coalesce behind a single JMAP writer without a batching delay. Workers retain their slots through writing, so slow updates cannot build an unbounded paid queue. TypeSafe's normal rate-limit retries/backoff remain enabled; reduce workers if your account regularly hits its rate limit.

**Stop after current**, closing the page, or Ctrl+C prevents new work and finishes only the in-flight emails (up to the selected worker count). Successful changes are not rolled back. A failed or unconfirmed update stops the batch, is not animated as a success, and is never automatically retried. Reload a fresh batch before retrying; the default untriaged filter skips successful updates. Usage is recorded even when a batch is stopped or partially fails. Terminal shutdown allows 30 seconds to finish; a forced shutdown or lost connection can leave the last update uncertain, so check the mailbox before retrying.

### Browser verification

`bun run test:web` runs Playwright against an isolated synthetic server using installed Google Chrome. It never loads credentials, calls Jev/JMAP, or changes real mail. It covers the folder/configuration/sorting wizard, current-folder counts, read-only Next and explicit Start, forward/back transitions, reduced motion and transition fallback, immediate startup feedback, falling-stack entrances, frozen/reset elapsed timers, early Stop, desktop and phone layouts, continuous overlapping flips, one-decimal percentages, invalid scope, bursts of results, and failed writes. Each browser test starts a fresh synthetic backend; demo moves update only its in-memory folder counts. Screenshots and traces go to the ignored `.scratch/` directory. `bun test` covers the API's authorization, explicit-start boundary, concurrent-run lock, cancellation, partial failures, usage accounting, and stream decoding with synthetic Effect test layers instead of real JMAP or Jev clients.

## Development

The server and core are written with [Effect](https://effect.website) v4 (`effect@4.0.0-rc.117`, pinned exactly). JMAP, TypeSafe Jev, file paths, and the web backend are `Context.Service`s provided by layers, so tests swap in synthetic layers rather than mocking modules. Every input crosses a Schema decoder: `config.json`, `categories.json`, `state.json`, HTTP bodies, NDJSON stream events, and Jev answers. The terminal and browser UIs stay plain React; the browser imports only browser-safe schemas to decode API responses.

Before committing, run:

```bash
bun test && bun run typecheck && bun run lint && bun run format:check && bun run test:web
```

`bun run lint` includes the vendored [anti-slop](tools/oxlint/anti-slop/UPSTREAM.md) oxlint rules and their Effect plugin.

## Git hooks

Pre-commit checks (oxfmt, oxlint) and a pre-push type check are managed by [Lefthook](https://lefthook.dev). Enable them once after installing dependencies:

```bash
bunx lefthook install
```

Run `bun run format` to fix formatting. Bypass hooks in an emergency with `git commit --no-verify`; remove them with `bunx lefthook uninstall`.
