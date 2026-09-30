# jjmap

jjmap sorts a JMAP mailbox into your categories using [TypeSafe](https://typesafe.ai)'s Jev classifier. For each email it moves the message, sets a color flag, and marks it `$triaged` so later runs skip it. You can drive it from a browser app, a terminal UI, or the CLI.

```bash
bun install
bun run web:demo   # try it with synthetic mail: no account, no spending
```

## Requirements

- [Bun](https://bun.com) 1.4.2 or newer.
- A JMAP account with an API token. jjmap is built for [Fastmail](https://www.fastmail.com); the color flags use its Apple Mail flag scheme.
- A TypeSafe API key. **Classification is paid**, including dry runs. Every screen shows estimated spend.

## Setup

Put credentials in a gitignored `.env.local` (loaded by [Varlock](https://varlock.dev)) or export them in your shell:

```bash
JMAP_BEARER_TOKEN=...   # Fastmail API token with Mail scope, read/write
TYPESAFE_API_KEY=...
# JMAP_SESSION_URL=...  # defaults to Fastmail
```

Optionally, tell Jev your name and override pricing in `~/.config/jjmap/config.json`:

```json
{ "name": "Ada Lovelace", "pricing": { "inputPerMTok": 0.042, "outputPerMTok": 0 } }
```

Run `bun link` to install the `jjmap` command.

## Usage

```bash
jjmap --web             # browser app; nothing is classified until you press Start sorting
jjmap --web --demo      # synthetic demo
jjmap                   # terminal UI: browse, dry-run, review, apply
bun run triage          # CLI dry run of untriaged Inbox mail
bun run triage --apply  # CLI: classify, move and flag
```

The first browser launch walks you through setting up categories, which are saved to `~/.config/jjmap/categories.json` and shared by all three interfaces. The browser app listens on `127.0.0.1` behind a per-launch link. Use `--host <ipv4>` to expose it on one specific interface, such as your Tailscale IP.

**Start sorting** and `--apply` write to your mailbox as they go. Stop finishes the in-flight emails, and changes are never rolled back.

## Development

```bash
bunx lefthook install   # pre-commit format/lint, pre-push typecheck
bun test && bun run typecheck && bun run lint && bun run format:check && bun run test:web
```

The server and core use [Effect](https://effect.website) v4. Tests and the demo are fully synthetic. Contributor conventions are in [`CLAUDE.md`](CLAUDE.md) and [`.claude/rules/`](.claude/rules).

## License

[MIT](LICENSE)
