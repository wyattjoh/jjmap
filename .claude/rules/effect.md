---
paths:
  - "src/*.ts"
  - "src/web/*.ts"
  - "src/tui/main.tsx"
  - "src/tui/terminal.tsx"
---

# Effect in server and core code

Load the `effect-ts` skill before writing Effect code. `effect` is pinned exactly to `4.0.0-rc.117`, the version that skill vendors. Any added `@effect/*` package must be the same version, because mismatched versions cause confusing type errors.

## Services

Capabilities are `Context.Service`s with a `layer` static or `of`/`fromX` constructors:

- `JmapClient` in `src/mailbox.ts`
- `Jev` in `src/classify.ts`
- `Paths` in `src/usage.ts`
- `Connector` in `src/triage.ts`
- `Backend` in `src/web/api.ts`, implemented by `LiveBackend` (`backend.ts`) and `DemoBackend` (`demo.ts`)
- `Api` in `src/web/api.ts`

Tests provide synthetic layers or `Service.of` values instead of module mocks. See [testing.md](testing.md).

## Errors

Use `Schema.TaggedError` with a `message` that is safe to show. Provider details go in `cause`:

```ts
export class JevError extends Schema.TaggedError<JevError>()("JevError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}
```

Handle errors with `catchTag`, never by comparing `_tag`. The `anti-slop-effect/no-manual-tag-comparison` lint rule enforces this.

## Functions

Name effectful functions with `Effect.fn`. Don't write functions that return `Effect.gen`.

## I/O boundaries

Decode every boundary with Schema: `config.json`, `categories.json` (`CategoriesFile`, which also runs `validateDrafts`), `state.json`, HTTP bodies, NDJSON events, Jev answers and JMAP `/set` responses. Use `src/json-file.ts` to read and atomically write schema-checked JSON rather than calling `Bun.file` directly.

## Env

Varlock loads env first (`import "varlock/auto-load"`). Read it afterwards through Effect `Config`, using `Config.Redacted` for `JMAP_BEARER_TOKEN` and `TYPESAFE_API_KEY`.

## Mail types

`Message` and `Folder` (`src/mailbox.ts`) are the narrow email and mailbox contracts jjmap reads. Full JMAP objects satisfy them, so fixtures need no casts.

## Lint

`bun run lint` enables the vendored anti-slop generic and Effect plugins (`tools/oxlint/anti-slop/`) at `error`. Fix findings properly. Don't add disables, lower severities, or chain assertions.
