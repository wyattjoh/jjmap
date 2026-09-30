# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10), path `skills/install-anti-slop/assets/anti-slop/`. The upstream checkout was clean, and the files matched it at install time apart from the deviations below.
- Installed: 2026-09-30 to `tools/oxlint/anti-slop/`, with `@oxlint/plugins` pinned to `1.85.0` to match `oxlint`.
- Registered: the generic plugin (`index.ts`) in `.oxlintrc.json` with all generic rules plus `oxc/no-accumulating-spread` at `error`. The Effect plugin (`effect/index.ts`) is registered as `anti-slop-effect` with all five of its rules at `error`, since the server and core now use Effect v4.
- Excluded from oxlint and oxfmt (`.oxlintrc.json`, `.oxfmtrc.json`) so upstream formatting stays intact.

## Deviations

- `shared/dictionary-types.ts`: `unsafeMembers[0]` changed to `(unsafeMembers[0] ?? null)` so the file typechecks under this project's `noUncheckedIndexedAccess`. Behavior is unchanged because the preceding `length > 0` guard ensures the element exists.
